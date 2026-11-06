# llm-cache benchmark results

- generated: 2026-11-06 13:56:35
- dataset: src/llm_cache/benchmark/dataset/qa.yaml (30 rephrasings, 10 distractors)
- model: `llama3.2:3b` via Ollama, proxy: spawned per sweep on localhost:8123

## Baseline — every prompt sent directly to Ollama

| metric | value |
|---|---|
| prompts | 50 |
| mean latency (ms) | 2320.8 |
| p50 / p95 (ms) | 2443.6 / 3309.6 |
| total inference time (s) | 116.0 |

## Threshold sweep — replay through the proxy (fresh cache per threshold)

Cosine distance radius; lower = stricter semantic matching. Any distractor hit at a radius is a **false positive**.

| radius | rephrase hit rate | distractor false-hit rate | hit p50 (ms) | hit p95 (ms) | miss mean (ms) | inference avoided (s) |
|---|---|---|---|---|---|---|
| 0.05 | 13.3% (4/30) | 0.0% (0/10) | 19.8 | 26.9 | 2255.2 | 10.6 |
| 0.08 | 40.0% (12/30) | 0.0% (0/10) | 21.5 | 29.0 | 2220.0 | 29.6 |
| 0.1 | 53.3% (16/30) | 0.0% (0/10) | 19.2 | 25.6 | 2155.7 | 39.1 |
| 0.15 | 76.7% (23/30) | 0.0% (0/10) | 19.0 | 23.0 | 2125.6 | 57.8 |
| 0.2 | 93.3% (28/30) | 0.0% (0/10) | 18.2 | 23.1 | 1926.9 | 72.6 |
| 0.3 | 100.0% (30/30) | 0.0% (0/10) | 16.4 | 21.0 | 1909.3 | 77.0 |

## Recommendation

**radius 0.2** (success_bar): 93.3% rephrase hits, 0.0% false hits, hit p50 18.2 ms, ≈72.6s inference avoided.

## False-positive spot-checks (distractors served from cache)

_No distractor hits at any radius — the cache never answered off-topic._

## Method

1. **Baseline**: every prompt is sent directly to Ollama exactly once; per-prompt latency is recorded to `baseline.json`.
2. **Population pass** (per run): the topic seeds and distractors are sent through the proxy once to populate the cache with *known* entries.
3. **Sweep**: for each cosine radius the runner spawns a fresh proxy with that radius as its configured `LLM_CACHE_DISTANCE_THRESHOLD` (the radius is process config, not per-request state) and replays the rephrasings. Each rephrase's cache document is removed right after its request, so hits can only come from the fixed population pool — no sweep-to-sweep or intra-sweep cascades.
4. **Inference avoided** sums the baseline latency of each prompt that was served from cache.
