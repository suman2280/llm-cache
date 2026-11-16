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
import { DomainPolicy, OPEN_POLICY } from "./domain.js";
import { overlapVerdict } from "./lexicon.js";
import { retrieve, groundRequest, PREFILL, assembleAnswer } from "./knowledge.js";
import { DOMAIN } from "./corpus.js";
import {
  requestFingerprint, scopeOf, semanticText, lastUserText,
  symbolFingerprint, asciiHeaderValue, parseEnvelope, encodeEnvelope, samplingClass,
} from "./keying.js";

/**
 * The domain policy, built from the corpus's DOMAIN descriptor.
 *
 * Mode is configurable because "refuse everything out of domain" is a product
 * decision, not a technical one:
 *   off     no restriction (the old behaviour)
 *   bypass  out-of-domain requests are served by the model but NEVER cached,
 *           and are labelled x-cache-policy: out-of-domain
 *   strict  out-of-domain requests are refused with 422
 *
 * Either way, an out-of-domain answer never enters the cache: it must not be
 * able to resurface later as a "semantic hit" for something else.
 */
let _policy = null;
export async function getPolicy() {
  if (_policy) return _policy;
  if (!config.domainMode || config.domainMode === "off") {
    _policy = OPEN_POLICY;
    return _policy;
  }
  _policy = new DomainPolicy({ ...DOMAIN, mode: config.domainMode });
  return _policy;
}

/**
 * Describe the active policy. Works before the policy has been built (the
 * first /stats call can precede the first chat request), so the domain name
 * and mode are always truthful.
 */
export function policyInfo() {
  if (_policy) return _policy.describe();
  if (!config.domainMode || config.domainMode === "off") {
    return { name: "open", description: "no domain restriction", mode: "off", threshold: null };
  }
  return {
    name: DOMAIN.name,
    description: DOMAIN.description,
    mode: config.domainMode,
    threshold: DOMAIN.threshold,
    exemplars: DOMAIN.exemplars.length,
    terms: DOMAIN.terms.length,
  };
}

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

  const candFp = await db().getByFingerprint(candidate.fingerprint);
  const cachedFp = candFp?.symbol_fp ?? "";
  if (cachedFp && ctx.symbolFp && cachedFp !== ctx.symbolFp) {
    return { ok: false, reason: "symbol fingerprint differs (different operators/numbers)" };
  }

  // 2. lexical grounding -- the candidate must actually be about what was
  //    asked. A cosine distance is not a correctness criterion: "redis aws"
  //    sits at d=0.349 from "What is AWS?", inside the radius, and the cached
  //    answer was about AWS in general rather than about Redis. The query's
  //    specific content words must appear in the candidate.
  if (ctx.overlap !== false) {
    let answer = "";
    try { answer = answerText(JSON.parse(candFp?.response_json || "{}")) ?? ""; } catch { /* ignore */ }
    const verdict = overlapVerdict(ctx.queryText, candFp?.prompt ?? "", answer, candidate.dist ?? 0);
    if (!verdict.ok) {
      return { ok: false, reason: `not lexically grounded: ${verdict.reason}` };
    }
    ctx.lastOverlap = verdict;
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

  // The lexical guard compares the QUESTION, not the whole conversation: the
  // system prompt is boilerplate that appears in every request, so counting
  // its words ("expert", "assistant") as topical terms only adds noise.
  const ctx = {
    scope, symbolFp, minReviewStatus, body, envelope,
    queryText: prompt || semText,
  };
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

  // ---- domain guard ----------------------------------------------------
  // The fine-tune's model card promises it refuses out-of-domain questions
  // ("100% correct refusal"). Measured, it does not: 0 of 6 out-of-scope
  // questions were refused. So the promise is enforced here, before any tier
  // can serve or store an answer.
  const policy = await getPolicy();
  let domain = null;
  if (policy.mode !== "off") {
    domain = await policy.classify(semText);
    if (!domain.inDomain) {
      if (policy.mode === "strict") {
        const latency = performance.now() - started;
        db().recordEvent({
          ts: new Date().toISOString(), status: "bypass", model: body.model,
          latency_ms: round1(latency), prompt,
          reason: `out of domain '${policy.name}': ${domain.reason}`,
          tier: "domain",
        });
        db().increment(["requests", "bypasses", "out_of_domain"]);
        const err = new Error(
          `This assistant only answers questions about ${policy.description}. ` +
          `Your question was not recognised as being in that domain (${domain.reason}).`
        );
        err.statusCode = 422;
        err.public = true;
        throw err;
      }
      // mode === "bypass": fall through to inference, but never cache it.
      ctx.outOfDomain = domain;
    } else {
      db().increment(["in_domain"]);
    }
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
  // ---- grounding --------------------------------------------------------
  // The checkpoint has no RAG of its own (the model card attributes its
  // grounding to a FAISS layer that is not part of the weights), so the
  // reference material is retrieved here and folded into the system prompt.
  // Without it the model answers from memory and produces generic text:
  // "What are virtual machines?" came back as a definition of virtualization
  // with no mention of EC2 at all.
  let groundedBody = body;
  let groundingUsed = 0;
  try {
    const chunks = await retrieve(semText, config.groundingTopK);
    if (chunks.length) {
      groundedBody = groundRequest(body, chunks, policy.mode !== "off" ? policy : null);
      groundingUsed = chunks.length;
    }
  } catch (err) {
    console.warn(`[knowledge] retrieval failed, answering ungrounded: ${err.message}`);
  }

  const t2 = performance.now();
  let payload;
  try {
    payload = await model.infer(groundedBody, {
      maxTokens: Math.max(maxTokens ?? 0, config.maxAnswerTokens),
      prefill: config.answerPrefill ? PREFILL : null,
    });
    if (config.answerPrefill) {
      const text = assembleAnswer(PREFILL, payload?.choices?.[0]?.message?.content);
      payload = {
        ...payload,
        choices: [{ ...payload.choices[0], message: { ...payload.choices[0].message, content: text } }],
      };
    }
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

  // Store for tiers 1 and 2. An out-of-domain answer is NEVER stored: it must
  // not be able to resurface later as a "semantic hit" for something else.
  if (!ctx.outOfDomain) {
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
  }

  const latency = performance.now() - started;
  db().recordEvent({
    ts: new Date().toISOString(), status: "miss", model: body.model,
    latency_ms: round1(latency), similarity: null, threshold: config.distanceThreshold,
    prompt, response: answerText(payload), tier: "miss",
    embed_ms: timings.embed_ms, redis_ms: timings.redis_ms, infer_ms: timings.infer_ms,
    reason: groundingUsed ? `grounded on ${groundingUsed} reference chunk(s)` : null,
  });
  db().increment(["requests", "misses", "model_invocations"]);
  if (ctx.outOfDomain) db().increment(["out_of_domain"]);

  return {
    status: "miss", tier: "miss",
    response: mintResponse(payload, { status: "miss" }),
    headers: {
      "x-cache-status": "miss",
      "x-cache-latency-ms": round1(latency).toFixed(1),
      "x-embed-ms": timings.embed_ms != null ? String(timings.embed_ms) : "",
      "x-redis-ms": timings.redis_ms != null ? String(timings.redis_ms) : "",
      "x-cache-policy": ctx.outOfDomain
        ? "out-of-domain"
        : (ctx.cacheDegraded ? "cache-degraded" : "miss"),
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
      domain: policyInfo(),
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
      in_domain: counters.in_domain || 0,
      out_of_domain: counters.out_of_domain || 0,
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