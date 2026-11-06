"""routes.py: end-to-end request flow with fake components."""



from tests.conftest import FakeEmbedder, FakeOllama, chat_body


def test_miss_then_exact_hit(client):
    r1 = client.post("/v1/chat/completions", json=chat_body("What is Redis?"))
    assert r1.status_code == 200
    assert r1.headers["x-cache-status"] == "miss"
    assert r1.json()["choices"][0]["message"]["content"] == "ANS[What is Redis?]"
    assert "x-cache-latency-ms" in r1.headers

    r2 = client.post("/v1/chat/completions", json=chat_body("What is Redis?"))
    assert r2.status_code == 200
    assert r2.headers["x-cache-status"] == "exact-hit"
    assert r2.json() == r1.json()
    assert len(client.app.state.ollama.calls) == 1  # second never hit inference


def test_different_param_is_a_miss_not_an_exact_hit(client):
    client.post("/v1/chat/completions", json=chat_body("What is Redis?"))
    r = client.post("/v1/chat/completions", json=chat_body("What is Redis?", temperature=0.5))
    assert r.headers["x-cache-status"] == "miss"
    assert len(client.app.state.ollama.calls) == 2


def test_semantic_hit(client, ollama):
    # seed the cache, then send a *different* prompt that maps to the same bucket
    client.app.state.embedder = FakeEmbedder(
        buckets={"What is Redis?": 7, "Can you explain what Redis is?": 7}
    )
    client.post("/v1/chat/completions", json=chat_body("What is Redis?"))
    r = client.post("/v1/chat/completions", json=chat_body("Can you explain what Redis is?"))
    assert r.headers["x-cache-status"] == "semantic-hit"
    assert float(r.headers["x-cache-similarity"]) == 0.0
    assert r.headers["x-cache-source-prompt"] == "What is Redis?"
    assert r.json()["choices"][0]["message"]["content"] == "ANS[What is Redis?]"
    assert "x-embed-ms" in r.headers
    assert len(ollama.calls) == 1


def test_semantic_miss_when_far_apart(client, ollama):
    client.post("/v1/chat/completions", json=chat_body("What is Redis?"))
    r = client.post("/v1/chat/completions", json=chat_body("What is Docker?"))
    assert r.headers["x-cache-status"] == "miss"
    assert len(ollama.calls) == 2


def test_semantic_hit_never_crosses_model(client, ollama):
    client.post("/v1/chat/completions", json=chat_body("What is Redis?"))
    r = client.post("/v1/chat/completions", json=chat_body("What is Redis?", model="qwen3:8b"))
    assert r.headers["x-cache-status"] == "miss"
    assert len(ollama.calls) == 2


def test_semantic_hit_never_crosses_temperature_class(client, ollama):
    # Seeded deterministically (temperature=0 -> t0); a sampled request (thot)
    # must not receive the deterministic cached answer.
    client.post("/v1/chat/completions", json=chat_body("What is Redis?"))
    r = client.post("/v1/chat/completions", json=chat_body("What is Redis?", temperature=0.9))
    assert r.headers["x-cache-status"] == "miss"
    assert len(ollama.calls) == 2
    # ...but two sampled requests to the same prompt can hit each other
    r2 = client.post("/v1/chat/completions", json=chat_body("What is Redis?", temperature=0.9))
    assert r2.headers["x-cache-status"] == "exact-hit"


def test_stream_rejected(client):
    r = client.post("/v1/chat/completions", json=chat_body("hi", stream=True))
    assert r.status_code == 400
    assert "stream" in r.json()["detail"]


def test_tools_bypass_cache(client, ollama):
    body = chat_body("What is Redis?")
    body["tools"] = [{"type": "function", "function": {"name": "f", "parameters": {}}}]
    r = client.post("/v1/chat/completions", json=body)
    assert r.headers["x-cache-status"] == "bypass"
    assert r.headers["x-cache-policy"] == "tools"
    assert r.json()["choices"][0]["message"]["content"] == "ANS[What is Redis?]"
    # nothing was stored
    r2 = client.post("/v1/chat/completions", json=chat_body("What is Redis?"))
    assert r2.headers["x-cache-status"] == "miss"


def test_ollama_error_returns_502_and_counts(client):
    client.app.state.ollama = FakeOllama(fail=True)
    r = client.post("/v1/chat/completions", json=chat_body("What is Redis?"))
    assert r.status_code == 502
    stats = client.get("/stats").json()
    assert stats["totals"]["errors"] == 1


def test_stats_and_reset(client):
    client.post("/v1/chat/completions", json=chat_body("What is Redis?"))
    client.post("/v1/chat/completions", json=chat_body("What is Redis?"))
    stats = client.get("/stats").json()
    assert stats["totals"]["requests"] == 2
    assert stats["totals"]["exact_hits"] == 1
    assert stats["totals"]["misses"] == 1
    assert stats["schema_version"] == 1
    assert stats["service"]["distance_threshold"] == 0.20
    assert stats["service"]["uptime_s"] >= 0
    assert len(stats["recent"]) == 2

    reset = client.post("/stats/reset").json()
    assert reset["totals"]["requests"] == 0


def test_models_passthrough(client):
    r = client.get("/v1/models")
    assert r.status_code == 200
    assert r.json()["data"][0]["id"] == "llama3.2:3b"


def test_healthz(client):
    r = client.get("/healthz")
    assert r.status_code == 200
    checks = r.json()["checks"]
    assert checks["redis"] is True
    assert checks["embedder"] is True
    assert checks["ollama"] is True
    assert checks["stats_memory_fallback"] is False


def test_invalid_body_shape(client):
    r = client.post("/v1/chat/completions", json={"model": "m", "messages": "nope"})
    assert r.status_code == 400
