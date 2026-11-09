# llm-cache

A minimal, fully-offline **OpenAI-compatible caching proxy** for
`llama3.2:3b` running on **Ollama**, backed by **Redis 8 vector search** —
with a live **dashboard** (`/dashboard/`), exact + semantic cache tiers, and
a threshold-sweep benchmark harness.

> Thesis: *similar requests shouldn't hit inference — they should read from
> cache.* The benchmark exists to prove or disprove that, honestly.

- Design docs: [`docs/plan.md`](docs/plan.md) · Dashboard plan:
  [`docs/ui-plan.md`](docs/ui-plan.md) · Phase-0 validation:
  [`docs/validation.md`](docs/validation.md)
- License: MIT

---

## Quickstart (CPU-only, ~5 minutes)

Requirements: Python ≥3.11, [uv](https://docs.astral.sh/uv/), Docker, and a
running Ollama with `llama3.2:3b` pulled (`ollama pull llama3.2:3b`).

```bash
# 1. Redis 8 (vector search ships in the base image — redis-stack not needed)
docker compose up -d redis

# 2. Install and start the proxy
uv sync --extra dev
uv run uvicorn llm_cache.app:app --port 8000   # first run downloads MiniLM (~90 MB)

# 3. Use it exactly like the OpenAI API
curl localhost:8000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"llama3.2:3b","messages":[{"role":"user","content":"What is Redis?"}],"temperature":0}'

# second identical call -> X-Cache-Status: miss, then exact-hit ...
# 'Can you explain what Redis is?'        -> X-Cache-Status: semantic-hit
```

Open the **dashboard** at http://localhost:8000/dashboard/ and stats JSON at
http://localhost:8000/stats.

---

## Dashboard (`/dashboard/`)

Vanilla HTML/CSS/JS served by the FastAPI app itself — no build step, no
framework, no CDN, no external requests. One poll of `GET /stats` per second
(`?poll=<ms>`, clamped 500–60000); pauses when the tab is hidden. Rows are
reconciled by event id (`dashboard/reconcile.js`, pure + node-tested), so
expanded rows keep their state across polls and new rows FLIP in via View
Transitions.

- **Hero — the demo moment.** A composer (prompt, temp, optional system) and
  **Run the demo**, which sends a question, the exact same text, then a
  rewording — live: **miss** (inference, seconds) → **exact-hit** (~1 ms) →
  **semantic-hit** (~15 ms, with `d=` and the prompt it was served from).
  The verdict line is the proxy's own `X-Cache-*` headers, never re-derived.
  The demo rotates through a question pool; a warm cache reports honestly
  ("already cached") instead of lying about a miss.
- **Instrument band.** Config strip (model, embedder, threshold, uptime,
  version); KPI tiles with animated counters (requests, hit rate, exact,
  semantic, misses, bypasses, errors, inferences avoided); latency
  percentiles over the **last 100 events** (`n` shown).
- **One unified log.** Every request through the proxy — from this page, curl,
  or any OpenAI client — lands in the same newest-first feed. Each row shows
  the verdict badge, distance, latency, cache overhead, and prompt preview;
  expand (native `<details>`, keyboard-accessible) for the full question, the
  full answer, and the `served from:` source prompt on semantic hits.
- **Design.** OKLCH token palette with a lightness ladder, cascade layers,
  one accent hue, paired status colors, tabular numerals — the grammar of
  Linear/Vercel/Langfuse-class dashboards, hand-written in ~600 lines of CSS.
  Dark-only; tokens are `light-dark()`-ready if a light theme is ever added.
- **States:** empty (narrates the three tiers), stale (`● stale` chip + banner,
  last payload kept), error rows (detail shown, never swallowed).
- All rendering is `textContent`-only (no `innerHTML`) — now covering full
  answer text, not just previews.
- `aria-live` is scoped to the composer's verdict line so a 1 s poll can't
  spam a screen reader; the log is `aria-live="off"`.

### Seed demo data (no model needed)

```powershell
$env:LLM_CACHE_ALLOW_SEED="1"
uvicorn llm_cache.app:app --port 8000   # terminal 1
python scripts/seed_demo.py             # terminal 2 — 12 mixed events
```

Then reload http://localhost:8000/dashboard/ — mixed verdicts, distances,
latencies and full answers render.

### `/stats` contract (v2)

`GET /stats` → `{schema_version: 2, generated_at, service{}, totals{},
latency_ms{}, recent[]}`. Each `recent` event carries a stable monotonic
`id` (survives `POST /stats/reset` so clients can reconcile rows), the full
`prompt` and `response` (null on bypass/error), `source_prompt` on semantic
hits, plus `status/model/similarity/threshold/latency_ms/embed_ms/redis_ms/
ts/reason`. `POST /stats/reset` zeroes counters + feed (the event *sequence*
deliberately survives — ids must stay unique across resets).

---

## Running the benchmark

Self-contained — it runs the baseline, spawns its own proxy per radius, and
purges the cache itself (no manual setup needed):

```bash
uv run python -m llm_cache.benchmark all \
    --dataset src/llm_cache/benchmark/dataset/qa.yaml \
    --out results
```

- **Baseline**: every prompt is sent directly to Ollama once → `results/baseline.json`.
- **Population pass**: 10 topic seeds + 10 distractors populate a fixed cache pool.
- **Sweep**: for each cosine radius the runner spawns a fresh proxy with that
  radius as its configured `LLM_CACHE_DISTANCE_THRESHOLD` (the radius is process
  config, not per-request state) and replays the 30 rephrasings. Each
  rephrase's document is removed right after its request, so hits can only come
  from the fixed pool — no sweep-to-sweep or intra-sweep cascades.
- Outputs: `results.md` (tables + spot-checks), `results.json`,
  `hit-vs-falsehit.png`.

Committed results from the reference machine (CPU-only, `llama3.2:3b` on
Ollama 0.40.14): see [`results/results.md`](results/results.md) — headline:
**93.3% rephrase hit rate at radius 0.20 with 0% false positives**, hit p50
≈17 ms vs a ≈2.2 s direct-inference baseline.

Smoke test with a subset (2 topics) in ~2 minutes:

```bash
uv run python -m llm_cache.benchmark all --max-topics 2 --out results-smoke

## Architecture

```
client ──POST /v1/chat/completions──▶ FastAPI proxy (native)
                                     │  ├─ tier 1: FT.SEARCH tag pre-filter (req_hash)
                                     │  ├─ tier 2: FT.SEARCH VECTOR_RANGE(radius)
                                     │  └─ miss ──▶ Ollama http://localhost:11434
                                     │        (MiniLM-L6-v2 embedded in-process)
                                     ▼
                              Redis 8 (docker compose)
                              ├─ idx_llm_cache  sem:<digest>  {req_hash TAG, model TAG,
                              │                  prompt TEXT, response TEXT, embedding VECTOR}
                              └─ stats:counters / stats:events
```

Same index serves both tiers: stored docs carry the request's `req_hash` tag
*and* the last-user-message embedding, so one write path feeds both lookups
([`docs/plan.md`](docs/plan.md) §10).

## Configuration

All settings overridable with `LLM_CACHE_*` env vars or a `.env` file:

| Setting | Default | Meaning |
| --- | --- | --- |
| `LLM_CACHE_REDIS_URL` | `redis://localhost:6379/0` | Redis connection |
| `LLM_CACHE_OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama (native on host) |
| `LLM_CACHE_DISTANCE_THRESHOLD` | `0.20` | Semantic radius (COSINE distance; lower = stricter) |
| `LLM_CACHE_TTL_S` | `86400` | Cache document TTL |
| `LLM_CACHE_EMBEDDING_MODEL` | `sentence-transformers/all-MiniLM-L6-v2` | In-process embedder |
| `LLM_CACHE_STATS_EVENT_LIMIT` | `100` | Recent-event ring size (percentile window) |

## Response headers

| Header | Meaning |
| --- | --- |
| `X-Cache-Status` | `miss` \| `exact-hit` \| `semantic-hit` \| `bypass` \| `error` |
| `X-Cache-Similarity` | Cosine distance of the served semantic hit |
| `X-Cache-Source-Prompt` | Prompt whose cached answer was served (truncated) |
| `X-Embed-Ms` / `X-Redis-Ms` | Cache overhead breakdown |
| `X-Cache-Policy` | Bypass reason (`tools`, `no_user_text`, …) |

## API

- `POST /v1/chat/completions` — cached proxy (non-streaming MVP)
- `GET /v1/models`, `GET /v1/models/{model}` — passthrough to Ollama
- `GET /healthz` — Redis / embedder / Ollama checks (+ memory-fallback flag)
- `POST /stats/record-event` — demo seed endpoint, gated by `LLM_CACHE_ALLOW_SEED=1`
- `GET /stats` — machine-readable counters + recent-event feed
  ([`docs/ui-plan.md`](docs/ui-plan.md) §3 — the contract a future UI consumes)
- `POST /stats/reset` — zero the counters and event feed

## MVP scope (what is deliberately *not* here)

- **Streaming** (`stream: true` → `400`); tool-calling and vision-only prompts
  bypass the cache (pass-through, labelled `X-Cache-Policy`)
- The **dashboard's only write action is the composer / Run-the-demo panel** —
  and it goes through the same `/v1/chat/completions` a normal client uses.
  It sends real requests (the first runs inference and populates the cache);
  the verdict line always reports the proxy's own headers
- Multi-turn/agentic traffic semantics, auth, rate limiting
- A bundled dashboard UI — `/stats` is the designed API for one (plan:
  [`docs/ui-plan.md`](docs/ui-plan.md))
- Redis persistence tuning / cache admin endpoints

## Development

```bash
uv sync --extra dev
uv run pytest                       # unit tests (fakes: no Redis/Ollama/model needed)
uv run ruff check src tests scripts
uv run python scripts/check_dashboard.py   # every JS-referenced id exists in index.html

# dashboard unit tests — Node's built-in runner, zero dependencies:
# the log-reconciliation planner (the page's one load-bearing assumption)
node --test dashboard/          # or: npm test

# dashboard dev server with HMR (DEV-ONLY; production serves the same files):
npm install                      # one time, dev-only (Vite 8, no framework)
npm run dev                      # http://localhost:5173 — proxies /stats,/v1 to :8000

# end-to-end UI smoke in real Chrome (needs the proxy + Redis + Ollama up):
npm i -D puppeteer-core          # one time, dev-only
node scripts/ui_smoke.mjs       # drives Run the demo: miss → exact-hit → semantic-hit

# live integration (requires Redis + Ollama; note: FT.* indexes are DB-0 only):
LLM_CACHE_TEST_REDIS_URL=redis://localhost:6379/0 \
LLM_CACHE_TEST_OLLAMA_URL=http://localhost:11434 \
    uv run pytest tests/integration
```

> **No build step in production.** `uv run uvicorn llm_cache.app:app` serves
> the `dashboard/` files exactly as they are in the repo; Node (Vite, tests,
> Chrome smoke) is dev-only tooling and never enters the runtime path.

## Validation notes

Everything marked "verified" here was confirmed against the live stack on the
reference machine; full write-up in [`docs/validation.md`](docs/validation.md):

- **Redis 8.10 syntax quirks** encoded in `store.py`: `PARAMS` counts tokens
  (not name/value pairs); params are rejected inside TAG terms (values are
  inlined + escaped); `VECTOR_RANGE` needs a literal radius and `DIALECT 2`;
  FT indexes are DB-0 only; redis-py ≥5 parses FT.SEARCH replies into a dict.
- **Ollama 0.40.14 already caches prompt prefill** (`cached_tokens` in
  `usage`): bit-identical repeats are ~2.5× faster on their own
  (7.6s → 2.9s). It cannot help *rephrasings*; this cache turns any hit into
  ~17 ms.
- **Semantic safety gates**: reuse never crosses model or temperature-class
  (`tclass`), and tool/vision/stream requests bypass the cache with an
  explanatory header.
- Phase-0 experiments (embedding separation, Redis smoke test, Ollama probe,
  overhead measurement) and the bugs they caught are documented in
  [`docs/validation.md`](docs/validation.md).

Layout:

```
src/llm_cache/
├── app.py          # FastAPI factory (injectable for tests; mounts /dashboard)
├── config.py       # LLM_CACHE_* settings
├── canonical.py    # request hashing / last-user-message extraction
├── guardrails.py   # cacheability policy
├── embedder.py     # MiniLM singleton
├── store.py        # FT index, exact/semantic lookup, stats (memory fallback)
├── ollama.py       # async Ollama client
├── routes.py       # /v1 endpoints + /healthz + /stats + demo seed
├── benchmark/      # dataset, replay sweep, markdown/chart report
dashboard/
├── index.html      # hero composer + demo button + instrument band + unified log
├── style.css       # @layered OKLCH token system (~600 lines, no framework)
├── app.js          # poll → keyed reconcile (View Transitions) → tickers
├── reconcile.js    # pure log-reconciliation planner (npm test)
└── reconcile.test.js
scripts/seed_demo.py
scripts/check_dashboard.py
scripts/ui_smoke.mjs              # dev-only Chrome smoke test of the demo flow
tests/               # unit (fakes) + stats contract + gated live integration
```

## Tests

```bash
uv run pytest                       # 47 tests: unit + stats contract (no services needed)
node --test dashboard/              # 9 reconciliation tests (no browser, zero deps)
uv run python scripts/check_dashboard.py
# with live Redis + Ollama (3 more integration tests):
LLM_CACHE_TEST_REDIS_URL=redis://localhost:6379/0 \
LLM_CACHE_TEST_OLLAMA_URL=http://localhost:11434 uv run pytest tests/integration
```
