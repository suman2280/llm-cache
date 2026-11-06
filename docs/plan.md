# llm-cache — Implementation Plan

A minimal, fully offline, OpenAI-compatible caching proxy in front of `llama3.2:3b`
(Ollama), backed by Redis, with a benchmark harness whose output is the headline deliverable.
Companion UI plan: [`ui-plan.md`](./ui-plan.md).

---

## 1. Idea

A proxy exposing `/v1/chat/completions` that checks Redis in two tiers before inference:

1. **Exact tier** — canonical request hash (tag pre-filter in the same index)
2. **Semantic tier** — MiniLM embeddings + Redis vector `VECTOR_RANGE` radius query with a
   per-run-tunable distance threshold

Misses forward to Ollama; responses are stored so rephrasings of already-answered questions
never re-run inference on a CPU-only machine. Ships with a threshold-sweep benchmark and a
dashboard consuming a JSON `/stats` API designed for future UIs.

## 2. Problem

On CPU-only hardware `llama3.2:3b` takes seconds per completion. Demo traffic is dominated by
*semantically repeated* single-turn questions asked several different ways, each wasting a full
inference. The claim to prove: **similar requests should not hit inference; they should be served
from a Redis cache, measurably.**

## 3. Target Users

- **Primary:** repo owner — single dev machine, CPU-only, localhost. Judged as a public
  portfolio repo whose centerpiece is a benchmark table.
- **Secondary (future):** anyone with an Ollama instance on weak hardware wanting a transparent
  self-hosted semantic cache without adopting a full gateway (LiteLLM) or a stale library
  (GPTCache).
- **Excluded from MVP:** multi-user auth, production traffic, multi-turn/agentic conversations,
  streaming.

## 4. Evidence

### FACT (verified from primary docs during research)

- Ollama exposes an OpenAI-compatible `/v1/chat/completions` (non-streaming, `seed`,
  `temperature`, `stream_options.include_usage`); API keys accepted-and-ignored.
- Ollama exposes `/v1/embeddings` — local embedding is possible without sentence-transformers
  (rejected as the embedder source due to CPU contention).
- Redis vector search is part of **Redis Open Source 8** — plain `redis:8` in Docker suffices,
  no `redis-stack` needed.
- Radius query syntax exists and is documented:
  `@field:[VECTOR_RANGE <radius> $vec]=>{$YIELD_DISTANCE_AS: d}` `SORTBY d ASC` … `DIALECT 2`;
  pre-filtered KNN `(@tag:{x})=>[KNN k @vec $v]` also documented. → threshold is a runtime
  query parameter (sweep-friendly); exact lookups can be a tag pre-filter in the same index.
- `sentence-transformers/all-MiniLM-L6-v2`: 384 dims, ~90 MB, CPU-friendly (appears in official
  Redis vector-search docs examples).

### ASSUMPTIONS (to be proven by the benchmark)

- MiniLM cosine distance between rephrasings is consistently lower than between different
  questions, by a margin wide enough to hit ≥80% rephrasing hit rate at a threshold with <1%
  distractor false-hit rate.
- Embed + Redis lookup (~10–50 ms) is negligible next to CPU inference (seconds).
- "Cache everything" (including `temperature > 0`) is acceptable for a PoC as long as responses
  say so.

### OPEN QUESTIONS (resolve in Phase 0/1)

- Does Ollama return a `usage` object on non-streaming `/v1/chat/completions`?
- Does Ollama internally reuse KV/prompt prefill on exact repeats? (Would shrink the exact-tier
  win; must be measured, not assumed.)
- Optimal `num_ctx` pin for `llama3.2:3b` on this machine (benchmark reproducibility).
- Final recommended threshold — comes from the sweep, not pre-decided.

## 5. Competitive Landscape

| Competitor | Overlap | Why ours differs |
| --- | --- | --- |
| **LiteLLM proxy** (`redis-semantic`) | Exact + semantic Redis caching behind an OpenAI-compatible proxy | Heavy multi-provider gateway; its own docs limit semantic caching to single-shot prompts; ours is 1-model, transparent mechanics, sweep-first benchmark |
| **GPTCache** (Zilliz) | Exact + similar matching, OpenAI adapter | Stale (README: no longer adding API/model support); needs FAISS/Milvus sidecar; not Redis-native |
| **redisvl `SemanticCache`** | Redis vector cache with distance threshold | Library requiring app-side glue; threshold baked into cache construction (fights our sweep); no proxy, no benchmark |
| **Redis 8 vector search** | The store we build on | Substrate, not a product |
| **Ollama-native behavior** | Possibly its own prompt/KV reuse | Undocumented for the OpenAI endpoint — measured in benchmark, not assumed |

## 6. Differentiation

1. **Truth-tracking benchmark** — false positives on distractors are a first-class metric; the
   README shows where the technique breaks (sweep curve + spot-checked false positives).
2. **Runtime-tunable threshold** — `VECTOR_RANGE` radius as config/CLI parameter; the sweep is
   real, not re-implemented per run.
3. **Fully offline, zero-API-key, zero-cloud** — MiniLM in-process + Ollama + Redis.
4. **`/stats` as a designed JSON API** — counters + recent-event feed (Redis-backed), built for
   a future UI from day one; bundled dashboard is the first consumer.
5. **Portfolio-grade clarity** — ~1.5k readable lines; redisvl is *not* in the main path.

## 7. Product Definition

### Core workflow (non-streaming `/v1/chat/completions`)

1. Client → proxy request `{model, messages, temperature, ...}`.
2. **Guardrail check** → if `stream: true`, vision content, or `tools` present: bypass
   (`stream` → clear `400` in MVP; others pass through uncached with a reason header).
3. Canonicalize request → `sha256(model + messages + params)`; embed the **last user message**
   with MiniLM.
4. **Exact tier:** FT.SEARCH with `req_hash` tag pre-filter → hit: return stored response, header
   `X-Cache-Status: exact-hit`.
5. **Semantic tier:** `@embedding:[VECTOR_RANGE <threshold> $vec]=>{$YIELD_DISTANCE_AS: d}`
   sorted ascending → hit within threshold: return stored response, headers
   `X-Cache-Status: semantic-hit`, `X-Cache-Similarity`, `X-Cache-Source-Prompt`.
6. **Miss** → forward to Ollama, store JSON doc (prefix `sem:`) with `req_hash` tag +
   last-user-message embedding + response + metadata; record stats event; return
   `X-Cache-Status: miss`.

### Stats/metrics

Redis `INCR` counters + `LPUSH/LTRIM` event feed (last 100). `GET /stats` returns
`{totals, latency_percentiles, recent[]}`; `POST /stats/reset`.

### Dashboard

Static HTML polling `/stats`; renders counters, latency table, live event feed.
Details in [`ui-plan.md`](./ui-plan.md).

### Benchmark harness (CLI)

- Dataset: 10 topics × 3 rephrasings + 10 distractors (~40 prompts) in YAML.
- **Baseline:** each prompt sent direct-to-Ollama exactly once (pinned `num_ctx`, warm
  `keep_alive`) → `baseline.json`.
- **Replay:** same set through a cold cache at radii `[0.05, 0.08, 0.10, 0.15, 0.20, 0.30]`;
  per radius: hit rate on rephrasings, false-hit rate on distractors, p50/p95 hit latency,
  aggregate inference time avoided (baseline − replay).
- Outputs: `results.json`, `results.md` (tables), `hit-vs-falsehit.png` (curve), spot-check
  section.

## 8. MVP

1. FastAPI proxy: `/v1/chat/completions`, `/v1/models` passthrough, `/healthz`
2. Redis unified FT index (`req_hash` TAG + 384-d FLOAT32 COSINE VECTOR, FLAT)
3. Exact tier + semantic tier with configurable `VECTOR_RANGE` radius
4. Guardrails: `stream: true` → 400; tools/vision → uncached passthrough with
   `X-Cache-Policy: bypass:<reason>`
5. `/stats` counters + recent event feed + reset endpoint (Redis-backed)
6. Benchmark CLI (baseline-once-replay) with 40-prompt dataset; markdown/CSV/PNG outputs
7. Static dashboard consuming `/stats`
8. `docker compose up redis` one-liner; `uv run` service; MIT README
9. pytest unit suite (mocked Redis/Ollama) + gated integration tests (live services)

## 9. Future Features (explicitly excluded from MVP)

Streaming support (pass-through and/or simulated replay); multi-turn history handling;
auth/API keys/rate limiting; pluggable remote embedders behind an interface; automatic
threshold calibration; cache admin endpoints beyond stats reset; persistence strategy beyond
Redis TTL; vLLM-style prefix-caching comparison.

## 10. Technical Architecture

```
Client (OpenAI SDK / curl)
  │  POST /v1/chat/completions
  ▼
FastAPI proxy (native, uv) ── SentenceTransformer MiniLM-L6-v2 (in-process, 384d)
  │  ├─ exact: FT.SEARCH (@req_hash tag pre-filter)
  │  ├─ semantic: FT.SEARCH VECTOR_RANGE(radius=threshold)
  │  └─ miss → httpx → Ollama /v1/chat/completions (host:11434)
  ▼
Redis 8 (Docker) ── FT index `idx_llm_cache` (prefix `sem:`)
  │  ├─ vector docs: {req_hash TAG, prompt, response JSON, embedding, ts, model, params}
  │  └─ stats keys (INCR counters + event list)
```

**Key design points**

- **One index, two tiers** — exact hits are a tag pre-filter; misses fall to `VECTOR_RANGE`.
  Every stored entry participates in both tiers (single write path).
- **Threshold as radius** — sweep without re-creating cache objects.
- **Stats in Redis** — survives restarts, future-UI ready.
- **Ollama stays native** (`localhost:11434`, `keep_alive` pinned during benchmarks to avoid
  cold-load noise).

### Repository layout

```
llm-cache/
├── docker-compose.yml          # redis:8 (+ optional proxy profile w/ host-gateway)
├── pyproject.toml              # uv-managed, MIT
├── README.md
├── docs/
│   ├── plan.md                 # this file
│   └── ui-plan.md              # dashboard plan
├── src/llm_cache/
│   ├── __init__.py  config.py  app.py (lifespan: load model, create index)
│   ├── routes.py (chat, models, healthz, stats)
│   ├── canonical.py (request serialization + sha256)
│   ├── embedder.py (singleton MiniLM)
│   ├── store.py (FT.CREATE, exact_lookup, range_lookup, store, stats_*)
│   ├── ollama.py (httpx client, timeout, keep_alive handling)
│   ├── guardrails.py (cacheability policy → header reasons)
│   └── benchmark/__main__.py, dataset.py, report.py, dataset/qa.yaml
├── dashboard/index.html (+ tiny JS polling /stats)
└── tests/ (unit/, integration/ gated by env vars)
```

## 11. Technology Choices

| Choice | Decision | Rationale | Alternative rejected |
| --- | --- | --- | --- |
| Language/framework | **Python + FastAPI + uv** | async-native; sentence-transformers ecosystem | Node (weak local ML story), Go (no in-process embedding) |
| Redis client | **redis-py raw `FT.CREATE`/`FT.SEARCH`** in a thin wrapper | Full control of per-query radius; mechanics visible | redisvl `RangeQuery` (threshold baked into objects); redis-py `ft()` helper (fine, but raw keeps the brief honest) |
| Redis deployment | **Docker `redis:8`** | Vector search is in Redis OSS 8 | redis-stack (heavier, unnecessary modules) |
| Embedder | **sentence-transformers `all-MiniLM-L6-v2`** in-process | ~90 MB, 384d, tens of ms on CPU, offline | Ollama `/v1/embeddings` (2nd model, CPU contention); cloud API (breaks offline claim) |
| Vector index algorithm | **FLAT** (brute force) | PoC scale; exact results → cleaner sweep numbers | HNSW (unneeded complexity/recall noise) |
| Distance metric | **COSINE** | RedisVL semantic-cache default; MiniLM outputs normalized vectors | IP |
| HTTP to Ollama | **httpx async client** | Streaming-ready later; timeouts | requests (sync would block the loop) |
| Charts | **matplotlib** in benchmark report | Zero services; PNG in README | JS chart lib in dashboard |
| Tests | **pytest + fakeredis / mocked httpx**; integration gated by env | Fast CI; airtight demos when services present | compose-based e2e (heavier) |

## 12. Risks

**Product/benchmark**

- *Semantic false positives:* loose thresholds produce distractor hits that look great but are
  bad caching. Mitigation: sweep curve + distractor set + spot-check section make the failure
  mode visible, not hidden.
- *"Cache everything" policy* (`temp > 0`, nondeterminism): mitigated by noting it in
  `X-Cache-Policy` + benchmark caveats; acceptable for a PoC.
- *Ollama-internal caching:* if Ollama reuses prompt prefill on exact repeats, the exact-tier
  win shrinks → measured in Phase 1, reported honestly (possibly an interesting finding itself).
- *Small dataset* (40 prompts): coarse statistics → publish dataset + methodology so anyone can
  re-run larger.

**Technical**

- MiniLM retrieval quality on these specific rephrasings — **the single biggest assumption**;
  Phase 0 spike exists to fail-fast.
- CPU contention: MiniLM encode runs in-process while Ollama generates → measure and expose the
  latency split (embed vs Redis vs would-be inference) in the report.
- Non-streaming `usage` availability from Ollama unverified → tokens-saved may degrade to
  "requests avoided".
- redis-py binary `float32` vector param handling — verified pattern in official docs;
  prototype first (Phase 1).
- Docker `host.docker.internal` needs `extra_hosts` — only affects the optional containerized
  profile.

**Market/operational/financial**

- Market: niche by design; no monetization risk — cost is zero (MIT deps, own hardware).
- Operational: `keep_alive` default (5 min) can unload the model mid-benchmark → pin
  `keep_alive` + document a prewarm step.
- Key management: none — no secrets, fully offline.

## 13. Open Questions

1. Will rephrasings actually cluster below distractors under MiniLM at a usable threshold?
   → Phase 0 decides.
2. Does Ollama return token usage on non-streaming `/v1/chat/completions`?
3. Does Ollama exhibit internal prompt/KV caching on exact repeats?
4. Optimal `num_ctx` pin for `llama3.2:3b` on this machine?
5. Exact final threshold recommendation — output of the sweep.

## 14. Validation Plan (fastest experiments for the riskiest assumptions)

| Experiment | Effort | Kills/confirms |
| --- | --- | --- |
| **E0 — Embedding spike**: embed the 40-prompt set offline with MiniLM, compute pairwise distances, report min-rephrase vs max-distractor distance and the overlap region | ~30 min, no repo | If rephrasings don't separate from distractors, the semantic-tier thesis fails → escalate embedder or narrow scope |
| **E1 — Redis vector smoke test**: `FT.CREATE` + `VECTOR_RANGE` with binary float32 param via redis-py against `redis:8` Docker | ~30 min | Confirms query syntax/integration before building |
| **E2 — Ollama behavior probe**: 3 identical calls, measure latency, inspect `usage`; then `keep_alive=1s` cold vs warm | ~20 min | Answers Q2/Q3, shapes baseline methodology |
| **E3 — Overhead measurement**: embed+lookup on 100 synthetic prompts, p50/p95 | ~15 min | Confirms cache overhead ≪ inference |

## 15. Implementation Plan

### Phase 0 — Validation spike (gate)

- **Objective:** fail-fast the riskiest assumption.
- **Work:** E0–E3 as scripts in `scratch/`; record results in `docs/validation.md`.
- **Dependencies:** Docker (`redis:8`), Ollama + `llama3.2:3b` pulled, Python 3.11+, uv.
- **Output:** validation notes + go/no-go.
- **Validation criteria:** rephrasing/distractor separation exists with a usable threshold zone;
  embed + Redis round-trip p95 < 100 ms.

### Phase 1 — Skeleton + passthrough

- **Objective:** speak OpenAI to Ollama with observability.
- **Work:** repo scaffold (uv, ruff, pytest); config; FastAPI app + lifespan; `/v1/models`,
  `/healthz`; proxy non-streaming `/v1/chat/completions` → Ollama; error/timeout handling; gated
  integration test against live Ollama.
- **Dependencies:** Phase 0 go.
- **Output:** working passthrough; `usage` behavior documented.
- **Validation criteria:** `curl` via proxy ≈ direct curl in shape and latency
  (overhead < 50 ms).

### Phase 2 — Exact-match tier

- **Objective:** identical requests never hit inference twice.
- **Work:** canonical request serializer; FT index creation (`req_hash` TAG + VECTOR + response
  JSON); store-on-miss; `X-Cache-Status` headers; unit tests (fakeredis).
- **Dependencies:** Phase 1.
- **Output:** repeat request → `exact-hit`, latency ≈ embedding-free Redis GET (< 10 ms).
- **Validation criteria:** 3 identical sequential calls → hits on 2 & 3; changing one param
  (e.g. `temperature`) → miss.

### Phase 3 — Semantic tier + guardrails + stats

- **Objective:** rephrasings served from cache, honestly labeled; stats API ready for UI.
- **Work:** embedder singleton; `VECTOR_RANGE` lookup with configurable radius; guardrails
  (`stream` → 400; tools/vision → bypass); stats counters + event feed; `/stats`, `/stats/reset`;
  `/stats` contract test.
- **Dependencies:** Phase 2.
- **Output:** `semantic-hit` responses with similarity metadata; JSON stats via curl.
- **Validation criteria:** hand-written rephrasing pair hits at default threshold; unrelated
  prompt misses; counters match event feed.

### Phase 4 — Benchmark harness

- **Objective:** the headline deliverable.
- **Work:** 40-prompt dataset YAML; baseline runner (pinned `num_ctx`, `keep_alive`, prewarm);
  replay sweep over radii; metrics (hit rate, distractor FP curve, p50/p95, time saved);
  `results.json` / `results.md` / `hit-vs-falsehit.png`; false-positive spot-check template.
- **Dependencies:** Phase 3.
- **Output:** reproducible one-command benchmark + markdown tables for README.
- **Validation criteria:** sweep curve shows a threshold zone meeting the success bar
  (≥ 80% rephrase hits, < 1% distractor FPs) or explicitly documents where it fails.

### Phase 5 — Dashboard, docs, polish

- **Objective:** portfolio-ready repo.
- **Work:** static dashboard (counters, percentiles, live feed); README (architecture diagram,
  quickstart `docker compose up redis && uv run uvicorn`, benchmark tables, limitations, MIT
  license); final test suite green; seed demo script for visitors.
- **Dependencies:** Phase 4.
- **Output:** complete public repo, one-liner demo path.
- **Validation criteria:** fresh clone → quickstart works in < 10 min; benchmark reproducible
  from clean Redis.

## 16. Final Recommendation

**BUILD AFTER VALIDATION — with a deliberately light gate (Phase 0).**

- Architecture is fully de-risked: every load-bearing syntax (Redis 8 vector range queries,
  pre-filtered tag KNN, in-process MiniLM, Ollama's OpenAI endpoint) is verified against primary
  docs, and scope is intentionally PoC-sized.
- Research cannot answer *your data*: whether MiniLM separates rephrasings from distractors on
  this machine. That is a ~1-hour spike (E0), not a build blocker — but it decides whether the
  headline claim is true.
- Cost of being wrong is bounded: even a partial win (strong exact tier, mediocre semantic tier)
  is a legitimate benchmark exhibit — the false-hit curve is the story, not an embarrassment.

If E0 shows clean separation → proceed straight into Phase 1 and build all five phases.
If E0 shows overlap → first decision is narrowing the dataset/domain or swapping the embedder,
*before* scaffolding the repo.
