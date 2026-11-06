"""Redis-backed cache: exact tier + semantic tier in one index, plus stats.

Layout
------
- Vector index ``idx_llm_cache`` over hash keys ``sem:<digest>``
  (digest = sha256(model + normalized last-user-message)) with fields:
  ``req_hash`` TAG, ``model`` TAG, ``prompt`` TEXT, ``response`` TEXT,
  ``embedding`` VECTOR (FLAT / FLOAT32 / COSINE).
- One write path stores a doc per (model, normalized prompt); every stored doc
  participates in *both* tiers: exact lookups pre-filter on the ``req_hash``
  tag, semantic lookups range-query the embedding. (docs/plan.md §10)

Stats
-----
- Hash  ``stats:counters``  — HINCRBY counters.
- List  ``stats:events``    — LPUSH/LTRIM ring of the last N events (JSON).
Both are flushed by POST /stats/reset; the ring keeps percentiles honest by
being labelled "last N events" in the API and any UI (docs/ui-plan.md §3).
"""

from __future__ import annotations

import json
import logging
import time
from typing import Any

import redis

from .config import Settings, get_settings


class StoreError(RuntimeError):
    pass


_STARTED_AT = time.time()


def percentile(sorted_vals: list[float], p: float) -> float:
    """Linear-interpolation percentile (numpy 'linear' method)."""
    if not sorted_vals:
        return 0.0
    if len(sorted_vals) == 1:
        return float(sorted_vals[0])
    rank = (p / 100.0) * (len(sorted_vals) - 1)
    low = int(rank)
    high = min(low + 1, len(sorted_vals) - 1)
    frac = rank - low
    return float(sorted_vals[low] * (1 - frac) + sorted_vals[high] * frac)


def _round1(x: float) -> float:
    return round(float(x) + 0.0, 1)


_COUNTER_FIELDS = {
    "exact-hit": "exact_hits",
    "semantic-hit": "semantic_hits",
    "miss": "misses",
    "bypass": "bypasses",
    "error": "errors",
}


def _counter_field(status: str) -> str:
    """Map event status -> stats counter field name."""
    return _COUNTER_FIELDS.get(status, status)


class RedisCache:
    """Exact + semantic cache store, plus /stats counters and the event ring.

    Accepts either an explicit redis client or just settings: if Redis is
    unreachable the store degrades to an in-memory stats backend so the
    dashboard and tests still run without Docker (the cache itself simply
    passes everything through — a cache without Redis cannot work).
    """

    def __init__(
        self,
        client: redis.Redis | None = None,
        settings: Settings | None = None,
    ) -> None:
        settings = settings or get_settings()
        self.settings = settings
        self.prefix = settings.cache_prefix
        self.stats_prefix = settings.stats_prefix
        self._event_limit = settings.stats_event_limit
        self.index = settings.index_name
        self.memory_mode = False
        self._mem_counters: dict[str, int] = {
            "requests": 0,
            "exact_hits": 0,
            "semantic_hits": 0,
            "misses": 0,
            "bypasses": 0,
            "errors": 0,
        }
        self._mem_events: list[dict[str, Any]] = []

        if client is None:
            client = redis.Redis.from_url(settings.redis_url, decode_responses=True)
            try:
                client.ping()
            except redis.RedisError:
                logging.getLogger("llm_cache").warning(
                    "Redis unreachable at %s; stats fall back to memory and the "
                    "cache passes requests through", settings.redis_url
                )
                self.memory_mode = True
        self.r = client

    # ------------------------------------------------- fallback stats helpers

    def _mem_record(self, status: str, event: dict[str, Any]) -> None:
        self._mem_counters["requests"] += 1
        self._mem_counters[_counter_field(status)] += 1
        self._mem_events.insert(0, event)
        del self._mem_events[self._event_limit:]

    def _mem_get(self) -> dict[str, Any]:
        counters = dict(self._mem_counters)
        events = list(self._mem_events)
        return counters, events

    # ------------------------------------------------------------------ index

    def _index_exists(self) -> bool:
        try:
            names = self.r.execute_command("FT._LIST")
        except redis.ResponseError:
            return False
        return self.index in [n if isinstance(n, str) else n.decode() for n in names]

    def ensure_index(self, dim: int, drop: bool = False) -> None:
        """Create the FT index if absent (idempotent)."""
        if self.memory_mode:
            return
        if drop:
            try:
                self.r.execute_command("FT.DROPINDEX", self.index)
            except redis.ResponseError:
                pass  # did not exist
        elif self._index_exists():
            return
        self.r.execute_command(
            "FT.CREATE", self.index, "ON", "HASH", "PREFIX", "1", f"{self.prefix}:",
            "SCHEMA",
            "req_hash", "TAG",
            "mtag", "TAG",
            "tclass", "TAG",
            "model", "TAG",
            "prompt", "TEXT",
            "embedding", "VECTOR", "FLAT", "6",
            "TYPE", "FLOAT32", "DIM", str(dim), "DISTANCE_METRIC", "COSINE",
        )

    # ------------------------------------------------------------- cache tiers

    # Redis 8.10 query syntax notes (verified against redis:8.10.3):
    # - `{}`-params are NOT accepted inside TAG terms → inline escaped values
    # - VECTOR_RANGE wants a *literal* radius + DIALECT 2 (params unsupported
    #   inside the range brackets)
    # - the query vector itself is still passed as a binary PARAM
    def lookup_exact(self, req_hash: str) -> str | None:
        """Tag pre-filter lookup; returns the stored response JSON or None."""
        if self.memory_mode:
            return None
        res = self.r.execute_command(
            "FT.SEARCH", self.index,
            f"@req_hash:{{{_escape_tag(req_hash)}}}",
            "LIMIT", "0", "1",
            "RETURN", "2", "response", "req_hash",
        )
        docs = _parse_docs(res)
        if not docs:
            return None
        return docs[0].get("response")

    def lookup_similar(
        self,
        vec_bytes: bytes,
        radius: float,
        mtag: str | None = None,
        tclass: str | None = None,
    ) -> dict | None:
        """VECTOR_RANGE lookup within ``radius`` (COSINE distance). Nearest wins.

        Hard pre-filters (never crossed by semantic reuse):
        ``mtag``   — same model
        ``tclass`` — same temperature class (docs/plan.md §7; serving a
                    deterministic answer for a sampled request would be wrong)

        Returns {"response": str, "similarity": float, "prompt": str} or None.
        """
        if self.memory_mode:
            return None
        filters = ""
        if mtag:
            filters += f" @mtag:{{{_escape_tag(mtag)}}}"
        if tclass:
            filters += f" @tclass:{{{_escape_tag(tclass)}}}"
        query = (
            f"{filters} @embedding:[VECTOR_RANGE {float(radius)!r} $v]"
            f"=>{{$YIELD_DISTANCE_AS: dist}}"
        )
        res = self.r.execute_command(
            "FT.SEARCH", self.index,
            query,
            "PARAMS", "2", "v", vec_bytes,
            "SORTBY", "dist", "ASC",
            "LIMIT", "0", "1",
            "RETURN", "4", "response", "prompt", "dist", "req_hash",
            "DIALECT", "2",
        )
        docs = _parse_docs(res)
        if not docs:
            return None
        doc = docs[0]
        try:
            similarity = float(doc["dist"])
        except (KeyError, TypeError, ValueError):
            similarity = float("nan")
        doc["similarity"] = similarity
        return doc

    def store(
        self,
        doc_key: str,
        req_hash: str,
        model: str,
        prompt: str,
        response_json: str,
        vec_bytes: bytes,
        mtag: str | None = None,
        tclass: str | None = None,
    ) -> None:
        if self.memory_mode:
            return
        mapping = {
            "req_hash": req_hash,
            "model": model,
            "prompt": prompt,
            "response": response_json,
            "embedding": vec_bytes,
            "created_at": str(time.time()),
        }
        if mtag is not None:
            mapping["mtag"] = mtag
        if tclass is not None:
            mapping["tclass"] = tclass
        pipe = self.r.pipeline(transaction=False)
        pipe.hset(f"{self.prefix}:{doc_key}", mapping=mapping)
        pipe.expire(f"{self.prefix}:{doc_key}", self.settings.ttl_s)
        pipe.execute()

    def purge_cache(self) -> int:
        """Delete every cache document (used by the benchmark between sweeps)."""
        if self.memory_mode:
            return 0
        deleted = 0
        for key in self.r.scan_iter(match=f"{self.prefix}:*", count=500):
            self.r.unlink(key)
            deleted += 1
        return deleted

    # ------------------------------------------------------------------- stats

    def record_event(
        self,
        status: str,
        latency_ms: float,
        model: str | None = None,
        similarity: float | None = None,
        threshold: float | None = None,
        embed_ms: float | None = None,
        redis_ms: float | None = None,
        prompt_preview: str | None = None,
        reason: str | None = None,
    ) -> None:
        event = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "status": status,
            "model": model,
            "similarity": None if similarity is None else round(float(similarity), 6),
            "threshold": threshold,
            "latency_ms": round(float(latency_ms), 1),
            "embed_ms": None if embed_ms is None else round(float(embed_ms), 1),
            "redis_ms": None if redis_ms is None else round(float(redis_ms), 1),
            "prompt_preview": (prompt_preview or "")[:80],
            "reason": reason,
        }
        counters_key = f"{self.stats_prefix}:counters"
        events_key = f"{self.stats_prefix}:events"
        if self.memory_mode:
            self._mem_record(status, event)
            return
        pipe = self.r.pipeline(transaction=False)
        pipe.hincrby(counters_key, "requests", 1)
        pipe.hincrby(counters_key, _counter_field(status), 1)
        pipe.lpush(events_key, json.dumps(event, separators=(",", ":")))
        pipe.ltrim(events_key, 0, self._event_limit - 1)
        pipe.execute()

    def get_stats(self) -> dict[str, Any]:
        if self.memory_mode:
            counters, events = self._mem_get()
            counters = {k: str(v) for k, v in counters.items()}
            raw = [json.dumps(e, separators=(",", ":")) for e in events]
        else:
            counters = self.r.hgetall(f"{self.stats_prefix}:counters") or {}
            raw = self.r.lrange(f"{self.stats_prefix}:events", 0, self._event_limit - 1)
        events = [json.loads(item) for item in raw]
        latencies = sorted(float(e["latency_ms"]) for e in events if e.get("latency_ms") is not None)

        requests = int(counters.get("requests", 0))
        exact = int(counters.get("exact_hits", 0))
        semantic = int(counters.get("semantic_hits", 0))
        hit_rate = round((exact + semantic) / requests, 4) if requests else None

        s = self.settings
        return {
            "schema_version": 1,
            "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "service": {
                "name": s.name,
                "version": s.version,
                "uptime_s": round(time.time() - _STARTED_AT, 1),
                "model": s.model,
                "embedder": s.embedding_model,
                "distance_threshold": s.distance_threshold,
                "ttl_s": s.ttl_s,
            },
            "totals": {
                "requests": requests,
                "exact_hits": exact,
                "semantic_hits": semantic,
                "misses": int(counters.get("misses", 0)),
                "bypasses": int(counters.get("bypasses", 0)),
                "errors": int(counters.get("errors", 0)),
                "cache_hit_rate": hit_rate,
            },
            "latency_ms": {
                "n": len(latencies),
                "p50": _round1(percentile(latencies, 50)),
                "p90": _round1(percentile(latencies, 90)),
                "p95": _round1(percentile(latencies, 95)),
                "p99": _round1(percentile(latencies, 99)),
                "mean": _round1(sum(latencies) / len(latencies)) if latencies else 0.0,
                "max": _round1(latencies[-1]) if latencies else 0.0,
            },
            "recent": events,
        }

    def reset_stats(self) -> dict[str, Any]:
        if self.memory_mode:
            self._mem_counters = {k: 0 for k in self._mem_counters}
            self._mem_events = []
            return self.get_stats()
        self.r.delete(f"{self.stats_prefix}:counters")
        self.r.delete(f"{self.stats_prefix}:events")
        return self.get_stats()

    # UI-plan compatibility aliases (docs/ui-plan.md §3, tests/test_stats.py)
    def reset(self) -> dict[str, Any]:
        return self.reset_stats()


_TAG_SPECIAL = set(",.<>{}[]\"':;!@#$%^&()-=~| \\")


def _escape_tag(value: str) -> str:
    """Backslash-escape Redis query syntax chars inside a tag term."""
    return "".join(f"\\{c}" if c in _TAG_SPECIAL else c for c in value)


def _parse_docs(res: Any) -> list[dict]:
    """Parse FT.SEARCH replies.

    redis-py ≥5 registers a response callback for FT.SEARCH and returns a
    dict (``{"total_results": n, "results": [{"id", "extra_attributes"|"values"}]}``);
    raw RESP2 clients return ``[total, docId, [field, value, ...], ...]``.
    """
    if not res:
        return []

    docs: list[dict] = []

    # redis-py parsed shape
    if isinstance(res, dict):
        for r in res.get("results", []):
            fields = r.get("extra_attributes") or {}
            if not fields and isinstance(r.get("values"), (list, tuple)):
                values = r["values"]
                fields = {
                    (values[j] if not isinstance(values[j], bytes) else values[j].decode()):
                    (values[j + 1] if not isinstance(values[j + 1], bytes)
                     else values[j + 1].decode())
                    for j in range(0, len(values) - 1, 2)
                }
            doc = {}
            for k, v in fields.items():
                if isinstance(k, bytes):
                    k = k.decode()
                if isinstance(v, bytes):
                    v = v.decode()
                doc[k] = v
            docs.append(doc)
        return docs

    # raw RESP2 array shape
    if isinstance(res, (list, tuple)) and len(res) >= 2:
        i = 2
        while i < len(res):
            fields = res[i + 1] if i + 1 < len(res) else []
            if isinstance(fields, (list, tuple)):
                doc = {}
                for j in range(0, len(fields) - 1, 2):
                    k = fields[j]
                    v = fields[j + 1]
                    if isinstance(k, bytes):
                        k = k.decode()
                    if isinstance(v, bytes):
                        v = v.decode()
                    doc[k] = v
                docs.append(doc)
            i += 2
    return docs


# ---------------------------------------------------------------------------
# UI-plan compatibility surface (docs/ui-plan.md). The dashboard UI commit
# introduced StatsStore/build_stats_payload; the merged store keeps those names
# as aliases so both routes.py generations and tests/test_stats.py keep working.
StatsStore = RedisCache


def build_stats_payload(settings=None, store=None, started_at: float = 0.0) -> dict:
    """/stats payload builder (uptime is measured from module import)."""
    if store is None:
        store = RedisCache(settings=settings)
    return store.get_stats()


def compute_latency(events: list[dict]) -> dict[str, Any]:
    """Server-side percentiles over the event window (docs/ui-plan.md §3).

    Mirrors the values RedisCache.get_stats() reports under ``latency_ms``.
    """
    vals = sorted(float(e["latency_ms"]) for e in events if e.get("latency_ms") is not None)
    if not vals:
        return {"n": 0, "p50": None, "p90": None, "p95": None, "p99": None,
                "mean": None, "max": None}
    return {
        "n": len(vals),
        "p50": percentile(vals, 50),
        "p90": percentile(vals, 90),
        "p95": percentile(vals, 95),
        "p99": percentile(vals, 99),
        "mean": sum(vals) / len(vals),
        "max": vals[-1],
    }
