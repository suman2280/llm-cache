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
import { coverageVerdict } from "./lexicon.js";
import { storeBreaker } from "./breaker.js";
import { inferenceLimiter } from "./ratelimit.js";
import { splitIntents } from "./intents.js";
import { retrieve, groundRequest, PREFILL, assembleAnswer } from "./knowledge.js";
import { detectDegeneracy } from "./degenerate.js";
import { referenceTerms, referenceIdentifiers, checkGrounding } from "./grounding.js";
import { DOMAIN } from "./corpus.js";
import {
  requestFingerprint, scopeOf, semanticText, lastUserText,
  symbolFingerprint, asciiHeaderValue, parseEnvelope, encodeEnvelope, samplingClass,
  cacheIdentityOf,
} from "./keying.js";

/**
 * Rebuild the Redis vector index from SQLite after a restart.
 *
 * SQLite rows survive a restart; the vector index does not (Redis runs with
 * --save "" --appendonly no). Purging vectors on shutdown used to leave a
 * cache that exact-hit but could never semantically hit until everything was
 * regenerated. This runs once, lazily, on the first semantic lookup.
 */
let vectorsChecked = false;
async function ensureVectorsPopulated() {
  if (vectorsChecked) return;
  vectorsChecked = true;
  const indexed = await vectors.vectorCount().catch(() => 0);
  const rows = db().countEntries();
  if (indexed >= rows) return;
  console.log(`[cache] rebuilding ${rows} vector entries from SQLite (index had ${indexed})`);
  let built = 0;
  for (const row of db().listEntries({ limit: 10_000 })) {
    const vec = await embed(row.semantic_text || row.prompt).catch(() => null);
    if (!vec) continue;
    await vectors.indexDocument(`e${row.id}`, {
      scope: row.scope, model: row.model, fingerprint: row.fingerprint,
      generation_method: row.generation_method, review_status: row.review_status,
      prompt: row.prompt, chunks: row.chunk_ids,
    }, vec).catch(() => {});
    built += 1;
  }
  console.log(`[cache] rebuilt ${built} vector entries`);
}

/** Mark the vector index dirty after an external SQLite write. */
export function invalidateVectorCache() { vectorsChecked = false; }

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

/**
 * Sweep the cache for answers that are already degenerate.
 *
 * New degenerate answers are never cached, but an entry cached before this
 * guard existed would still be served -- and its neighbours in the semantic
 * index would inherit the garbage. This runs at startup and evicts them.
 */
export async function purgeDegenerateEntries() {
  const rows = db().listEntries({ limit: 10_000 });
  let purged = 0;
  for (const row of rows) {
    let text = "";
    try { text = answerText(JSON.parse(row.response_json || "{}")) ?? ""; } catch { /* ignore */ }
    const verdict = detectDegeneracy(text);
    if (!verdict.degenerate) continue;
    db().deleteEntry(row.id);
    await vectors.deleteDocument(`e${row.id}`).catch(() => {});
    purged += 1;
    console.warn(`[cache] evicted a degenerate cached answer (id=${row.id}): ${verdict.reason}`);
  }
  return purged;
}

const REVIEW_ORDER = ["draft", "needs_academic_review", "reviewed", "approved", "production"];
const reviewRank = (s) => {
  const i = REVIEW_ORDER.indexOf(String(s || "draft"));
  return i === -1 ? 0 : i;
};

/**
 * #21 single-flight: N concurrent identical misses produce ONE inference.
 * Keyed by the exact fingerprint, which already covers every answer-changing
 * parameter. Waiters join the same promise and get a copy of its payload.
 */
const inFlight = new Map();

/** #32/#41: clamp caller-supplied max_tokens to a bounded range. A missing
 *  value keeps the configured default; a too-large value is capped. */
function boundedTokens(value) {
  const ceiling = config.maxAnswerTokens * 2;
  const requested = Number(value);
  if (!Number.isFinite(requested) || requested <= 0) return value;
  return Math.min(requested, ceiling);
}

/**
 * #37: acceptance is not one global number. Curated and template entries are
 * human-verified and can be reused at a lower coverage; model-generated
 * entries are unverified drafts and need a higher bar. The declared error
 * budget (TARGET_FPR) is reported alongside the MEASURED rate from
 * scripts/bench_cache.mjs -- a target alone proves nothing.
 */
const THRESHOLD_BY_ORIGIN = {
  curated: 0.70,
  deterministic_template: 0.75,
  model: 0.85,
};
const coverageThreshold = (origin) => THRESHOLD_BY_ORIGIN[origin] ?? 0.80;

/** #44: age check shared by exact and semantic hit paths. */
function isExpired(row) {
  if (!config.cacheTtlS || config.cacheTtlS <= 0) return false;
  return Date.now() - Number(row.created_at) > config.cacheTtlS * 1000;
}

/**
 * Store-backed verifier: fetches the row, enforces TTL side effects, then
 * delegates every accept/reject decision to verifyCandidateCore.
 */
async function verifyCandidate(candidate, ctx) {
  const candFp = await db().getByFingerprint(candidate.fingerprint);
  // #44: TTL must be checked on EVERY read, not only on misses -- a hot
  // entry would otherwise never expire.
  if (candFp && isExpired(candFp)) {
    db().deleteEntry(candFp.id);
    vectors.deleteDocument(`e${candFp.id}`).catch(() => {});
    return { ok: false, reason: "the cached answer has expired" };
  }
  return verifyCandidateCore(candidate, candFp, ctx);
}

/** The contract's three distance headers. One source of truth so they cannot drift. */
function distanceHeaders(distance = 0) {
  const d = Number(distance) || 0;
  return {
    "x-cache-similarity": d.toFixed(4),
    "x-cache-distance": d.toFixed(4),
    "x-cache-similarity-score": (1 - d).toFixed(4),
  };
}

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
/**
 * The pure, store-free core of the verifier. Everything that can be decided
 * without a database lives here so the benchmark can exercise it directly
 * (issue #40) instead of measuring retrieval + coverageVerdict and calling
 * it the real accept/reject decision.
 */
export async function verifyCandidateCore(candidate, candFp, ctx) {
  // 1. scope -- the Redis query already enforced it; assert rather than trust.
  if (candidate?.scope && candidate.scope !== ctx.scope) {
    return { ok: false, reason: `scope mismatch (${candidate.scope} != ${ctx.scope})` };
  }

  // #44: TTL must be checked on EVERY read. The store-backed wrapper also
  // deletes the row; this pure check keeps the benchmark honest.
  if (candFp && isExpired(candFp)) {
    return { ok: false, reason: "the cached answer has expired" };
  }
  const cachedFp = candFp?.symbol_fp ?? "";
  if (cachedFp && ctx.symbolFp && cachedFp !== ctx.symbolFp) {
    return { ok: false, reason: "symbol fingerprint differs (different operators/numbers)" };
  }

  // 2. is the candidate actually the answer to THIS question?
  //
  //    A cosine distance is not a correctness criterion. "redis aws" sits at
  //    d=0.349 from "What is AWS?", inside the radius, and the cached answer
  //    was about AWS in general rather than about Redis.
  //
  //    And a distance is not an EQUIVALENCE criterion either: "What are
  //    virtual machines?" and "What is EC2?" are the same question, but they
  //    are 0.792 apart -- far outside any radius -- because they share no
  //    vocabulary. What they DO share is the knowledge-base chunk they
  //    ground in ("ec2-instances").
  //
  //    So the acceptance rule is: the query and the candidate must ground in
  //    a shared knowledge-base chunk, AND the candidate must cover the
  //    query's specific terms.
  let answer = "";
  try { answer = answerText(JSON.parse(candFp?.response_json || "{}")) ?? ""; } catch { /* ignore */ }
  const candChunks = String(candFp?.chunk_ids || "").split(",").filter(Boolean);
  // #13: require the TOP chunk to match, not just any overlap. "How do I
  // price an EC2 spot instance?" and "What is an EC2 instance?" share the
  // EC2 topic, but their top chunks (ec2-pricing vs ec2-instances) differ --
  // and a shared ancestor must not license serving one for the other.
  const chunkOverlap = ctx.chunkIds?.length
    ? Boolean(ctx.chunkIds[0] && candChunks[0] === ctx.chunkIds[0])
    : false;
  // A query that grounds in a chunk may only reuse an entry that grounds in
  // the same chunk. A query that grounds in NO chunk (a topic the knowledge
  // base does not cover) falls back to coverage alone.
  const sameMaterial = ctx.chunkIds?.length ? chunkOverlap : true;
  const verdict = coverageVerdict(ctx.queryText, candFp?.prompt ?? "", answer,
    sameMaterial, coverageThreshold(candFp?.generation_method), ctx.chunkText || "");
  if (!verdict.ok) {
    return { ok: false, reason: `not the same question: ${verdict.reason}` };
  }
  ctx.lastOverlap = verdict;

  // 2b. #38: re-run the domain guard on the CACHED QUESTION, not just on the
  //     incoming request. An entry that was acceptable when written can have
  //     been written through a bypass path, or its context can have changed.
  if (ctx.policy && ctx.policy.mode !== "off" && candFp?.prompt) {
    const stored = await ctx.policy.classify(candFp.prompt).catch(() => null);
    if (stored && !stored.inDomain) {
      return { ok: false, reason: `cached entry is out of domain: ${stored.reason}` };
    }
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

export async function handleChat(body, { envelopeHeader = "", role = "author", maxTokens,
  requireGrounded = false, trusted = false, clientId = "local", requestId, streamDelta } = {}) {
  const started = performance.now();
  // #66: a trace id minted by the HTTP layer (or here for direct callers).
  const rid = requestId || `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  // #62: streaming is opt-in via stream=true with a delta sink.
  const wantStream = Boolean(body?.stream && typeof streamDelta === "function");
  // #41: normalize answer-affecting params before keying and inference, so a
  // huge max_tokens cannot bypass the ceiling by being hashed verbatim.
  if (body && typeof body === "object" && body.max_tokens !== undefined) {
    body.max_tokens = boundedTokens(body.max_tokens);
  }
  const envelope = parseEnvelope(envelopeHeader);
  const semText = semanticText(body?.messages);
  const prompt = lastUserText(body?.messages);
  const symbolFp = symbolFingerprint(semText);
  const { scope, fingerprint } = cacheIdentityOf({
    body, envelope, tenantId: config.tenantId,
  });
  const minReviewStatus = role === "author" ? "draft" : (config.minReviewStatus || null);
  // Declare BEFORE ctx: ctx captures `policy`, and a later declaration is a
  // temporal dead zone error that the route catch turns into a silent 500.
  const policy = await getPolicy();

  // The lexical guard compares the QUESTION, not the whole conversation: the
  // system prompt is boilerplate that appears in every request, so counting
  // its words ("expert", "assistant") as topical terms only adds noise.
  // The KB chunks the question grounds in are needed by BOTH the semantic
  // lookup and the verifier, so they are resolved here rather than only on a
  // miss. Declared up front: the tier blocks below read them.
  let groundedBody = body;
  let groundingUsed = 0;
  let retrievalFailed = false;
  let refTerms = new Set();
  let refIds = new Set();
  let chunks = [];

  const ctx = {
    scope, symbolFp, minReviewStatus, body, envelope,
    policy,
    queryText: prompt || semText,
    fingerprint,
    trusted,
    clientId,
    requestId: rid,
    // The content path is strict: an ungrounded answer may not become content.
    // The chat path serves it labelled and uncached.
    requireGrounded,
  };
  const timings = { embed_ms: null, redis_ms: null, infer_ms: null };

  // #66: one outcome row per request, for bounded-cardinality breakdowns.
  const noteOutcome = (status, savedTokens = 0, latency = performance.now() - started) => {
    try {
      db().recordOutcome({
        ts: new Date().toISOString(), status, scope,
        concept_id: envelope?.concept_id ?? null,
        template_id: envelope?.template_id ?? null,
        generation_method: envelope?.generation_method ?? "model",
        tokens_saved: savedTokens, latency_ms: round1(latency), request_id: rid,
      });
    } catch { /* never let observability fail a response */ }
  };


  const reject = async (status, reason) => {
    const latency = performance.now() - started;
    db().recordEvent({
      ts: new Date().toISOString(), status, model: body?.model ?? config.model, request_id: rid,
      latency_ms: round1(latency), similarity: null, threshold: config.distanceThreshold,
      prompt, response: null, reason, tier: "guard", verified: 0, ...timings,
    });
    db().increment(["requests", "errors"]);
    noteOutcome("error", 0, latency);
    const err = new Error(reason);
    err.statusCode = 400;
    err.public = true;
    throw err;
  };

  if (!body?.model) return reject("error", "no model in request body");
  if (!Array.isArray(body?.messages) || body.messages.length === 0) {
    return reject("error", "no messages in request body");
  }
  // #62: stream=true is now supported when the caller supplies streamDelta.
  // Direct callers without a stream sink still get a clear error.
  if (body.stream && !wantStream) {
    const err = new Error("stream=true requires a streaming-capable transport");
    err.statusCode = 400;
    err.public = true;
    throw err;
  }

  // ---- domain guard ----------------------------------------------------
  // The fine-tune's model card promises it refuses out-of-domain questions
  // ("100% correct refusal"). Measured, it does not: 0 of 6 out-of-scope
  // questions were refused. So the promise is enforced here, before any tier
  // can serve or store an answer.
  let domain = null;
  if (policy.mode !== "off") {
    // Guard the USER'S QUESTION, not the whole conversation. A system prompt
    // ("You are an AWS assistant") made every question look in-domain.
    domain = await policy.classify(prompt || semText);
    if (!domain.inDomain) {
      if (policy.mode === "strict") {
        const latency = performance.now() - started;
        db().recordEvent({
          ts: new Date().toISOString(), status: "bypass", model: body.model, request_id: rid,
          latency_ms: round1(latency), prompt,
          reason: `out of domain '${policy.name}': ${domain.reason}`,
          tier: "domain",
        });
        db().increment(["requests", "bypasses", "out_of_domain"]);
        noteOutcome("out-of-domain", 0, latency);
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
      ts: new Date().toISOString(), status: "deterministic-hit", model: config.model, request_id: rid,
      latency_ms: round1(latency), prompt: det.prompt, response: det.answer,
      reason: `template ${det.templateId} answered by code, no model call`,
      tier: "deterministic", verified: 1,
    });
    // Tier 0 is computed in CODE -- no model was invoked. Counting it here
    // understated the project's own "inferences avoided" metric.
    db().increment(["requests", "exact_hits"]);
    noteOutcome("deterministic-hit", config.estimatedTokensPerAnswer, latency);
    return {
      status: "deterministic-hit", tier: "deterministic",
      response: mintResponse(det.response, { status: "miss" }),
      headers: {
        "x-cache-status": "deterministic-hit",
        "x-request-id": rid,
        "x-cache-latency-ms": round1(latency).toFixed(1),
        "x-cache-policy": `deterministic:${det.templateId}`,
        ...distanceHeaders(0),
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
        ts: new Date().toISOString(), status: "exact-hit", model: body.model, request_id: rid,
        latency_ms: round1(latency), similarity: 0, threshold: config.distanceThreshold,
        prompt: prompt || existing.prompt, response: answerText(payload),
        source_prompt: existing.prompt, reason: "byte-identical request",
        tier: "exact", verified: 1,
      });
      db().increment(["requests", "exact_hits"]);
      db().increment("tokens_saved", config.estimatedTokensPerAnswer);
      noteOutcome("exact-hit", config.estimatedTokensPerAnswer, latency);
      return {
        status: "exact-hit", tier: "exact",
        response: mintResponse(payload, { status: "hit" }),
        headers: {
          "x-cache-status": "exact-hit",
          "x-request-id": rid,
          "x-cache-latency-ms": round1(latency).toFixed(1),
          ...distanceHeaders(0),
          "x-cache-source-prompt": asciiHeaderValue(existing.prompt),
          "x-cache-policy": "exact",
        },
        event: { prompt: prompt || existing.prompt, response: answerText(payload), source_prompt: existing.prompt },
      };
    }
    // exact hit failed the review floor -> fall through (do not serve)
    ctx.exactRejected = verdict.reason;
  }

  // ---- multi-intent: compose from several cached answers --------------
  const intents = splitIntents(prompt || "");
  if (intents.length > 1 && config.distanceThreshold > 0) {
    const resolved = [];
    for (const intent of intents) {
      const r = await resolveIntent(intent, ctx).catch(() => null);
      if (!r) break;
      resolved.push(r);
    }
    if (resolved.length === intents.length) {
      const answer = composeAnswers(intents, resolved);
      const latency = performance.now() - started;
      db().recordEvent({
        ts: new Date().toISOString(), status: "semantic-hit", model: body.model, request_id: rid,
        latency_ms: round1(latency), similarity: 0, threshold: config.distanceThreshold,
        prompt: prompt, response: answer,
        source_prompt: resolved.map((r) => r.prompt).join(" | "),
        reason: `composed from ${resolved.length} cached answers (one per question)`,
        tier: "semantic", verified: 1,
        embed_ms: timings.embed_ms, redis_ms: timings.redis_ms,
      });
      db().increment(["requests", "semantic_hits"]);
      db().increment("tokens_saved", config.estimatedTokensPerAnswer);
      noteOutcome("semantic-hit", config.estimatedTokensPerAnswer, latency);
      return {
        status: "semantic-hit", tier: "semantic",
        response: mintResponse({
          model: body.model,
          choices: [{ index: 0, finish_reason: "stop",
            message: { role: "assistant", content: answer } }],
        }, { status: "hit" }),
        headers: {
          "x-cache-status": "semantic-hit",
          "x-request-id": rid,
          "x-cache-latency-ms": round1(latency).toFixed(1),
          ...distanceHeaders(0),
          "x-cache-source-prompt": asciiHeaderValue(resolved.map((r) => r.prompt).join(" | ")),
          "x-cache-policy": `composed-from-${resolved.length}`,
        },
        event: { prompt, response: answer,
          source_prompt: resolved.map((r) => r.prompt).join(" | ") },
      };
    }
    // At least one question was not cached: let the model answer BOTH rather
    // than serving a partial answer. Skip the single-question semantic path.
    ctx.multiIntentIncomplete = true;
  }

  // ---- tier 2: semantic ------------------------------------------------
  if (config.distanceThreshold > 0 && !ctx.multiIntentIncomplete) {
    if (!storeBreaker.allow()) {
      ctx.cacheDegraded = "store circuit breaker open";
      console.warn("[cache] store circuit breaker open -- skipping semantic tier");
    } else try {
      // The KB chunks the question grounds in are needed by the verifier (a
      // shared chunk is what makes two questions "the same question"), so
      // retrieve them before the lookup rather than only on a miss.
      if (!chunks.length) {
        chunks = await retrieve(prompt || semText, config.groundingTopK).catch(() => []);
        if (chunks.length) refTerms = referenceTerms(chunks);
        if (chunks.length) refIds = referenceIdentifiers(chunks);
      }
      ctx.chunkIds = chunks.map((c) => c.id);
      ctx.chunkText = chunks.map((c) => `${c.title} ${c.text}`).join(" ");

      let vec = null;
      const t0 = performance.now();
      vec = await embed(semText);
      timings.embed_ms = round1(performance.now() - t0);
      if (vec) {
        await ensureVectorsPopulated();
        const t1 = performance.now();
        // Two candidate sets:
        //  - entries grounded in the SAME knowledge-base chunk (the precise
        //    equivalence signal; "What are virtual machines?" and "What is
        //    EC2?" are 0.792 apart but share the chunk "ec2-instances")
        //  - entries within the cosine radius (the fuzzy signal, which catches
        //    a question that maps to no chunk)
        const [byChunk, byRadius] = await Promise.all([
          vectors.searchByChunks(vec, {
            chunks: ctx.chunkIds, scope, model: config.model, limit: 5,
          }),
          vectors.searchScope(vec, { scope, model: config.model, limit: 3 }),
        ]);
        const seen = new Set();
        const candidates = [...byChunk, ...byRadius].filter((c) => {
          if (seen.has(c.fingerprint)) return false;
          seen.add(c.fingerprint);
          return true;
        });
        timings.redis_ms = round1(performance.now() - t1);
        storeBreaker.success();

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
              ts: new Date().toISOString(), status: "semantic-hit", model: body.model, request_id: rid,
              latency_ms: round1(latency), similarity: dist, threshold: config.distanceThreshold,
              prompt: prompt || row.prompt, response: answerText(payload),
              source_prompt: row.prompt, tier: "semantic", verified: 1,
              embed_ms: timings.embed_ms, redis_ms: timings.redis_ms,
            });
            db().increment(["requests", "semantic_hits"]);
            db().increment("tokens_saved", config.estimatedTokensPerAnswer);
            noteOutcome("semantic-hit", config.estimatedTokensPerAnswer, latency);
            return {
              status: "semantic-hit", tier: "semantic",
              response: mintResponse(payload, { status: "hit" }),
              headers: {
                "x-cache-status": "semantic-hit",
                "x-request-id": rid,
                "x-cache-latency-ms": round1(latency).toFixed(1),
                ...distanceHeaders(dist),
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
      storeBreaker.failure();
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
  try {
    // Retrieve with the QUESTION, not the rendered conversation. The rendered
    // form carries a "USER:\n" prefix, and that prefix is enough to reorder
    // the results: for "aws" it put "IAM users" and "IAM roles" above the
    // overview chunk, so the answer came back about IAM instead of about AWS.
    chunks = await retrieve(prompt || semText, config.groundingTopK);
    if (chunks.length) {
      groundedBody = groundRequest(body, chunks, policy.mode !== "off" ? policy : null);
      groundingUsed = chunks.length;
      refTerms = referenceTerms(chunks);
      refIds = referenceIdentifiers(chunks);
    }
  } catch (err) {
    // #18: retrieval failure must NOT silently skip the grounding check and
    // let a fabricated answer into the cache.
    retrievalFailed = true;
    console.warn(`[knowledge] retrieval failed: ${err.message}; answers will not be cached`);
  }

  const t2 = performance.now();
  // #14: an actual inference, not a cache hit, is the expensive thing.
  const admitted = inferenceLimiter.allow(ctx.clientId || "local");
  if (!admitted.allowed) {
    const err = new Error("inference rate limit exceeded; please retry shortly");
    err.statusCode = 429;
    err.public = true;
    throw err;
  }
  let payload;
  let failure = null;
  let grounding = null;
  try {
    // A 7B on a CPU sometimes falls into a repetition loop and emits one line
    // over and over ("s3 HTTPS encryption" produced the same bullet 15
    // times). Such an answer must never be cached -- it would then be served
    // to every future request for that question -- so it is detected, retried
    // with a hotter sample, and discarded if it happens again.
    for (let attempt = 0; attempt <= config.degenerateRetries; attempt++) {
      // Each attempt starts clean: a failure from the previous attempt must not
      // condemn a good answer from this one.
      failure = null;
      const retry = attempt > 0;
      // The retry is CLOSED BOOK: the first answer was not grounded in the
      // reference material, which happens when a small model is pushed for
      // more detail than the material supports.
      const reqBody = retry
        ? {
          ...groundRequest(body, chunks, policy.mode !== "off" ? policy : null, { closedBook: true }),
          temperature: Math.min(1.2, Number(groundedBody.temperature ?? 0.3) + 0.3),
          seed: undefined, // a fresh sample
        }
        : groundedBody;

      // Join an in-flight generation for the same request instead of running
      // a second inference. This dedups the burst that --parallel 1 would
      // otherwise queue for minutes. Streaming requests run their own stream
      // (each owns its delta sink) and bypass the shared single-flight job.
      const existing = wantStream ? null : inFlight.get(fingerprint);
      let generated;
      if (existing) {
        generated = await existing;
      } else {
        const inferOpts = {
          maxTokens: boundedTokens(maxTokens),
          prefill: config.answerPrefill ? PREFILL : null,
        };
        const job = wantStream
          ? model.inferStream(reqBody, inferOpts, streamDelta)
          : model.infer(reqBody, inferOpts);
        if (wantStream) {
          generated = await job; // each streaming caller owns its delta sink
        } else {
          inFlight.set(fingerprint, job);
          try { generated = await job; }
          finally { inFlight.delete(fingerprint); }
        }
      }
      payload = generated ? JSON.parse(JSON.stringify(generated)) : generated;
      if (config.answerPrefill) {
        const text = assembleAnswer(PREFILL, payload?.choices?.[0]?.message?.content);
        payload = {
          ...payload,
          choices: [{ ...payload.choices[0], message: { ...payload.choices[0].message, content: text } }],
        };
      }

      const answer = answerText(payload) ?? "";
      const verdict = detectDegeneracy(answer);
      if (retrievalFailed) {
        failure = {
          kind: "ungrounded",
          reason: "reference material unavailable; the answer could not be checked against a source",
        };
      } else if (!verdict.degenerate && refTerms.size) {
        // The answer must be grounded in the reference material it was given.
        // Asking a small model for more makes it fabricate -- "aws" with six
        // to nine bullets produced a "t2.micro" free-tier instance type that
        // appears nowhere in the reference.
        const g = checkGrounding(answer, refTerms, refIds);
        grounding = g;
        if (!g.grounded) {
          failure = { kind: "ungrounded", reason: g.reason ?? "not grounded in the reference" };
        }
      }
      if (!verdict.degenerate && !failure) { failure = null; break; }
      if (!failure) {
        failure = { kind: "degenerate", reason: verdict.reason ?? "the answer repeated itself" };
      }
      console.warn(`[generation] ${failure.kind} output (${failure.reason}) -- attempt ${attempt + 1}`);
      if (attempt === config.degenerateRetries) {
        if (failure.kind === "degenerate") {
          // A repetition loop is never servable.
          const err = new Error(
            `the model produced a degenerate answer (${failure.reason}) and it could ` +
            "not be regenerated; nothing was cached."
          );
          err.statusCode = 502;
          err.public = true;
          throw err;
        }
        // An ungrounded answer is servable but must NOT be cached: it would
        // otherwise be replayed to every later request as if it were sourced.
        // The chat path serves it with a warning; the content path refuses it,
        // because content is what the SOP requires to be source-grounded.
        if (ctx.requireGrounded) {
          const err = new Error(
            `the answer could not be grounded in the reference material ` +
            `(${failure.reason}); the knowledge base has no source for this question. ` +
            `Nothing was cached.`
          );
          err.statusCode = 502;
          err.public = true;
          throw err;
        }
        break; // serve it, labelled, uncached
      }
    }
  } catch (err) {
    const latency = performance.now() - started;
    db().recordEvent({
      ts: new Date().toISOString(), status: "error", model: body?.model ?? config.model, request_id: rid,
      latency_ms: round1(latency), prompt, reason: err.message, tier: "miss",
      embed_ms: timings.embed_ms, redis_ms: timings.redis_ms,
    });
    db().increment(["requests", "errors"]);
    noteOutcome("error", 0, latency);
    const e = new Error(err.public ? err.message : `inference failed: ${err.message}`);
    e.statusCode = err.statusCode ?? 502;
    e.public = true;
    throw e;
  }
  timings.infer_ms = round1(performance.now() - t2);

  // #36/#9: keep both stores bounded and drop expired entries. The store
  // returns the evicted rows so their Redis vectors can be removed too.
  try {
    const evicted = [
      ...db().evictExpired(config.cacheTtlS * 1000),
      ...db().evictToLimit(config.maxEntries),
    ];
    for (const row of evicted) {
      await vectors.deleteDocument(`e${row.id}`).catch(() => {});
    }
    if (evicted.length) invalidateVectorCache();
  } catch (err) {
    console.warn(`[cache] eviction failed: ${err.message}`);
  }

  // Store for tiers 1 and 2. An out-of-domain answer is NEVER stored: it must
  // not be able to resurface later as a "semantic hit" for something else.
  // Nothing that failed a check may be cached. An ungrounded answer replayed
  // to every later request would be worse than no cache at all.
  if (config.trustedWritesOnly && !ctx.trusted) {
    console.warn(`[cache] quarantined an untrusted answer from ${ctx.clientId} (not cached)`);
  }
  if (!ctx.outOfDomain && !failure && !(config.trustedWritesOnly && !ctx.trusted)) {
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
      chunk_ids: chunks.map((c) => c.id).join(","),
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
          prompt, chunks: chunks.map((c) => c.id),
        }, vec).catch((e) => console.warn(`[redis] index failed: ${e.message}`));
      }
    }
  } catch (err) {
    console.warn(`[store] cache write failed, request still served: ${err.message}`);
  }
  }

  const latency = performance.now() - started;
  db().recordEvent({
    ts: new Date().toISOString(), status: "miss", model: body.model, request_id: rid,
    latency_ms: round1(latency), similarity: null, threshold: config.distanceThreshold,
    prompt, response: answerText(payload), tier: "miss",
    embed_ms: timings.embed_ms, redis_ms: timings.redis_ms, infer_ms: timings.infer_ms,
    reason: failure?.kind === "ungrounded"
      ? `not cached: ${failure.reason}`
      : (groundingUsed ? `grounded on ${groundingUsed} reference chunk(s)` : null),
  });
  db().increment(["requests", "misses", "model_invocations"]);
  noteOutcome("miss", 0, latency);
  if (ctx.outOfDomain) db().increment(["out_of_domain"]);

  return {
    status: "miss", tier: "miss",
    response: mintResponse(payload, { status: "miss" }),
    headers: {
      "x-cache-status": "miss",
      "x-request-id": rid,
      "x-cache-latency-ms": round1(latency).toFixed(1),
      "x-embed-ms": timings.embed_ms != null ? String(timings.embed_ms) : "",
      "x-redis-ms": timings.redis_ms != null ? String(timings.redis_ms) : "",
      "x-cache-policy": ctx.outOfDomain
        ? "out-of-domain"
        : (failure?.kind === "ungrounded"
          ? "ungrounded"
          : (ctx.cacheDegraded ? "cache-degraded" : "miss")),
      ...(grounding ? { "x-grounding": String(grounding.ratio) } : {}),
    },
    event: { prompt, response: answerText(payload), embed_ms: timings.embed_ms, redis_ms: timings.redis_ms },
  };
}

// ---------------------------------------------------------------------------
// Multi-intent resolution
//
// "tell me about AWS\ntell me about EC2" is two questions. Serving the nearest
// single answer drops the first one silently -- and it happened to pass the
// verifier because "aws" is domain-generic and "ec2" was the only specific
// term left. Each intent is resolved independently here, then the answers are
// composed.

async function resolveIntent(intent, ctx) {
  const text = semanticText([{ role: "user", content: intent }]);
  const chunks = await retrieve(intent, config.groundingTopK).catch(() => []);
  // temporarily swap context so the verifier checks THIS intent, not the
  // whole multi-intent message.
  const savedChunkIds = ctx.chunkIds;
  const savedChunkText = ctx.chunkText;
  const savedQueryText = ctx.queryText;
  const savedSymbolFp = ctx.symbolFp;
  ctx.chunkIds = chunks.map((c) => c.id);
  ctx.chunkText = chunks.map((c) => `${c.title} ${c.text}`).join(" ");
  ctx.queryText = intent;
  ctx.symbolFp = symbolFingerprint(intent);
  const chunkIds = chunks.map((c) => c.id);
  try {
  const vec = await embed(text);
  if (!vec) return null;

  const [byChunk, byRadius] = await Promise.all([
    vectors.searchByChunks(vec, {
      chunks: chunkIds, scope: ctx.scope, model: config.model, limit: 5,
    }),
    vectors.searchScope(vec, { scope: ctx.scope, model: config.model, limit: 3 }),
  ]);
  const seen = new Set();
  for (const cand of [...byChunk, ...byRadius]) {
    if (seen.has(cand.fingerprint)) continue;
    seen.add(cand.fingerprint);
    if (cand.fingerprint === ctx.fingerprint) continue;
    const row = db().getByFingerprint(cand.fingerprint);
    if (!row) continue;
    let answer = "";
    try { answer = answerText(JSON.parse(row.response_json)) ?? ""; } catch { continue; }
    if (!answer) continue;
    const verdict = await verifyCandidate(cand, ctx);
    if (!verdict.ok) db().increment(["rejected_hits"]);
    if (verdict.ok) {
      db().touchHit(row.id);
      return { answer, prompt: row.prompt, distance: Number(cand.dist) };
    }
  }
  return null;
  } finally {
    ctx.chunkIds = savedChunkIds;
    ctx.chunkText = savedChunkText;
    ctx.queryText = savedQueryText;
    ctx.symbolFp = savedSymbolFp;
  }
}

function composeAnswers(intents, resolved) {
  const sections = resolved.map((r, i) =>
    `**${intents[i]}**\n\n${r.answer.replace(/^Key points:\s*/i, "")}`);
  return `Here are answers to your questions.\n\n${sections.join("\n\n")}`;
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

export function statsPayload({ breakdownDim } = {}) {
  const counters = db().counters();
  const events = db().recentEvents(config.statsEventLimit).map((e) => ({
    id: Number(e.id), ts: e.ts, status: e.status, model: e.model,
    similarity: e.similarity, threshold: e.threshold, latency_ms: e.latency_ms,
    embed_ms: e.embed_ms, redis_ms: e.redis_ms, prompt: e.prompt,
    response: e.response, source_prompt: e.source_prompt, reason: e.reason,
    request_id: e.request_id ?? null,
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
      ttl_s: config.cacheTtlS || null,
      // additive: the frozen UI ignores fields it does not read
      model_state: model.modelStats(),
      domain: policyInfo(),
      error_budget: {
        target_fpr: config.targetFpr,
        // provenance-dependent thresholds; the measured FPR comes from
        // `node scripts/bench_cache.mjs`, not from this process
        coverage_thresholds: THRESHOLD_BY_ORIGIN,
        measured_fpr: { curated: null, deterministic_template: null, model: null },
      },
      store_breaker: storeBreaker.describe(),
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
      // R-17: an ESTIMATE, not a measurement -- a hit has no `usage` object.
      tokens_saved: counters.tokens_saved || 0,
      // #65: negative-cache refusals served without guard/model work.
      negative_hits: counters.negative_hits || 0,
      // #66: cost saved is tokens_saved * price-per-token. Still an estimate.
      cost_saved_usd: Number(((counters.tokens_saved || 0) * config.costPerTokenUsd).toFixed(6)),
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
    // #66: additive fine-grained observability. Never read by the frozen UI.
    breakdown: {
      dimensions: ["scope", "concept_id", "template_id", "generation_method"],
      ...(breakdownDim
        ? { requested: breakdownDim, top: db().breakdown(breakdownDim, { limit: config.breakdownLimit }) }
        : {
          scope: db().breakdown("scope", { limit: config.breakdownLimit }),
          template_id: db().breakdown("template_id", { limit: config.breakdownLimit }),
          concept_id: db().breakdown("concept_id", { limit: config.breakdownLimit }),
          generation_method: db().breakdown("generation_method", { limit: config.breakdownLimit }),
        }),
      totals: db().outcomeTotals(),
    },
    // #66: trace id is emitted on the response header x-request-id (set by
    // the HTTP layer); this is the id stamped on the most recent event.
    request_id: events.length ? events[0].request_id : null,
    recent: events,
  };
}