# llm-cache

Minimal, fully offline, OpenAI-compatible caching proxy in front of
`llama3.2:3b` (Ollama), backed by Redis vector search — exact + semantic
cache tiers with a benchmark harness. See [`docs/plan.md`](docs/plan.md)
and [`docs/ui-plan.md`](docs/ui-plan.md).

---

## Quickstart (UI phase)

```powershell
# 1. (optional) Redis — vector search needs Redis 8
docker compose up -d redis

# 2. install + run (uv if available, else pip + venv)
#   uv run uvicorn llm_cache.app:app --reload --port 8000
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -e .[dev]
uvicorn llm_cache.app:app --reload --port 8000
```

Open:

- Dashboard → http://localhost:8000/dashboard/
- Stats JSON → http://localhost:8000/stats
- Health → http://localhost:8000/healthz

## Dashboard (`/dashboard/`)

Vanilla HTML/CSS/JS served by the FastAPI app itself — no build step, no
CDN, no external requests. Polls `GET /stats` every 1s (`?poll=<ms>`,
clamped 500–60000), pauses when the tab is hidden.

- **Config strip:** model, embedder, threshold, uptime, version.
- **KPI cards:** requests, hit rate, exact hits, semantic hits, misses,
  bypasses, errors, inferences avoided (`aria-live="polite"`).
- **Latency:** p50/p90/p95/p99/max over the **last 100 events** (`n` shown;
  `—` when `n = 0`).
- **Recent events:** newest-first table with `<caption>`/scope headers,
  status badges carry text (never color-only).
- **States:** empty (no requests yet), stale/error (banner keeps last
  payload with a `● stale` chip).

### Seed demo data (validates UI plan U-4)

```powershell
$env:LLM_CACHE_ALLOW_SEED="1"
uvicorn llm_cache.app:app --port 8000   # terminal 1
python scripts/seed_demo.py             # terminal 2 — 12 mixed events
```

Then reload http://localhost:8000/dashboard/.

### `/stats` contract (UI plan U3)

`GET /stats` → `{schema_version, generated_at, service{}, totals{},
latency_ms{}, recent[]}`. `POST /stats/reset` clears counters + feed
(Redis `INCR` / `LPUSH`/`LTRIM` when Redis is up, in-memory fallback
otherwise — same payload either way).

## Tests

```powershell
pip install -e .[dev]
pytest -q
```

## Layout

```
docker-compose.yml        # redis:8 (+ optional proxy profile)
pyproject.toml            # uv-managed, MIT
src/llm_cache/
  config.py   app.py   routes.py   store.py
  canonical.py  embedder.py  ollama.py  guardrails.py   # placeholders, Phases 1-3
dashboard/   index.html + app.js + style.css
scripts/     seed_demo.py
tests/       test_stats.py (contract + dashboard + percentiles)
docs/        plan.md · ui-plan.md
```

## Status

- ✅ `/stats` API + static dashboard (this PR)
- ⬜ Phases 1–4: passthrough proxy, exact/semantic tiers, benchmark (plan.md §15)
