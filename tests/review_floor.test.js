/**
 * #69: a consumer can reuse the answer it just generated, but cannot serve
 * another actor's unreviewed draft.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import config from "../src/config.js";
import { Store, setStore, resetStore, getStore } from "../src/store.js";
import { useMemoryVectors } from "../src/vectors.js";
import { setInferForTests } from "../src/model.js";
import { setEmbedForTests } from "../src/embedder.js";
import { setRetrieveForTests, resetKnowledgeForTests } from "../src/knowledge.js";
import { handleChat, invalidateVectorCache } from "../src/cache.js";
import { indexDocument } from "../src/vectors.js";
import { configureLimiter } from "../src/ratelimit.js";

const MODEL = "test-model";
const DIM = config.vectorDim || 384;
function unit(v) { let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; return v.map((x) => x / n); }
function baseVec(seed) {
  const h = createHash("sha256").update(seed).digest(); const v = new Array(DIM).fill(0);
  for (let i = 0; i < DIM; i++) v[i] = ((h[i % h.length] + i * 31) % 257) / 256 - 0.5; return unit(v);
}
const near = (v, e = 0.01) => {
  const h = createHash("sha256").update("e" + e + v[1]).digest();
  return unit(v.map((x, i) => x + ((h[i % h.length] / 255) - 0.5) * e));
};
const CHUNK = [{ id: "c-s3", title: "S3", text: "Amazon S3 stores objects in buckets and supports server-side encryption.", source: "t" }];

function setup() {
  const ORIG_MODEL = config.model;
  config.model = MODEL;
  config.domainMode = "off"; config.distanceThreshold = 0.35; config.groundingTopK = 3;
  config.trustedWritesOnly = false; config.minReviewStatus = "approved";
  config.maxInferencesPerMinute = 10000; config.cacheTtlS = 0; config.maxEntries = 0;
  config.degenerateRetries = 1;
  configureLimiter(10000);
  setStore(new Store(":memory:")); useMemoryVectors(true); invalidateVectorCache();
  resetKnowledgeForTests();
  setRetrieveForTests(async () => CHUNK);
  setEmbedForTests((t) => {
    if (!t) return null;
    const s = String(t);
    if (s.includes("server-side encryption")) return baseVec("s3-enc");
    return baseVec("other:" + s.slice(0, 60));
  });
  let calls = 0;
  setInferForTests(() => {
    calls += 1;
    return { id: "x", object: "chat.completion", created: 1, model: MODEL,
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Amazon S3 stores objects in buckets and supports server-side encryption." } }] };
  });
  return { ORIG_MODEL, calls: () => calls };
}
function teardown(orig) {
  config.model = orig; setInferForTests(null); setEmbedForTests(null); setRetrieveForTests(null);
  resetKnowledgeForTests(); useMemoryVectors(false); resetStore();
}
const chat = (c) => ({ model: MODEL, messages: [{ role: "system", content: "You are an AWS enterprise assistant." }, { role: "user", content: c }], temperature: 0.3, max_tokens: 250 });
// trusted:false + role consumer == how the demo reaches the API.
const consumerOpts = { trusted: false, role: "consumer", clientId: "client-a" };

test("#69 untrusted caller can exact-hit and semantic-hit its own generated answer", async (t) => {
  const orig = setup();
  t.after(() => teardown(orig.ORIG_MODEL));
  const q = "How does S3 server-side encryption work?";
  const reword = "Explain how S3 server-side encryption works.";

  const first = await handleChat(chat(q), consumerOpts);
  assert.equal(first.status, "miss");
  const afterFirst = orig.calls();

  const exact = await handleChat(chat(q), consumerOpts);
  assert.equal(exact.status, "exact-hit", "consumer must be able to exact-hit its own answer");
  assert.equal(orig.calls(), afterFirst, "no model call on self exact-hit");

  const semantic = await handleChat(chat(reword), consumerOpts);
  assert.equal(semantic.status, "semantic-hit", "consumer must be able to semantic-hit its own answer");
  assert.equal(orig.calls(), afterFirst, "no model call on self semantic-hit");
});

test("#47 trusted-writes-only actually quarantines untrusted answers", async (t) => {
  const orig = setup();
  t.after(() => { config.trustedWritesOnly = false; teardown(orig.ORIG_MODEL); });
  config.trustedWritesOnly = true;
  const q = "How does S3 server-side encryption work?";

  const first = await handleChat(chat(q), consumerOpts);
  assert.equal(first.status, "miss");
  const second = await handleChat(chat(q), consumerOpts);
  assert.equal(second.status, "miss", "#79 trustedWritesOnly=true means nothing was cached");
  assert.ok(orig.calls() >= 2, "both requests invoked the model");
});

test("#69 floor still blocks a different actor's unreviewed draft", async (t) => {
  const orig = setup();
  t.after(() => teardown(orig.ORIG_MODEL));
  const q = "How does S3 server-side encryption work?";
  const reword = "Explain how S3 server-side encryption works.";
  const store = getStore();

  // A draft entry created by a DIFFERENT actor, in a reachable scope.
  const first = await handleChat(chat(q), consumerOpts); // establishes scope via miss
  assert.equal(first.status, "miss");
  const row = store.getByFingerprint(
    (await import("../src/keying.js")).cacheIdentityOf({ body: chat(q), envelope: {}, tenantId: config.tenantId }).fingerprint
  );
  const scope = row.scope;
  // Replace with a draft owned by someone else.
  store.insertEntry({
    fingerprint: row.fingerprint, scope, model: MODEL,
    semantic_text: (await import("../src/keying.js")).semanticText(chat(q).messages),
    prompt: q, response_json: row.response_json, symbol_fp: "", envelope_json: "{}",
    chunk_ids: "c-s3", generation_method: "model", review_status: "draft",
    created_at: Date.now(), last_used_at: Date.now(), origin_client: "other-actor",
  });
  await indexDocument(`e${row.id}`, { scope, model: MODEL, fingerprint: row.fingerprint,
    generation_method: "model", review_status: "draft", prompt: q, chunks: ["c-s3"] }, baseVec("s3-enc"));

  const before = store.counters().rejected_hits || 0;
  const out = await handleChat(chat(reword), consumerOpts);
  assert.equal(out.status, "miss", "another actor's draft must not be served");
  assert.ok((store.counters().rejected_hits || 0) > before, "the floor rejection is recorded");
});
