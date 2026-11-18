/**
 * #70: the negative cache must never refuse an in-domain question.
 * #73: admin invalidation (clear/purge/reseed) drops negative entries.
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
import { handleChat, invalidateVectorCache, resetPolicy, statsPayload } from "../src/cache.js";
import { clearNegativeCache } from "../src/negative_cache.js";
import { build } from "../src/server.js";
import { configureLimiter } from "../src/ratelimit.js";

const MODEL = "test-model";
const DIM = config.vectorDim || 384;
function unit(v) { let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; return v.map((x) => x / n); }
function baseVec(seed) {
  const h = createHash("sha256").update(seed).digest(); const v = new Array(DIM).fill(0);
  for (let i = 0; i < DIM; i++) v[i] = ((h[i % h.length] + i * 31) % 257) / 256 - 0.5; return unit(v);
}
const near = (v, e = 0.01) => {
  const h = createHash("sha256").update("n" + e + v[1]).digest();
  return unit(v.map((x, i) => x + ((h[i % h.length] / 255) - 0.5) * e));
};
const OOD = "Who painted the Mona Lisa?";
const MIXED = "Does S3 store images like the Mona Lisa?";
const MONA = baseVec("mona");

function setup() {
  config.model = MODEL;
  config.domainMode = "strict"; config.distanceThreshold = 0.35;
  config.groundingTopK = 3; config.trustedWritesOnly = false; config.minReviewStatus = "draft";
  config.maxInferencesPerMinute = 10000; config.cacheTtlS = 0; config.maxEntries = 0;
  config.negativeCacheTtlS = 300; config.adminToken = "";
  configureLimiter(10000);
  setStore(new Store(":memory:")); useMemoryVectors(true);
  invalidateVectorCache(); clearNegativeCache(); resetPolicy(); resetKnowledgeForTests();
  setEmbedForTests((t) => {
    if (!t) return null;
    const s = String(t);
    if (s.includes("Mona Lisa")) return s.includes("S3") ? near(MONA, 0.01) : MONA;
    if (s.includes("Amazon S3")) return baseVec("aws-s3");
    return baseVec("other:" + s.slice(0, 60));
  });
  setRetrieveForTests(async () => [{ id: "c", title: "S3", text: "Amazon S3 stores objects in buckets.", source: "t" }]);
  setInferForTests(() => ({ id: "x", object: "chat.completion", created: 1, model: MODEL,
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Amazon S3 stores objects in buckets." } }] }));
}
function teardown() {
  setInferForTests(null); setEmbedForTests(null); setRetrieveForTests(null);
  resetKnowledgeForTests(); clearNegativeCache(); useMemoryVectors(false); resetStore();
  config.domainMode = "strict";
}
const chat = (c) => ({ model: MODEL, messages: [{ role: "user", content: c }], temperature: 0 });
async function refuse(c) {
  try { await handleChat(chat(c), { trusted: true }); return null; } catch (e) { return e; }
}

test("#70 a mixed in-domain question is not refused from the negative cache", async (t) => {
  setup(); t.after(teardown);
  const first = await refuse(OOD);
  assert.ok(first && first.statusCode === 422, "seed the OOD refusal");
  const before = statsPayload().totals.negative_hits;

  const mixed = await handleChat(chat(MIXED), { trusted: true });
  assert.notEqual(mixed.status, "error", "an AWS question mentioning a refused topic must be served");
  assert.equal(statsPayload().totals.negative_hits, before, "no negative-cache hit recorded");
});

test("#73 /cache/clear drops negative entries", async (t) => {
  setup(); t.after(teardown);
  await refuse(OOD);
  assert.equal(statsPayload().totals.negative_hits, 0);
  const app = await build();
  await app.inject({ method: "POST", url: "/cache/clear", payload: {} });
  const after = await refuse(OOD);
  assert.ok(after && after.statusCode === 422, "still refused by the real guard");
  assert.equal(statsPayload().totals.negative_hits, 0, "re-classified, not replayed from the negative cache");
  await app.close();
});
