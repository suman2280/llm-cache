/**
 * #65: negative cache for out-of-domain refusals.
 *
 * - identical out-of-domain questions are refused from the negative cache
 *   (no re-classification) and increment negative_hits;
 * - reworded out-of-domain questions hit the negative semantic cache;
 * - an in-domain question is never refused from it;
 * - TTL / invalidation clears the entries.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import config from "../src/config.js";
import { Store, setStore, resetStore } from "../src/store.js";
import { useMemoryVectors } from "../src/vectors.js";
import { setInferForTests } from "../src/model.js";
import { setEmbedForTests } from "../src/embedder.js";
import { resetKnowledgeForTests } from "../src/knowledge.js";
import { handleChat, invalidateVectorCache, resetPolicy, statsPayload } from "../src/cache.js";
import { clearNegativeCache } from "../src/negative_cache.js";
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
function near(vec, eps = 0.01) {
  const h = createHash("sha256").update("e" + eps + vec[1]).digest();
  return unit(vec.map((v, i) => v + ((h[i % h.length] / 255) - 0.5) * eps));
}

const Q1 = "Who painted the Mona Lisa?";
const Q2 = "Who was the artist behind the Mona Lisa painting?";
const MONA = baseVec("topic:mona-lisa");

function setup() {
  config.dbPath = ":memory:";
  config.domainMode = "strict";
  config.distanceThreshold = 0.35;
  config.groundingTopK = 3;
  config.trustedWritesOnly = false;
  config.minReviewStatus = "draft";
  config.maxInferencesPerMinute = 10000;
  config.cacheTtlS = 0;
  config.maxEntries = 0;
  config.negativeCacheTtlS = 300;
  configureLimiter(10000);
  setStore(new Store(":memory:"));
  useMemoryVectors(true);
  invalidateVectorCache();
  clearNegativeCache();
  resetPolicy();
  resetKnowledgeForTests();
  setEmbedForTests((t) => {
    if (!t) return null;
    const s = String(t);
    if (s.includes("Mona Lisa") || s.includes("mona lisa")) return MONA;
    if (s.includes("painted") || s.includes("artist") || s.includes("painting")) return near(MONA, 0.01);
    if (s.includes("Amazon S3")) return baseVec("aws:s3");
    return baseVec("other:" + s.slice(0, 60));
  });
  setInferForTests(() => ({ id: "x", object: "chat.completion", created: 1, model: MODEL,
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Amazon S3 stores objects." } }] }));
}
function teardown() {
  setInferForTests(null);
  setEmbedForTests(null);
  resetKnowledgeForTests();
  useMemoryVectors(false);
  clearNegativeCache();
  resetStore();
}
function chat(c) { return { model: MODEL, messages: [{ role: "user", content: c }], temperature: 0 }; }
async function refusal(c) {
  try { await handleChat(chat(c), { trusted: true }); return null; }
  catch (e) { return e; }
}

test("#65 identical out-of-domain question is refused from negative cache", async (t) => {
  setup(); t.after(teardown);
  const e1 = await refusal(Q1);
  assert.ok(e1 && e1.statusCode === 422, "first refusal is 422");
  const before = statsPayload().totals.negative_hits;

  const e2 = await refusal(Q1);
  assert.ok(e2 && e2.statusCode === 422);
  assert.equal(e2.message, e1.message, "negative hit returns the identical refusal text");
  assert.equal(statsPayload().totals.negative_hits, before + 1, "negative_hits incremented");

  const reason = statsPayload().recent[0].reason;
  assert.match(reason, /negative-cache/, "event records the negative-cache hit");
});

test("#65 reworded out-of-domain question hits the negative semantic cache", async (t) => {
  setup(); t.after(teardown);
  const e1 = await refusal(Q1);
  assert.ok(e1 && e1.statusCode === 422);
  const before = statsPayload().totals.negative_hits;

  const e2 = await refusal(Q2);
  assert.ok(e2 && e2.statusCode === 422, "reworded question is refused");
  assert.equal(e2.message, e1.message);
  assert.equal(statsPayload().totals.negative_hits, before + 1, "reworded hit counted");
});

test("#65 in-domain question is never refused from the negative cache", async (t) => {
  setup(); t.after(teardown);
  await refusal(Q1);
  const before = statsPayload().totals.negative_hits;

  const out = await handleChat(chat("What is Amazon S3?"), { trusted: true });
  assert.notEqual(out.status, "error");
  assert.equal(statsPayload().totals.negative_hits, before, "in-domain request did not hit negative cache");
});

test("#65 invalidation clears negative entries", async (t) => {
  setup(); t.after(teardown);
  await refusal(Q1);
  assert.equal(statsPayload().totals.negative_hits, 0);

  invalidateVectorCache(); // simulates corpus/KB change

  await refusal(Q1);
  assert.equal(statsPayload().totals.negative_hits, 0, "after invalidation the refusal is recomputed, not replayed");
});
