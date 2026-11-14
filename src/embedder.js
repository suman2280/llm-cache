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

export async function embed(text) {
  if (!text || !text.trim()) return null;
  const p = await load();
  lastUsedAt = Date.now();
  const out = await p(text, { pooling: "mean", normalize: true });
  return Array.from(out.data);
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