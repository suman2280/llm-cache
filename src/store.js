/**
 * Durable store: SQLite (node:sqlite -- no native build, no dependency).
 *
 * Holds the cache documents, their provenance, their review state, the event
 * ring and the counters. Redis is used only for the vector index, because
 * that is the one thing SQLite does not do well at scale.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import config from "./config.js";

let _singleton = null;

/**
 * Process-wide store singleton. The cache engine and the HTTP surface both use
 * it so they share one SQLite connection and one set of counters.
 */
export function getStore() {
  if (_singleton) return _singleton;
  _singleton = new Store(config.dbPath);
  return _singleton;
}

/** Test seam: replace the singleton (e.g. with an in-memory Store). */
export function setStore(store) { _singleton = store; }
/** Test seam: drop the singleton so the next getStore() reopens from config. */
export function resetStore() { if (_singleton) { try { _singleton.close(); } catch {} } _singleton = null; }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cache_entries (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  fingerprint       TEXT    NOT NULL UNIQUE,
  scope             TEXT    NOT NULL,
  model             TEXT    NOT NULL,
  semantic_text     TEXT    NOT NULL,
  prompt            TEXT    NOT NULL,
  response_json     TEXT    NOT NULL,
  symbol_fp         TEXT    NOT NULL DEFAULT '',
  envelope_json     TEXT    NOT NULL DEFAULT '{}',
  template_id       TEXT,
  params_json       TEXT,
  chunk_ids         TEXT    NOT NULL DEFAULT '',   -- the KB chunks that grounded it
  actual_answer     TEXT,
  generation_method TEXT    NOT NULL DEFAULT 'model',
  verification_method TEXT,
  review_status     TEXT    NOT NULL DEFAULT 'draft',
  source_prompt     TEXT,
  created_at        INTEGER NOT NULL,
  last_used_at      INTEGER NOT NULL,
  hits              INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_cache_scope  ON cache_entries(scope);
CREATE INDEX IF NOT EXISTS idx_cache_model  ON cache_entries(model, scope);

-- Event ring. AUTOINCREMENT is what makes ids monotonic AND never reused:
-- SQLite documents that AUTOINCREMENT ids are never recycled, which is exactly
-- the property the dashboard's reconciler depends on (docs/UI-CONTRACT.md 3).
CREATE TABLE IF NOT EXISTS events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           TEXT    NOT NULL,
  status       TEXT    NOT NULL,
  model        TEXT,
  similarity   REAL,
  threshold    REAL,
  latency_ms   REAL    NOT NULL,
  embed_ms     REAL,
  redis_ms     REAL,
  infer_ms     REAL,
  prompt       TEXT    NOT NULL,
  response     TEXT,
  source_prompt TEXT,
  reason       TEXT,
  tier         TEXT,
  verified     INTEGER,
  request_id   TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(id DESC);

-- #66: one outcome row per request, used for per-scope/template/concept
-- breakdowns and cost-saved attribution. Bounded-cardinality dimensions only.
CREATE TABLE IF NOT EXISTS outcomes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           TEXT    NOT NULL,
  status       TEXT    NOT NULL,
  scope        TEXT,
  concept_id   TEXT,
  template_id  TEXT,
  generation_method TEXT,
  tokens_saved INTEGER NOT NULL DEFAULT 0,
  latency_ms   REAL    NOT NULL DEFAULT 0,
  request_id   TEXT
);
CREATE INDEX IF NOT EXISTS idx_outcomes_status ON outcomes(status);
CREATE INDEX IF NOT EXISTS idx_outcomes_scope ON outcomes(scope);

-- #38: an auditable review trail. Promoting to "production" requires two
-- distinct approvers, so no single caller can release content alone.
CREATE TABLE IF NOT EXISTS review_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id  INTEGER NOT NULL,
  status     TEXT    NOT NULL,
  actor      TEXT    NOT NULL,
  rationale  TEXT    NOT NULL DEFAULT '',
  ts         TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_review_log_record ON review_log(record_id, id);

CREATE TABLE IF NOT EXISTS counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);
`;

const COUNTER_KEYS = [
  "requests", "exact_hits", "semantic_hits", "misses", "bypasses", "errors",
  "rejected_hits", "model_invocations", "tokens_saved", "model_spawns",
  "in_domain", "out_of_domain", "negative_hits", "negative_entries",
];

export class Store {
  constructor(dbPath) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA synchronous=NORMAL");
    this.db.exec("PRAGMA foreign_keys=ON");
    this.db.exec(SCHEMA);
    this._migrate();
    for (const k of COUNTER_KEYS) {
      this.db.prepare("INSERT OR IGNORE INTO counters(name,value) VALUES (?,0)").run(k);
    }
  }

  /** Additive columns added after v0.2 -- keep older SQLite files working. */
  _migrate() {
    const cols = () => this.db.prepare("PRAGMA table_info(events)").all().map((r) => r.name);
    if (!cols().includes("request_id")) {
      this.db.exec("ALTER TABLE events ADD COLUMN request_id TEXT");
    }
  }

  // --------------------------------------------------------------- entries

  getByFingerprint(fingerprint) {
    return this.db.prepare("SELECT * FROM cache_entries WHERE fingerprint = ?").get(fingerprint);
  }

  getById(id) {
    return this.db.prepare("SELECT * FROM cache_entries WHERE id = ?").get(id);
  }

  /** Newest first; used by /stats and by the corpus view. */
  listEntries({ scope, limit = 100, offset = 0, reviewStatus, model } = {}) {
    const where = [];
    const args = [];
    if (scope) { where.push("scope = ?"); args.push(scope); }
    if (reviewStatus) { where.push("review_status = ?"); args.push(reviewStatus); }
    if (model) { where.push("model = ?"); args.push(model); }
    const sql = `SELECT * FROM cache_entries ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
                 ORDER BY id DESC LIMIT ? OFFSET ?`;
    return this.db.prepare(sql).all(...args, limit, offset);
  }

  countEntries() {
    return this.db.prepare("SELECT COUNT(*) n FROM cache_entries").get().n;
  }

  /**
   * #36: evict least-recently-used entries down to `limit`.
   * Returns the deleted rows so the caller can remove their vector documents
   * too -- the two stores must stay in sync.
   */
  evictToLimit(limit) {
    // #45: 0 means "no cap", not "keep nothing".
    if (!limit || limit <= 0) return [];
    const count = this.countEntries();
    if (count <= limit) return [];
    const rows = this.db.prepare(
      "SELECT id, fingerprint, scope, chunk_ids, response_json FROM cache_entries " +
      "ORDER BY last_used_at ASC, id ASC LIMIT ?",
    ).all(count - limit);
    const del = this.db.prepare("DELETE FROM cache_entries WHERE id = ?");
    for (const r of rows) del.run(r.id);
    return rows;
  }

  /** #9: delete entries older than `ttlMs`, returning them for vector cleanup. */
  evictExpired(ttlMs) {
    if (!ttlMs || ttlMs <= 0) return [];
    const cutoff = Date.now() - ttlMs;
    const rows = this.db.prepare(
      "SELECT id, fingerprint, scope, chunk_ids, response_json FROM cache_entries " +
      "WHERE created_at < ?",
    ).all(cutoff);
    const del = this.db.prepare("DELETE FROM cache_entries WHERE id = ?");
    for (const r of rows) del.run(r.id);
    return rows;
  }

  insertEntry(entry) {
    const r = this.db.prepare(`
      INSERT INTO cache_entries
        (fingerprint, scope, model, semantic_text, prompt, response_json, symbol_fp,
         envelope_json, template_id, params_json, chunk_ids, actual_answer, generation_method,
         verification_method, review_status, source_prompt, created_at, last_used_at, hits)
      VALUES (@fingerprint,@scope,@model,@semantic_text,@prompt,@response_json,@symbol_fp,
              @envelope_json,@template_id,@params_json,@chunk_ids,@actual_answer,@generation_method,
              @verification_method,@review_status,@source_prompt,@created_at,@last_used_at,0)
      ON CONFLICT(fingerprint) DO UPDATE SET
        -- #30: update EVERY column. A partial update left the new answer
        -- paired with the old scope, prompt, chunk ids and template provenance.
        scope           = excluded.scope,
        model           = excluded.model,
        semantic_text   = excluded.semantic_text,
        prompt          = excluded.prompt,
        response_json   = excluded.response_json,
        symbol_fp       = excluded.symbol_fp,
        envelope_json   = excluded.envelope_json,
        template_id     = excluded.template_id,
        params_json     = excluded.params_json,
        chunk_ids       = excluded.chunk_ids,
        actual_answer   = excluded.actual_answer,
        generation_method = excluded.generation_method,
        verification_method = excluded.verification_method,
        -- #50: never downgrade an approved/production record to draft on
        -- regeneration. Adding a review_status field is deliberate work.
        review_status   = CASE
          WHEN excluded.review_status IN ('draft', 'needs_academic_review')
               AND review_status IN ('approved', 'production')
          THEN review_status ELSE excluded.review_status END,
        source_prompt   = excluded.source_prompt,
        -- #48: a regenerated answer is NEW; refreshing created_at keeps it
        -- from being TTL-evicted immediately. hits is preserved.
        created_at      = excluded.created_at,
        last_used_at    = excluded.last_used_at
    `).run(entry);
    return r.lastInsertRowid;
  }

  touchHit(id) {
    this.db.prepare("UPDATE cache_entries SET hits = hits + 1, last_used_at = ? WHERE id = ?")
      .run(Date.now(), id);
  }

  setReviewStatus(id, status) {
    return this.db.prepare("UPDATE cache_entries SET review_status = ? WHERE id = ?").run(status, id).changes;
  }

  /** #38: append an immutable review event. */
  logReview(id, status, actor, rationale = "") {
    this.db.prepare(
      "INSERT INTO review_log(record_id,status,actor,rationale,ts) VALUES (?,?,?,?,?)",
    ).run(id, status, String(actor || "unknown"), String(rationale || "").slice(0, 500),
      new Date().toISOString());
  }

  /** Distinct actors who previously recorded an approval for this record. */
  approversFor(id) {
    return this.db.prepare(
      "SELECT DISTINCT actor FROM review_log WHERE record_id = ? AND status IN ('approved','production')",
    ).all(id).map((r) => r.actor);
  }

  deleteEntry(id) {
    return this.db.prepare("DELETE FROM cache_entries WHERE id = ?").run(id).changes;
  }

  /** Delete by scope (chapter/asset/concept/difficulty band). */
  deleteByScope(scope) {
    return this.db.prepare("DELETE FROM cache_entries WHERE scope = ?").run(scope).changes;
  }

  /** Delete every entry in a chapter. */
  deleteByChapter(chapterCode) {
    // chapter lives in envelope_json; scan is fine at PoC corpus sizes.
    const rows = this.db.prepare("SELECT id, envelope_json FROM cache_entries").all();
    let n = 0;
    for (const r of rows) {
      try {
        const env = JSON.parse(r.envelope_json || "{}");
        if (env.chapter_code === chapterCode) n += this.deleteEntry(r.id);
      } catch { /* ignore malformed */ }
    }
    return n;
  }

  findNearDuplicates(symbolFp, scope, excludeId, limit = 5) {
    // Deterministic pre-filter first: identical glyph fingerprint and scope.
    // This is the SOP's "reject near-duplicates" gate, reusing the same
    // machinery the semantic tier uses -- but for rejection, not reuse.
    return this.db.prepare(`
      SELECT * FROM cache_entries
      WHERE scope = ? AND symbol_fp = ? AND id != ?
      ORDER BY hits DESC, id DESC LIMIT ?
    `).all(scope, symbolFp, excludeId ?? -1, limit);
  }

  // ---------------------------------------------------------------- events

  recordEvent(evt) {
    const r = this.db.prepare(`
      INSERT INTO events
        (ts,status,model,similarity,threshold,latency_ms,embed_ms,redis_ms,infer_ms,
         prompt,response,source_prompt,reason,tier,verified,request_id)
      VALUES (@ts,@status,@model,@similarity,@threshold,@latency_ms,@embed_ms,@redis_ms,
              @infer_ms,@prompt,@response,@source_prompt,@reason,@tier,@verified,@request_id)
    `).run({ request_id: null, ...evt });
    return Number(r.lastInsertRowid);
  }

  // ------------------------------------------------------------- outcomes (#66)

  /** #66: record a request outcome for breakdowns and cost-saved attribution. */
  recordOutcome(o) {
    return this.db.prepare(`
      INSERT INTO outcomes
        (ts,status,scope,concept_id,template_id,generation_method,tokens_saved,latency_ms,request_id)
      VALUES (@ts,@status,@scope,@concept_id,@template_id,@generation_method,
              @tokens_saved,@latency_ms,@request_id)
    `).run({
      scope: null, concept_id: null, template_id: null, generation_method: null,
      tokens_saved: 0, latency_ms: 0, request_id: null, ...o,
    });
  }

  /**
   * #66: top-N breakdown along one bounded dimension.
   * Returns [{ key, requests, hits, misses, rejects, tokens_saved }].
   */
  breakdown(dim, { limit = 10 } = {}) {
    const allowed = { scope: "scope", concept_id: "concept_id", template_id: "template_id", generation_method: "generation_method" };
    const col = allowed[dim];
    if (!col) return [];
    return this.db.prepare(`
      SELECT ${col} AS key,
             COUNT(*) AS requests,
             SUM(CASE WHEN status IN ('exact-hit','semantic-hit','deterministic-hit') THEN 1 ELSE 0 END) AS hits,
             SUM(CASE WHEN status = 'miss' THEN 1 ELSE 0 END) AS misses,
             SUM(CASE WHEN status IN ('rejected','semantic-hit-rejected') THEN 1 ELSE 0 END) AS rejects,
             SUM(tokens_saved) AS tokens_saved
      FROM outcomes
      WHERE ${col} IS NOT NULL AND ${col} != ''
      GROUP BY ${col}
      ORDER BY hits DESC, requests DESC, key ASC
      LIMIT ?
    `).all(limit).map((r) => ({ ...r, key: String(r.key), requests: Number(r.requests),
      hits: Number(r.hits), misses: Number(r.misses), rejects: Number(r.rejects),
      tokens_saved: Number(r.tokens_saved) }));
  }

  /** Aggregate totals over all outcomes (for /metrics cost-saved gauges). */
  outcomeTotals() {
    const r = this.db.prepare(`
      SELECT COUNT(*) AS requests,
             SUM(CASE WHEN status IN ('exact-hit','semantic-hit','deterministic-hit') THEN 1 ELSE 0 END) AS hits,
             SUM(CASE WHEN status = 'miss' THEN 1 ELSE 0 END) AS misses,
             SUM(tokens_saved) AS tokens_saved
      FROM outcomes
    `).get();
    return { requests: Number(r.requests) || 0, hits: Number(r.hits) || 0,
      misses: Number(r.misses) || 0, tokens_saved: Number(r.tokens_saved) || 0 };
  }

  recentEvents(limit) {
    return this.db.prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?").all(limit);
  }

  trimEvents(limit) {
    this.db.prepare(`
      DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT ?)
    `).run(limit);
  }

  // -------------------------------------------------------------- counters

  increment(names, by = 1) {
    const stmt = this.db.prepare(
      "INSERT INTO counters(name,value) VALUES (?,?) ON CONFLICT(name) DO UPDATE SET value = value + excluded.value"
    );
    for (const n of Array.isArray(names) ? names : [names]) stmt.run(n, by);
  }

  counters() {
    const rows = this.db.prepare("SELECT name, value FROM counters").all();
    const out = {};
    for (const r of rows) out[r.name] = r.value;
    return out;
  }

  /** Clears counters + events; the event id sequence deliberately survives. */
  resetStats() {
    this.db.exec("DELETE FROM events");
    this.db.exec("DELETE FROM outcomes");
    for (const k of COUNTER_KEYS) {
      this.db.prepare("UPDATE counters SET value = 0 WHERE name = ?").run(k);
    }
  }

  close() { this.db.close(); }
}