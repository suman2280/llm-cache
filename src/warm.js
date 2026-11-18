/**
 * #63: cache warming / precomputation.
 *
 * Runs a list of questions through the SAME handleChat path as live traffic,
 * so the domain guard, grounding, verifier and review floor are not bypassed.
 * Concurrency is bounded to avoid starving the single model slot. Dry-run
 * mode reports exact-tier hit/miss without invoking the model.
 */

import config from "./config.js";
import { getStore as db } from "./store.js";
import { handleChat } from "./cache.js";
import { cacheIdentityOf, encodeEnvelope, parseEnvelope } from "./keying.js";

function normalize(q) {
  const withDefault = (body) => ({ temperature: 0, ...body });
  if (typeof q === "string") return withDefault({ messages: [{ role: "user", content: q }] });
  if (q && Array.isArray(q.messages)) return withDefault(q);
  if (q && typeof q.prompt === "string") return withDefault({ messages: [{ role: "user", content: q.prompt }] });
  return null;
}

/** Would this query hit the exact tier? No model, no side effects. */
function wouldHit(messages, envelopeHeader) {
  const envelope = parseEnvelope(envelopeHeader);
  const body = { model: config.model, messages, temperature: 0 };
  const { fingerprint } = cacheIdentityOf({ body, envelope, tenantId: config.tenantId });
  return Boolean(db().getByFingerprint(fingerprint));
}

async function worker(queue, run, results) {
  for (;;) {
    const item = queue.shift();
    if (!item) return;
    results.push(await run(item));
  }
}

/**
 * Warm the cache with `queries` (array of strings or {messages, envelope}).
 * @returns {Promise<{total,warmed,skipped,failed,dryRun,model_invocations,last_warm,details}>}
 */
export async function warmQueries(queries, { dryRun = false, concurrency } = {}) {
  const list = Array.isArray(queries) ? queries : [];
  const limit = Math.max(1, Math.min(concurrency ?? config.warmConcurrency, 16));
  const queue = list.map((q, i) => ({ index: i, q }));
  const results = [];
  const invBefore = db().counters().model_invocations || 0;

  const run = async ({ index, q }) => {
    const m = normalize(q);
    if (!m) return { index, status: "failed", reason: "invalid query" };
    const envelope = q?.envelope ?? {};
    const envelopeHeader = encodeEnvelope(envelope);
    const body = { ...m, model: m.model || config.model };
    if (dryRun) {
      const hit = wouldHit(body.messages, envelopeHeader);
      return { index, status: hit ? "hit" : "miss", prompt: body.messages?.at(-1)?.content };
    }
    try {
      const out = await handleChat(body, {
        envelopeHeader, role: "author", trusted: true,
        clientId: `warm:${index}`,
      });
      return { index, status: out.status === "miss" ? "warmed" : "skipped", cache: out.status };
    } catch (err) {
      return { index, status: "failed", reason: err.public ? err.message : err.message };
    }
  };

  const workers = Array.from({ length: Math.min(limit, queue.length || 1) }, () =>
    worker(queue, run, results));
  await Promise.all(workers);

  const counts = { warmed: 0, skipped: 0, failed: 0, hit: 0, miss: 0 };
  for (const r of results) if (r.status in counts) counts[r.status] += 1;
  const invocations = (db().counters().model_invocations || 0) - invBefore;
  const last_warm = new Date().toISOString();
  db().setMeta("last_warm", last_warm);
  return {
    total: list.length, dryRun,
    warmed: counts.warmed, skipped: counts.skipped, failed: counts.failed,
    would_hit: counts.hit, would_miss: counts.miss,
    model_invocations: invocations, last_warm,
    details: results.sort((a, b) => a.index - b.index),
  };
}

export function getLastWarm() { return db().getMeta("last_warm"); }
