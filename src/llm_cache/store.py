"""Redis-backed stats store with in-memory fallback.

Per docs/ui-plan.md U3:
- counters via INCR (stats:totals:<field>)
- events via LPUSH/LTRIM 100 (stats:events)

When Redis is unreachable (common in local dev without Docker),
an in-memory dict/list with the same semantics is used so the
dashboard and tests run standalone. The payload shape is identical.
"""
from __future__ import annotations

import json
import math
import time
from datetime import datetime, timezone
from typing import Any

try:
    import redis as _redis
except ImportError:  # pragma: no cover
    _redis = None  # type: ignore

MAX_EVENTS = 100

_COUNTER_FIELDS = (
    "requests",
    "exact_hits",
    "semantic_hits",
    "misses",
    "bypasses",
    "errors",
)

_STATUS_TO_COUNTER = {
    "exact-hit": "exact_hits",
    "semantic-hit": "semantic_hits",
    "miss": "misses",
    "bypass": "bypasses",
    "error": "errors",
}


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def percentile(sorted_vals: list[float], pct: float) -> float | None:
    if not sorted_vals:
        return None
    if len(sorted_vals) == 1:
        return float(sorted_vals[0])
    k = (len(sorted_vals) - 1) * (pct / 100)
    f = math.floor(k)
    c = math.ceil(k)
    if f == c:
        return float(sorted_vals[int(k)])
    d0 = sorted_vals[f] * (c - k)
    d1 = sorted_vals[c] * (k - f)
    return float(d0 + d1)


def compute_latency(events: list[dict[str, Any]]) -> dict[str, Any]:
    """Server-side percentiles over the event window (<=100)."""
    vals = sorted(
        float(e["latency_ms"]) for e in events if e.get("latency_ms") is not None
    )
    if not vals:
        return {"n": 0, "p50": None, "p90": None, "p95": None, "p99": None,
                "mean": None, "max": None}
    return {
        "n": len(vals),
        "p50": percentile(vals, 50),
        "p90": percentile(vals, 90),
        "p95": percentile(vals, 95),
        "p99": percentile(vals, 99),
        "mean": float(sum(vals) / len(vals)),
        "max": float(max(vals)),
    }


class StatsStore:
    """Thread-unsafe in-memory fallback is fine for PoC; Redis path is atomic."""

    def __init__(self, redis_client: Any = None, redis_url: str | None = None):
        self._redis = redis_client
        self._mem_counters: dict[str, int] = {f: 0 for f in _COUNTER_FIELDS}
        self._mem_events: list[dict[str, Any]] = []

        if self._redis is None and redis_url and _redis is not None:
            try:
                client = _redis.from_url(redis_url, decode_responses=True,
                                         socket_connect_timeout=1.0)
                client.ping()
                self._redis = client
            except Exception:
                self._redis = None  # fall back to memory; UI must still work

    @property
    def using_redis(self) -> bool:
        return self._redis is not None

    # -- writes -------------------------------------------------------
    def record_event(
        self,
        status: str,
        model: str,
        similarity: float | None = None,
        threshold: float | None = None,
        latency_ms: float | int | None = None,
        embed_ms: float | int | None = None,
        redis_ms: float | int | None = None,
        prompt_preview: str | None = None,
    ) -> dict[str, Any]:
        event: dict[str, Any] = {
            "ts": _utcnow_iso(),
            "status": status,
            "model": model,
            "similarity": similarity,
            "threshold": threshold,
            "latency_ms": latency_ms,
            "embed_ms": embed_ms,
            "redis_ms": redis_ms,
            "prompt_preview": (prompt_preview or "")[:80],
        }
        if self._redis is not None:
            try:
                self._redis.incr("stats:totals:requests")
                counter = _STATUS_TO_COUNTER.get(status)
                if counter:
                    self._redis.incr(f"stats:totals:{counter}")
                self._redis.lpush("stats:events", json.dumps(event))
                self._redis.ltrim("stats:events", 0, MAX_EVENTS - 1)
            except Exception:
                self._record_memory(status, event)
        else:
            self._record_memory(status, event)
        return event

    def _record_memory(self, status: str, event: dict[str, Any]) -> None:
        self._mem_counters["requests"] += 1
        counter = _STATUS_TO_COUNTER.get(status)
        if counter:
            self._mem_counters[counter] += 1
        self._mem_events.insert(0, event)
        self._mem_events = self._mem_events[:MAX_EVENTS]

    # -- reads --------------------------------------------------------
    def get_totals(self) -> dict[str, Any]:
        if self._redis is not None:
            try:
                totals = {}
                for f in _COUNTER_FIELDS:
                    v = self._redis.get(f"stats:totals:{f}")
                    totals[f] = int(v) if v is not None else 0
            except Exception:
                totals = dict(self._mem_counters)
        else:
            totals = dict(self._mem_counters)
        req = totals.get("requests", 0)
        hits = totals.get("exact_hits", 0) + totals.get("semantic_hits", 0)
        totals["cache_hit_rate"] = round(hits / req, 4) if req else None
        return totals

    def get_recent(self) -> list[dict[str, Any]]:
        if self._redis is not None:
            try:
                raw = self._redis.lrange("stats:events", 0, MAX_EVENTS - 1)
                return [json.loads(x) for x in raw]
            except Exception:
                return list(self._mem_events)
        return list(self._mem_events)

    # -- reset --------------------------------------------------------
    def reset(self) -> None:
        if self._redis is not None:
            try:
                for f in _COUNTER_FIELDS:
                    self._redis.delete(f"stats:totals:{f}")
                self._redis.delete("stats:events")
            except Exception:
                pass
        self._mem_counters = {f: 0 for f in _COUNTER_FIELDS}
        self._mem_events = []


def build_stats_payload(settings: Any, store: StatsStore, started_at: float) -> dict[str, Any]:
    """Contract per docs/ui-plan.md U3 (schema_version 1)."""
    recent = store.get_recent()
    totals = store.get_totals()
    latency = compute_latency(recent)
    uptime_s = max(0.0, time.time() - started_at) if started_at else 0.0
    return {
        "schema_version": 1,
        "generated_at": _utcnow_iso(),
        "service": {
            "name": settings.name,
            "version": settings.version,
            "uptime_s": round(uptime_s, 1),
            "model": settings.model,
            "embedder": settings.embedder,
            "distance_threshold": settings.distance_threshold,
            "ttl_s": settings.ttl_s,
        },
        "totals": totals,
        "latency_ms": latency,
        "recent": recent,
    }
