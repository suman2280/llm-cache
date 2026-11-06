"""Renders benchmark results as JSON + Markdown + a hit-rate/false-hit chart."""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

SUCCESS_HIT_RATE = 0.80
SUCCESS_FP_RATE = 0.01


def recommend_threshold(rows: list[dict]) -> dict[str, Any]:
    """Tightest radius meeting the success bar, else the best tradeoff.

    Success bar (docs/plan.md §15 Phase 4): >= 80% rephrase hit rate with
    <= 1% distractor false-hit rate. Among passing radii the *tightest* is
    recommended: it is the closest to provably-distinct answers and keeps the
    maximum margin from false positives. Falls back to maximizing
    hit_rate - false_hit_rate.
    """
    passing = [
        r for r in rows
        if r["paraphrase_hit_rate"] >= SUCCESS_HIT_RATE
        and r["distractor_false_hit_rate"] <= SUCCESS_FP_RATE
    ]
    if passing:
        best = min(passing, key=lambda r: r["threshold"])
        return {"threshold": best["threshold"], "criterion": "success_bar", "row": best}
    if rows:
        best = max(rows, key=lambda r: (r["paraphrase_hit_rate"] - r["distractor_false_hit_rate"]))
        return {"threshold": best["threshold"], "criterion": "best_tradeoff", "row": best}
    return {"threshold": None, "criterion": "no_data", "row": None}


def _md_table(headers: list[str], rows: list[list[Any]]) -> str:
    lines = ["| " + " | ".join(headers) + " |", "|" + "|".join(["---"] * len(headers)) + "|"]
    for row in rows:
        lines.append("| " + " | ".join(str(c) for c in row) + " |")
    return "\n".join(lines)


def render_markdown(
    dataset: dict,
    baseline_summary: dict,
    rows: list[dict],
    spot_checks: list[dict],
    recommendation: dict,
) -> str:
    now = time.strftime("%Y-%m-%d %H:%M:%S")
    out = [
        "# llm-cache benchmark results",
        "",
        f"- generated: {now}",
        (f"- dataset: {dataset['path']} ({dataset['n_paraphrases']} rephrasings, "
        f"{dataset['n_distractors']} distractors)"),
        f"- model: `{dataset['model']}` via Ollama, proxy: {dataset['proxy_url']}",
        "",
        "## Baseline — every prompt sent directly to Ollama",
        "",
        _md_table(
            ["metric", "value"],
            [
                ["prompts", baseline_summary["n"]],
                ["mean latency (ms)", baseline_summary["mean_ms"]],
                ["p50 / p95 (ms)", f"{baseline_summary['p50_ms']} / {baseline_summary['p95_ms']}"],
                ["total inference time (s)", round(baseline_summary["total_ms"] / 1000, 1)],
            ],
        ),
        "",
        "## Threshold sweep — replay through the proxy (fresh cache per threshold)",
        "",
        ("Cosine distance radius; lower = stricter semantic matching. "
        "Any distractor hit at a radius is a **false positive**."),
        "",
        _md_table(
            [
                "radius",
                "rephrase hit rate",
                "distractor false-hit rate",
                "hit p50 (ms)",
                "hit p95 (ms)",
                "miss mean (ms)",
                "inference avoided (s)",
            ],
            [
                [
                    r["threshold"],
                    f"{r['paraphrase_hit_rate']:.1%} ({r['paraphrase_hits']}/{r['paraphrase_total']})",
                    f"{r['distractor_false_hit_rate']:.1%} ({r['distractor_hits']}/{r['distractor_total']})",
                    r["hit_latency_ms"]["p50"],
                    r["hit_latency_ms"]["p95"],
                    r["miss_latency_ms"]["mean"],
                    round(r["est_inference_ms_avoided"] / 1000, 1),
                ]
                for r in rows
            ],
        ),
        "",
        "## Recommendation",
        "",
    ]
    if recommendation["row"]:
        r = recommendation["row"]
        out += [
            (f"**radius {recommendation['threshold']}** "
            f"({recommendation['criterion']}): "
            f"{r['paraphrase_hit_rate']:.1%} rephrase hits, "
            f"{r['distractor_false_hit_rate']:.1%} false hits, "
            f"hit p50 {r['hit_latency_ms']['p50']} ms, "
            f"≈{r['est_inference_ms_avoided'] / 1000:.1f}s inference avoided."),
        ]
    else:
        out.append("_No sweep data._")
    out += ["", "## False-positive spot-checks (distractors served from cache)", ""]
    if spot_checks:
        out.append(
            _md_table(
                ["radius", "distractor", "answer served came from", "verdict"],
                [
                    [
                        s["threshold"],
                        f"{s['distractor_prompt']}",
                        f"→ cached answer for “{s['source_prompt']}”",
                        s["verdict"],
                    ]
                    for s in spot_checks[:10]
                ],
            )
        )
        out += [
            "",
            ("A `false positive` here means the question was *not* in the cache topic set, "
            "yet a cached answer for a different question was served. The verdict column "
            "is a human judgement of whether the served answer was still acceptable."),
        ]
    else:
        out.append("_No distractor hits at any radius — the cache never answered off-topic._")
    out += [
        "",
        "## Method",
        "",
        ("1. **Baseline**: every prompt is sent directly to Ollama exactly once; "
        "per-prompt latency is recorded to `baseline.json`."),
        ("2. **Population pass** (per run): the topic seeds and distractors are sent "
        "through the proxy once to populate the cache with *known* entries."),
        ("3. **Sweep**: for each cosine radius the runner spawns a fresh proxy with that "
        "radius as its configured `LLM_CACHE_DISTANCE_THRESHOLD` (the radius is process "
        "config, not per-request state) and replays the rephrasings. Each rephrase's "
        "cache document is removed right after its request, so hits can only come from "
        "the fixed population pool — no sweep-to-sweep or intra-sweep cascades."),
        ("4. **Inference avoided** sums the baseline latency of each prompt that was "
        "served from cache."),
        "",
    ]
    return "\n".join(out)


def render_chart(rows: list[dict], out_path: Path) -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    thresholds = [r["threshold"] for r in rows]
    hit_rates = [r["paraphrase_hit_rate"] * 100 for r in rows]
    fp_rates = [r["distractor_false_hit_rate"] * 100 for r in rows]

    fig, ax = plt.subplots(figsize=(7, 4))
    ax.plot(thresholds, hit_rates, marker="o", label="rephrase hit rate")
    ax.plot(thresholds, fp_rates, marker="x", color="crimson", label="distractor false-hit rate")
    ax.set_xlabel("cosine distance radius (stricter ← → looser)")
    ax.set_ylabel("% of prompts")
    ax.set_title("llm-cache: semantic hit rate vs. false positives")
    ax.set_ylim(-2, 105)
    ax.grid(alpha=0.3)
    ax.legend(loc="center right")
    fig.tight_layout()
    fig.savefig(out_path, dpi=140)
    plt.close(fig)


def write_json(path: Path, payload: dict) -> None:
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False))
