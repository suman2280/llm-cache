/**
 * HTTP surface. Built to docs/UI-CONTRACT.md -- the frozen dashboard is the
 * spec, so every field it reads is emitted exactly.
 *
 * Additive endpoints (the /content/* surface) exist because the SOP is a
 * content pipeline, not a chat box: they let a caller hand the cache a
 * concept_id / asset_type / template and get a governed answer back.
 */

import { readFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import Fastify from "fastify";
import config from "./config.js";
import { getStore as db } from "./store.js";
import * as vectors from "./vectors.js";
import * as cache from "./cache.js";
import * as model from "./model.js";
import * as templates from "./templates.js";
import { encodeEnvelope, asciiHeaderValue, parseEnvelope, scopeOf } from "./keying.js";
import { isLoaded as embedderLoaded } from "./embedder.js";

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

  const adminOk = (req) =>
    !config.adminToken || req.headers["x-admin-token"] === config.adminToken;

  // ---- OpenAI-compatible chat ----------------------------------------
  app.post("/v1/chat/completions", async (req, reply) => {
    const envelopeHeader = String(req.headers["x-content-envelope"] || "");
    const role = String(req.headers["x-content-role"] || "author");
    try {
      const out = await cache.handleChat(req.body, {
        envelopeHeader, role, maxTokens: req.body?.max_tokens,
      });
      reply.headers(out.headers);
      return out.response;
    } catch (err) {
      const status = err.statusCode ?? 500;
      reply.code(status);
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
  app.get("/stats", async () => cache.statsPayload());

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
    if (!config.allowSeed) return reply.code(404).send({ detail: "demo seed disabled" });
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
      embedder: { loaded: embedderLoaded(), model: config.embedderModel },
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
    const role = String(req.headers["x-content-role"] || "author");

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
      const out = await cache.handleChat(body, {
        envelopeHeader: encodeEnvelope(full), role, maxTokens: 400,
      });
      db().insertEntry({
        fingerprint: req.headers["x-content-envelope"] ? "" : "",
        scope: scopeOf(full, 'det'), model: config.model,
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
    const out = await cache.handleChat(body, { envelopeHeader: encodeEnvelope(full), role, maxTokens: body.max_tokens });
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
    const changes = db().setReviewStatus(id, status);
    const invalidated = status === "approved" || status === "production";
    let removed = 0;
    if (invalidated) {
      removed = db().deleteEntry(id);
      await vectors.deleteDocument(`e${id}`).catch(() => {});
    }
    db().recordEvent({
      ts: new Date().toISOString(), status: "review", model: row.model,
      latency_ms: 0, prompt: row.prompt,
      reason: `review_status -> ${status}${invalidated ? ` (cache entry ${id} invalidated and will be re-verified on next use)` : ""}`,
      tier: "review",
    });
    db().increment(["requests"]);
    return { id, status, updated: changes, cache_invalidated: removed };
  });

  app.delete("/cache/scope/:scope", async (req, reply) => {
    if (!adminOk(req)) return reply.code(404).send({ detail: "not found" });
    const removed = db().deleteByScope(req.params.scope);
    return { scope: req.params.scope, removed };
  });

  app.delete("/cache/chapter/:chapterCode", async (req, reply) => {
    if (!adminOk(req)) return reply.code(404).send({ detail: "not found" });
    const removed = db().deleteByChapter(req.params.chapterCode);
    return { chapter_code: req.params.chapterCode, removed };
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
      const scope = scopeOf(parseEnvelope(String(req.headers["x-content-envelope"] || "")), "det");
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
  app.post("/demo/seed", async (req, reply) => {
    if (!adminOk(req) || !config.allowSeed) return reply.code(404).send({ detail: "demo seed disabled" });
    const { seedDemoCorpus } = await import("./corpus.js");
    const n = await seedDemoCorpus(db());
    return { seeded: n };
  });

  app.addHook("onClose", async () => {
    await model.shutdown();
    await vectors.purgeIndex?.();
    db().close();
  });

  return app;
}