"""Live integration tests — skipped unless services are reachable.

Run with:  LLM_CACHE_TEST_REDIS_URL=redis://localhost:6379/1 \
           LLM_CACHE_TEST_OLLAMA_URL=http://localhost:11434 \
           uv run pytest tests/integration
"""

from __future__ import annotations

import os

import pytest

REDIS_URL = os.environ.get("LLM_CACHE_TEST_REDIS_URL")
OLLAMA_URL = os.environ.get("LLM_CACHE_TEST_OLLAMA_URL")

pytestmark = pytest.mark.skipif(not REDIS_URL, reason="LLM_CACHE_TEST_REDIS_URL not set")

live = pytest.mark.skipif(not (REDIS_URL and OLLAMA_URL), reason="needs Redis + Ollama")


@pytest.fixture(scope="module")
def store():
    import redis as redis_lib

    from llm_cache.config import Settings
    from llm_cache.store import RedisCache

    # NOTE: Redis Search (FT.*) requires DB 0 — "Cannot create index on
    # db != 0". So tests share DB 0 with everything else but use their own
    # key prefixes / index name to avoid touching the app's data.
    settings = Settings(
        redis_url=REDIS_URL,
        cache_prefix="semtest",
        stats_prefix="statstest",
        index_name="idx_llm_cache_test",
    )
    return RedisCache(redis_lib.Redis.from_url(REDIS_URL, decode_responses=True), settings)


def test_index_creation_and_purge(store):
    store.ensure_index(dim=384, drop=True)
    store.purge_cache()
    store.reset_stats()
    stats = store.get_stats()
    assert stats["totals"]["requests"] == 0
    assert stats["schema_version"] == 2


def test_record_event_and_stats(store):
    store.reset_stats()
    store.record_event("miss", 5000.0, model="llama3.2:3b", prompt="What is Redis?",
                       response="Redis is an in-memory data store.")
    store.record_event("semantic-hit", 15.0, model="llama3.2:3b", similarity=0.03,
                       prompt="what is redis??", response="Redis is an in-memory data store.")
    store.record_event("bypass", 3000.0, model="llama3.2:3b", reason="tools",
                       prompt="tool request", response=None)
    stats = store.get_stats()
    assert stats["totals"]["requests"] == 3
    assert stats["totals"]["misses"] == 1
    assert stats["totals"]["semantic_hits"] == 1
    assert stats["totals"]["bypasses"] == 1
    assert stats["totals"]["cache_hit_rate"] == round(1 / 3, 4)
    assert stats["latency_ms"]["n"] == 3
    assert len(stats["recent"]) == 3
    # contract v2: monotonic ids + full text; bypass carries no response
    ids = [e["id"] for e in stats["recent"]]
    assert ids == sorted(ids, reverse=True)
    assert all(isinstance(i, int) and i > 0 for i in ids)
    assert stats["recent"][0]["reason"] == "tools"
    assert stats["recent"][0]["response"] is None
    # ids survive reset_stats() (dashboard reconciliation invariant)
    store.reset_stats()
    store.record_event("miss", 10.0, model="llama3.2:3b", prompt="after reset")
    assert store.get_stats()["recent"][0]["id"] > max(ids)
    store.reset_stats()


@live
def test_store_roundtrip_with_real_vectors(store):

    from llm_cache.embedder import Embedder

    store.purge_cache()
    embedder = Embedder("sentence-transformers/all-MiniLM-L6-v2")
    prompt = "What is Redis?"
    vec = embedder.embed(prompt)
    store.store("test-doc", "hash1", "llama3.2:3b", prompt,
                '{"choices": []}', embedder.to_bytes(vec))

    assert store.lookup_exact("hash1") == '{"choices": []}'
    hit = store.lookup_similar(embedder.to_bytes(embedder.embed("What's Redis?")), radius=0.5)
    assert hit is not None and hit["similarity"] <= 0.5
    far = store.lookup_similar(
        embedder.to_bytes(embedder.embed("What is the boiling point of water?")), radius=0.05
    )
    assert far is None
    store.purge_cache()
