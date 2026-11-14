# llm-cache

A caching layer in front of a local LLM, for the **JEE AI Tutor content pipeline** — and the
instrument panel that proves what it actually did.

> **This repo is mid-rebuild.** The backend has been scrapped and is being rebuilt from the
> ground up. What survived is the dashboard, which was good, and is now frozen as the spec.
> **[→ `docs/REBUILD.md`](./docs/REBUILD.md)** · **[→ `docs/UI-CONTRACT.md`](./docs/UI-CONTRACT.md)**

## What this is today

| | |
|---|---|
| ✅ **Present** | The dashboard — a live view of every request through the cache: verdict, distance, latency, overhead, full Q&A, reconciled by event id so expanded rows survive a 1 s poll. Vanilla HTML/CSS/JS, no framework, no build step, zero external requests. |
| ⏳ **Being built** | The backend that serves it. Storage, keying, semantic matching with verification, and `/stats`. |
| 🗑️ **Scrapped** | Everything from the Python/FastAPI/Redis era. Tagged `v0-scrapped`; the reasons are recorded, not forgotten — see §"Why we started over" below. |

The dashboard is currently not runnable, because nothing serves its three endpoints yet:
`GET /stats`, `POST /v1/chat/completions`, `GET /healthz`. That is the build.

## Run the dashboard

```bash
npm install        # dev-only tooling: Vite (HMR) + the test runner
npm test           # 9 reconciliation tests, zero deps, no browser
npm run dev        # http://localhost:5173 — proxies /stats,/v1,/healthz to :8000
python3 scripts/check_dashboard.py    # every id app.js reaches for exists in index.html
```

`npm run dev` proxies to the backend on port 8000 (`BACKEND_PORT=xxxx npm run dev` to override).
In production the app serves these same files from its own origin — there is no build step.

## The dashboard is the spec

Because the UI is frozen, the new backend is written against it — not the other way round.
`docs/UI-CONTRACT.md` extracts the contract line-by-line from `dashboard/app.js`: the `/stats`
payload, the `X-Cache-*` response headers, the five statuses, the event-id rules the
reconciler depends on, and the non-negotiables (event ids are numeric and survive reset; headers
are ASCII-safe; served hits mint a fresh `id`).

```bash
node scripts/check_api_contract.mjs                       # defaults to http://localhost:8000
node scripts/check_api_contract.mjs http://host:port      # check any running backend
```

That script exits 0 when the dashboard will work against the backend **unchanged**. It is the
acceptance gate for the rebuild.

## Why we started over

The first build was an OpenAI-compatible semantic-cache proxy (FastAPI + Redis 8 vector search +
Ollama, ~1.5k LOC). It worked, and it was honest enough to include a benchmark that measured its
own failure mode. It was also scrapped, because a hard review found — and reproduced — that:

- a generic sentence embedder cannot distinguish `∈` from `⊂`, so the shipped threshold served
  **wrong answers to different maths questions** (10 of 11 measured pairs);
- the semantic cache ignored the system prompt, embedding only the last user message;
- a maths-semantic hit returned **HTTP 500**, because a user prompt containing `∈` went into an
  `latin-1` HTTP header;
- the benchmark's "0% false positives" was **structural, not measured** — distractors were never
  replayed against a populated pool;
- a Redis failure became a **500**, not a fallback to inference;
- served responses replayed the original request's `id`, `created` and token counts.

The full list, with reproductions, is in the `v0-scrapped` tree. The knowledge it produced is
carried forward as measurable requirements in [`docs/REBUILD.md`](./docs/REBUILD.md) §3, so the
rebuild does not need to rediscover any of it.

The lesson the rebuild is designed around: **similarity selects candidates; it never authorises an
answer.** A cached response is served when it has been verified to answer *this* request, not when
it is merely nearby.

## License

MIT — see [`LICENSE`](./LICENSE).