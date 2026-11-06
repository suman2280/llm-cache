"""Seed demo events via POST /stats/record-event (needs LLM_CACHE_ALLOW_SEED=1).

Usage:
  set LLM_CACHE_ALLOW_SEED=1          # cmd
  $env:LLM_CACHE_ALLOW_SEED="1"       # PowerShell
  python -m uvicorn llm_cache.app:app --port 8000
  python scripts/seed_demo.py         # posts 12 mixed events

This validates UI plan U-4: mixed statuses/distances/latencies render.
"""
from __future__ import annotations
import json
import os
import urllib.request

BASE = os.environ.get("LLM_CACHE_APP_BASE_URL", "http://localhost:8000").rstrip("/")

EVENTS = [
    {"status": "miss", "latency_ms": 9821, "embed_ms": 19, "redis_ms": 2, "similarity": None, "prompt_preview": "What is Redis?"},
    {"status": "exact-hit", "latency_ms": 9, "embed_ms": 2, "redis_ms": 1, "similarity": 0.031, "prompt_preview": "What is Redis?"},
    {"status": "semantic-hit", "latency_ms": 12, "embed_ms": 3, "redis_ms": 1, "similarity": 0.042, "prompt_preview": "what is redis??"},
    {"status": "miss", "latency_ms": 10420, "embed_ms": 21, "redis_ms": 2, "similarity": None, "prompt_preview": "Explain TCP congestion control."},
    {"status": "semantic-hit", "latency_ms": 15, "embed_ms": 3, "redis_ms": 1, "similarity": 0.055, "prompt_preview": "How does TCP handle congestion?"},
    {"status": "bypass", "latency_ms": 400, "embed_ms": 0, "redis_ms": 0, "similarity": None, "prompt_preview": "stream request (bypass)"},
    {"status": "miss", "latency_ms": 8730, "embed_ms": 18, "redis_ms": 2, "similarity": None, "prompt_preview": "What is a vector database?"},
    {"status": "semantic-hit", "latency_ms": 11, "embed_ms": 3, "redis_ms": 1, "similarity": 0.048, "prompt_preview": "What is a vector DB?"},
    {"status": "exact-hit", "latency_ms": 8, "embed_ms": 2, "redis_ms": 1, "similarity": 0.029, "prompt_preview": "Explain TCP congestion control."},
    {"status": "miss", "latency_ms": 9200, "embed_ms": 20, "redis_ms": 2, "similarity": None, "prompt_preview": "Summarize the plot of Hamlet."},
    {"status": "semantic-hit", "latency_ms": 14, "embed_ms": 3, "redis_ms": 1, "similarity": 0.061, "prompt_preview": "Tell me about Hamlet."},
    {"status": "error", "latency_ms": 1200, "embed_ms": 19, "redis_ms": 2, "similarity": None, "prompt_preview": "upstream timeout"},
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
            with urllib.request.urlopen(req, timeout=10) as r:
                print(f"  {ev['status']:<14} {ev['latency_ms']:>6} ms  {ev['prompt_preview'][:44]}")
        except Exception as e:
            print(f"FAILED posting {ev['status']}: {e}")
            print("Start server with:  set LLM_CACHE_ALLOW_SEED=1 && uvicorn llm_cache.app:app --port 8000")
            return 1
    print("Done. Open /dashboard/ (poll ?poll=1000).")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
