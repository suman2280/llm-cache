/**
 * #68: llama.cpp prompt/KV prefix caching + prefill/decode observability.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import config from "../src/config.js";
import { Store, setStore, resetStore, getStore } from "../src/store.js";
import { useMemoryVectors } from "../src/vectors.js";
import { setInferForTests } from "../src/model.js";
import { defaultCmd, extractTimings } from "../src/model.js";
import { setEmbedForTests } from "../src/embedder.js";
import { setRetrieveForTests, resetKnowledgeForTests } from "../src/knowledge.js";
import { handleChat, invalidateVectorCache, statsPayload } from "../src/cache.js";
import { configureLimiter } from "../src/ratelimit.js";

test("#68 spawn args include --cache-prompt when enabled, not when disabled", () => {
  const orig = config.modelCachePrompt;
  try {
    config.modelCachePrompt = true;
    assert.ok(defaultCmd().includes("--cache-prompt"));
    config.modelCachePrompt = false;
    assert.ok(!defaultCmd().includes("--cache-prompt"));
  } finally { config.modelCachePrompt = orig; }
});

test("#68 extractTimings parses llama.cpp timings and OpenAI usage", () => {
  const a = extractTimings({ timings: { prompt_ms: 120.5, predicted_ms: 900, prompt_n: 40, predicted_n: 80, cached_n: 30 } }, 0);
  assert.equal(a.prompt_eval_ms, 120.5);
  assert.equal(a.eval_ms, 900);
  assert.equal(a.ttft_ms, 120.5);
  assert.equal(a.prompt_tokens, 40);
  assert.equal(a.completion_tokens, 80);
  assert.equal(a.cached_tokens, 30);

  const b = extractTimings({ usage: { prompt_tokens: 50, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 20 } } }, 0);
  assert.equal(b.prompt_tokens, 50);
  assert.equal(b.completion_tokens, 10);
  assert.equal(b.cached_tokens, 20);
  assert.equal(b.prompt_eval_ms, null, "unreported fields stay null, not invented");
});

test("#68 miss event/headers carry prefill timing; stats reports prefix cache", async () => {
  const ORIG = { model: config.model, cache: config.modelCachePrompt, idle: config.modelIdleS };
  config.model = "test-model";
  config.domainMode = "off"; config.distanceThreshold = 0.35; config.groundingTopK = 3;
  config.trustedWritesOnly = false; config.minReviewStatus = "draft";
  config.maxInferencesPerMinute = 10000; config.cacheTtlS = 0; config.maxEntries = 0;
  config.modelCachePrompt = true; config.modelIdleS = 120;
  configureLimiter(10000);
  setStore(new Store(":memory:")); useMemoryVectors(true); invalidateVectorCache();
  setEmbedForTests(() => null); // force a miss; no semantic index needed
  setRetrieveForTests(async () => [{ id: "c", title: "T", text: "Amazon S3 stores objects in buckets.", source: "t" }]);
  resetKnowledgeForTests();
  setInferForTests(() => ({
    id: "x", object: "chat.completion", created: 1, model: "test-model",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Amazon S3 stores objects in buckets." } }],
    _timings: { prompt_eval_ms: 44.5, eval_ms: 300, ttft_ms: 44.5, prompt_tokens: 30, completion_tokens: 12, cached_tokens: 22, wall_ms: 350 },
  }));
  try {
    const out = await handleChat({ model: "test-model", messages: [{ role: "user", content: "What is Amazon S3?" }], temperature: 0 }, { trusted: true });
    assert.equal(out.status, "miss");
    assert.equal(out.headers["x-cache-ttft-ms"], "44.5");
    assert.equal(out.headers["x-cache-cached-tokens"], "22");

    const events = getStore().recentEvents(5);
    assert.equal(Number(events[0].ttft_ms), 44.5);
    assert.equal(Number(events[0].cached_tokens), 22);
    assert.equal(Number(events[0].prompt_eval_ms), 44.5);

    const s = statsPayload();
    assert.equal(s.service.prompt_cache.enabled, true);
    assert.equal(s.service.prompt_cache.idle_s, 120);
    assert.ok("estimated_inference_ms_saved" in s.totals);
    assert.equal(s.recent[0].ttft_ms, 44.5);
  } finally {
    setInferForTests(null); setEmbedForTests(null); setRetrieveForTests(null);
    resetKnowledgeForTests(); useMemoryVectors(false); resetStore();
    config.model = ORIG.model; config.modelCachePrompt = ORIG.cache; config.modelIdleS = ORIG.idle;
  }
});
