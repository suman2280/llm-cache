"""Contract tests for GET /stats + POST /stats/reset (UI plan U-1).

Uses in-memory StatsStore (no Redis required) + FastAPI TestClient.
"""
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from llm_cache.app import create_app
from llm_cache.config import Settings
from llm_cache.store import StatsStore


@pytest.fixture()
def store():
    return StatsStore()  # no redis_url -> in-memory


@pytest.fixture()
def client(store):
    app = create_app(Settings(), store)
    return TestClient(app)


def test_stats_contract_empty(client):
    r = client.get("/stats")
    assert r.status_code == 200, r.text
    p = r.json()
    assert p["schema_version"] == 1
    assert "generated_at" in p and "service" in p and "totals" in p and "latency_ms" in p and "recent" in p
    for f in ("name", "version", "uptime_s", "model", "embedder", "distance_threshold", "ttl_s"):
        assert f in p["service"]
    for f in ("requests", "exact_hits", "semantic_hits", "misses", "bypasses", "errors", "cache_hit_rate"):
        assert f in p["totals"]
    assert p["totals"]["requests"] == 0
    assert p["totals"]["cache_hit_rate"] is None
    assert p["latency_ms"]["n"] == 0
    assert p["recent"] == []


def test_record_then_stats(client, store):
    store.record_event("exact-hit", "llama3.2:3b", similarity=0.01, threshold=0.10,
                       latency_ms=9, embed_ms=2, redis_ms=1, prompt_preview="What is Redis?")
    store.record_event("semantic-hit", "llama3.2:3b", similarity=0.04, threshold=0.10,
                       latency_ms=12, embed_ms=3, redis_ms=1, prompt_preview="what is redis??")
    store.record_event("miss", "llama3.2:3b", similarity=None, threshold=0.10,
                       latency_ms=9800, embed_ms=21, redis_ms=2, prompt_preview="Explain TCP?")
    r = client.get("/stats")
    assert r.status_code == 200, r.text
    p = r.json()
    assert p["totals"]["requests"] == 3
    assert p["totals"]["exact_hits"] == 1
    assert p["totals"]["semantic_hits"] == 1
    assert p["totals"]["misses"] == 1
    assert p["totals"]["cache_hit_rate"] == round(2 / 3, 4)
    assert p["latency_ms"]["n"] == 3
    assert p["latency_ms"]["p50"] == 12.0  # median of [9, 12, 9800]
    assert len(p["recent"]) == 3
    # newest first: miss was recorded last
    assert p["recent"][0]["status"] == "miss"
    assert p["recent"][0]["similarity"] is None
    ev = p["recent"][1]
    assert ev["status"] == "semantic-hit"
    assert ev["threshold"] == 0.10


def test_reset_zeroes(client, store):
    store.record_event("miss", "llama3.2:3b", latency_ms=100)
    assert client.get("/stats").json()["totals"]["requests"] == 1
    r = client.post("/stats/reset")
    assert r.status_code == 200, r.text
    p = r.json()
    assert p["totals"]["requests"] == 0
    assert p["recent"] == []
    assert p["latency_ms"]["n"] == 0


def test_percentiles():
    from llm_cache.store import compute_latency
    events = [{"latency_ms": v} for v in [10, 20, 30, 40, 100]]
    lat = compute_latency(events)
    assert lat["n"] == 5
    assert lat["p50"] == 30.0
    assert lat["max"] == 100
    assert lat["mean"] == 40.0
    assert compute_latency([])["n"] == 0
    assert compute_latency([])["p50"] is None


def test_dashboard_static_served(client):
    r = client.get("/dashboard/")
    assert r.status_code == 200, r.text[:500]
    assert "llm-cache" in r.text


def test_healthz(client):
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"
