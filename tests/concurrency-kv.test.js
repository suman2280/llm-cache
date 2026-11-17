/**
 * #61: concurrency, one-to-many, many-to-one, and multi-intent KV tests.
 *
 * Runs without Redis, model, or network (stubbed inference + in-process
 * vector store).
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
import { handleChat, invalidateVectorCache } from "../src/cache.js";
import { configureLimiter } from "../src/ratelimit.js";

const MODEL = "test-model";
const DIM = config.vectorDim || 384;

function sha(s) { return createHash("sha256").update(String(s)).digest("hex"); }

function unit(vec) {
  let n = 0;
  for (const v of vec) n += v * v;
  n = Math.sqrt(n) || 1;
  return vec.map((v) => v / n);
}
function baseVec(seed) {
  const h = createHash("sha256").update(seed).digest();
  const v = new Array(DIM).fill(0);
  for (let i = 0; i < DIM; i++) v[i] = ((h[i % h.length] + i * 31) % 257) / 256 - 0.5;
  return unit(v);
}
function near(vec, eps = 0.01) {
  const h = createHash("sha256").update("eps" + eps + vec[1]).digest();
  return unit(vec.map((v, i) => v + ((h[i % h.length] / 255) - 0.5) * eps));
}

const TOPICS = {
  s3: baseVec("s3"),
  s3r1: near(baseVec("s3"), 0.01),
  s3r2: near(baseVec("s3"), 0.015),
  s3r3: near(baseVec("s3"), 0.02),
  ec2: baseVec("ec2"),
  ec2r: near(baseVec("ec2"), 0.01),
};

function makeEmbed(map) {
  return (text) => {
    if (!text) return null;
    for (const [needle, vec] of map.entries()) {
      if (String(text).includes(needle)) return vec;
    }
    return baseVec("other:" + String(text).slice(0, 60));
  };
}

function chunksFor(q) {
  const s = String(q || "").toLowerCase();
  const out = [];
  if (s.includes("s3") || s.includes("bucket") || s.includes("lifecycle")) {
    out.push({ id: "c-s3", title: "S3", text: "Amazon S3 stores objects in buckets and supports lifecycle rules for storage transitions.", source: "t" });
  }
  if (s.includes("ec2") || s.includes("virtual machine") || s.includes("instance")) {
    out.push({ id: "c-ec2", title: "EC2", text: "Amazon EC2 provides resizable virtual machine instances in the cloud.", source: "t" });
  }
  return out;
}

function setup({ embedMap, inferImpl, distanceThreshold = 0.35 } = {}) {
  config.dbPath = ":memory:";
  config.domainMode = "off";
  config.distanceThreshold = distanceThreshold;
  config.groundingTopK = 3;
  config.trustedWritesOnly = false;
  config.minReviewStatus = "draft";
  config.maxInferencesPerMinute = 10000;
  config.cacheTtlS = 0;
  config.maxEntries = 0;
  config.tenantId = "tenant-a";
  config.degenerateRetries = 1;
  configureLimiter(10000);
  setStore(new Store(":memory:"));
  useMemoryVectors(true);
  invalidateVectorCache();
  setEmbedForTests(makeEmbed(embedMap || new Map()));
  setRetrieveForTests(async (query) => chunksFor(query));
  resetKnowledgeForTests();
  let calls = 0;
  const infer = inferImpl || ((body) => {
    calls += 1;
    const q = (body.messages || []).map((m) => m.content).join(" ").toLowerCase();
    const parts = [];
    if (q.includes("s3")) parts.push("Amazon S3 stores objects in buckets and supports lifecycle rules for storage transitions.");
    if (q.includes("ec2") || q.includes("virtual machine") || q.includes("instance")) parts.push("Amazon EC2 provides resizable virtual machine instances in the cloud.");
    const answer = parts.join(" ") || "Amazon EC2 provides resizable virtual machine instances in the cloud.";
    return {
      id: "id-" + calls, object: "chat.completion", created: 1, model: MODEL,
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: answer } }],
    };
  });
  const wrapped = async (body, opts) => { const r = await infer(body, opts); wrapped.calls = (wrapped.calls || 0) + 1; return r; };
  wrapped.calls = 0;
  setInferForTests(wrapped);
  return { get calls() { return wrapped.calls; } };
}

function teardown() {
  setInferForTests(null);
  setEmbedForTests(null);
  setRetrieveForTests(null);
  resetKnowledgeForTests();
  useMemoryVectors(false);
  resetStore();
  config.tenantId = "local";
}

function chat(content, extra = {}) {
  return { model: MODEL, messages: [{ role: "user", content }], temperature: 0, ...extra };
}

test("#61.1 many→one: N concurrent identical cold misses produce 1 inference", async (t) => {
  const embedMap = new Map([["What is Amazon S3?", TOPICS.s3]]);
  let resolveGate;
  const gate = new Promise((r) => { resolveGate = r; });
  let calls = 0;
  setup({
    embedMap,
    inferImpl: async (body) => {
      calls += 1;
      await gate;
      return {
        id: "slow", object: "chat.completion", created: 1, model: MODEL,
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Amazon S3 stores objects in buckets." } }],
      };
    },
  });
  t.after(teardown);

  const N = 5;
  const req = chat("What is Amazon S3?");
  const ps = Array.from({ length: N }, () => handleChat(req, { trusted: true }));
  // let them all enter inFlight join path
  await new Promise((r) => setTimeout(r, 20));
  resolveGate();
  const results = await Promise.all(ps);
  assert.equal(calls, 1, "exactly one model call for N concurrent identical misses");
  const first = results[0].response.choices[0].message.content;
  for (const r of results) assert.equal(r.response.choices[0].message.content, first, "all callers receive identical answer");

  const after = await handleChat(req, { trusted: true });
  assert.equal(after.status, "exact-hit", "subsequent request must be an exact hit");
  assert.equal(calls, 1, "exact hit must not trigger another inference");
});

test("#61.2 one→many: varying answer-affecting params produces misses", async (t) => {
  const embedMap = new Map([["What is Amazon S3?", TOPICS.s3]]);
  const ctx = setup({ embedMap, distanceThreshold: 0 }); // exact-only to isolate identity
  t.after(teardown);

  const base = await handleChat(chat("What is Amazon S3?"), { trusted: true });
  assert.equal(base.status, "miss");
  const baseline = ctx.calls;

  const variants = [
    { seed: 42 },
    { top_k: 5 },
    { max_tokens: 123 },
    { repeat_penalty: 1.3 },
    { frequency_penalty: 0.5 },
    { presence_penalty: 0.5 },
    { stop: ["END"] },
    { logit_bias: { "1": 1 } },
    { n: 2 },
  ];
  for (const extra of variants) {
    const before = ctx.calls;
    const r = await handleChat(chat("What is Amazon S3?", extra), { trusted: true });
    assert.equal(r.status, "miss", `param ${Object.keys(extra)[0]} must not reuse cached answer`);
    assert.equal(ctx.calls, before + 1, `param ${Object.keys(extra)[0]} must invoke model`);
  }
  assert.ok(ctx.calls >= baseline + variants.length);
});

test("#61.3 one→many: same text under two scopes is isolated", async (t) => {
  const text = "What is Amazon S3?";
  const embedMap = new Map([[text, TOPICS.s3]]);
  const ctx = setup({ embedMap });
  t.after(teardown);

  config.tenantId = "tenant-a";
  const a = await handleChat(chat(text), { trusted: true });
  assert.equal(a.status, "miss");
  config.tenantId = "tenant-b";
  const b = await handleChat(chat(text), { trusted: true });
  assert.equal(b.status, "miss", "same text in different scope must be a separate miss, not cross-served");
  assert.equal(ctx.calls, 2, "each scope must invoke model once");

  config.tenantId = "tenant-a";
  const a2 = await handleChat(chat(text), { trusted: true });
  assert.equal(a2.status, "exact-hit", "tenant-a must still get its own exact hit");
  config.tenantId = "tenant-b";
  const b2 = await handleChat(chat(text), { trusted: true });
  assert.equal(b2.status, "exact-hit", "tenant-b must still get its own exact hit");
  assert.equal(ctx.calls, 2, "hits must not invoke model");
});

test("#61.4 many→one: rewordings resolve to one cached answer (1 miss + N-1 semantic hits)", async (t) => {
  const q = "What is Amazon S3 object storage?";
  const rewordings = [
    "What is Amazon S3 object storage service?",
    "Tell me what Amazon S3 object storage is",
    "Explain what Amazon S3 object storage does",
  ];
  const embedMap = new Map([
    [q, TOPICS.s3],
    [rewordings[0], TOPICS.s3r1],
    [rewordings[1], TOPICS.s3r2],
    [rewordings[2], TOPICS.s3r3],
  ]);
  const ctx = setup({ embedMap });
  t.after(teardown);

  const first = await handleChat(chat(q), { trusted: true });
  assert.equal(first.status, "miss");
  assert.equal(ctx.calls, 1);

  for (const rw of rewordings) {
    const r = await handleChat(chat(rw), { trusted: true });
    assert.equal(r.status, "semantic-hit", `rewording '${rw}' should be semantic-hit, got ${r.status}`);
  }
  assert.equal(ctx.calls, 1, "rewordings must not invoke the model");
});

test("#61.5 partial multi-intent falls through to model; both cached composes", async (t) => {
  const qS3 = "What is Amazon S3";
  const qEC2 = "What is Amazon EC2";
  const combined = `${qS3}\n${qEC2}`;
  const embedMap = new Map([
    [qS3, TOPICS.s3],
    [qEC2, TOPICS.ec2],
    [qS3 + " object storage", TOPICS.s3],
    [qEC2 + " virtual machines", TOPICS.ec2r],
  ]);
  const ctx = setup({
    embedMap,
    inferImpl: async (body) => {
      const q = (body.messages || []).map((m) => m.content).join(" ").toLowerCase();
      // For the combined question, return an ungrounded answer so a partial
      // miss is served but NOT cached (it must not block later composition).
      if (q.includes("amazon s3") && q.includes("amazon ec2") && q.includes("\n")) {
        return { id: "u", object: "chat.completion", created: 1, model: MODEL,
          choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "General cloud information without specific service details." } }] };
      }
      const parts = [];
      if (q.includes("amazon s3")) parts.push("Amazon S3 stores objects in buckets and supports lifecycle rules for storage transitions.");
      if (q.includes("amazon ec2")) parts.push("Amazon EC2 provides resizable virtual machine instances in the cloud.");
      const answer = parts.join(" ") || "Amazon cloud service.";
      return { id: "id", object: "chat.completion", created: 1, model: MODEL,
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: answer } }] };
    },
  });
  t.after(teardown);

  // Cache only S3
  const s3 = await handleChat(chat(qS3), { trusted: true });
  assert.equal(s3.status, "miss");

  const partial = await handleChat(chat(combined), { trusted: true });
  assert.equal(partial.status, "miss", "partial multi-intent must not serve a partial composed answer");
  assert.ok(ctx.calls >= 2, "partial multi-intent must go to model");

  // Cache EC2 as well
  const ec2 = await handleChat(chat(qEC2), { trusted: true });
  assert.equal(ec2.status, "miss");

  const callsBefore = ctx.calls;
  const composed = await handleChat(chat(combined), { trusted: true });
  assert.equal(composed.status, "semantic-hit", "when both intents are cached it must compose");
  assert.equal(ctx.calls, callsBefore, "composed answer must not invoke model");
  const answer = composed.response.choices[0].message.content;
  assert.ok(/S3/i.test(answer) && /EC2/i.test(answer), "composed answer must include both intents");
});
