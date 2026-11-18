/**
 * Race hardening for the model supervisor: a transient "fetch failed" (the
 * model being idle-recycled between health-check and inference) must be
 * retried against a freshly ensured model rather than failing the request.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import config from "../src/config.js";
import { infer, modelStats, setModelDepsForTests, clearModelDepsForTests } from "../src/model.js";

const COMPLETION = {
  id: "x", object: "chat.completion", created: 1, model: "m",
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "answer" } }],
};
const okResponse = () => new Response(JSON.stringify(COMPLETION), {
  status: 200, headers: { "content-type": "application/json" },
});
const body = { model: "m", messages: [{ role: "user", content: "hello" }] };

function teardown() { clearModelDepsForTests(); config.modelFetchRetries = 2; }

test("a transient fetch failure is retried against a re-ensured model", async (t) => {
  t.after(teardown);
  config.modelFetchRetries = 2;
  let fetches = 0;
  let ensures = 0;
  setModelDepsForTests({
    ensureModel: async () => { ensures += 1; return "http://fake:8080"; },
    fetch: async () => {
      fetches += 1;
      if (fetches === 1) throw new TypeError("fetch failed"); // dead socket
      return okResponse();
    },
  });

  const out = await infer(body);
  assert.equal(out.choices[0].message.content, "answer");
  assert.equal(fetches, 2, "the fetch was retried once");
  assert.equal(ensures, 2, "ensureModel re-ran before the retry");
  assert.equal(modelStats().active_inferences, 0, "in-flight counter released");
});

test("a non-network error is NOT retried", async (t) => {
  t.after(teardown);
  let fetches = 0;
  setModelDepsForTests({
    ensureModel: async () => "http://fake:8080",
    fetch: async () => { fetches += 1; throw new Error("upstream 500: server error"); },
  });
  await assert.rejects(() => infer(body), /upstream 500/);
  assert.equal(fetches, 1, "no retry for a deterministic upstream error");
  assert.equal(modelStats().active_inferences, 0);
});

test("in-flight count is released even when inference ultimately fails", async (t) => {
  t.after(teardown);
  config.modelFetchRetries = 0;
  setModelDepsForTests({
    ensureModel: async () => "http://fake:8080",
    fetch: async () => { throw new TypeError("fetch failed"); },
  });
  await assert.rejects(() => infer(body));
  assert.equal(modelStats().active_inferences, 0, "no leaked in-flight count after failure");
});
