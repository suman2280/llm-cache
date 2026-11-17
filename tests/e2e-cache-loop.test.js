/**
 * #60: end-to-end cache loop (exact-hit, semantic-hit, miss)
 *
 * Runs without Redis, model, or network (stubbed inference + in-process
 * vector store). Verifies the central claim: exact/semantic hits avoid the
 * model and serve the cached answer unchanged.
 */

import { test, before, after, beforeEach } from "node:test";
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

function sha(s) { return createHash("sha256").update(s).digest("hex"); }

function unit(vec) {
  let n = 0;
  for (const v of vec) n += v * v;
  n = Math.sqrt(n) || 1;
  return vec.map((v) => v / n);
}

// Deterministic base vectors per "topic" so rewordings can be placed nearby.
function baseVec(seed) {
  const h = createHash("sha256").update(seed).digest();
  const v = new Array(DIM).fill(0);
  for (let i = 0; i < DIM; i++) v[i] = ((h[i % h.length] + i * 31) % 257) / 256 - 0.5;
  return unit(v);
}

function near(vec, eps = 0.02) {
  // Small perturbation that keeps cosine distance tiny.
  const h = createHash("sha256").update(String(eps) + vec[0]).digest();
  return unit(vec.map((v, i) => v + ((h[i % h.length] / 255) - 0.5) * eps));
}

const V = {
  s3: baseVec("topic:s3-lifecycle"),
  s3reword: near(baseVec("topic:s3-lifecycle"), 0.01),
  ec2: baseVec("topic:ec2"),
};

const EMBEDS = new Map([
  ["How do I configure an S3 lifecycle rule to archive old objects to Glacier?", V.s3],
  ["How do I set up an S3 lifecycle rule to archive old objects to Glacier storage?", V.s3reword],
  ["What is Amazon EC2?", V.ec2],
]);

function embedStub(text) {
  if (!text) return null;
  for (const [k, v] of EMBEDS.entries()) {
    if (text.includes(k) || k.includes(text)) return v;
  }
  // fallback: stable but unrelated
  return baseVec("other:" + text.slice(0, 80));
}

let inferCalls = 0;
function inferStub(body) {
  inferCalls += 1;
  const q = (body.messages || []).map((m) => m.content).join(" ").toLowerCase();
  let answer = "Amazon EC2 provides resizable virtual servers in the AWS cloud.";
  if (q.includes("lifecycle") || q.includes("glacier") || q.includes("archive")) {
    answer = "Amazon S3 lifecycle rules transition objects to Glacier storage classes after a configured number of days.";
  }
  return {
    id: "stub-" + inferCalls,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: MODEL,
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: answer } }],
  };
}

const CHUNK = [{ id: "aws-s3-lifecycle", title: "S3 Lifecycle", text: "S3 lifecycle rules transition objects to Glacier storage classes after a configured number of days.", source: "test" }];

function setup() {
  inferCalls = 0;
  config.dbPath = ":memory:";
  config.domainMode = "off";
  config.distanceThreshold = 0.35;
  config.groundingTopK = 3;
  config.trustedWritesOnly = false;
  config.minReviewStatus = "draft";
  config.maxInferencesPerMinute = 1000;
  config.cacheTtlS = 0;
  config.maxEntries = 0;
  config.degenerateRetries = 1;
  configureLimiter(1000);
  setStore(new Store(":memory:"));
  useMemoryVectors(true);
  invalidateVectorCache();
  setEmbedForTests(embedStub);
  setInferForTests(inferStub);
  setRetrieveForTests(async (query) => {
    const q = String(query || "").toLowerCase();
    if (q.includes("lifecycle") || q.includes("glacier") || q.includes("archive") || q.includes("s3")) return CHUNK;
    if (q.includes("ec2") || q.includes("virtual")) return [{ id: "aws-ec2", title: "EC2", text: "Amazon EC2 provides resizable virtual servers called instances in the AWS cloud.", source: "test" }];
    return [];
  });
  resetKnowledgeForTests();
}

function teardown() {
  setInferForTests(null);
  setEmbedForTests(null);
  setRetrieveForTests(null);
  resetKnowledgeForTests();
  useMemoryVectors(false);
  resetStore();
}

function body(content) {
  return { model: MODEL, messages: [{ role: "user", content }], temperature: 0 };
}

function asciiSafe(v) {
  return /^[\x20-\x7E]*$/.test(String(v || ""));
}

test("#60 end-to-end cache loop: miss → exact-hit → semantic-hit → miss", async (t) => {
  setup();
  t.after(teardown);

  const q1 = "How do I configure an S3 lifecycle rule to archive old objects to Glacier?";
  const q1reword = "How do I set up an S3 lifecycle rule to archive old objects to Glacier storage?";
  const q2 = "What is Amazon EC2?";

  const r1 = await handleChat(body(q1), { trusted: true });
  assert.equal(r1.status, "miss");
  assert.equal(r1.headers["x-cache-status"], "miss");
  assert.equal(inferCalls, 1, "first request must invoke the model");
  const missAnswer = r1.response?.choices?.[0]?.message?.content;
  assert.ok(missAnswer);

  const invAfterMiss = inferCalls;
  const r2 = await handleChat(body(q1), { trusted: true });
  assert.equal(r2.status, "exact-hit");
  assert.equal(r2.headers["x-cache-status"], "exact-hit");
  assert.equal(inferCalls, invAfterMiss, "exact hit must not invoke the model");
  assert.ok(asciiSafe(r2.headers["x-cache-source-prompt"]), "x-cache-source-prompt must be ASCII-safe");

  const invAfterExact = inferCalls;
  const r3 = await handleChat(body(q1reword), { trusted: true });
  assert.equal(r3.status, "semantic-hit", `expected semantic-hit, got ${r3.status} (${r3.headers?.["x-cache-policy"] || ""})`);
  assert.equal(r3.headers["x-cache-status"], "semantic-hit");
  assert.equal(inferCalls, invAfterExact, "semantic hit must not invoke the model");
  assert.ok(asciiSafe(r2.headers["x-cache-source-prompt"]), "exact-hit source prompt must be ASCII-safe");
  assert.ok(asciiSafe(r3.headers["x-cache-source-prompt"]), "semantic-hit source prompt must be ASCII-safe");
  assert.ok(r2.headers["x-cache-source-prompt"], "exact hit must name its source prompt");
  assert.ok(r3.headers["x-cache-source-prompt"], "semantic hit must name its source prompt");
  assert.notEqual(r3.headers["x-cache-source-prompt"], q1reword, "semantic hit source prompt must name the cached source, not the rewording");
  const semanticAnswer = r3.response?.choices?.[0]?.message?.content;
  assert.equal(sha(semanticAnswer), sha(missAnswer), "semantic hit must serve the byte-identical cached answer");

  const invAfterSemantic = inferCalls;
  const r4 = await handleChat(body(q2), { trusted: true });
  assert.equal(r4.status, "miss", "unrelated question must miss");
  assert.equal(r4.headers["x-cache-status"], "miss");
  assert.equal(inferCalls, invAfterSemantic + 1, "miss must invoke the model");
});
