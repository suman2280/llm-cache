"""Shared fixtures: in-memory fakes so unit tests need no Redis/Ollama/model."""

from __future__ import annotations

import hashlib
from collections import defaultdict
from typing import Any

import numpy as np
import pytest
from fastapi.testclient import TestClient

from llm_cache.app import create_app
from llm_cache.config import Settings
from llm_cache.store import percentile

# --------------------------------------------------------------------- fakes

class FakeEmbedder:
    """Deterministic embedder: one-hot vectors bucketed by prompt hash.

    ``buckets`` maps a normalized prompt -> bucket id (0..383). Unknown prompts
    hash into a pseudo-random bucket, so distinct prompts are "far" apart
    (cosine distance 1.0) and same-bucket prompts are identical.
    """

    dim = 384

    def __init__(self, buckets: dict[str, int] | None = None) -> None:
        self.buckets = {k.strip().lower(): v for k, v in (buckets or {}).items()}

    def _bucket(self, text: str) -> int:
        key = text.strip().lower()
        if key in self.buckets:
            return self.buckets[key] % self.dim
        digest = hashlib.sha256(key.encode()).hexdigest()
        return int(digest[:8], 16) % self.dim

    def embed(self, text: str) -> np.ndarray:
        vec = np.zeros(self.dim, dtype=np.float32)
        vec[self._bucket(text)] = 1.0
        return vec

    def embed_many(self, texts: list[str]) -> np.ndarray:
        return np.stack([self.embed(t) for t in texts])

    @staticmethod
    def to_bytes(vec: np.ndarray) -> bytes:
        return np.asarray(vec, dtype=np.float32).tobytes()


class FakeOllama:
    """Echoes a deterministic answer; records every call."""

    def __init__(self, fail: bool = False) -> None:
        self.calls: list[dict] = []
        self.fail = fail

    async def chat_completions(self, body: dict[str, Any]) -> dict[str, Any]:
        self.calls.append(body)
        if not isinstance(body.get("messages"), list):
            from llm_cache.ollama import OllamaError

            raise OllamaError("messages must be a list", status=400)
        if self.fail:
            from llm_cache.ollama import OllamaError

            raise OllamaError("Ollama down", status=502)
        user = next(
            (m["content"] for m in reversed(body["messages"]) if m["role"] == "user"), ""
        )
        return {
            "id": "chatcmpl-fake",
            "object": "chat.completion",
            "model": body.get("model", "?"),
            "choices": [
                {"index": 0, "message": {"role": "assistant", "content": f"ANS[{user}]"},
                 "finish_reason": "stop"}
            ],
            "usage": {"prompt_tokens": 7, "completion_tokens": 9, "total_tokens": 16},
        }

    async def models(self) -> dict[str, Any]:
        self.calls.append({"models": True})
        return {"object": "list", "data": [{"id": "llama3.2:3b"}]}

    async def get(self, path: str):
        raise AssertionError(f"unexpected GET {path}")

    async def reachable(self) -> bool:
        return not self.fail

    async def close(self) -> None:
        pass


class FakeCache:
    """Minimal in-memory twin of RedisCache (same method signatures)."""

    def __init__(self, distance_threshold: float = 0.20) -> None:
        self.docs: dict[str, dict[str, Any]] = {}
        self.events: list[dict[str, Any]] = []
        self.counters: dict[str, int] = defaultdict(int)
        self.distance_threshold = distance_threshold
        self.prefix = "sem"
        self.stored = 0
        self.r = _FakeRedisClient()

    def ensure_index(self, dim: int, drop: bool = False) -> None:
        pass

    def lookup_exact(self, req_hash: str) -> str | None:
        for doc in self.docs.values():
            if doc["req_hash"] == req_hash:
                return doc["response"]
        return None

    def lookup_similar(
        self,
        vec_bytes: bytes,
        radius: float,
        mtag: str | None = None,
        tclass: str | None = None,
    ) -> dict | None:
        q = np.frombuffer(vec_bytes, dtype=np.float32)
        best = None
        best_dist = float("inf")
        for doc in self.docs.values():
            if mtag is not None and doc.get("mtag") != mtag:
                continue
            if tclass is not None and doc.get("tclass") != tclass:
                continue
            v = np.frombuffer(doc["embedding"], dtype=np.float32)
            dist = 1.0 - float(np.dot(q, v))
            if dist < best_dist:
                best, best_dist = doc, dist
        if best is not None and best_dist <= radius:
            return {
                "response": best["response"],
                "prompt": best["prompt"],
                "similarity": best_dist,
            }
        return None

    def store(
        self,
        doc_key,
        req_hash,
        model,
        prompt,
        response_json,
        vec_bytes,
        mtag=None,
        tclass=None,
    ) -> None:
        self.docs[doc_key] = {
            "req_hash": req_hash,
            "model": model,
            "prompt": prompt,
            "response": response_json,
            "embedding": vec_bytes,
            "mtag": mtag,
            "tclass": tclass,
        }
        self.stored += 1

    def record_event(self, status: str, latency_ms: float, **kw: Any) -> None:
        from llm_cache.store import _counter_field

        self.counters["requests"] += 1
        self.counters[_counter_field(status)] += 1
        self.events.append(
            {"status": status, "latency_ms": round(float(latency_ms), 1), **kw}
        )

    def get_stats(self) -> dict[str, Any]:
        latencies = sorted(float(e["latency_ms"]) for e in self.events)
        requests = self.counters.get("requests", 0)
        exact = self.counters.get("exact_hits", 0)
        semantic = self.counters.get("semantic_hits", 0)
        return {
            "schema_version": 1,
            "generated_at": "2026-11-06T00:00:00Z",
            "service": {
                "name": "llm-cache",
                "version": "0.1.0",
                "uptime_s": 1.0,
                "ollama_base_url": "http://localhost:11434",
                "embedder": "sentence-transformers/all-MiniLM-L6-v2",
                "distance_threshold": self.distance_threshold,
                "ttl_s": 86400,
            },
            "totals": {
                "requests": requests,
                "exact_hits": exact,
                "semantic_hits": semantic,
                "misses": self.counters.get("misses", 0),
                "bypasses": self.counters.get("bypasses", 0),
                "errors": self.counters.get("errors", 0),
                "cache_hit_rate": round((exact + semantic) / requests, 4) if requests else None,
            },
            "latency_ms": {
                "n": len(latencies),
                "p50": round(percentile(latencies, 50), 1) if latencies else 0.0,
                "p95": round(percentile(latencies, 95), 1) if latencies else 0.0,
            },
            "recent": self.events[-100:],
        }

    def reset_stats(self) -> dict[str, Any]:
        self.events.clear()
        self.counters = defaultdict(int)
        return self.get_stats()

    def purge_cache(self) -> int:
        n = len(self.docs)
        self.docs.clear()
        return n


class _FakeRedisClient:
    def ping(self) -> bool:
        return True


# ------------------------------------------------------------------ fixtures

def make_settings(**kw: Any) -> Settings:
    base = {"distance_threshold": 0.10}
    base.update(kw)
    return Settings(**base)


@pytest.fixture
def settings() -> Settings:
    return make_settings()


@pytest.fixture
def embedder() -> FakeEmbedder:
    return FakeEmbedder()


@pytest.fixture
def ollama() -> FakeOllama:
    return FakeOllama()


@pytest.fixture
def cache() -> FakeCache:
    return FakeCache()


@pytest.fixture
def client(settings: Settings, embedder: FakeEmbedder, ollama: FakeOllama, cache: FakeCache):
    app = create_app(settings=settings, store=cache, embedder=embedder, ollama=ollama)
    with TestClient(app) as c:
        yield c


def chat_body(prompt: str, **kw: Any) -> dict[str, Any]:
    body = {"model": "llama3.2:3b", "messages": [{"role": "user", "content": prompt}]}
    body.update(kw)
    return body
