# Phase 0 — Validation Results

Recorded during the initial build (2026-11-06) on the author's machine:
CPU-only, 12 cores / 14 GB RAM, `llama3.2:3b` on Ollama 0.40.14, Redis 8.10.3
(Docker), embedder `sentence-transformers/all-MiniLM-L6-v2` (384-d).

Scripts live in `scratch/` (gitignored); the permanent, reproducible version of
this evidence is the benchmark harness (`uv run python -m llm_cache.benchmark`).

| # | Experiment | Question | Result | Verdict |
| --- | --- | --- | --- | --- |
| E0 | Embedding separation | Do rephrasings cluster apart from distractors? | Rephrase→nearest same-topic: p50 **0.090**, max **0.208**. Distractor→nearest topic: min **0.615**. ~3× gap. Radius 0.20 ⇒ 96.7% hit / 0% FP; 0.15 ⇒ 80% / 0%. | ✅ Go — threshold default set to 0.20 |
| E1 | Redis vector smoke | Does the production query shape work against `redis:8`? | Yes, after fixing three Redis 8.10 facts (see below) | ✅ |
| E2 | Ollama probe | Usage reporting? Internal prompt caching? `keep_alive` via `/v1`? | (1) non-streaming returns full `usage` incl. `prompt_tokens_details.cached_tokens`. (2) **Ollama 0.40.14 caches prompt prefill itself** — repeat of the same prompt went 7.6s → 2.9s with `cached_tokens: 33/34`. (3) `keep_alive` accepted via `/v1/chat/completions` (HTTP 200). | ✅ (and reshaped the benchmark's honesty) |
| E3 | Overhead | Embed + Redis lookup cost vs inference | ~20 ms embed + ~1.5 ms Redis vs ~2.9 s warm inference (~190× overhead margin) | ✅ |

## E1 findings — Redis 8.10.3 query syntax (now encoded in `store.py`)

1. **`PARAMS` counts tokens, not name/value pairs** (`PARAMS 2 v <bytes>` for one
   param). Passing the pair count yields `SEARCH_ADD_ARGS`.
2. **Params are not accepted inside TAG terms** — `@req_hash:{$h}` is a syntax
   error; tag values must be inlined (backslash-escaped; `_escape_tag`).
3. **`VECTOR_RANGE` requires a literal radius and `DIALECT 2`**; the radius cannot
   be a `PARAMS` binding. (The query vector itself is still a binary param.)
4. **FT index creation is DB-0 only** (`Cannot create index on db != 0`) — tests
   use DB 0 with their own prefixes/index name.
5. redis-py ≥5 **auto-parses FT.SEARCH replies into a dict**, so `_parse_docs`
   handles both the parsed dict and raw RESP2 arrays.

## E2 consequence — what the benchmark can honestly claim

Ollama's own KV/prompt cache already makes *bit-identical* repeats ~2.5× faster
(7.6s → 2.9s). It cannot help **rephrasings** (different token sequences), while
this cache turns any hit into ~1–25 ms. The benchmark therefore measures:

- time/cost of inference *avoided* (summed baseline latency per cache hit), and
- the semantic tier's failure mode — distractors served from cache — as a
  first-class metric.

## E0 distance detail (50 prompts: 10 seeds + 30 rephrasings + 10 distractors)

```
rephrase -> nearest same-topic : min 0.024  p50 0.090  max 0.208
distractor -> nearest topic    : min 0.615  p50 0.832  max 0.913

radius | rephrase hit rate | distractor false-hit rate
0.05   |             20.0% |                     0.0%
0.10   |             66.7% |                     0.0%
0.15   |             80.0% |                     0.0%
0.20   |             96.7% |                     0.0%
0.25   |            100.0% |                     0.0%
```

E0 measures "nearest same-topic prompt" — sibling rephrasings count as
candidates. The stricter benchmark (rephrase vs *seed-only* pool, siblings
purged) reports 93.3% at radius 0.20 — see `results/results.md`; both clear
the success bar with a ~0.4 margin to the nearest off-topic question.

## Final benchmark (reference machine, 2026-11-06)

```
radius | rephrase hit rate | distractor false-hit rate | hit p50 (ms)
0.05   |             13.3% |                     0.0% |        19.8
0.10   |             53.3% |                     0.0% |        19.2
0.15   |             76.7% |                     0.0% |        19.0
0.20   |             93.3% |                     0.0% |        18.2
0.30   |            100.0% |                     0.0% |        16.4
```

- Baseline (direct to Ollama): mean 2245 ms, p50 2392 ms, 50 prompts.
- Recommended radius: **0.20** (tightest meeting the ≥80% / ≤1% bar) — now the
  shipped `LLM_CACHE_DISTANCE_THRESHOLD` default.
- At radius 0.20: 72.6 s of inference avoided across the sweep, hit p50 ≈18 ms
  (~125× faster than the baseline mean).
- An earlier benchmark iteration had the runner vary only its *reporting* math
  while the server kept one fixed threshold — caught because E0 predicted 20%
  at radius 0.05 but the sweep showed 93%. The runner now spawns a proxy per
  radius (see `store.py` / `_proxy_server`).

## Bugs the phase caught before they mattered

- `_counter_field` mapping mismatch → live 500s on every request (fixed + live
  regression test added: `test_record_event_and_stats`).
- Semantic tier crossed temperature-class boundaries → served deterministic
  answers to sampled requests (fixed with `tclass` pre-filter + tests).
- `FT.INFO`-string error matching assumed RediSearch wording → replaced with
  `FT._LIST` existence check.
