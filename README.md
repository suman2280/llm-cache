# llm-cache

A **governed response cache** in front of a local LLM. Requests that can be answered
without the model are; requests that cannot are verified before they are reused.

The premise: *inference is the expensive part, and most of it is avoidable.* A 7B model on
a CPU box takes **6–20 seconds** per answer. A cache hit on this project takes **0.4–14 ms**.
The whole design is about making the second number the common one.

![the dashboard, live against the new backend](docs/images/dashboard.png)

*One run of the demo, live: **p50 5 ms** against **p99 24.7 s**. The gap is the product.*

This is being built as the **preview for the JEE AI Tutor content-creation SOP**
([`docs/REBUILD.md`](./docs/REBUILD.md)). The dashboard — kept from the previous build
because it was good — is **frozen**, and the backend is written to its contract
([`docs/UI-CONTRACT.md`](./docs/UI-CONTRACT.md)).

---

## The preview, in one run

```bash
node scripts/demo_preview.mjs
```

```
1. deterministic tier — a template answered by CODE
  template T-EC2-COST    deterministic-hit      0.5 ms  deterministic:T-EC2-COST
     answer: $280.32 for the month
  same template, 160h    deterministic-hit      0.5 ms  differ from 730h by ONE number
     answer: $61.44 for the month
     correct: $61.44, NOT the 730h answer

2. exact tier — a byte-identical request
  first ask              miss               6267.5 ms
  identical re-send      exact-hit             0.6 ms
  with top_k=1           miss               6144.6 ms  different param -> must not be a hit

3. semantic tier — a rewording (the model is still stopped)
  rewording              semantic-hit         14.1 ms  from: "What is S3 storage classes?"

4. miss — the one request that genuinely needs the model
  genuinely new          miss              16429.0 ms
  asked again            exact-hit             0.4 ms

  model invocations for the whole run : 3
  requests that never touched the model: 5 of 8 (63%)
```

Read it as three separate claims:

1. **A template is answered by code** — 0.5 ms, and the answer is *correct by construction*.
   The same template with one parameter changed produces a different answer, because the
   cache key is `(template, parameters)`, not the prompt text.
2. **A byte-identical request is a hit** — 0.6 ms — but a request that differs in
   `top_k` is **not**, even though the text is identical.
3. **A rewording is a hit** — 14.1 ms — after the *whole conversation* is embedded and the
   candidate is **verified**. The verifier rejected 2 candidates during this run; those
   were served from inference instead of silently reused.

---

## The three tiers

| Tier | Key | Cost | Model? | When |
|---|---|---|---|---|
| **0 · deterministic** | `(template_id, parameters)` | **0.3 ms** | **no** | the SOP says *"Start with deterministic templates whenever the answer can be computed from controlled parameters"* (line 595) |
| **1 · exact** | sha256 of model + messages + **every answer-affecting param** | **0.6 ms** | **no** | byte-identical request |
| **2 · semantic** | embedding of the **whole conversation**, vector search **pre-filtered by scope**, then **verified** | **8–14 ms** | **no** | a rewording of the same question in the same scope |
| **miss** | — | 6–20 s | **yes** | genuinely new work |

### The verifier is the point

Tier 2 does **not** serve a cached answer because it is nearby. A candidate must survive:

1. **Scope match** — enforced by the Redis TAG pre-filter, not by hope. A `SET-07`
   learning object is in a different scope from `SET-08`'s and cannot be a candidate.
2. **Symbol fingerprint** — the multiset of non-alphanumeric glyphs must match. A generic
   sentence embedder cannot tell `⊂` from `∪`: measured on the previous build, **10 of 11
   maths prompt pairs needing different answers landed inside its shipped radius**.
3. **Deterministic recomputation** — if the candidate was template-generated, recompute it
   from its own parameters and compare. A candidate whose stored answer no longer matches
   its template is rejected.
4. **Review floor** — an entry below the required `review_status` is never served to the
   tutor path.

A rejected candidate is **counted and logged**, not hidden: `semantic-hit-rejected`.

---

## Memory: the model is not a resident service

The model is spawned **on the first genuine miss** and killed when it goes idle. The box
serves everything else at Node speed with no model resident at all.

| State | Memory |
|---|---|
| App idle, model unloaded | **191 MB** (Node) — ~250 MB more once the embedder loads |
| Model resident (7B Q4_K_M, ctx 512) | **4.72 GB RSS**, of which ~4.6 GB is file-backed and reclaimable |
| Redis (Podman, capped 192 MB) | ~25 MB |

`LLM_MODEL_IDLE_S` controls it: `0` unloads after every request, `120` (default) after two
idle minutes, `-1` never.

The single biggest memory win was a build flag. With llama.cpp's default
`GGML_CPU_REPACK=ON`, the 7B model exists **twice** in memory — **7.66 GB RSS, 3.13 GB of
it anonymous**. With it off: **4.59 GB RSS, 109 MB anonymous**, and **identical throughput**
(the repack path targets Q4_0; this GGUF is Q4_K_M). See [`docs/MODEL-FINDINGS.md`](./docs/MODEL-FINDINGS.md).

---

## The model

`Debarun12/aws-enterprise-assistant-qwen2.5-7b-qlora` — a **9.7 MB LoRA adapter**, not a
runnable model. The base is `Qwen/Qwen2.5-7B-Instruct`.

Llama.cpp loads LoRA **at runtime** (`--lora-scaled`), so no merge is needed — merging would
require holding the 15.2 GB FP16 base in memory on a 14 GB box.

```bash
bash scripts/setup_model.sh     # idempotent: builds llama.cpp, downloads the model, converts the adapter
```

The setup is reproducible and keeps the build out of `/tmp` (a reboot otherwise destroys
~10 minutes of compile).

**Measured**: ~7.5 tok/s on 12 CPU threads; a 150-token answer takes ~20 s; the model loads
in ~3 s; the embedder takes 9 ms per 384-d vector.

> **One finding worth flagging.** The model card claims *"correctly refuses 100% of
> out-of-scope questions"*. Tested against six out-of-scope questions with its own suggested
> system prompt, it refused **zero** of them. A 0.03 %-of-parameters adapter trained for 17
> minutes does not reliably encode that safety property. That is precisely why the SOP's
> *"no derived content is approved only because an AI generated it"* has to be enforced in
> code — and it is a good thing to show a stakeholder.

---

## Running it

```bash
# prerequisites
podman run -d --name llm-redis -p 127.0.0.1:6379:6379 \
  --restart unless-stopped --memory 192m --cpus 1.0 \
  docker.io/library/redis:8 redis-server --save "" --appendonly no

bash scripts/setup_model.sh
cp .env.example .env      # then edit the paths setup_model.sh printed

# run
bash scripts/dev.sh --wipe        # restart cleanly (kills whatever owns :8000)
node scripts/seed_corpus.mjs      # seed 29 Chapter-1 assets
```

Then open <http://localhost:8000/dashboard/>.

| Command | What it does |
|---|---|
| `npm start` | serve on :8000 (dashboard at `/dashboard/`) |
| `npm run demo` | the preview above |
| `npm run seed` | seed the demonstration corpus |
| `npm run contract` | assert the backend satisfies the frozen UI's contract |
| `npm run bench:model` | measure the inference layer (throughput, latency, memory, refusal) |
| `npm test` | 36 tests: the dashboard's reconciliation planner + the backend's keying and templates |
| `npm run check:dashboard` | every id `app.js` reaches for exists in `index.html` |
| `node scripts/ui_smoke.mjs` | drive the dashboard in a real Chrome (11 checks) |
| `node scripts/screenshot.mjs` | capture the dashboard for the docs |

### The acceptance gates

The dashboard is frozen, so the backend is checked against it mechanically:

```bash
node scripts/check_api_contract.mjs http://localhost:8000
# 38/38 contract checks pass.
# The frozen dashboard will work against this backend unchanged.
```

It asserts the `/stats` shape, the `X-Cache-*` headers on all five statuses, that a
non-ASCII prompt does **not** 500, that the exact tier respects every answer-affecting
parameter, that a served hit mints a fresh `id`, that event ids survive `/stats/reset`, and
that `x-cache-source-prompt` is ASCII-safe.

And in a real browser, against the real backend:

```bash
npx puppeteer browsers install chrome   # once
node scripts/ui_smoke.mjs
# 11/11 checks passed
```

which drives the dashboard's **Run the demo** button through
`miss → exact-hit → semantic-hit`, checks the row expands to the full answer, checks the
stale banner when `/stats` stops answering, and asserts **zero external requests**.

---

## The SOP mapping

The demo corpus is AWS-shaped (`MATH-01-AWS`) so that every gate in the SOP maps 1:1 onto a
real asset. Swapping in the JEE *Sets* corpus is a data change, not a code change — the
cache never depends on the domain.

| SOP requirement | Line | Where it lives |
|---|---|---|
| *"Start with deterministic templates whenever the answer can be computed"* | 595 | tier 0 (`src/templates.js`) |
| *"store the template_id, parameters, actual_answer"* | 596 | `template_key` + `actual_answer` on every entry |
| *"Verify the answer by code/rule"* | 597 | the verifier's deterministic recomputation |
| *"Use AI generation mainly for wording diversity"* | 599 | tier 2, and only inside a scope |
| *"must be independently checked … human academic review"* | 601 | `review_status` + the review endpoint |
| *"Near-duplicate objects are removed"* | 314, 604 | `POST /content/near-duplicates` — the same vector search, used to **reject** |
| *"hand-off to the database/RAG pipeline"* | 750 | `GET /content/records` — the inventory with provenance |

---

## Layout

```
src/
  main.js       entrypoint (model and embedder are lazy)
  server.js     HTTP surface: /v1/chat/completions, /stats, /healthz, /content/*
  cache.js      the three tiers + the verifier
  keying.js     denylist request hash, scope, symbol fingerprint, ASCII-safe headers
  store.js      SQLite (node:sqlite): entries, provenance, review state, events
  vectors.js    Redis vector index for the semantic tier
  embedder.js   lazy ONNX MiniLM
  model.js      model supervisor: spawn on a miss, kill when idle
  templates.js  deterministic templates (the tier that never calls the model)
  corpus.js     the AWS-shaped demonstration corpus
dashboard/      FROZEN — the spec this backend is written against
docs/
  UI-CONTRACT.md    what the frozen dashboard requires
  REBUILD.md        requirements, hard-won facts, open decisions
  MODEL-FINDINGS.md measured facts about the model and the build
scripts/
  setup_model.sh    build llama.cpp, fetch the model, convert the adapter
  demo_preview.mjs  the preview
  check_api_contract.mjs  the acceptance gate
  bench_model.mjs   measure the inference layer
  dev.sh            restart cleanly
```

## License

MIT — see [`LICENSE`](./LICENSE).
