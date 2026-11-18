/**
 * #66: fine-grained observability tests.
 *
 * - x-request-id on every response, echoed from the trace id; events carry it.
 * - breakdowns by scope/template/concept/generation_method.
 * - cost-saved estimate in /stats and /metrics.
 * - bounded-cardinality labels in /metrics.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import config from "../src/config.js";
import { Store, setStore, resetStore } from "../src/store.js";
import { useMemoryVectors } from "../src/vectors.js";
import { setInferForTests } from "../src/model.js";
import { setEmbedForTests } from "../src/embedder.js";
import { setRetrieveForTests, resetKnowledgeForTests } from "../src/knowledge.js";
import { invalidateVectorCache, statsPayload } from "../src/cache.js";
import { build } from "../src/server.js";
import { configureLimiter } from "../src/ratelimit.js";

const MODEL = "test-model";
const DIM = config.vectorDim || 384;
function unit(v) { let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; return v.map((x) => x / n); }
function baseVec(seed) {
  const h = createHash("sha256").update(seed).digest();
  const v = new Array(DIM).fill(0);
  for (let i = 0; i < DIM; i++) v[i] = ((h[i % h.length] + i * 31) % 257) / 256 - 0.5;
  return unit(v);
}

function setup() {
  config.dbPath = ":memory:";
  config.domainMode = "off";
  config.distanceThreshold = 0.35;
  config.groundingTopK = 3;
  config.trustedWritesOnly = false;
  config.minReviewStatus = "draft";
  config.maxInferencesPerMinute = 10000;
  config.cacheTtlS = 0;
  config.maxEntries = 0;
  config.costPerTokenUsd = 0.000002;
  config.breakdownLimit = 10;
  configureLimiter(10000);
  setStore(new Store(":memory:"));
  useMemoryVectors(true);
  invalidateVectorCache();
  setEmbedForTests((t) => (t ? baseVec("e:" + String(t).slice(0, 60)) : null));
  setRetrieveForTests(async () => [{ id: "c", title: "T", text: "Amazon S3 stores objects in buckets.", source: "t" }]);
  resetKnowledgeForTests();
  setInferForTests(() => {
    return { id: "x", object: "chat.completion", created: 1, model: MODEL,
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Amazon S3 stores objects in buckets." } }] };
  });
}
function teardown() {
  setInferForTests(null);
  setEmbedForTests(null);
  setRetrieveForTests(null);
  resetKnowledgeForTests();
  useMemoryVectors(false);
  resetStore();
}
function chat(content, extra = {}) { return { model: MODEL, messages: [{ role: "user", content }], temperature: 0, ...extra }; }

test("#66 every response carries a unique x-request-id and events record it", async (t) => {
  setup();
  t.after(teardown);
  const app = await build();

  const env = Buffer.from(JSON.stringify({ chapter_code: "AWS", concept_id: "C-1", asset_type: "chat", difficulty_level: "2" })).toString("base64");
  const r1 = await app.inject({ method: "POST", url: "/v1/chat/completions",
    headers: { "x-content-envelope": env }, payload: chat("What is Amazon S3?") });
  const r2 = await app.inject({ method: "POST", url: "/v1/chat/completions",
    headers: { "x-content-envelope": env }, payload: chat("What is Amazon S3?") });

  const id1 = r1.headers["x-request-id"];
  const id2 = r2.headers["x-request-id"];
  assert.ok(id1 && id2, "x-request-id must be present on responses");
  assert.notEqual(id1, id2, "each request must have a distinct trace id");

  const events = (await app.inject({ method: "GET", url: "/stats" })).json().recent;
  assert.ok(events.length >= 2, "events recorded");
  assert.ok(events.some((e) => e.request_id === id1), "first request id present on an event");
  assert.ok(events.some((e) => e.request_id === id2), "second request id present on an event");

  const rErr = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: chat("") });
  assert.ok(rErr.headers["x-request-id"], "error responses also carry x-request-id");

  await app.close();
});

test("#66 store records per-dimension breakdowns and cost saved", async (t) => {
  setup();
  t.after(teardown);
  const app = await build();
  const env = Buffer.from(JSON.stringify({ chapter_code: "AWS", concept_id: "C-1", asset_type: "chat", difficulty_level: "2" })).toString("base64");

  await app.inject({ method: "POST", url: "/v1/chat/completions",
    headers: { "x-content-envelope": env }, payload: chat("What is Amazon S3?") });
  await app.inject({ method: "POST", url: "/v1/chat/completions",
    headers: { "x-content-envelope": env }, payload: chat("What is Amazon S3?") });

  const stats = (await app.inject({ method: "GET", url: "/stats" })).json();
  assert.ok(stats.breakdown.totals.hits >= 1, "breakdown has hits");
  const scope = stats.breakdown.scope;
  assert.ok(scope.length >= 1, "scope breakdown populated");
  assert.ok(scope[0].hits >= 1, "the scope shows at least one hit");

  const narrowed = (await app.inject({ method: "GET", url: "/stats?breakdown=scope" })).json();
  assert.equal(narrowed.breakdown.requested, "scope");
  assert.ok(Array.isArray(narrowed.breakdown.top));

  assert.ok(stats.totals.tokens_saved >= config.estimatedTokensPerAnswer);
  const expected = Number((stats.totals.tokens_saved * config.costPerTokenUsd).toFixed(6));
  assert.equal(stats.totals.cost_saved_usd, expected);

  const metrics = (await app.inject({ method: "GET", url: "/metrics" })).payload;
  assert.match(metrics, /llm_cache_cost_saved_usd_estimate/);
  assert.match(metrics, /llm_cache_hits_by_scope\{scope=/);
  assert.match(metrics, /llm_cache_negative_hits_total/);

  await app.close();
});

test("#66 statsPayload exposes additive observability fields", () => {
  setup();
  try {
    const before = statsPayload();
    assert.ok(before.breakdown && Array.isArray(before.breakdown.scope));
    assert.ok("cost_saved_usd" in before.totals);
    assert.ok("request_id" in before);
  } finally {
    teardown();
  }
});
