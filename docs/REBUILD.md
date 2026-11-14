# Rebuild Charter

**This repo is being rebuilt from the ground up.** Everything from the Python/FastAPI/Redis era
has been scrapped except the dashboard (`dashboard/`) and its dev tooling, both of which were good
and are now **frozen as the spec** — see [`UI-CONTRACT.md`](./UI-CONTRACT.md).

This document is the bridge: it records what the old build taught us (measured, not remembered),
converts my review findings into requirements a new backend can be written against, and names the
decisions still open.

---

## 1. What was scrapped, and what survives

| Scrapped | Survives |
|---|---|
| `src/llm_cache/` — all app code | `dashboard/` — `index.html`, `style.css`, `app.js`, `reconcile.js`, `reconcile.test.js` |
| `tests/`, `docs/BRUTAL_REVIEW.md`, `results/`, `scratch/` | `package.json` + `package-lock.json` (dashboard dev tooling) |
| `pyproject.toml`, `uv.lock`, `docker-compose.yml`, `.venv/` | `vite.config.js`, `scripts/ui_smoke.mjs`, `scripts/check_dashboard.py` |
| the benchmark harness and the committed `results/` | `LICENSE`, `.gitignore` |

Tagged `v0-scrapped`; a full pre-scrap tarball is outside the repo. Git history is **not** wiped
(`origin` is `git@github.com:suman2280/llm-cache.git`, so the old code remains recoverable and a
history rewrite would be an irreversible force-push over a live remote for no benefit).

The dashboard is not runnable today — it fronts `/stats`, `/v1/chat/completions` and `/healthz`,
and nothing serves them yet. That is the build.

---

## 2. Hard-won facts — measured on the old build, do not rediscover

These are measurements, reproduced by `docs/evidence/verify_findings.py` in the `v0-scrapped` tree.
They are inputs to the design, and each one has a requirement attached in §3.

**F1 — The semantic cache is unsafe for mathematics as configured.**
With the old embedder (`all-MiniLM-L6-v2`) and the shipped radius `0.20`:

```
Evaluate 3 + 4 x 5.            ||  Evaluate (3 + 4) x 5.            d=0.0302
Solve for x: 2x + 6 = 10.      ||  Solve for x: 2x + 10 = 6.        d=0.0085
Is 2 an element of A = {1,2,3}?||  Is 2 a subset of A = {1,2,3}?    d=0.1401
What is the derivative of x^2?  ||  What is the derivative of x^3?   d=0.1743
… 10 of 11 distinct-answer maths pairs land inside radius 0.20.
```

A generic sentence embedder cannot tell `⊂` from `∪`, or `15%` from `25%`. **Similarity alone is
not a correctness criterion.** Any rebuild that serves a cached answer on a distance threshold
and nothing else is broken for this domain.

**F2 — Embedding only the last user message makes the system prompt invisible.**
Two requests with different system prompts and the same user text embed to *distance 0.0* and map
to the same cache document. Embedding the full conversations gives `d=0.3447`. The information
that distinguishes two jobs is exactly the information the old design threw away.

**F3 — An 8-parameter allowlist silently swallowed answer-changing parameters.**
`top_k`, `min_p`, `num_predict`, `repeat_penalty`, `n`, `logit_bias` all hashed identically to the
bare request. Every one of them changes the completion.

**F4 — Non-ASCII in an HTTP header is a 500.**
`X-Cache-Source-Prompt` carried a raw user prompt into a header; the framework encodes headers as
`latin-1`; `∈ ∪ ⊂ π √ ≤` are all outside it. A maths-semantic cache **hit** returned HTTP 500.
Every character in the target domain is in that set.

**F5 — The old benchmark never measured false positives.**
`results/replay-0.2.json` contains 30 paraphrase records and **0 distractor records**. Distractors
were only ever *inserted* into the pool, never *looked up* against it. The "0% false positives"
headline was structural, not a measurement. The ten "distractors" were also general-knowledge
trivia (*"What is the capital of Australia?"*) — no same-domain hard negatives.

**F6 — The FP rate is a function of corpus size, and it was only ever measured at N=20.**
A nearest-neighbour distance shrinks as the pool grows; a threshold calibrated at 20 documents is
optimistic by construction. And the `FLAT` vector index scans every candidate:

```
n=1,000     →   1.5 MB of vectors per query     (~1 ms)
n=10,000    →  15.4 MB                          (~5 ms)
n=100,000   → 153.6 MB                          (~51 ms)
```

**F7 — A cache failure became a product failure.**
`redis.RedisError` was caught around the *store* path but not around either *lookup* path. A Redis
timeout produced an unhandled exception → HTTP 500, with no fallback to inference. If Redis was
down at boot, the store latched a "memory mode" that never recovered and never told the caller the
cache was off.

**F8 — Served hits replayed the original response's identity.**
A cache hit returned the *first* request's `id`, `created` timestamp and token `usage` verbatim.
Any cost accounting or client-side de-duplication built on those fields was wrong from the second
request onwards.

**F9 — The proxy blocked its own event loop.**
`SentenceTransformer.encode` (~15-17 ms of CPU) and the synchronous Redis client both ran inside
`async def chat_completions`. Every request paid the full block, serialising concurrent traffic.

**F10 — Ollama already caches prompt prefill.**
Ollama 0.40.14 gives `cached_tokens` in `usage` and makes bit-identical repeats ~2.5× faster on its
own (7.6 s → 2.9 s). So the honest benefit of an exact tier is *that difference*, not the full
inference cost. Any "we saved X" claim measured against cold inference overstates the win.

**F11 — Redis 8.10.3 vector-search dialect quirks** (only relevant if Redis is kept):
`PARAMS` counts *tokens* not name/value pairs; params are rejected inside TAG terms (values must be
inlined and backslash-escaped); `VECTOR_RANGE` needs a literal radius and `DIALECT 2`; FT indexes
can only be created on DB 0; redis-py ≥5 auto-parses `FT.SEARCH` replies into a dict.

---

## 3. Requirements carried forward

Each requirement is derived from a finding in the scrapped review and is written so the new
backend can be checked against it. `docs/UI-CONTRACT.md` supplies the rest of the external
contract.

| ID | Requirement | Derived from |
|---|---|---|
| **R-1** | No header derived from user input may contain non-ASCII bytes. Percent-encode or strip. | F4 |
| **R-2** | The cache key and the semantic vector must be computed from the **full conversation** (system + all turns), not only the last user message. | F2 |
| **R-3** | Request hashing must be **denylist-based** (hash everything except a small set of known-inert keys). Default to hashing unknown parameters. | F3 |
| **R-4** | A cached answer may only be served if it is **verified to answer *this* request** — scope match plus, where available, deterministic recomputation. Similarity is a *candidate selector*, never an authorisation. | F1 |
| **R-5** | Every cache entry carries **provenance** (which scope it belongs to, which prompt produced it, when, by which model) and may be **individually invalidated**. | review P0-6 |
| **R-6** | **Fail open.** Any store/lookup/inference error must degrade to "run the inference and answer", never to an error response. Circuit-break a failing store rather than retrying it per request. | F7 |
| **R-7** | Every served response gets a freshly minted `id`/`created`; token `usage` is not replayed from the original request. | F8 |
| **R-8** | No blocking I/O on the request path. Storage lookups and embedding must be awaitable, and concurrent requests must not serialise behind one CPU-bound call. | F9 |
| **R-9** | **Single-flight.** N concurrent identical requests produce exactly one inference. | — |
| **R-10** | **Scope isolation.** Entries from one caller/tenant/asset scope are never served to another. | — |
| **R-11** | Every mutating admin endpoint requires a token; nothing destructive is open to the network. Redis must not be published unauthenticated. | — |
| **R-12** | The exact tier is an O(1) key lookup, not a vector-index scan. The vector index must be stated to scale (index algorithm + measured cost at N). | F6 |
| **R-13** | The benchmark's headline metric is **answer correctness on served hits**, not hit rate. Hit rate is a supporting number. | F5 |
| **R-14** | Benchmarks must include **distractors replayed against a populated pool**, **same-domain hard negatives**, **multiple corpus sizes**, and **confidence intervals**. | F5, F6 |
| **R-15** | "Inference avoided" must be reported **both** against cold inference and against Ollama's own prefill cache. | F10 |
| **R-16** | Event text must be capped and optionally redacted (needs a UI change to `/stats`; see UI-CONTRACT §2). | — |
| **R-17** | Observability: counters, latency, **cost accounting** (tokens and dollars per unit of work), structured logs with request ids, and a Prometheus-format metrics endpoint. | — |
| **R-18** | One toolchain if possible. Do not rebuild a Python venv if the dashboard is already Node. | F9 (25 MB of deps for a cache) |

Non-requirements (explicitly out of scope, so nobody re-litigates them): multi-tenancy at cloud
scale, a gateway with many upstream providers, auth UI, billing.

---

## 4. Open decisions — these block the build

> **Status: all four are now resolved.** They were answered while building, and the
> answers are recorded here because the reasoning still matters.
>
> | Decision | Resolution |
> |---|---|
> | **DEC-1 stack** | **Node/TypeScript + `node:sqlite` + Redis (Podman) + ONNX MiniLM.** One toolchain, and it removes ~2.5 GB of torch from the runtime. `node:sqlite` (SQLite 3.54 built into Node 26) also removes the native-build dependency that `better-sqlite3` needed. |
> | **DEC-2 product identity** | **The acceleration layer for the SOP's 7-step pipeline**, with the generic `/v1/chat/completions` proxy kept as the layer underneath it. The `/content/*` surface carries the envelope, review status and provenance. |
> | **DEC-3 model / inference** | **`Qwen2.5-7B-Instruct` + the `aws-enterprise-assistant` QLoRA adapter**, served by llama.cpp with the adapter applied at runtime (`--lora-scaled`) so no FP16 merge is needed on a 14 GB box. Deterministic-first, model-fallback — the template tier answers what it can in code. |
> | **DEC-4 benchmark negatives** | **Still open.** Needs the SOP's Chapter-1 asset files to build hard negatives (SET-07 vs SET-08). The current corpus is AWS-shaped, so the negatives are template-parameter near-misses rather than concept near-misses. |

Fill these in and the rebuild can start the same day. My recommendation is listed first in each;
the alternatives are what I would want argued back.

### DEC-1 — Stack

*(You said: "the dashboard stays as it was. The model and the inference will need rethinking.")*

The dashboard is vanilla JS with Node as dev tooling. Options:

| Option | Storage | Embeddings | Trade-off |
|---|---|---|---|
| **Node/TypeScript + SQLite + sqlite-vec** *(recommended)* | `better-sqlite3` + `sqlite-vec` | `@xenova/transformers` / `onnxruntime-node`, running `all-MiniLM-L6-v2` | **One toolchain end to end.** No Docker, no second service, no Redis auth hole, no FT-dialect quirks (F11), no `.venv`. A single-file database makes invalidation, provenance and O(1) exact keys trivial, and `sqlite-vec` gives a real ANN index. Cost: a new vector extension dependency, and an embedder port must be validated. |
| Node/TypeScript + Redis | Redis 8 | same | Keeps F11 as a cost, and the network/auth surface. |
| Python + FastAPI + SQLite | same | `sentence-transformers` | Keeps the validated embedder, but two toolchains and a 1.3 GB venv. |
| Go + SQLite | same | separate service or ONNX binding | Fastest runtime, riskiest embedding path. |

If DEC-1 is Node, `R-18` is satisfied and the repo's entire runtime dependency story becomes
`npm install`.

### DEC-2 — Product identity

*(You said: "I'll get to that soon.")*

My review's conclusion: the SOP PDF is the real spec, and the old code was a generic cache proxy
its own benchmark couldn't support. The three shapes:

1. **The acceleration layer for the 7-step JEE content pipeline.** Requests carry a content
   envelope (chapter, concept, asset type, difficulty, review status); cache keys and semantic
   scope derive from it; hits must pass verification and a review-status floor; there is
   invalidation on review. This is the only option that closes R-4, R-5 and R-10 properly.
2. **A correct generic cache proxy.** Same product as before, minus the bugs. Cheaper, but the
   benchmark still has nothing honest to measure (F5, F6) and the demo still isn't the SOP.
3. **Both** — the pipeline is the product; the generic proxy is an internal layer with the fixes.

Recommendation: **(3)**, built pipeline-first. The UI's Send panel then keeps working as-is, and
the content pipeline is a new endpoint that reuses the same internals.

### DEC-3 — Model / inference layer

*(You said: "the model and the inference will need rethinking.")*

| Option | What it means |
|---|---|
| **Hybrid: deterministic-first, model-fallback** *(recommended)* | Any content the SOP can generate from a **template** (practice questions, membership checks, arithmetic variants) is produced and verified by code — no LLM, no cost, no false positives, and the answer is *provably* correct. The model is called only for genuinely open-ended assets (explanations, hints, misconceptions) where a verifier is possible or a human review gate applies. This directly satisfies R-4 (verification is intrinsic, not bolted on) and matches the SOP's own rule: *"Use AI generation mainly for wording diversity … or formats not conveniently expressed by a deterministic template."* |
| Bigger local model | Replace `llama3.2:3b` with something stronger via Ollama. Doesn't address F1 — a better model still can't make a distance threshold safe. |
| API model (Claude/GPT/Gemini) | Breaks the offline claim; needs key management; turns cost accounting from a nice-to-have into a necessity (R-17 becomes blocking). |

### DEC-4 — Where the benchmark's negatives come from

Needs the SOP's Chapter-1 asset files (concepts, learning objects, questions, templates) to build
hard negatives like SET-07-vs-SET-08. Without them the benchmark can only reuse the old
general-knowledge distractors, which F5 showed are worthless.

---

## 5. Build order once decisions land

1. **Storage + keying** (DEC-1): schema, O(1) exact key with denylist hashing (R-3), provenance
   fields, individual invalidation (R-5), fail-open error handling with a circuit breaker (R-6).
2. **The request path**: non-blocking (R-8), single-flight (R-9), fresh response identity (R-7),
   ASCII-safe headers (R-1).
3. **Scope + verification** (R-4, R-10, DEC-2/DEC-3): the envelope, the scope filter, the
   verifier registry, the review-status floor.
4. **`/stats` + the UI contract**: build to `docs/UI-CONTRACT.md`, then gate on
   `node scripts/check_api_contract.mjs` — do not proceed until it exits 0.
5. **Deterministic template path** (DEC-3) with its own tests.
6. **Benchmark** (R-13 … R-15, DEC-4) — and only publish numbers it can defend.
7. **Observability** (R-17), security (R-11), then the README rewrite.