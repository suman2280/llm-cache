/**
 * #64: optional cross-encoder reranker for candidate verification.
 *
 * - default off: verifier behaviour unchanged;
 * - a low reranker score rejects an otherwise-accepted candidate;
 * - a high score accepts and is reported on the header/event/counter;
 * - integration: a reranker-rejected semantic candidate falls through to a
 *   miss, so a wrong answer is never served.
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
import { verifyCandidateCore, handleChat, invalidateVectorCache } from "../src/cache.js";
import { setRerankerForTests, clearRerankerForTests, rerankerInfo } from "../src/reranker.js";
import { configureLimiter } from "../src/ratelimit.js";

const CHUNK_TEXT = "EC2 instances (virtual machines) — resizable virtual servers called instances.";
function candFp() {
  return {
    prompt: "What is EC2?",
    response_json: JSON.stringify({ choices: [{ message: { content: "Amazon EC2 provides resizable virtual servers in the cloud." } }] }),
    chunk_ids: "ec2-instances",
    generation_method: "model",
    review_status: "approved",
    symbol_fp: "",
    created_at: Date.now(),
  };
}
function ctx(reranker) {
  return {
    scope: "s", symbolFp: "", minReviewStatus: "approved", policy: null,
    queryText: "What are virtual machines?",
    chunkIds: ["ec2-instances"], chunkText: CHUNK_TEXT,
    reranker, lastRerankerScore: null,
  };
}

test("#64 default off leaves the verifier unchanged", async () => {
  setStore(new Store(":memory:"));
  try {
    config.verifierReranker = "off";
    clearRerankerForTests();
    assert.equal(rerankerInfo().enabled, false);
    const c = ctx({ enabled: false, threshold: 0.5, countRejections: false });
    const v = await verifyCandidateCore({ scope: "s", fingerprint: "f" }, candFp(), c);
    assert.equal(v.ok, true, `expected accept: ${v.reason}`);
    assert.equal(c.lastRerankerScore, null, "no score recorded when off");
  } finally { resetStore(); }
});

test("#64 low reranker score rejects a false-positive candidate", async () => {
  setStore(new Store(":memory:"));
  try {
    const c = ctx({ enabled: true, threshold: 0.5, countRejections: false });
    setRerankerForTests(async () => 0.1);
    const v = await verifyCandidateCore({ scope: "s", fingerprint: "f" }, candFp(), c);
    assert.equal(v.ok, false);
    assert.match(v.reason, /reranker/);
    assert.equal(c.lastRerankerScore, 0.1);
    clearRerankerForTests();
  } finally { resetStore(); }
});

test("#64 high reranker score accepts and is reported", async () => {
  setStore(new Store(":memory:"));
  try {
    const c = ctx({ enabled: true, threshold: 0.5, countRejections: false });
    setRerankerForTests(async () => 0.93);
    const v = await verifyCandidateCore({ scope: "s", fingerprint: "f" }, candFp(), c);
    assert.equal(v.ok, true, `expected accept: ${v.reason}`);
    assert.equal(c.lastRerankerScore, 0.93);
    assert.equal(getStore().counters().reranker_rejections, 0, "countRejections=false respected (benchmark)");
    clearRerankerForTests();
  } finally { resetStore(); }
});

test("#64 reranker rejection is counted", async () => {
  setStore(new Store(":memory:"));
  try {
    const c = ctx({ enabled: true, threshold: 0.5, countRejections: true });
    setRerankerForTests(async () => 0.2);
    await verifyCandidateCore({ scope: "s", fingerprint: "f" }, candFp(), c);
    assert.equal(getStore().counters().reranker_rejections, 1);
    clearRerankerForTests();
  } finally { resetStore(); }
});

test("#64 a reranker-rejected semantic candidate falls through to a miss", async () => {
  const DIM = config.vectorDim || 384;
  const unit = (v) => { let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; return v.map((x) => x / n); };
  const baseVec = (seed) => {
    const h = createHash("sha256").update(seed).digest(); const v = new Array(DIM).fill(0);
    for (let i = 0; i < DIM; i++) v[i] = ((h[i % h.length] + i * 31) % 257) / 256 - 0.5; return unit(v);
  };
  const near = (v, eps = 0.01) => {
    const h = createHash("sha256").update("e" + eps + v[1]).digest();
    return unit(v.map((x, i) => x + ((h[i % h.length] / 255) - 0.5) * eps));
  };
  const q1 = "What is Amazon S3?";
  const q1r = "What is Amazon S3 object storage?";
  const V = baseVec("s3");
  let calls = 0;
  const ORIG_MODEL = config.model;
  config.model = "test-model";
  config.domainMode = "off"; config.distanceThreshold = 0.35; config.groundingTopK = 3;
  config.trustedWritesOnly = false; config.minReviewStatus = "draft";
  config.maxInferencesPerMinute = 10000; config.cacheTtlS = 0; config.maxEntries = 0;
  config.verifierReranker = "on"; config.rerankerThreshold = 0.5;
  configureLimiter(10000);
  setStore(new Store(":memory:")); useMemoryVectors(true); invalidateVectorCache();
  setEmbedForTests((t) => {
    if (!t) return null;
    const s = String(t);
    if (s.includes(q1) || s.includes("Amazon S3")) return V;
    if (s.includes("object storage")) return near(V, 0.01);
    return baseVec("other:" + s.slice(0, 60));
  });
  setRetrieveForTests(async () => [{ id: "c-s3", title: "S3", text: "Amazon S3 stores objects in buckets and supports lifecycle rules for storage transitions.", source: "t" }]);
  resetKnowledgeForTests();
  const CHUNK = [{ id: "c-s3", title: "S3", text: "Amazon S3 stores objects in buckets and supports lifecycle rules for storage transitions.", source: "t" }];
  setRetrieveForTests(async () => CHUNK);
  setInferForTests(() => {
    calls += 1;
    return { id: "x", object: "chat.completion", created: 1, model: "test-model",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Amazon S3 stores objects in buckets and supports lifecycle rules for storage transitions." } }] };
  });
  setRerankerForTests(async () => 0.1); // reject every semantic candidate
  try {
    const chat = (c) => ({ model: "test-model", messages: [{ role: "user", content: c }], temperature: 0 });
    const first = await handleChat(chat(q1), { trusted: true });
    assert.equal(first.status, "miss");
    const afterFirst = calls;
    const second = await handleChat(chat(q1r), { trusted: true });
    assert.equal(second.status, "miss", "reranker-rejected semantic candidate must fall through to a miss");
    assert.equal(calls, afterFirst + 1, "the fall-through miss invokes the model again");
    assert.ok(getStore().counters().reranker_rejections >= 1, "rejection counted");
  } finally {
    clearRerankerForTests(); setInferForTests(null); setEmbedForTests(null); setRetrieveForTests(null);
    resetKnowledgeForTests(); useMemoryVectors(false); resetStore();
    config.verifierReranker = "off"; config.model = ORIG_MODEL;
  }
});
