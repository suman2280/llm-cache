/**
 * Lazy embedder: ONNX MiniLM via @xenova/transformers.
 *
 * Cost: ~250 MB RSS and ~17 s first load (model download). Neither is paid
 * until the semantic tier is actually used, so a deployment that serves
 * everything from the deterministic and exact tiers never loads it at all.
 *
 * Measured on this box: 9 ms per 384-d embed, faster than the previous
 * build's 17 ms in-process MiniLM.
 */

import config from "./config.js";

let extractor = null;
let loading = null;
let lastUsedAt = 0;
let unloadTimer = null;

/**
 * #67: the embedder is selected by config. `id` is the provenance stamp, `dim`
 * is the vector index width. A swapped model MUST be paired with a reindex.
 */
export function embedderInfo() {
  return {
    provider: config.embedderProvider || "transformers",
    id: config.embedderModel,
    model: config.embedderModel,
    dim: config.vectorDim,
    loaded: extractor !== null,
  };
}

/** Fail loudly on a dimension mismatch instead of indexing garbage vectors. */
function assertDim(vec) {
  const want = config.vectorDim;
  if (vec.length !== want) {
    throw new Error(
      `Embedding dimension mismatch: model '${config.embedderModel}' produced ${vec.length} ` +
      `dimensions but VECTOR_DIM=${want}. Set VECTOR_DIM=${vec.length} and run ` +
      `node scripts/reindex_vectors.mjs to rebuild the vector index.`
    );
  }
  return vec;
}

async function load() {
  if (extractor) return extractor;
  if (loading) return loading;
  loading = (async () => {
    const t0 = Date.now();
    const { pipeline, env: tfenv } = await import("@xenova/transformers");
    tfenv.allowLocalModels = true;
    extractor = await pipeline("feature-extraction", config.embedderModel, { quantized: true });
    console.log(`[embedder] loaded ${config.embedderModel} in ${Date.now() - t0} ms`);
    return extractor;
  })();
  return loading;
}

let _embedForTests = null;
/** Test seam: replace embedding with a deterministic stub. */
export function setEmbedForTests(fn) { _embedForTests = fn; }

export async function embed(text) {
  // Test stubs bypass the model but still honour the dimension contract.
  if (_embedForTests) {
    const v = await _embedForTests(text);
    return v ? assertDim(v) : v;
  }
  if (!text || !text.trim()) return null;
  const provider = config.embedderProvider || "transformers";
  if (provider !== "transformers") {
    throw new Error(
      `Unknown EMBEDDER_PROVIDER='${provider}'. Supported: transformers.`
    );
  }
  const p = await load();
  lastUsedAt = Date.now();
  const out = await p(text, { pooling: "mean", normalize: true });
  return assertDim(Array.from(out.data));
}

export function isLoaded() { return extractor !== null; }

/** Release native memory if the tier stays unused. Best-effort. */
export async function maybeUnload() {
  if (config.embedderIdleS < 0 || !extractor) return false;
  if (Date.now() - lastUsedAt < config.embedderIdleS * 1000) return false;
  try { extractor?.dispose?.(); } catch { /* dispose is best-effort */ }
  extractor = null;
  loading = null;
  return true;
}

export function startIdleTimer() {
  if (unloadTimer || config.embedderIdleS < 0) return;
  unloadTimer = setInterval(() => { maybeUnload().catch(() => {}); }, 30_000);
  unloadTimer.unref?.();
}