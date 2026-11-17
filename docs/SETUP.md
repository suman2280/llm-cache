# Setup guide

> **Baseline:** commit `f84f2d7`, tagged **`v0.2-baseline`** on `origin`, is the reference build
> — the three cache tiers, the domain guard, RAG grounding, the repetition and grounding checks,
> KB-chunk equivalence, the Clear-cache button, and the collaborator setup guide. It passes
> 91 unit tests / 44 contract checks / 13 browser checks. **Every feature from here on is added
> on top of that tag.** When something regresses, `git diff v0.2-baseline` is the first thing to
> look at.

This is the guide for a new collaborator. It assumes a Linux machine with no GPU and roughly
16 GB of RAM — the reference environment. Nothing here needs an API key or a cloud account.

If anything fails, jump to [Troubleshooting](#troubleshooting).

---

## 1. What you need

| Requirement | Why | Check |
|---|---|---|
| Linux, 12+ CPU cores, **12–16 GB RAM** | A 7B model at Q4 uses ~4.6 GB. Less than ~10 GB will be painful. | `free -h` |
| **~12 GB free disk** | ~4.4 GB of GGUF weights, ~2 GB of llama.cpp build output, ~1 GB of Python deps | `df -h` |
| **Node ≥ 20.6** | The app uses `node --env-file`. Tested on Node 26. | `node -v` |
| **uv** | Builds the one-off Python venv used to convert the LoRA adapter | `uv --version` |
| **Podman** | Runs Redis 8. Docker is deliberately not used. | `podman --version` |
| **git, gcc, g++, make, cmake, curl** | llama.cpp is built from source | `which git gcc g++ make cmake curl` |

You do **not** need Docker, Python for the app itself, or any external API. Python is only used
by `setup_model.sh` to convert the adapter once.

---

## 2. Clone and set up

```bash
git clone git@github.com:suman2280/llm-cache.git
cd llm-cache
```

### 2.1 Install Node dependencies

```bash
npm install
```

### 2.2 Start Redis

```bash
podman run -d --name llm-redis \
  -p 127.0.0.1:6379:6379 \
  --restart unless-stopped \
  --memory 192m --cpus 1.0 \
  docker.io/library/redis:8 \
  redis-server --save "" --appendonly no

podman exec llm-redis redis-cli ping     # -> PONG
```

`--restart unless-stopped` survives a container restart but **not a host reboot on rootless
Podman** (there is no user systemd unit here). If Redis is down after a reboot, run
`podman start llm-redis`, or just use `scripts/dev.sh`, which starts it for you.

### 2.3 Build the model layer

```bash
bash scripts/setup_model.sh
```

This single script:

1. clones `llama.cpp` into `~/llm-cache-tools/llama.cpp` (outside the repo, so a reboot or a
   `git clean` cannot destroy a 10-minute build), and builds `llama-server` with
   **`-DGGML_CPU_REPACK=OFF`** — that flag is the difference between 7.66 GB and 4.59 GB of RAM
   at the same throughput;
2. downloads the prebuilt Qwen2.5-7B-Instruct Q4_K_M GGUF (~4.4 GB) — no 15 GB conversion;
3. downloads the 9.7 MB QLoRA adapter from
   `Debarun12/aws-enterprise-assistant-qwen2.5-7b-qlora` and converts it to GGUF using a one-off
   Python 3.12 venv with CPU-only torch;
4. writes a `.env` with **absolute paths for this machine**, because Node's `--env-file` does not
   expand `~`.

The script is idempotent — safe to re-run. If `.env` already exists it is left alone and the
three paths are printed for you to paste.

> **Why a fine-tune needs a base model:** the HuggingFace repo ships only a 9.7 MB *adapter*,
> not a runnable model. `llama.cpp` applies it at runtime with `--lora-scaled`, so there is no
> need to merge a 15 GB FP16 model in memory.

### 2.4 Start the app

```bash
bash scripts/dev.sh --wipe
node scripts/seed_corpus.mjs
```

`dev.sh` starts Redis if needed, stops whatever owns port 8000, and launches the backend. The
`--wipe` flag clears the SQLite cache and the Redis vector index for a clean start.

Open <http://localhost:8000/dashboard/>.

You should see the config strip report `qwen2.5-7b-instruct`, `all-MiniLM-L6-v2`, and
`● live`. The model is **not running** at this point — it is spawned on the first genuine miss
and killed 120 s after the last one.

---

## 3. Check your setup

Run these before changing anything:

```bash
npm test                                   # 106 unit tests, no services needed
node scripts/check_api_contract.mjs        # backend must satisfy the dashboard contract
node scripts/bench_cache.mjs               # verifier recall + FPR, no model needed
node scripts/ui_smoke.mjs                  # drives the real dashboard in headless Chrome
```

For the browser smoke, Chrome is discovered automatically (system install, then the
puppeteer cache). If yours is elsewhere:

```bash
CHROME_PATH=/path/to/chrome node scripts/ui_smoke.mjs
```

To install a browser: `npx puppeteer browsers install chrome`.

Useful smoke checks that need no browser:

```bash
curl -s localhost:8000/healthz | python3 -m json.tool
curl -s localhost:8000/stats | python3 -m json.tool
curl -s localhost:8000/demo/prompts | python3 -m json.tool
```

---

## 4. How a request flows

Read this before changing the cache logic.

```
POST /v1/chat/completions
   |
   +-- domain guard          src/domain.js     in/out of the loaded domain
   |
   +-- tier 0  deterministic  src/templates.js  (template + params) computed in CODE
   |                                              -> no model, no embedding
   |
   +-- tier 1  exact          src/store.js      denylist hash -> O(1) SQLite row
   |
   +-- tier 2  semantic       src/vectors.js    Redis, filtered by scope AND by
   |                                              the KB chunk ids it grounds in
   |              |
   |              +-- verifier  src/cache.js      shared KB chunk + term coverage
   |              +-- verifier  src/lexicon.js    symbol fingerprint, stemming
   |              +-- verifier  src/grounding.js  the CACHED answer is about this query
   |
   +-- miss                   src/domain.js / knowledge.js
                               retrieve reference chunks -> ground the system prompt
                               -> src/model.js spawns llama-server -> generate
                               -> src/degenerate.js + src/grounding.js check the output
                               -> store (or serve labelled + uncached)
```

Three rules that are easy to break:

1. **Never use the rendered conversation where you need the user's question.** `semText`
   carries a `USER:\n` prefix; embedding or retrieving with it reordered results badly enough
   that an `aws` question came back about IAM.
2. **A cosine distance is not a correctness criterion.** `redis aws` sits at `d=0.349` inside a
   0.35 radius. The KB chunk is the equivalence signal; the distance only ranks.
3. **Nothing that failed a check may be cached.** A bad answer replayed to every later request
   is worse than no cache.

---

## 5. Where to make changes

| I want to... | Edit | Then run |
|---|---|---|
| add an AWS fact / fix a wrong answer | `knowledge/aws-knowledge.json` | `node --test tests/knowledge.test.js` |
| change what the demo asks | `src/corpus.js` → `DEMO_PROMPTS` | `node scripts/ui_smoke.mjs` |
| change the cache's accept/reject rule | `src/cache.js`, `src/lexicon.js`, `src/grounding.js` | `npm test` + `node scripts/check_api_contract.mjs` |
| add a deterministic template | `src/templates.js` | `node --test tests/templates.test.js` |
| change the dashboard | `dashboard/` | `node --test dashboard/` + `node scripts/check_dashboard.py` + `node scripts/ui_smoke.mjs` |
| change settings / add an env var | `src/config.js` and `.env.example` | `npm test` |

The dashboard was kept from the earlier build because it was good, and the backend is written to
its contract in [`docs/UI-CONTRACT.md`](./UI-CONTRACT.md). If you change an endpoint's response
shape, update that document and the contract checker together.

---

## 6. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `fetch failed` from the contract checker | app is not listening | `bash scripts/dev.sh --wipe` |
| `/healthz` says `redis: false` | Podman container stopped | `podman start llm-redis` |
| `EADDRINUSE :8000` | an old backend is still running | `bash scripts/dev.sh` kills the port owner before starting |
| `redis-cli: command not found` | client only exists inside the container | use `podman exec llm-redis redis-cli …` |
| `spawn ENOENT llama-server` | setup did not complete | re-run `bash scripts/setup_model.sh`; check `LLAMA_SERVER_BIN` in `.env` |
| `request (N tokens) exceeds the available context size (512)` | `MODEL_CTX=512` from an old `.env` | set `MODEL_CTX=2048`; grounding needs the room |
| answers come back too short | `repeat_penalty` or DRY turned on | keep `REPEAT_PENALTY=1.0`, `DRY_MULTIPLIER=0.0` |
| `x-cache-policy: ungrounded` | the KB has no source for that question | add a chunk to `knowledge/aws-knowledge.json`, or accept that it is served but not cached |
| a question returns 422 | the domain guard rejected it | expected for out-of-domain; set `DOMAIN_MODE=bypass` to answer-and-label instead |
| 404 from a `/cache/*` route | no admin token and not a same-origin browser request | send `X-Admin-Token`, or `Sec-Fetch-Site: same-origin` |
| an answer repeats one line 15× | a repetition loop slipped through | it is detected, retried, then refused or served unlabelled — check `[generation]` in the app log |
| `Cannot access 'X' before initialization` | a TDZ error swallowed by a tier's catch | check variable declaration order; these errors silently degrade a tier to a miss |
| a semantic tier looks "dead" (all misses) | check the app log for `[cache] semantic tier degraded` | fix the underlying error; the catch deliberately fails open |

The **contract checker is the fastest way to tell whether your changes broke the dashboard**:
if it prints `40/40 contract checks pass`, the UI still works against the backend.

---

## 7. Pushing a change

```bash
npm test
node scripts/check_api_contract.mjs
node scripts/ui_smoke.mjs
git add -A && git commit -m "..."
git push origin main
```

Do not commit `.env`, `models/`, `data/`, `node_modules/`, or the `tools/` build output — they
are all gitignored.
