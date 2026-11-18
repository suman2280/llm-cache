/**
 * #64: optional second-stage reranker for semantic candidate verification.
 *
 * A cross-encoder scores (query, candidate question, candidate answer) jointly
 * and catches false positives that cosine distance + lexical guards miss
 * ("same chunk, many shared words, different question"). It is LAZY: the model
 * is loaded on the first verification that needs it and unloaded on idle, just
 * like the embedder. Default 'off' preserves existing behaviour exactly.
 */

import config from "./config.js";

let extractor = null;
let loading = null;
let failed = false;
let failureReason = null;
let lastUsedAt = 0;
let testScorer = null;
let loaderOverride = null; // test seam: force a deterministic load failure/success

/** Test seam: replace the (lazy) model loader. */
export function setRerankerLoaderForTests(fn) { loaderOverride = fn; }
export function clearRerankerLoaderForTests() { loaderOverride = null; failed = false; failureReason = null; }

/** Test seam: replace the scorer with a deterministic stub. */
export function setRerankerForTests(fn) { testScorer = fn; }
export function clearRerankerForTests() { testScorer = null; failed = false; failureReason = null; }

export function rerankerInfo() {
  const mode = config.verifierReranker || "off";
  const enabled = mode !== "off";
  return {
    mode,
    enabled,
    model: config.rerankerModel,
    threshold: config.rerankerThreshold,
    loaded: extractor !== null,
    // #75: an enabled-but-unloadable reranker is reported, never silent.
    failed,
    failure_reason: failureReason,
    status: !enabled ? "off" : failed ? "failed" : extractor ? "ready" : loading ? "loading" : "idle",
  };
}

async function load() {
  if (extractor) return extractor;
  if (failed) return null;
  if (loading) return loading;
  loading = (async () => {
    try {
      const t0 = Date.now();
      let pipe;
      if (loaderOverride) {
        pipe = await loaderOverride(config.rerankerModel);
      } else {
        const { pipeline } = await import("@xenova/transformers");
        pipe = await pipeline("text-classification", config.rerankerModel, { quantized: true });
      }
      extractor = pipe;
      failed = false;
      failureReason = null;
      console.log(`[reranker] loaded ${config.rerankerModel} in ${Date.now() - t0} ms`);
      return pipe;
    } catch (err) {
      // Fail OPEN, but RECORD it so /stats (/healthz) and startup logs show why.
      failed = true;
      failureReason = `${err.message}`;
      console.warn(`[reranker] unavailable (${failureReason}); verification continues without it`);
      return null;
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/**
 * Score a (query, candidate prompt, candidate answer) triple in [0, 1].
 * Returns null when the reranker is off/unavailable (fail-open).
 */
export async function scoreRerank(query, candidatePrompt, candidateAnswer) {
  if (testScorer) {
    const s = await testScorer(query, candidatePrompt, candidateAnswer);
    return s == null ? null : { score: Number(s), model: "test" };
  }
  const mode = config.verifierReranker || "off";
  if (mode === "off") return null;
  const pipe = await load();
  if (!pipe) return null;
  try {
    lastUsedAt = Date.now();
    const text = `Question: ${query || ""}\nCached question: ${candidatePrompt || ""}\nCached answer: ${candidateAnswer || ""}`;
    const out = await pipe(text, { topk: null });
    const raw = Array.isArray(out) ? out[0] : out;
    let score = Number(raw?.score);
    const label = String(raw?.label || "").toLowerCase();
    if (!Number.isFinite(score)) return null;
    // Some cross-encoders expose only the positive-class probability under a
    // label like LABEL_1 / LABEL_0; normalise to "similar" probability.
    if (label === "label_0" || label === "dissimilar" || label === "not_duplicate") score = 1 - score;
    return { score, model: config.rerankerModel };
  } catch (err) {
    console.warn(`[reranker] scoring failed: ${err.message}`);
    return null;
  }
}

/** Release native memory if the reranker has been idle. */
export async function maybeUnloadReranker() {
  if (config.rerankerIdleS < 0 || !extractor) return false;
  if (Date.now() - lastUsedAt < config.rerankerIdleS * 1000) return false;
  try { extractor?.dispose?.(); } catch { /* best effort */ }
  extractor = null;
  return true;
}
