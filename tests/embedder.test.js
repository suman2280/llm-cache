/**
 * #67: pluggable embedder identity + dimension-aware index migration.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import config from "../src/config.js";
import { Store, setStore, resetStore, getStore } from "../src/store.js";
import { embedderInfo, embed, setEmbedForTests } from "../src/embedder.js";
import { checkIndexIdentity, recordIndexIdentity } from "../src/vectors.js";
import { statsPayload } from "../src/cache.js";

const ORIG = { model: config.embedderModel, dim: config.vectorDim, provider: config.embedderProvider };
function fresh() {
  setStore(new Store(":memory:"));
  config.embedderModel = "Xenova/test-embedder";
  config.vectorDim = 8;
  config.embedderProvider = "transformers";
}
function restore() {
  config.embedderModel = ORIG.model; config.vectorDim = ORIG.dim; config.embedderProvider = ORIG.provider;
  setEmbedForTests(null); resetStore();
}

test("#67 embedderInfo exposes id/dim/provider", () => {
  fresh();
  try {
    const info = embedderInfo();
    assert.equal(info.id, "Xenova/test-embedder");
    assert.equal(info.dim, 8);
    assert.equal(info.provider, "transformers");
    assert.ok("loaded" in info);
  } finally { restore(); }
});

test("#67 embed rejects a dimension mismatch with a clear remediation", async () => {
  fresh();
  try {
    setEmbedForTests(() => new Array(5).fill(0.1)); // wrong: expected 8
    await assert.rejects(() => embed("hello"), (e) => {
      assert.match(e.message, /dimension mismatch/i);
      assert.match(e.message, /reindex_vectors\.mjs/i);
      assert.match(e.message, /VECTOR_DIM=5/);
      return true;
    });
  } finally { restore(); }
});

test("#67 embed accepts a correctly-dimensioned vector", async () => {
  fresh();
  try {
    setEmbedForTests(() => new Array(8).fill(0.1));
    const v = await embed("hello");
    assert.equal(v.length, 8);
  } finally { restore(); }
});

test("#67 index identity: fresh records, matching passes, mismatches throw", () => {
  fresh();
  try {
    const first = checkIndexIdentity();
    assert.equal(first.fresh, true);
    assert.equal(getStore().getMeta("vector_index_model"), "Xenova/test-embedder");
    assert.equal(getStore().getMeta("vector_index_dim"), "8");

    // same config -> ok
    assert.equal(checkIndexIdentity().fresh, false);

    // dimension mismatch -> throws with remediation
    config.vectorDim = 16;
    assert.throws(() => checkIndexIdentity(), (e) => {
      assert.match(e.message, /dimension mismatch/i);
      assert.match(e.message, /reindex_vectors\.mjs/i);
      return true;
    });
    config.vectorDim = 8;

    // model change (same dim) -> throws, requires reindex
    config.embedderModel = "Xenova/other-model";
    assert.throws(() => checkIndexIdentity(), (e) => {
      assert.match(e.message, /model changed/i);
      assert.match(e.message, /reindex_vectors\.mjs/i);
      return true;
    });

    // reindex records the new identity -> now ok, idempotent
    config.embedderModel = "Xenova/test-embedder";
    recordIndexIdentity();
    recordIndexIdentity();
    assert.equal(checkIndexIdentity().fresh, false);
  } finally { restore(); }
});

test("#67 stats exposes additive embedder identity fields", () => {
  fresh();
  try {
    const s = statsPayload();
    assert.equal(s.service.embedder_id, "Xenova/test-embedder");
    assert.equal(s.service.embedder_dim, 8);
    assert.equal(s.service.embedder_provider, "transformers");
  } finally { restore(); }
});
