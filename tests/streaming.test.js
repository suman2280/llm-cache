/**
 * #62: streaming responses with cache write-back.
 *
 * - stream=true returns text/event-stream with X-Cache-* headers and [DONE].
 * - a streamed miss is cached; the next identical streamed request is an
 *   exact-hit with the same SSE shape.
 * - degenerate streamed output is not cached.
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
import { invalidateVectorCache } from "../src/cache.js";
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
const CHUNK = [{ id: "c", title: "T", text: "Amazon S3 stores objects in buckets.", source: "t" }];

function setup(inferImpl) {
  config.dbPath = ":memory:";
  config.domainMode = "off";
  config.distanceThreshold = 0.35;
  config.groundingTopK = 3;
  config.trustedWritesOnly = false;
  config.minReviewStatus = "draft";
  config.maxInferencesPerMinute = 10000;
  config.cacheTtlS = 0;
  config.maxEntries = 0;
  config.degenerateRetries = 1;
  configureLimiter(10000);
  setStore(new Store(":memory:"));
  useMemoryVectors(true);
  invalidateVectorCache();
  setEmbedForTests((t) => (t ? baseVec("e:" + String(t).slice(0, 60)) : null));
  setRetrieveForTests(async () => CHUNK);
  resetKnowledgeForTests();
  setInferForTests(inferImpl || (() => ({
    id: "s", object: "chat.completion", created: 1, model: MODEL,
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Amazon S3 stores objects in buckets." } }],
  })));
}
function teardown() {
  setInferForTests(null);
  setEmbedForTests(null);
  setRetrieveForTests(null);
  resetKnowledgeForTests();
  useMemoryVectors(false);
  resetStore();
}
function chat(content, extra = {}) {
  return { model: MODEL, messages: [{ role: "user", content }], temperature: 0, stream: true, ...extra };
}
function sseFrames(payload) {
  return String(payload).split("\n\n").filter((f) => f.startsWith("data: ")).map((f) => f.slice(6));
}

test("#62 streamed miss → exact-hit, with SSE shape and headers on the first chunk", async (t) => {
  setup();
  t.after(teardown);
  const app = await build();
  const body = chat("What is Amazon S3?");

  const r1 = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: body });
  assert.equal(r1.statusCode, 200);
  assert.match(r1.headers["content-type"], /text\/event-stream/);
  assert.equal(r1.headers["x-cache-status"], "miss");
  assert.ok(r1.headers["x-request-id"]);
  const frames1 = sseFrames(r1.payload);
  assert.ok(frames1.length > 2, "multiple SSE data frames");
  assert.ok(frames1.some((f) => f.includes('"content"')), "a content delta frame");
  assert.ok(frames1.includes("[DONE]"), "termination frame");

  const r2 = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: body });
  assert.equal(r2.statusCode, 200);
  assert.equal(r2.headers["x-cache-status"], "exact-hit", "streamed miss must be cached");
  const frames2 = sseFrames(r2.payload);
  assert.ok(frames2.includes("[DONE]"), "streamed hit has same SSE shape");

  await app.close();
});

test("#62 degenerate streamed output is not cached", async (t) => {
  let calls = 0;
  setup(() => {
    calls += 1;
    const repeated = ("s3 encryption " .repeat(20)).trim();
    return { id: "d", object: "chat.completion", created: 1, model: MODEL,
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: repeated } }] };
  });
  t.after(teardown);
  const app = await build();

  const r = await app.inject({ method: "POST", url: "/v1/chat/completions",
    payload: chat("What is Amazon S3?") });
  // A degenerate answer is never cached. The request either fails (502) after
  // retries or is served as a miss; in no case may a later identical request
  // become an exact hit off the degenerate answer.
  const r2 = await app.inject({ method: "POST", url: "/v1/chat/completions",
    payload: chat("What is Amazon S3?") });
  assert.notEqual(r2.headers["x-cache-status"], "exact-hit",
    "degenerate streamed output must never be cached as an exact hit");
  await app.close();
});
