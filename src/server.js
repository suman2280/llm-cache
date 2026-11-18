/**
 * HTTP surface. Built to docs/UI-CONTRACT.md -- the frozen dashboard is the
 * spec, so every field it reads is emitted exactly.
 *
 * Additive endpoints (the /content/* surface) exist because the SOP is a
 * content pipeline, not a chat box: they let a caller hand the cache a
 * concept_id / asset_type / template and get a governed answer back.
 */

import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import Fastify from "fastify";
import config from "./config.js";
import { getStore as db } from "./store.js";
import * as vectors from "./vectors.js";
import * as cache from "./cache.js";
import { invalidateVectorCache } from "./cache.js";
import * as model from "./model.js";
import * as templates from "./templates.js";
import { encodeEnvelope, asciiHeaderValue, parseEnvelope, scopeOf } from "./keying.js";
import { isLoaded as embedderLoaded, embedderInfo } from "./embedder.js";
import { retrieve } from "./knowledge.js";

function hash(v) { return createHash("sha256").update(v, "utf8").digest("hex").slice(0, 12); }
// Escape a value for use inside a Prometheus label string.
function escMetric(v) { return String(v ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").slice(0, 128); }

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

export async function build() {
  model.registerCleanup();
  const app = Fastify({ logger: false, bodyLimit: 8 * 1024 * 1024 });

  // #66: a trace id on EVERY response (including errors and static files).
  // Set in onRequest so it is present even when a handler throws.
  app.addHook("onRequest", async (req, reply) => {
    req.requestId = randomUUID();
    reply.header("x-request-id", req.requestId);
  });

  // ---- static dashboard (same origin: no CORS surface) ----------------
  // A hand-rolled handler for 5 files: no extra dependency, no virtual
  // filesystem walk, and it can only serve the exact known set.
  const DASH_FILES = ["index.html", "style.css", "app.js", "reconcile.js", "reconcile.test.js"];
  app.get("/dashboard", (req, reply) => reply.redirect("/dashboard/"));
  app.get("/dashboard/", async (_req, reply) => {
    reply.type(MIME[".html"]);
    return readFile(join(config.dashboardDir, "index.html"), "utf8");
  });
  app.get("/dashboard/:file", async (req, reply) => {
    const file = String(req.params.file);
    if (!DASH_FILES.includes(file)) return reply.code(404).send({ detail: "not found" });
    const ext = file.slice(file.lastIndexOf("."));
    try {
      const body = await readFile(join(config.dashboardDir, normalize(file)));
      reply.type(MIME[ext] ?? "application/octet-stream");
      return body;
    } catch {
      return reply.code(404).send({ detail: "not found" });
    }
  });
  app.setNotFoundHandler(async (req, reply) => {
    if (req.url.startsWith("/dashboard")) return reply.code(404).send({ detail: "not found" });
    return reply.code(404).send({ detail: `no route ${req.method} ${req.url}` });
  });

  /**
   * Is this request allowed to change state?
   *
   * Either it carries the admin token, or it is a same-origin browser request.
   * The second clause is what lets the dashboard's own buttons work without
   * embedding the admin token in the page: a same-origin fetch is inside the
   * page's own trust boundary, while a cross-origin or script-driven request
   * is not. It is defence in depth, not a hard boundary -- anything that can
   * reach the port can forge the header -- so ADMIN_TOKEN should still be set
   * for anything but a localhost PoC.
   */
  const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
  const isLoopbackHost = (host = "") => {
    const bare = String(host).split(":")[0].replace(/^\[|\]$/g, "");
    return LOOPBACK.has(bare) || LOOPBACK.has(String(host));
  };

  /**
   * The principal acting on this request, derived from the presented token.
   * Never from a body field: that is how #43's "two approvers" became one
   * caller with two strings.
   */
  const principal = (req) => {
    const t = String(req.headers["x-admin-token"] || "");
    if (config.adminToken && t === config.adminToken) return `operator:${hash(t)}`;
    if (config.reviewerToken && t === config.reviewerToken) return `reviewer:${hash(t)}`;
    if (isLoopbackHost(config.host)) return "operator:loopback";
    return "anonymous";
  };
  const adminOk = (req) => {
    if (!config.adminToken) return true;
    const t = String(req.headers["x-admin-token"] || "");
    if (config.adminToken && t === config.adminToken) return true;
    if (config.reviewerToken && t === config.reviewerToken) return true;
    // The dashboard cannot embed the admin token in the page, so same-origin
    // headers are accepted ONLY for a loopback-bound PoC. On a non-loopback
    // bind these are forgeable by any HTTP client, so they are ignored and
    // the token is the sole authority.
    if (!isLoopbackHost(config.host)) return false;
    if (req.headers["sec-fetch-site"] === "same-origin") return true;
    const host = req.headers.host;
    if (!isLoopbackHost(host)) return false;
    const origin = req.headers.origin;
    if (origin && origin === `http://${host}`) return true;
    const referer = req.headers.referer;
    if (referer && referer.startsWith(`http://${host}`)) return true;
    return false;
  };

  // ---- OpenAI-compatible chat ----------------------------------------
  app.post("/v1/chat/completions", async (req, reply) => {
    const envelopeHeader = String(req.headers["x-content-envelope"] || "");
    const trusted = adminOk(req);
    const role = trusted ? "author" : "consumer";
    const clientId = String(req.ip || req.socket?.remoteAddress || "local");
    const opts = { envelopeHeader, role, maxTokens: req.body?.max_tokens,
      trusted, clientId, requestId: req.requestId };
    try {
      if (req.body?.stream) {
        // #62: stream=true returns text/event-stream. Deltas are buffered while
        // the cache/guard/verifier/infer path runs, then headers (with the real
        // X-Cache-* verdict) are written before the first chunk. A streamed
        // miss still goes through grounding + degeneracy checks + cache
        // write-back because it is the same handleChat path.
        const deltas = [];
        const out = await cache.handleChat(req.body, {
          ...opts, streamDelta: (t) => { if (t) deltas.push(t); },
        });
        const answer = out.response?.choices?.[0]?.message?.content
          ?? deltas.join("") ?? "";
        const id = out.response?.id || `chatcmpl-${req.requestId}`;
        const model = out.response?.model || config.model;
        reply.hijack();
        reply.raw.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          ...out.headers,
          "x-request-id": req.requestId,
        });
        const chunks = answer ? answer.match(/(\S+\s*)/g) || [answer] : [];
        for (const chunk of chunks) {
          reply.raw.write(`data: ${JSON.stringify({
            id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model,
            choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
          })}\n\n`);
        }
        reply.raw.write(`data: ${JSON.stringify({
          id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n`);
        reply.raw.write("data: [DONE]\n\n");
        reply.raw.end();
        return;
      }
      const out = await cache.handleChat(req.body, opts);
      reply.headers(out.headers);
      return out.response;
    } catch (err) {
      const status = err.statusCode ?? 500;
      if (!err.public) console.error("[chat] unexpected error:", err.stack || err.message);
      // #54: guard rejections (422 domain, 429 rate-limit, 400 invalid body)
      // must be visible on /stats and must carry cache headers.
      const policy = status === 422 ? "out-of-domain"
        : status === 429 ? "rate-limited"
        : (err.public ? "invalid-request" : "internal-error");
      const cacheStatus = status === 429 ? "bypass" : "error";
      reply.headers({
        "X-Cache-Status": cacheStatus,
        "X-Cache-Latency-Ms": "0.0",
        "X-Cache-Policy": policy,
        "X-Served-By": "llm-cache",
      });
      reply.code(status);
      try {
        const body = req.body ?? {};
        const prompt = (Array.isArray(body.messages)
          ? body.messages.map((m) => m?.content).join(" ") : "").slice(0, 200);
        db().recordEvent({
          ts: new Date().toISOString(),
          status: cacheStatus, model: body?.model ?? config.model,
          latency_ms: 0, prompt, reason: policy, tier: "guard",
        });
        db().increment(["requests", cacheStatus === "bypass" ? "bypasses" : "errors"]);
      } catch { /* never let observability fail the response */ }
      // The UI reads `payload.detail` (a string) to build its error line.
      return { detail: err.public ? err.message : "internal error" };
    }
  });

  app.get("/v1/models", async () => ({
    object: "list",
    data: [{
      id: config.model, object: "model", created: Math.floor(Date.now() / 1000),
      owned_by: "local",
    }],
  }));

  // ---- /stats (the frozen UI's contract) -------------------------------
  // #66: optional ?breakdown=scope|concept_id|template_id|generation_method
  // narrows the additive `breakdown` object; with no query all dimensions are
  // returned. The frozen fields are unchanged.
  app.get("/stats", async (req) => cache.statsPayload({ breakdownDim: req.query?.breakdown }));

  /**
   * R-17: Prometheus-format metrics. The dashboard's /stats is the JSON
   * contract; this is the machine-readable surface for scraping.
   */
  app.get("/metrics", async (_req, reply) => {
    const d = cache.statsPayload();
    const t = d.totals;
    const l = d.latency_ms;
    const lines = [
      "# HELP llm_cache_up Whether the proxy is serving.",
      "# TYPE llm_cache_up gauge",
      `llm_cache_up 1`,
      "# HELP llm_cache_requests_total Requests handled.",
      "# TYPE llm_cache_requests_total counter",
      `llm_cache_requests_total ${t.requests || 0}`,
      "# HELP llm_cache_hits_total Cache hits by tier.",
      "# TYPE llm_cache_hits_total counter",
      `llm_cache_hits_total{tier="exact"} ${t.exact_hits || 0}`,
      `llm_cache_hits_total{tier="semantic"} ${t.semantic_hits || 0}`,
      "# HELP llm_cache_misses_total Cache misses.",
      "# TYPE llm_cache_misses_total counter",
      `llm_cache_misses_total ${t.misses || 0}`,
      "# HELP llm_cache_bypasses_total Bypasses.",
      "# TYPE llm_cache_bypasses_total counter",
      `llm_cache_bypasses_total ${t.bypasses || 0}`,
      "# HELP llm_cache_errors_total Errors.",
      "# TYPE llm_cache_errors_total counter",
      `llm_cache_errors_total ${t.errors || 0}`,
      "# HELP llm_cache_rejected_hits_total Candidates refused by the verifier.",
      "# TYPE llm_cache_rejected_hits_total counter",
      `llm_cache_rejected_hits_total ${t.rejected_hits || 0}`,
      "# HELP llm_cache_model_invocations_total Actual model calls.",
      "# TYPE llm_cache_model_invocations_total counter",
      `llm_cache_model_invocations_total ${t.model_invocations || 0}`,
      "# HELP llm_cache_tokens_saved_estimate Estimated completion tokens avoided (not measured).",
      "# TYPE llm_cache_tokens_saved_estimate counter",
      `llm_cache_tokens_saved_estimate ${t.tokens_saved || 0}`,
      "# HELP llm_cache_cost_saved_usd_estimate Estimated USD avoided (tokens_saved * price/token).",
      "# TYPE llm_cache_cost_saved_usd_estimate gauge",
      `llm_cache_cost_saved_usd_estimate ${t.cost_saved_usd || 0}`,
      // #66: bounded-cardinality breakdown gauges (top-N per dimension).
      "# HELP llm_cache_hits_by_scope Cache hits by scope (top N, bounded cardinality).",
      "# TYPE llm_cache_hits_by_scope gauge",
      ...d.breakdown.scope.map((r) => `llm_cache_hits_by_scope{scope="${escMetric(r.key)}"} ${r.hits}`),
      "# HELP llm_cache_hits_by_template Cache hits by template (top N, bounded cardinality).",
      "# TYPE llm_cache_hits_by_template gauge",
      ...d.breakdown.template_id.map((r) => `llm_cache_hits_by_template{template_id="${escMetric(r.key)}"} ${r.hits}`),
      "# HELP llm_cache_negative_hits_total Refusals served from the negative cache.",
      "# TYPE llm_cache_negative_hits_total counter",
      `llm_cache_negative_hits_total ${t.negative_hits || 0}`,
      "# HELP llm_cache_reranker_rejections_total Candidates refused by the reranker.",
      "# TYPE llm_cache_reranker_rejections_total counter",
      `llm_cache_reranker_rejections_total ${t.reranker_rejections || 0}`,
      "# HELP llm_cache_entries Cached documents.",
      "# TYPE llm_cache_entries gauge",
      `llm_cache_entries ${d.service.cache_entries || 0}`,
      "# HELP llm_cache_latency_ms Request latency over the event window.",
      "# TYPE llm_cache_latency_ms gauge",
      `llm_cache_latency_ms{quantile="0.5"} ${l.p50}`,
      `llm_cache_latency_ms{quantile="0.9"} ${l.p90}`,
      `llm_cache_latency_ms{quantile="0.99"} ${l.p99}`,
    ];
    reply.type("text/plain; version=0.0.4; charset=utf-8");
    return lines.join("\n") + "\n";
  });

  // NOTE: /stats/reset is deliberately NOT admin-gated.
  //
  // The frozen dashboard's "Reset counters" button POSTs here with no
  // credentials (app.js:547) and is part of the shipped UI, so gating this
  // route would break the UI. The exposure it buys is small and deliberate:
  // this clears counters and the event ring only -- it cannot touch a cache
  // document, cannot delete content, and cannot promote a review status.
  // The endpoints that CAN do those things (/cache/*, /content/records/:id/
  // review) stay admin-gated.
  app.post("/stats/reset", async () => {
    db().resetStats();
    return cache.statsPayload();
  });

  app.post("/stats/record-event", async (req, reply) => {
    // #10: seeding fabricates events and inflates counters. It needs BOTH the
    // feature flag and an authorized caller, not just the flag.
    if (!config.allowSeed || !adminOk(req)) {
      return reply.code(404).send({ detail: "demo seed disabled" });
    }
    const b = req.body ?? {};
    const status = ["miss", "exact-hit", "semantic-hit", "bypass", "error",
      "deterministic-hit", "semantic-hit-rejected"].includes(b.status) ? b.status : "miss";
    db().recordEvent({
      ts: new Date().toISOString(), status, model: b.model ?? config.model,
      latency_ms: Number(b.latency_ms ?? 10), prompt: String(b.prompt ?? "demo prompt"),
      response: b.response ?? null, source_prompt: b.source_prompt ?? null,
      similarity: b.similarity ?? null, reason: b.reason ?? null,
      threshold: b.threshold ?? config.distanceThreshold, tier: "seed",
    });
    db().increment(["requests", { "miss": "misses", "exact-hit": "exact_hits",
      "semantic-hit": "semantic_hits", "bypass": "bypasses", "error": "errors",
    }[status] ?? "misses"]);
    return cache.statsPayload();
  });

  // ---- health ----------------------------------------------------------
  app.get("/healthz", async () => ({
    status: "ok",
    checks: {
      model: model.modelStats(),
      embedder: embedderInfo(),
      redis: { up: vectors.isUp() },
      sqlite: { entries: db().countEntries() },
    },
  }));

  app.get("/", async () => ({
    service: config.serviceName,
    version: config.serviceVersion,
    health: "/healthz",
    stats: "/stats",
    chat: "/v1/chat/completions",
    content: "/content/generate",
    dashboard: "/dashboard/",
    docs: ["docs/UI-CONTRACT.md", "docs/REBUILD.md", "docs/MODEL-FINDINGS.md"],
  }));

  // ---- the content surface (the SOP pipeline) --------------------------
  // Generate one asset, governed: deterministic-first, model-fallback, and the
  // result carries its provenance so it can be reviewed and invalidated.
  app.post("/content/generate", async (req, reply) => {
    const b = req.body ?? {};
    const envelope = parseEnvelope(String(req.headers["x-content-envelope"] || ""));
    const trusted = adminOk(req);
    const role = trusted ? "author" : "consumer";
    const clientId = String(req.ip || req.socket?.remoteAddress || "local");

    // Same rules as a chat request, but the prompt is built from the envelope
    // so the demo is deterministic and inspectable.
    const tplId = b.template_id ?? envelope.template_id;
    const params = b.params ?? envelope.params;

    if (tplId && params) {
      const tpl = templates.getTemplate(String(tplId));
      if (!tpl) return reply.code(400).send({ detail: `unknown template '${tplId}'` });
      const rendered = templates.renderTemplate(tpl, params);
      if (!rendered.ok) return reply.code(400).send({ detail: rendered.why });

      const full = {
        chapter_code: b.chapter_code ?? envelope.chapter_code ?? "_",
        concept_id: tpl.concept_id, asset_type: tpl.asset_type,
        source_section: b.source_section ?? envelope.source_section ?? "_",
        difficulty_level: String(tpl.difficulty_level), skill_type: tpl.skill_type,
        template_id: tpl.id, params, review_status: "draft",
        generation_method: "deterministic_template",
      };
      const body = {
        model: config.model,
        messages: [
          { role: "system", content: "You are an AWS enterprise assistant." },
          { role: "user", content: rendered.prompt },
        ],
        temperature: 0, max_tokens: 400,
      };
      // #25: content must be in-domain BEFORE any direct insert. Seeding and
      // generation used to bypass the guard entirely.
      const policy = await cache.getPolicy();
      if (policy.mode !== "off") {
        const verdict = await policy.classify(rendered.prompt);
        if (!verdict.inDomain) {
          return reply.code(422).send({
            detail: `out of domain '${policy.name}': ${verdict.reason}`,
          });
        }
      }
      const out = await cache.handleChat(body, {
        envelopeHeader: encodeEnvelope(full), role, maxTokens: 400,
        requireGrounded: true, trusted, clientId, requestId: req.requestId,
      });
      const seededChunks = await retrieve(rendered.prompt, 3).catch(() => []);
      db().insertEntry({
        chunk_ids: seededChunks.map((c) => c.id).join(","),
        // Tier 0 entries must have a REAL key: the column is UNIQUE and the
        // exact tier looks up requestFingerprint(), so an empty string made
        // the second generation fail and the first unreachable.
        fingerprint: templates.templateKey(tpl.id, params),
        scope: scopeOf(full, 'det', config.tenantId), model: config.model,
        semantic_text: rendered.prompt, prompt: rendered.prompt,
        response_json: JSON.stringify(out.response),
        symbol_fp: "", envelope_json: JSON.stringify(full),
        template_id: tpl.id, params_json: JSON.stringify(params),
        actual_answer: rendered.answer, generation_method: "deterministic_template",
        verification_method: "deterministic_rule", review_status: "draft",
        created_at: Date.now(), last_used_at: Date.now(),
      });
      return {
        asset_type: tpl.asset_type, concept_id: tpl.concept_id, chapter_code: full.chapter_code,
        prompt: rendered.prompt, actual_answer: rendered.answer,
        answer_explanation: rendered.explanation,
        generation_method: "deterministic_template",
        verification_method: "deterministic_rule",
        verification_status: "verified", review_status: "draft",
        parameters: params, cache_status: out.status, envelope: full,
      };
    }

    if (!b.prompt) {
      return reply.code(400).send({ detail: "provide either (template_id + params) or prompt" });
    }
    const full = {
      chapter_code: b.chapter_code ?? envelope.chapter_code ?? "_",
      concept_id: b.concept_id ?? envelope.concept_id ?? "_",
      asset_type: b.asset_type ?? envelope.asset_type ?? "learning_object",
      source_section: b.source_section ?? "_",
      difficulty_level: String(b.difficulty_level ?? 3),
      skill_type: b.skill_type ?? "explain",
      template_id: null, review_status: "draft", generation_method: "model",
    };
    const body = {
      model: config.model,
      messages: [
        { role: "system", content: b.system ?? "You are an AWS enterprise assistant." },
        { role: "user", content: String(b.prompt) },
      ],
      temperature: Number(b.temperature ?? 0.3),
      max_tokens: Number(b.max_tokens ?? 250),
    };
    // #12: content generation is strict in BOTH branches. An ungrounded
    // answer is an error here, never a 200 with "needs_verification".
    const out = await cache.handleChat(body, {
      envelopeHeader: encodeEnvelope(full), role, maxTokens: body.max_tokens,
      requireGrounded: true, trusted, clientId, requestId: req.requestId,
    });
    return {
      asset_type: full.asset_type, concept_id: full.concept_id, chapter_code: full.chapter_code,
      prompt: full.source_section, generation_method: "model",
      verification_status: "needs_verification", review_status: "draft",
      parameters: null, cache_status: out.status, envelope: full, response: out.response,
    };
  });

  // The inventory: every cache entry with its provenance. This is the SOP's
  // "source traceability" cross-file check, made queryable.
  app.get("/content/records", async (req) => {
    const q = req.query ?? {};
    return {
      schema_version: 1,
      chapter_code: q.chapter_code ?? null,
      records: db().listEntries({
        limit: Number(q.limit ?? 100), reviewStatus: q.review_status,
      }).map((r) => ({
        id: r.id, model: r.model, prompt: r.prompt,
        template_id: r.template_id, parameters: r.params_json ? JSON.parse(r.params_json) : null,
        actual_answer: r.actual_answer, generation_method: r.generation_method,
        verification_method: r.verification_method, review_status: r.review_status,
        envelope: JSON.parse(r.envelope_json || "{}"),
        hits: r.hits, created_at: new Date(Number(r.created_at)).toISOString(),
        source_prompt: r.source_prompt,
      })),
    };
  });

  /**
   * Transition review status. Approving an entry invalidates its cached copy on
   * purpose: the SOP's rule is that only reviewer-approved records may change
   * status, and an approved-then-corrected answer must not keep serving stale.
   */
  app.post("/content/records/:id/review", async (req, reply) => {
    if (!adminOk(req)) return reply.code(404).send({ detail: "not found" });
    const id = Number(req.params.id);
    const status = String(req.body?.status ?? "");
    const allowed = ["draft", "needs_academic_review", "reviewed", "approved", "production"];
    if (!allowed.includes(status)) {
      return reply.code(400).send({ detail: `status must be one of ${allowed.join(", ")}` });
    }
    const row = db().getById(id);
    if (!row) return reply.code(404).send({ detail: `no record ${id}` });
    // #43: the approver is the authenticated principal, never a body field.
    // The body may only carry a rationale; it may not assert who is acting.
    // #51: the approver is the authenticated PRINCIPAL, never a body field,
    // and the token itself is never persisted -- only its hashed principal.
    const actor = principal(req);
    const rationale = String(req.body?.rationale || "");
    // #38: production release needs a second, DISTINCT approver.
    if (status === "production" && row.review_status !== "production") {
      const prior = db().approversFor(id).filter((a) => a !== actor);
      if (!prior.length) {
        return reply.code(409).send({
          detail: "production requires a second distinct approver; record the first with status 'approved'",
        });
      }
    }
    db().logReview(id, status, actor, rationale);
    // Keep the row. Deleting it on approval destroyed the review decision:
    // the next request regenerated the entry as a draft and had to be
    // reviewed again, so an approved answer could never be served as approved.
    const changes = db().setReviewStatus(id, status);
    const promoted = status === "approved" || status === "production";
    db().recordEvent({
      ts: new Date().toISOString(), status: "review", model: row.model,
      latency_ms: 0, prompt: row.prompt,
      reason: `review_status -> ${status}${promoted ? " (entry now servable to non-author callers)" : ""}`,
      tier: "review",
    });
    db().increment(["requests"]);
    return { id, status, updated: changes, retained: true };
  });

  app.delete("/cache/scope/:scope", async (req, reply) => {
    if (!adminOk(req)) return reply.code(404).send({ detail: "not found" });
    // #29: delete the vector documents too. Orphans occupy the fixed
    // candidate limit and cause ghost rejections after invalidation.
    const rows = db().listEntries({ limit: 10_000 })
      .filter((r) => r.scope === req.params.scope);
    for (const r of rows) await vectors.deleteDocument(`e${r.id}`).catch(() => {});
    const removed = db().deleteByScope(req.params.scope);
    invalidateVectorCache();
    return { scope: req.params.scope, removed };
  });

  app.delete("/cache/chapter/:chapterCode", async (req, reply) => {
    if (!adminOk(req)) return reply.code(404).send({ detail: "not found" });
    const rows = db().listEntries({ limit: 10_000 }).filter((r) => {
      try { return JSON.parse(r.envelope_json || "{}").chapter_code === req.params.chapterCode; }
      catch { return false; }
    });
    for (const r of rows) await vectors.deleteDocument(`e${r.id}`).catch(() => {});
    const removed = db().deleteByChapter(req.params.chapterCode);
    invalidateVectorCache();
    return { chapter_code: req.params.chapterCode, removed };
  });

  /**
   * Clear the cache: every cached answer, the vector index, the counters and
   * the event feed.
   *
   * This is the dashboard's "Clear cache" button. It resets the counters too,
   * because leaving them would be misleading -- a hit count for entries that
   * no longer exist reads as a cache that is working when it is empty.
   */
  /**
   * #63: warm the cache from a list of queries. Admin-gated: warming drives
   * model invocations. Dry-run reports would-hit/would-miss without writing.
   */
  app.post("/cache/warm", async (req, reply) => {
    if (!adminOk(req)) return reply.code(404).send({ detail: "not found" });
    const b = req.body ?? {};
    const queries = b.queries ?? b.prompts ?? [];
    if (!Array.isArray(queries)) return reply.code(400).send({ detail: "queries must be an array" });
    if (queries.length > 1000) return reply.code(400).send({ detail: "at most 1000 queries per call" });
    const { warmQueries } = await import("./warm.js");
    return warmQueries(queries, { dryRun: Boolean(b.dry_run ?? b.dryRun), concurrency: b.concurrency });
  });

  app.post("/cache/clear", async (req, reply) => {
    if (!adminOk(req)) return reply.code(404).send({ detail: "not found" });
    const documents = db().countEntries();
    db().db.exec("DELETE FROM cache_entries");
    const vectorsPurged = await vectors.purgeIndex();
    db().resetStats();
    return {
      cleared: true,
      documents,
      vectors: vectorsPurged,
      note: "cached answers, the vector index, the counters and the event feed were cleared; " +
        "the next request for each question will run the model again",
    };
  });

  /**
   * Purge every cache document AND the vector index.
   *
   * Both stores must be cleared together: leaving SQLite populated while the
   * vector index is empty produces a cache that exact-hits but cannot
   * semantically hit -- a confusing half-state. The counters and the event
   * ring are untouched (that is what /stats/reset is for).
   */
  app.post("/cache/purge", async (req, reply) => {
    if (!adminOk(req)) return reply.code(404).send({ detail: "not found" });
    const documents = db().countEntries();
    db().db.exec("DELETE FROM cache_entries");
    const vectorsPurged = await vectors.purgeIndex();
    return { purged_documents: documents, purged_vectors: vectorsPurged };
  });

  // ---- the SOP's near-duplicate gate ---------------------------------
  // The same embedding machinery the semantic tier uses, repurposed for
  // REJECTION rather than reuse (SOP lines 314 and 604).
  app.post("/content/near-duplicates", async (req, reply) => {
    const b = req.body ?? {};
    if (!b.prompt) return reply.code(400).send({ detail: "prompt is required" });
    try {
      const { embed } = await import("./embedder.js");
      const { symbolFingerprint, scopeOf } = await import("./keying.js");
      const vec = await embed(String(b.prompt));
      const scope = scopeOf(parseEnvelope(String(req.headers["x-content-envelope"] || "")), "det", config.tenantId);
      const cands = vec ? await vectors.searchScope(vec, { scope, limit: 8 }) : [];
      return {
        near_duplicates: cands.map((c) => ({
          fingerprint: c.fingerprint, distance: Number(c.dist), prompt: c.prompt,
          generation_method: c.generation_method, review_status: c.review_status,
        })),
        verdict: cands.length
          ? `${cands.length} near-duplicate(s) within radius ${config.distanceThreshold} — review before adding`
          : "no near-duplicates found",
      };
    } catch (err) {
      return reply.code(503).send({ detail: `vector index unavailable: ${err.message}` });
    }
  });

  // ---- the demo seeding ------------------------------------------------
  app.get("/demo/prompts", async () => {
    // The dashboard's "Run the demo" button asks for its questions here, so
    // the demo is always in the same domain as the loaded corpus. The page
    // keeps its own list as a fallback for when this is unreachable.
    const { DEMO_PROMPTS } = await import("./corpus.js");
    return {
      chapter_code: "MATH-01-AWS",
      prompts: DEMO_PROMPTS.map(({ q, rephrase, concept_id, topic }) => ({
        q, rephrase, concept_id, topic,
      })),
    };
  });

  app.post("/demo/seed", async (req, reply) => {
    if (!adminOk(req) || !config.allowSeed) return reply.code(404).send({ detail: "demo seed disabled" });
    const { seedDemoCorpus } = await import("./corpus.js");
    const n = await seedDemoCorpus(db());
    return { seeded: n };
  });

  // Never purge vectors here. SQLite rows survive a restart; deleting the
  // vector index silently disabled semantic hits until every answer was
  // regenerated. Explicit invalidation is the ONLY thing that clears both
  // stores together (see /cache/purge, /cache/clear).
  app.addHook("onClose", async () => {
    await model.shutdown();
    db().close();
  });

  return app;
}