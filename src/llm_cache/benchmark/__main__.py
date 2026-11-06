"""Benchmark CLI.

Baseline (direct to Ollama, once) + threshold-sweep replay (through the proxy)
per docs/plan.md §14-15:

    uv run python -m llm_cache.benchmark all \
        --dataset src/llm_cache/benchmark/dataset/qa.yaml \
        --out results

Outputs: baseline.json, replay-<radius>.json, results.json, results.md,
hit-vs-falsehit.png in --out.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import subprocess
import sys
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import httpx
import redis as redis_lib
import yaml

from ..canonical import semantic_doc_key
from ..store import RedisCache
from . import metrics as M
from . import report as R

DEFAULT_THRESHOLDS = "0.05,0.08,0.10,0.15,0.20,0.30"


# --------------------------------------------------------------------- dataset

def load_dataset(path: Path, max_topics: int | None = None) -> dict[str, Any]:
    data = yaml.safe_load(path.read_text())
    topics = data["topics"][: max_topics or len(data["topics"])]
    items: list[dict[str, Any]] = []
    for t in topics:
        items.append(
            {"id": f"{t['id']}:seed", "kind": "seed", "topic": t["id"], "prompt": t["original"]}
        )
        for i, p in enumerate(t["paraphrases"], 1):
            items.append(
                {"id": f"{t['id']}:p{i}", "kind": "paraphrase", "topic": t["id"], "prompt": p}
            )
    for d in data["distractors"]:
        items.append({"id": d["id"], "kind": "distractor", "topic": None, "prompt": d["prompt"]})
    return {
        "path": str(path),
        "model": data["model"],
        "system": data.get("system", ""),
        "temperature": data.get("temperature", 0),
        "items": items,
        "n_paraphrases": sum(1 for i in items if i["kind"] == "paraphrase"),
        "n_distractors": sum(1 for i in items if i["kind"] == "distractor"),
    }


def build_body(dataset: dict, prompt: str) -> dict[str, Any]:
    messages = []
    if dataset["system"]:
        messages.append({"role": "system", "content": dataset["system"]})
    messages.append({"role": "user", "content": prompt})
    body: dict[str, Any] = {"model": dataset["model"], "messages": messages}
    if dataset["temperature"] is not None:
        body["temperature"] = dataset["temperature"]
    # Ollama-native extension (accepted by /v1/chat/completions, E2 probe):
    # pin the model in host RAM so the benchmark measures inference, not reloads.
    # Not part of the cache hash (canonical.CACHEABLE_PARAMS).
    body["keep_alive"] = "30m"
    return body


# ------------------------------------------------------------------ transport

async def _send_to_ollama(client: httpx.AsyncClient, body: dict) -> dict[str, Any]:
    t0 = time.perf_counter()
    resp = await client.post("/v1/chat/completions", json=body)
    latency_ms = (time.perf_counter() - t0) * 1000
    resp.raise_for_status()
    payload = resp.json()
    return {
        "latency_ms": round(latency_ms, 1),
        "usage": payload.get("usage"),
        "response": payload,
    }


async def _send_to_proxy(client: httpx.AsyncClient, body: dict) -> dict[str, Any]:
    t0 = time.perf_counter()
    resp = await client.post("/v1/chat/completions", json=body)
    latency_ms = (time.perf_counter() - t0) * 1000
    if resp.status_code >= 400:
        raise RuntimeError(f"proxy error {resp.status_code}: {resp.text[:300]}")
    payload = resp.json()
    headers = resp.headers
    return {
        "latency_ms": round(latency_ms, 1),
        "status": headers.get("x-cache-status", "unknown"),
        "similarity": _float_or_none(headers.get("x-cache-similarity")),
        "source_prompt": headers.get("x-cache-source-prompt"),
        "usage": payload.get("usage"),
        "response": payload,
    }


def _float_or_none(v: str | None) -> float | None:
    try:
        return float(v) if v is not None else None
    except ValueError:
        return None


def _answer_text(payload: dict) -> str:
    try:
        return payload["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        return ""


# -------------------------------------------------------------------- commands

async def run_baseline(args: argparse.Namespace) -> Path:
    dataset = load_dataset(Path(args.dataset), args.max_topics)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "baseline.json"

    records = []
    async with httpx.AsyncClient(base_url=args.ollama, timeout=args.timeout_s) as client:
        for i, item in enumerate(dataset["items"], 1):
            body = build_body(dataset, item["prompt"])
            result = await _send_to_ollama(client, body)
            records.append({**item, **result})
            _progress(f"baseline {i}/{len(dataset['items'])} {item['id']} {result['latency_ms']:.0f}ms")

    latencies = [r["latency_ms"] for r in records]
    summary = {
        "n": len(records),
        **M.summarize_latencies(latencies),
        "total_ms": round(sum(latencies), 1),
        "mean_ms": round(M.mean(latencies), 1),
    }
    R.write_json(
        out_path,
        {
            "dataset": dataset["path"],
            "model": dataset["model"],
            "ollama_url": args.ollama,
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "requests": records,
        },
    )
    print(f"baseline written to {out_path} ({summary['n']} prompts, "
          f"mean {summary['mean_ms']:.0f} ms)")
    return out_path


async def run_replay(args: argparse.Namespace) -> Path:
    dataset = load_dataset(Path(args.dataset), args.max_topics)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    thresholds = _parse_thresholds(args.thresholds)

    baseline_path = out_dir / "baseline.json"
    baseline_by_id: dict[str, dict] = {}
    if baseline_path.exists():
        baseline_by_id = {
            r["id"]: r for r in json.loads(baseline_path.read_text()).get("requests", [])
        }
    else:
        print(f"warning: {baseline_path} not found; 'inference avoided' will be 0", file=sys.stderr)

    settings_kwargs = {"redis_url": args.redis, "distance_threshold": thresholds[0]}
    store = RedisCache(redis_lib.Redis.from_url(args.redis, decode_responses=True),
                       _proxy_settings(**settings_kwargs))

    # A faithful sweep starts from an empty cache: stale docs from other runs
    # would exact-hit the seeds and corrupt the baseline comparison.
    purged = store.purge_cache()
    store.reset_stats()
    _progress(f"purged {purged} cached docs; stats reset")

    population_items = [i for i in dataset["items"] if i["kind"] in ("seed", "distractor")]
    paraphrase_items = [i for i in dataset["items"] if i["kind"] == "paraphrase"]

    def paraphrase_doc_keys() -> list[str]:
        return [
            f"{store.prefix}:{semantic_doc_key(dataset['model'], i['prompt'])}"
            for i in paraphrase_items
        ]

    # Population pass: seed + distractor prompts populate a FIXED, known pool.
    # Runs once, through a proxy using the first (loosest) sweep radius; every
    # population prompt is a miss regardless of radius, so the radius is
    # irrelevant here.
    population_records: list[dict[str, Any]] = []
    with _proxy_server(args, thresholds[0]) as base_url:
        async with httpx.AsyncClient(base_url=base_url, timeout=args.timeout_s) as client:
            for i, item in enumerate(population_items, 1):
                body = build_body(dataset, item["prompt"])
                result = await _send_to_proxy(client, body)
                population_records.append({**item, **result, "topic": item["topic"]})
                _progress(f"populate {i}/{len(population_items)} {item['id']} -> {result['status']}")

    rows = []
    for threshold in thresholds:
        # Each sweep must taste the *configured* server threshold, so the
        # runner spawns a fresh proxy per radius (the threshold is process
        # config, not per-request state). Within a sweep, every paraphrase doc
        # key is removed immediately after testing it, so a hit can only come
        # from the fixed population pool — never from an earlier sweep or an
        # earlier paraphrase in the same sweep (that would be a cascade).
        store.reset_stats()
        with _proxy_server(args, threshold) as base_url:
            async with httpx.AsyncClient(base_url=base_url, timeout=args.timeout_s) as client:
                sweep_records = []
                for i, item in enumerate(paraphrase_items, 1):
                    body = build_body(dataset, item["prompt"])
                    result = await _send_to_proxy(client, body)
                    sweep_records.append({**item, **result})
                    # keep the pool fixed: drop the doc this request may have created
                    store.r.unlink(
                        f"{store.prefix}:{semantic_doc_key(dataset['model'], item['prompt'])}"
                    )
                    _progress(
                        f"sweep r={threshold} {i}/{len(paraphrase_items)} "
                        f"{item['id']} -> {result['status']}"
                    )
        R.write_json(
            out_dir / f"replay-{threshold}.json",
            {"threshold": threshold, "records": sweep_records},
        )
        rows.append(
            M.compute_sweep_row(threshold, population_records + sweep_records, baseline_by_id)
        )

    # Spot-checks: every distractor that got a cache hit, with the answer served.
    spot_checks = []
    for rec in population_records:
        if rec["kind"] == "distractor" and M.is_hit(rec):
            baseline = baseline_by_id.get(rec["id"], {})
            spot_checks.append(
                {
                    "threshold": "population",
                    "distractor_prompt": rec["prompt"],
                    "source_prompt": rec.get("source_prompt") or "?",
                    "served_answer": _answer_text(rec["response"]),
                    "expected_answer": _answer_text(baseline.get("response", {})),
                    "verdict": "false positive (off-topic answer served)",
                }
            )

    recommendation = R.recommend_threshold(rows)
    baseline_summary = _baseline_summary(baseline_by_id)
    dataset_info = {
        "path": dataset["path"],
        "model": dataset["model"],
        "n_paraphrases": dataset["n_paraphrases"],
        "n_distractors": dataset["n_distractors"],
        "proxy_url": f"spawned per sweep on localhost:{args.port}",
    }
    R.write_json(
        out_dir / "results.json",
        {"dataset": dataset_info, "rows": rows, "recommendation": recommendation["threshold"]},
    )
    (out_dir / "results.md").write_text(
        R.render_markdown(dataset_info, baseline_summary, rows, spot_checks, recommendation)
    )
    R.render_chart(rows, out_dir / "hit-vs-falsehit.png")
    print(f"\nresults written to {out_dir}/ "
          f"(results.md, results.json, hit-vs-falsehit.png)")
    for r in rows:
        print(f"  r={r['threshold']:<5} hit={r['paraphrase_hit_rate']:.1%} "
              f"fp={r['distractor_false_hit_rate']:.1%} "
              f"hit_p50={r['hit_latency_ms']['p50']}ms "
              f"avoided={r['est_inference_ms_avoided'] / 1000:.1f}s")
    if recommendation["row"]:
        print(f"recommended radius: {recommendation['threshold']} "
              f"({recommendation['criterion']})")
    return out_dir / "results.md"


def _baseline_summary(baseline_by_id: dict[str, dict]) -> dict[str, Any]:
    latencies = [float(r["latency_ms"]) for r in baseline_by_id.values()]
    summary = M.summarize_latencies(latencies)
    return {
        "n": len(latencies),
        **summary,
        "total_ms": round(sum(latencies), 1),
        "mean_ms": round(M.mean(latencies), 1),
        "p50_ms": summary["p50"],
        "p95_ms": summary["p95"],
    }


def _proxy_settings(redis_url: str, distance_threshold: float):
    from ..config import Settings

    return Settings(redis_url=redis_url, distance_threshold=distance_threshold)


def _parse_thresholds(raw: str) -> list[float]:
    return [float(x) for x in raw.split(",") if x.strip()]


def _progress(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


@contextmanager
def _proxy_server(args: argparse.Namespace, threshold: float):
    """Spawn a throwaway proxy with the sweep's radius configured.

    The semantic radius is process config (LLM_CACHE_DISTANCE_THRESHOLD), so a
    faithful sweep must run the server with each radius rather than reinterpreting
    results afterwards. Yields the base URL; tears the process down after.
    """
    env = dict(os.environ)
    env["LLM_CACHE_DISTANCE_THRESHOLD"] = repr(float(threshold))
    env["LLM_CACHE_REDIS_URL"] = args.redis
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "llm_cache.app:app",
         "--port", str(args.port), "--log-level", "warning"],
        env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        base_url = f"http://localhost:{args.port}"
        deadline = time.time() + 120
        while time.time() < deadline:
            try:
                resp = httpx.get(f"{base_url}/healthz", timeout=2.0)
                if resp.status_code == 200:
                    break
            except httpx.HTTPError:
                pass
            if proc.poll() is not None:
                raise RuntimeError("proxy process exited during startup")
            time.sleep(0.5)
        else:
            raise RuntimeError(f"proxy did not become healthy on port {args.port}")
        yield base_url
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:  # pragma: no cover
            proc.kill()


async def run_all(args: argparse.Namespace) -> None:
    await run_baseline(args)
    await run_replay(args)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="llm-cache.benchmark")
    sub = parser.add_subparsers(dest="command", required=True)

    def common(p: argparse.ArgumentParser) -> None:
        p.add_argument("--dataset", required=True, help="YAML dataset path")
        p.add_argument("--out", default="results", help="output directory")
        p.add_argument("--max-topics", type=int, default=None,
                       help="limit topics (smoke tests)")
        p.add_argument("--timeout-s", type=float, default=600.0)

    p_base = sub.add_parser("baseline", help="run every prompt directly to Ollama once")
    common(p_base)
    p_base.add_argument("--ollama", default="http://localhost:11434")
    p_base.set_defaults(func=run_baseline)

    p_replay = sub.add_parser("replay", help="replay rephrasings through the proxy at radii")
    common(p_replay)
    p_replay.add_argument("--redis", default="redis://localhost:6379/0")
    p_replay.add_argument("--port", type=int, default=8123,
                          help="port for the spawned per-sweep proxy")
    p_replay.add_argument("--thresholds", default=DEFAULT_THRESHOLDS,
                          help=f"comma-separated cosine radii (default {DEFAULT_THRESHOLDS})")
    p_replay.set_defaults(func=run_replay)

    p_all = sub.add_parser("all", help="baseline then replay")
    common(p_all)
    p_all.add_argument("--ollama", default="http://localhost:11434")
    p_all.add_argument("--redis", default="redis://localhost:6379/0")
    p_all.add_argument("--port", type=int, default=8123)
    p_all.add_argument("--thresholds", default=DEFAULT_THRESHOLDS)
    p_all.set_defaults(func=run_all)

    args = parser.parse_args(argv)
    asyncio.run(args.func(args))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
