/**
 * #65: negative cache for out-of-domain refusals.
 *
 * Repeated (or reworded) out-of-domain questions must not re-run the domain
 * classifier's embedding path on every request. We remember the question's
 * embedding together with the refusal reason and serve the same 422 directly
 * on a hit. Entries are short-lived (TTL), cleared whenever the vector index
 * is invalidated (corpus/KB change), and are only ever written for questions
 * the domain guard itself classified as out-of-domain -- so an in-domain
 * question can never be refused from this cache.
 */

import { embed } from "./embedder.js";
import config from "./config.js";

let entries = [];
let overrideTtl = null; // test seam: override config.negativeCacheTtlS

export function configureNegativeCache({ ttlS: value } = {}) {
  if (Number.isFinite(value) && value >= 0) overrideTtl = value;
}
const ttl = () => (overrideTtl === null ? config.negativeCacheTtlS : overrideTtl);

export function clearNegativeCache() { entries = []; }
export function negativeCacheSize() { return entries.length; }

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return -1;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / ((Math.sqrt(na) * Math.sqrt(nb)) || 1);
}

/** Forget expired entries; returns the number removed. */
export function pruneNegativeCache(now = Date.now()) {
  const before = entries.length;
  entries = entries.filter((e) => now - e.created_at <= ttl() * 1000);
  return before - entries.length;
}

/**
 * Remember a refusal verdict. `status` is 'out-of-domain' or 'ungrounded'.
 * We store 'ungrounded' for observability but only 'out-of-domain' refusals are
 * served from the cache (an ungrounded question still needs an answer).
 */
export async function rememberNegative(text, status, reason) {
  if (!ttl()) return false;
  if (!text) return false;
  const vec = await embed(text).catch(() => null);
  if (!vec) return false;
  pruneNegativeCache();
  entries.push({ vec, status, reason: String(reason || ""), text: String(text), created_at: Date.now() });
  return true;
}

/**
 * Look up a cached refusal for `text`. Returns { status, reason } on a hit,
 * otherwise null. Skips embedding entirely when the cache is empty, so the
 * common case pays no cost.
 */
export async function lookupNegative(text) {
  if (!ttl() || !entries.length || !text) return null;
  pruneNegativeCache();
  if (!entries.length) return null;
  const vec = await embed(text).catch(() => null);
  if (!vec) return null;
  let best = null;
  let bestSim = -1;
  for (const e of entries) {
    if (e.status !== "out-of-domain") continue; // only refusals are replayable
    const sim = cosine(vec, e.vec);
    // cosine distance <= configured radius  =>  similarity >= 1 - radius
    if (sim >= 1 - config.distanceThreshold && sim > bestSim) { best = e; bestSim = sim; }
  }
  return best ? { status: best.status, reason: best.reason } : null;
}
