/**
 * #63: cache warming / precomputation tests.
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
import { handleChat, invalidateVectorCache, statsPayload } from "../src/cache.js";
import { warmQueries, getLastWarm } from "../src/warm.js";
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

let inferCalls = 0;
const ORIGINAL_MODEL = config.model;
function setup() {
  inferCalls = 0;
  config.model = MODEL;
  config.dbPath = ":memory:";
  config.domainMode = "off";
  config.distanceThreshold = 0.35;
  config.groundingTopK = 3;
  config.trustedWritesOnly = false;
  config.minReviewStatus = "draft";
  config.maxInferencesPerMinute = 10000;
  config.cacheTtlS = 0;
  config.maxEntries = 0;
  config.warmConcurrency = 2;
  configureLimiter(10000);
  setStore(new Store(":memory:"));
  useMemoryVectors(true);
  invalidateVectorCache();
  setEmbedForTests((t) => (t ? baseVec("e:" + String(t).slice(0, 60)) : null));
  setRetrieveForTests(async () => [{ id: "c", title: "T", text: "Amazon S3 stores objects in buckets.", source: "t" }]);
  resetKnowledgeForTests();
  setInferForTests(() => {
    inferCalls += 1;
    return { id: "w", object: "chat.completion", created: 1, model: MODEL,
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Amazon S3 stores objects in buckets." } }] };
  });
}
function teardown() {
  config.model = ORIGINAL_MODEL;
  setInferForTests(null);
  setEmbedForTests(null);
  setRetrieveForTests(null);
  resetKnowledgeForTests();
  useMemoryVectors(false);
  resetStore();
}
function chat(c) { return { model: MODEL, messages: [{ role: "user", content: c }], temperature: 0 }; }

test("#63 warming populates the cache; subsequent request is exact-hit with no model call", async (t) => {
  setup(); t.after(teardown);
  const qs = ["What is Amazon S3?", "How do I use an S3 bucket?", "Tell me about S3 storage"];
  const r = await warmQueries(qs, { concurrency: 2 });
  assert.equal(r.total, 3);
  assert.equal(r.failed, 0);
  assert.equal(r.warmed, 3, "all three questions warmed");
  assert.ok(r.model_invocations >= 1, "model was invoked during warming");

  const before = inferCalls;
  const out = await handleChat(chat(qs[0]), { trusted: true });
  assert.equal(out.status, "exact-hit", "warmed question is an exact hit");
  assert.equal(inferCalls, before, "no model call on the warmed hit");
});

test("#63 warming is idempotent; dry-run reports hit/miss without model", async (t) => {
  setup(); t.after(teardown);
  const dry1 = await warmQueries(["What is Amazon S3?"], { dryRun: true });
  assert.equal(dry1.would_miss, 1, "dry run reports a miss before warming");
  assert.equal(dry1.model_invocations, 0, "dry run invokes no model");
  assert.equal(getLastWarm(), null, "#72 a dry run does not write last_warm");

  await warmQueries(["What is Amazon S3?"], { concurrency: 1 });
  const dry2 = await warmQueries(["What is Amazon S3?"], { dryRun: true });
  assert.equal(dry2.would_hit, 1, "dry run reports a hit after warming");

  const again = await warmQueries(["What is Amazon S3?"], { concurrency: 1 });
  assert.equal(again.skipped, 1, "re-warming skips an already-cached question");
  assert.equal(again.warmed, 0);
});

test("#72 warmed entries are servable to a normal consumer", async (t) => {
  setup(); t.after(teardown);
  const q = "What is Amazon S3?";
  await warmQueries([q], { concurrency: 1 });

  const out = await handleChat(chat(q), { trusted: false, role: "consumer", clientId: "real-user" });
  assert.equal(out.status, "exact-hit", "a consumer must be able to reuse a warmed answer");

  const rows = (await import("../src/store.js")).getStore().listEntries({ limit: 10 });
  assert.ok(rows.some((r) => r.review_status === "approved"), "warmed entries are approved");
});

test("#63 last_warm is surfaced in /stats", async (t) => {
  setup(); t.after(teardown);
  assert.equal(getLastWarm(), null);
  await warmQueries(["What is Amazon S3?"], { concurrency: 1 });
  assert.ok(getLastWarm(), "last_warm recorded");
  assert.equal(statsPayload().service.last_warm, getLastWarm());
});
