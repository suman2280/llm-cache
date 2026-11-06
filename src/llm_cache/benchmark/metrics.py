"""Pure metric helpers for the benchmark (unit-testable, no I/O)."""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from typing import Any

from ..store import percentile

HIT_STATUSES = ("exact-hit", "semantic-hit")


def mean(vals: Sequence[float]) -> float:
    return sum(vals) / len(vals) if vals else 0.0


def rate(part: int, whole: int) -> float:
    return round(part / whole, 4) if whole else 0.0


def summarize_latencies(vals: Sequence[float]) -> dict[str, float]:
    if not vals:
        return {"n": 0, "p50": 0.0, "p90": 0.0, "p95": 0.0, "p99": 0.0, "mean": 0.0, "max": 0.0}
    s = sorted(vals)
    return {
        "n": len(s),
        "p50": round(percentile(s, 50), 1),
        "p90": round(percentile(s, 90), 1),
        "p95": round(percentile(s, 95), 1),
        "p99": round(percentile(s, 99), 1),
        "mean": round(mean(s), 1),
        "max": round(s[-1], 1),
    }


def is_hit(rec: dict) -> bool:
    return rec.get("status") in HIT_STATUSES


def hits_of_kind(records: Iterable[dict], kind: str) -> list[dict]:
    return [r for r in records if r.get("kind") == kind and is_hit(r)]


def kind_records(records: Iterable[dict], kind: str) -> list[dict]:
    return [r for r in records if r.get("kind") == kind]


def compute_sweep_row(
    threshold: float,
    records: list[dict],
    baseline_by_id: dict[str, dict],
) -> dict[str, Any]:
    """Aggregate one replay run at one distance threshold.

    ``records``: per-request results with keys id, kind, status, latency_ms,
    similarity. ``baseline_by_id``: id -> baseline record (latency_ms) used to
    estimate avoided inference time.
    """
    paraphrases = kind_records(records, "paraphrase")
    distractors = kind_records(records, "distractor")
    seeds = kind_records(records, "seed")

    para_hits = hits_of_kind(records, "paraphrase")
    dist_hits = hits_of_kind(records, "distractor")

    hit_latencies = [float(r["latency_ms"]) for r in records if is_hit(r)]
    miss_latencies = [float(r["latency_ms"]) for r in records if r.get("status") == "miss"]

    avoided_ms = 0.0
    for r in para_hits + dist_hits:
        base = baseline_by_id.get(r["id"])
        if base:
            avoided_ms += float(base.get("latency_ms", 0.0))

    return {
        "threshold": threshold,
        "paraphrase_hits": len(para_hits),
        "paraphrase_total": len(paraphrases),
        "paraphrase_hit_rate": rate(len(para_hits), len(paraphrases)),
        "distractor_hits": len(dist_hits),
        "distractor_total": len(distractors),
        "distractor_false_hit_rate": rate(len(dist_hits), len(distractors)),
        "seed_misses": sum(1 for r in seeds if r.get("status") == "miss"),
        "seed_total": len(seeds),
        "cache_hits": len(para_hits) + len(dist_hits),
        "hit_latency_ms": summarize_latencies(hit_latencies),
        "miss_latency_ms": summarize_latencies(miss_latencies),
        "est_inference_ms_avoided": round(avoided_ms, 1),
        "wall_ms": round(sum(float(r["latency_ms"]) for r in records), 1),
    }
