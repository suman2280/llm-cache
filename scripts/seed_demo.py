"""Seed demo events via POST /stats/record-event (needs LLM_CACHE_ALLOW_SEED=1).

Usage:
  set LLM_CACHE_ALLOW_SEED=1          # cmd
  $env:LLM_CACHE_ALLOW_SEED="1"       # PowerShell
  python -m uvicorn llm_cache.app:app --port 8000
  python scripts/seed_demo.py         # posts 12 mixed events

This validates UI plan U-4 / v2: mixed statuses/distances/latencies render,
now including full prompt + response text (contract v2).
"""
from __future__ import annotations

import json
import os
import urllib.request

BASE = os.environ.get("LLM_CACHE_APP_BASE_URL", "http://localhost:8000").rstrip("/")

REDIS_ANS = "Redis is an in-memory data structure store used as a database, cache, and message broker."
TCP_ANS = "TCP is a connection-oriented transport protocol that guarantees ordered, reliable delivery."
VECDB_ANS = "A vector database stores embeddings and supports similarity search over them."
HAMLET_ANS = "Hamlet follows the Prince of Denmark as he avenges his father's murder."

EVENTS = [
    {"status": "miss", "latency_ms": 9821, "embed_ms": 19, "redis_ms": 2, "similarity": None,
     "prompt": "What is Redis?", "response": REDIS_ANS},
    {"status": "exact-hit", "latency_ms": 9, "embed_ms": 2, "redis_ms": 1, "similarity": 0.031,
     "prompt": "What is Redis?", "response": REDIS_ANS},
    {"status": "semantic-hit", "latency_ms": 12, "embed_ms": 3, "redis_ms": 1, "similarity": 0.042,
     "prompt": "what is redis??", "response": REDIS_ANS,
     "source_prompt": "What is Redis?"},
    {"status": "miss", "latency_ms": 10420, "embed_ms": 21, "redis_ms": 2, "similarity": None,
     "prompt": "Explain TCP congestion control.", "response": TCP_ANS},
    {"status": "semantic-hit", "latency_ms": 15, "embed_ms": 3, "redis_ms": 1, "similarity": 0.055,
     "prompt": "How does TCP handle congestion?", "response": TCP_ANS,
     "source_prompt": "Explain TCP congestion control."},
    {"status": "bypass", "latency_ms": 400, "embed_ms": 0, "redis_ms": 0, "similarity": None,
     "prompt": "stream request (bypass)", "response": None, "reason": "stream"},
    {"status": "miss", "latency_ms": 8730, "embed_ms": 18, "redis_ms": 2, "similarity": None,
     "prompt": "What is a vector database?", "response": VECDB_ANS},
    {"status": "semantic-hit", "latency_ms": 11, "embed_ms": 3, "redis_ms": 1, "similarity": 0.048,
     "prompt": "What is a vector DB?", "response": VECDB_ANS,
     "source_prompt": "What is a vector database?"},
    {"status": "exact-hit", "latency_ms": 8, "embed_ms": 2, "redis_ms": 1, "similarity": 0.029,
     "prompt": "Explain TCP congestion control.", "response": TCP_ANS},
    {"status": "miss", "latency_ms": 9200, "embed_ms": 20, "redis_ms": 2, "similarity": None,
     "prompt": "Summarize the plot of Hamlet.", "response": HAMLET_ANS},
    {"status": "semantic-hit", "latency_ms": 14, "embed_ms": 3, "redis_ms": 1, "similarity": 0.061,
     "prompt": "Tell me about Hamlet.", "response": HAMLET_ANS,
     "source_prompt": "Summarize the plot of Hamlet."},
    {"status": "error", "latency_ms": 1200, "embed_ms": 19, "redis_ms": 2, "similarity": None,
     "prompt": "upstream timeout", "response": None, "reason": "Ollama timed out"},
]

def main() -> int:
    print(f"Seeding demo events into {BASE} (needs LLM_CACHE_ALLOW_SEED=1 on server)...")
    for ev in EVENTS:
        req = urllib.request.Request(
            f"{BASE}/stats/record-event",
            data=json.dumps(ev).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=10):
                print(f"  {ev['status']:<14} {ev['latency_ms']:>6} ms  {ev['prompt'][:44]}")
        except OSError as e:  # URLError/HTTPError are OSError subclasses
            print(f"FAILED posting {ev['status']}: {e}")
            print("Start server with:  set LLM_CACHE_ALLOW_SEED=1 && uvicorn llm_cache.app:app --port 8000")
            return 1
    print("Done. Open /dashboard/ (poll ?poll=1000).")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
