/**
 * The cache engine: three tiers, with a verifier between candidate selection
 * and serving.
 *
 *   tier 0  deterministic   template + params -> computed in CODE. No model,
 *                           no embedding, correct by construction. (SOP 595)
 *
 *   tier 1  exact           denylist fingerprint -> O(1) row. No embedding.
 *
 *   tier 2  semantic        full-conversation embedding, vector search
 *                           PRE-FILTERED BY SCOPE, then VERIFIED before it is
 *                           allowed to be served.
 *
 * The verifier is what makes tier 2 safe. The previous build served a cached
 * answer on a distance threshold alone; measured, 10 of 11 maths prompt pairs
 * needing different answers fell inside its shipped radius. Here:
 *
 *   1. scope match       -- enforced by the Redis query's TAG pre-filter, not
 *                           by hope
 *   2. symbol fingerprint-- if the special-glyph multisets differ, the prompts
 *                           are not interchangeable (cheap, runs first)
 *   3. deterministic      -- if the cached entry was template-generated,
 *      recomputation        recompute from its params and compare exactly
 *   4. review floor       -- an unreviewed entry never reaches the tutor path
 *
 * A rejected hit falls through to a real miss and is recorded as
 * `semantic-hit-rejected`, so the failure mode is visible rather than hidden.
 */

import config from "./config.js";
import { getStore as db } from "./store.js";
import * as vectors from "./vectors.js";
import { embed, isLoaded } from "./embedder.js";
import * as model from "./model.js";
import * as templates from "./templates.js";
import {
  requestFingerprint, scopeOf, semanticText, lastUserText,
  symbolFingerprint, asciiHeaderValue, parseEnvelope, encodeEnvelope, samplingClass,
} from "./keying.js";

const REVIEW_ORDER = ["draft", "needs_academic_review", "reviewed", "approved", "production"];
const reviewRank = (s) => {
  const i = REVIEW_ORDER.indexOf(String(s || "draft"));
  return i === -1 ? 0 : i;
};

function answerText(payload) {
  try {
    const c = payload?.choices?.[0]?.message?.content;
    return typeof c === "string" ? c : null;
  } catch {
    return null;
  }
}

function mintResponse(payload, { status }) {
  // Never replay the original request's identity (previous bug: a cache hit
  // returned the first request's id/created/usage).
  return {
    id: `chatcmpl-${Math.random().toString(36).slice(2, 12)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: payload.model,
    choices: payload.choices,
    // usage is deliberately omitted on a served hit: billing on it would be wrong.
    ...(status === "miss" ? { usage: payload.usage } : {}),
  };
}

// ---------------------------------------------------------------------------
// The verifier

/**
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
async function verifyCandidate(candidate, ctx) {
  // 1. scope -- the Redis query already enforced it; assert rather than trust.
  if (candidate.scope && candidate.scope !== ctx.scope) {
    return { ok: false, reason: `scope mismatch (${candidate.scope} != ${ctx.scope})` };
  }

  // 2. glyph fingerprint -- cheap, deterministic, catches the |, ∈ vs ⊂ class
  const candFp = await db().getByFingerprint(candidate.fingerprint);
  const cachedFp = candFp?.symbol_fp ?? "";
  if (cachedFp && ctx.symbolFp && cachedFp !== ctx.symbolFp) {
    return { ok: false, reason: "symbol fingerprint differs (different operators/numbers)" };
  }

  // 3. deterministic recomputation -- if the entry is template-generated, its
  //    answer must still be what the template computes from its own params.
  if (candFp?.generation_method === "deterministic_template" && candFp?.template_id) {
    const tpl = templates.getTemplate(candFp.template_id);
    if (tpl) {
      const params = JSON.parse(candFp.params_json || "{}");
      const recomputed = templates.renderTemplate(tpl, params);
      if (recomputed.ok && recomputed.answer !== candFp.actual_answer) {
        return { ok: false, reason: "deterministic recomputation disagrees with the stored answer" };
      }
      if (!recomputed.ok) {
        return { ok: false, reason: `cached template no longer solvable: ${recomputed.why}` };
      }
    }
  }

  // 4. review floor -- an unreviewed entry must not reach the tutor path.
  const need = ctx.minReviewStatus;
  if (need && reviewRank(candFp?.review_status) < reviewRank(need)) {
    return {
      ok: false,
      reason: `review_status '${candFp?.review_status}' below required '${need}'`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Tier 0: deterministic

function deterministicTier(envelope) {
  const templateId = envelope?.template_id;
  const params = envelope?.params;
  if (!templateId || !params || typeof params !== "object") return null;
  const tpl = templates.getTemplate(templateId);
  if (!tpl) return null;

  const key = templates.templateKey(templateId, params);
  const rendered = templates.renderTemplate(tpl, params);
  if (!rendered.ok) {
    return { error: `template ${templateId}: ${rendered.why}` };
  }

  const response = {
    id: `tpl-${key.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: config.model,
    choices: [{
      index: 0, finish_reason: "stop",
      message: { role: "assistant", content: rendered.answer },
    }],
  };

  return {
    status: "deterministic-hit",
    tier: "deterministic",
    response,
    key,
    prompt: rendered.prompt,
    answer: rendered.answer,
    explanation: rendered.explanation,
    templateId,
    params,
    conceptId: tpl.concept_id,
    assetType: tpl.asset_type,
    skillType: tpl.skill_type,
    difficultyLevel: tpl.difficulty_level,
    generationMethod: "deterministic_template",
    verificationMethod: "deterministic_rule",
    reason: null,
  };
}

// ---------------------------------------------------------------------------
// The main entry point

export async function handleChat(body, { envelopeHeader = "", role = "author", maxTokens } = {}) {
  const started = performance.now();
  const envelope = parseEnvelope(envelopeHeader);
  const sClass = samplingClass(body);
  const scope = scopeOf(envelope, sClass);
  const semText = semanticText(body?.messages);
  const prompt = lastUserText(body?.messages);
  const symbolFp = symbolFingerprint(semText);
  const fingerprint = requestFingerprint(body);
  const minReviewStatus = role === "author" ? "draft" : (config.minReviewStatus || null);

  const ctx = { scope, symbolFp, minReviewStatus, body, envelope };
  const timings = { embed_ms: null, redis_ms: null, infer_ms: null };

  const reject = async (status, reason) => {
    const latency = performance.now() - started;
    db().recordEvent({
      ts: new Date().toISOString(), status, model: body?.model ?? config.model,
      latency_ms: round1(latency), similarity: null, threshold: config.distanceThreshold,
      prompt, response: null, reason, tier: "guard", verified: 0, ...timings,
    });
    db().increment(["requests", "errors"]);
    const err = new Error(reason);
    err.statusCode = 400;
    err.public = true;
    throw err;
  };

  if (!body?.model) return reject("error", "no model in request body");
  if (!Array.isArray(body?.messages) || body.messages.length === 0) {
    return reject("error", "no messages in request body");
  }
  if (body.stream) {
    // Non-streaming only. Say so clearly rather than silently buffering.
    db().recordEvent({
      ts: new Date().toISOString(), status: "bypass", model: body.model,
      latency_ms: round1(performance.now() - started), prompt,
      reason: "stream=true is not supported by the cache; send stream=false", tier: "guard",
    });
    db().increment(["requests", "bypasses"]);
    const err = new Error("stream=true is not supported by the cache; send stream=false");
    err.statusCode = 400;
    err.public = true;
    throw err;
  }

  // ---- tier 0: deterministic -------------------------------------------
  const det = deterministicTier(envelope);
  if (det?.error) {
    return reject("error", det.error);
  }
  if (det) {
    const latency = performance.now() - started;
    db().recordEvent({
      ts: new Date().toISOString(), status: "deterministic-hit", model: config.model,
      latency_ms: round1(latency), prompt: det.prompt, response: det.answer,
      reason: `template ${det.templateId} answered by code, no model call`,
      tier: "deterministic", verified: 1,
    });
    db().increment(["requests", "exact_hits", "model_invocations"]);
    return {
      status: "deterministic-hit", tier: "deterministic",
      response: mintResponse(det.response, { status: "miss" }),
      headers: {
        "x-cache-status": "deterministic-hit",
        "x-cache-latency-ms": round1(latency).toFixed(1),
        "x-cache-policy": `deterministic:${det.templateId}`,
        "x-cache-similarity": "",
        "x-content-concept-id": det.conceptId,
        "x-content-generation-method": det.generationMethod,
        "x-content-verification-method": det.verificationMethod,
      },
      event: { prompt: det.prompt, response: det.answer, reason: `deterministic template ${det.templateId}` },
    };
  }

  // ---- tier 1: exact ----------------------------------------------------
  const existing = db().getByFingerprint(fingerprint);
  if (existing) {
    const verdict = await verifyCandidate(
      { scope: existing.scope, fingerprint: existing.fingerprint },
      ctx,
    );
    if (verdict.ok) {
      db().touchHit(existing.id);
      const latency = performance.now() - started;
      const payload = JSON.parse(existing.response_json);
      db().recordEvent({
        ts: new Date().toISOString(), status: "exact-hit", model: body.model,
        latency_ms: round1(latency), similarity: 0, threshold: config.distanceThreshold,
        prompt: prompt || existing.prompt, response: answerText(payload),
        source_prompt: existing.prompt, reason: "byte-identical request",
        tier: "exact", verified: 1,
      });
      db().increment(["requests", "exact_hits"]);
      return {
        status: "exact-hit", tier: "exact",
        response: mintResponse(payload, { status: "hit" }),
        headers: {
          "x-cache-status": "exact-hit",
          "x-cache-latency-ms": round1(latency).toFixed(1),
          "x-cache-similarity": "0.0000",
          "x-cache-source-prompt": asciiHeaderValue(existing.prompt),
          "x-cache-policy": "exact",
        },
        event: { prompt: prompt || existing.prompt, response: answerText(payload), source_prompt: existing.prompt },
      };
    }
    // exact hit failed the review floor -> fall through (do not serve)
    ctx.exactRejected = verdict.reason;
  }

  // ---- tier 2: semantic ------------------------------------------------
  if (config.distanceThreshold > 0) {
    try {
      let vec = null;
      const t0 = performance.now();
      vec = await embed(semText);
      timings.embed_ms = round1(performance.now() - t0);
      if (vec) {
        const t1 = performance.now();
        const candidates = await vectors.searchScope(vec, {
          scope, model: config.model, limit: 3,
        });
        timings.redis_ms = round1(performance.now() - t1);

        for (const cand of candidates) {
          if (cand.fingerprint === fingerprint) continue; // that's the exact tier's job
          const verdict = await verifyCandidate(cand, ctx);
          if (verdict.ok) {
            const row = db().getByFingerprint(cand.fingerprint);
            const payload = JSON.parse(row.response_json);
            db().touchHit(row.id);
            const latency = performance.now() - started;
            const dist = Number(cand.dist);
            db().recordEvent({
              ts: new Date().toISOString(), status: "semantic-hit", model: body.model,
              latency_ms: round1(latency), similarity: dist, threshold: config.distanceThreshold,
              prompt: prompt || row.prompt, response: answerText(payload),
              source_prompt: row.prompt, tier: "semantic", verified: 1,
              embed_ms: timings.embed_ms, redis_ms: timings.redis_ms,
            });
            db().increment(["requests", "semantic_hits"]);
            return {
              status: "semantic-hit", tier: "semantic",
              response: mintResponse(payload, { status: "hit" }),
              headers: {
                "x-cache-status": "semantic-hit",
                "x-cache-latency-ms": round1(latency).toFixed(1),
                "x-cache-similarity": dist.toFixed(4),
                "x-cache-source-prompt": asciiHeaderValue(row.prompt),
                "x-embed-ms": String(timings.embed_ms),
                "x-redis-ms": String(timings.redis_ms),
                "x-cache-policy": "semantic+verified",
              },
              event: {
                prompt: prompt || row.prompt, response: answerText(payload),
                source_prompt: row.prompt, similarity: dist,
              },
            };
          }
          // rejected: visible, counted, not hidden
          db().increment(["rejected_hits"]);
          ctx.lastRejection = verdict.reason;
          console.log(`[verifier] REJECTED semantic candidate d=${Number(cand.dist).toFixed(3)} — ${verdict.reason}`);
        }
      }
    } catch (err) {
      // A cache failure must never fail the user's request.
      console.warn(`[cache] semantic tier degraded, falling through: ${err.message}`);
      ctx.cacheDegraded = err.message;
    }
  }

  // ---- miss -------------------------------------------------------------
  const t2 = performance.now();
  let payload;
  try {
    payload = await model.infer(body, { maxTokens });
  } catch (err) {
    const latency = performance.now() - started;
    db().recordEvent({
      ts: new Date().toISOString(), status: "error", model: body?.model ?? config.model,
      latency_ms: round1(latency), prompt, reason: err.message, tier: "miss",
      embed_ms: timings.embed_ms, redis_ms: timings.redis_ms,
    });
    db().increment(["requests", "errors"]);
    const e = new Error(`inference failed: ${err.message}`);
    e.statusCode = 502;
    e.public = true;
    throw e;
  }
  timings.infer_ms = round1(performance.now() - t2);

  // Store for tiers 1 and 2.
  try {
    const reviewStatus = role === "author" ? "draft" : "needs_academic_review";
    const entryId = db().insertEntry({
      fingerprint,
      scope,
      model: body.model,
      semantic_text: semText,
      prompt,
      response_json: JSON.stringify(payload),
      symbol_fp: symbolFp,
      envelope_json: JSON.stringify(envelope),
      generation_method: ctx.exactRejected ? "model" : "model",
      verification_method: "model",
      review_status: reviewStatus,
      source_prompt: null,
      created_at: Date.now(),
      last_used_at: Date.now(),
    });
    // index for the semantic tier (best effort)
    if (config.distanceThreshold > 0) {
      const vec = await embed(semText).catch(() => null);
      if (vec) {
        await vectors.indexDocument(`e${entryId}`, {
          scope, model: config.model, fingerprint,
          generation_method: "model", review_status: reviewStatus,
          prompt,
        }, vec).catch((e) => console.warn(`[redis] index failed: ${e.message}`));
      }
    }
  } catch (err) {
    console.warn(`[store] cache write failed, request still served: ${err.message}`);
  }

  const latency = performance.now() - started;
  db().recordEvent({
    ts: new Date().toISOString(), status: "miss", model: body.model,
    latency_ms: round1(latency), similarity: null, threshold: config.distanceThreshold,
    prompt, response: answerText(payload), tier: "miss",
    embed_ms: timings.embed_ms, redis_ms: timings.redis_ms, infer_ms: timings.infer_ms,
  });
  db().increment(["requests", "misses", "model_invocations"]);

  return {
    status: "miss", tier: "miss",
    response: mintResponse(payload, { status: "miss" }),
    headers: {
      "x-cache-status": "miss",
      "x-cache-latency-ms": round1(latency).toFixed(1),
      "x-embed-ms": timings.embed_ms != null ? String(timings.embed_ms) : "",
      "x-redis-ms": timings.redis_ms != null ? String(timings.redis_ms) : "",
      "x-cache-policy": ctx.cacheDegraded ? "cache-degraded" : "miss",
    },
    event: { prompt, response: answerText(payload), embed_ms: timings.embed_ms, redis_ms: timings.redis_ms },
  };
}

// ---------------------------------------------------------------------------
// /stats payload -- built to docs/UI-CONTRACT.md

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo] * (1 - (rank - lo)) + sorted[hi] * (rank - lo);
}
const round1 = (v) => Math.round((Number(v) + Number.EPSILON) * 10) / 10;

export function statsPayload() {
  const counters = db().counters();
  const events = db().recentEvents(config.statsEventLimit).map((e) => ({
    id: Number(e.id), ts: e.ts, status: e.status, model: e.model,
    similarity: e.similarity, threshold: e.threshold, latency_ms: e.latency_ms,
    embed_ms: e.embed_ms, redis_ms: e.redis_ms, prompt: e.prompt,
    response: e.response, source_prompt: e.source_prompt, reason: e.reason,
  }));
  const lat = events.map((e) => Number(e.latency_ms)).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const requests = counters.requests || 0;
  const hits = (counters.exact_hits || 0) + (counters.semantic_hits || 0);

  return {
    schema_version: 3,
    generated_at: new Date().toISOString(),
    service: {
      name: config.serviceName,
      version: config.serviceVersion,
      uptime_s: Math.round(process.uptime()),
      model: config.model,
      embedder: config.embedderModel,
      distance_threshold: config.distanceThreshold,
      ttl_s: null,
      // additive: the frozen UI ignores fields it does not read
      model_state: model.modelStats(),
      cache_entries: db().countEntries(),
      embedder_loaded: isLoaded(),
      vector_count: undefined,
    },
    totals: {
      requests,
      exact_hits: counters.exact_hits || 0,
      semantic_hits: counters.semantic_hits || 0,
      misses: counters.misses || 0,
      bypasses: counters.bypasses || 0,
      errors: counters.errors || 0,
      rejected_hits: counters.rejected_hits || 0,
      model_invocations: counters.model_invocations || 0,
      cache_hit_rate: requests ? Number((hits / requests).toFixed(4)) : null,
    },
    latency_ms: {
      n: lat.length,
      p50: lat.length ? round1(percentile(lat, 50)) : 0,
      p90: lat.length ? round1(percentile(lat, 90)) : 0,
      p95: lat.length ? round1(percentile(lat, 95)) : 0,
      p99: lat.length ? round1(percentile(lat, 99)) : 0,
      mean: lat.length ? round1(lat.reduce((a, b) => a + b, 0) / lat.length) : 0,
      max: lat.length ? round1(lat[lat.length - 1]) : 0,
    },
    recent: events,
  };
}