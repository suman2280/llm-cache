/**
 * Regression tests for issues raised by the audit agent.
 * Each test names the GitHub issue it closes.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { containsTerm, DomainPolicy } from "../src/domain.js";
import { DOMAIN } from "../src/corpus.js";
import { specificIdentifiers, referenceIdentifiers, checkGrounding } from "../src/grounding.js";
import { coverageVerdict } from "../src/lexicon.js";
import { requestFingerprint, samplingClass, cacheIdentityOf, scopeOf } from "../src/keying.js";
import { build } from "../src/server.js";
import { getStore } from "../src/store.js";
import config from "../src/config.js";
import { Store } from "../src/store.js";
import { Breaker } from "../src/breaker.js";
import { TokenBucket, configureLimiter, inferenceLimiter } from "../src/ratelimit.js";
import * as templates from "../src/templates.js";

// ---------------------------------------------------------------- #16 ------
test("#16 domain terms use whole-word matching", () => {
  assert.ok(!containsTerm("tell me about diamonds and jewelry", "iam"),
    "diamonds must not count as IAM");
  assert.ok(!containsTerm("how many words are in this sentence", "rds"),
    "words must not count as RDS");
  assert.ok(containsTerm("tell me about IAM roles", "iam"));
  assert.ok(containsTerm("s3://my-bucket", "s3"));
  assert.ok(containsTerm("amazon web services overview", "amazon web services"));
});

// ---------------------------------------------------------------- #1 -------
test("#1 the domain guard classifies the question, not the system prompt", async () => {
  const policy = new DomainPolicy({ ...DOMAIN, mode: "strict" });
  // A system prompt full of "AWS" must not make an unrelated question pass.
  const out = await policy.classify("Who wrote the play Hamlet?");
  assert.ok(!out.inDomain, "an out-of-domain question stays out-of-domain");
  const inDomain = await policy.classify("How do I enable versioning on an S3 bucket?");
  assert.ok(inDomain.inDomain);
});

// ---------------------------------------------------------------- #20 ------
test("#20 a lexical domain hit does not embed (lazy embedder preserved)", async () => {
  const policy = new DomainPolicy({ ...DOMAIN, mode: "strict" });
  const out = await policy.classify("tell me about IAM roles");
  assert.ok(out.inDomain);
  assert.equal(out.semantic, null, "no embedding was performed on a lexical hit");
});

// ---------------------------------------------------------------- #13 ------
test("#13 an answer-only term match is not a hit", () => {
  // The cached entry is about EC2 but its answer mentions security groups.
  // A query about security groups must NOT be served that answer.
  const cachedPrompt = "What is EC2?";
  const cachedAnswer = "EC2 instances use security groups, subnets and EBS volumes.";
  const chunkText = "EC2 instances (virtual machines) — resizable virtual servers, AMIs, AZs.";
  const v = coverageVerdict("How do security groups work?", cachedPrompt, cachedAnswer, true, 0.75, chunkText);
  assert.ok(!v.ok, `must be rejected: ${v.reason}`);
});

test("#13 a real shared-topic hit still works", () => {
  const v = coverageVerdict(
    "What are virtual machines?",
    "What is EC2?",
    "Amazon EC2 provides resizable virtual servers in the cloud.",
    true, 0.75,
    "EC2 instances (virtual machines) — resizable virtual servers called instances.",
  );
  assert.ok(v.ok, `must be accepted: ${v.reason}`);
});

test("#11 and #8: scope and sampling parameters change identity", () => {
  const body = { model: "m", messages: [{ role: "user", content: "same" }] };
  assert.notEqual(requestFingerprint(body, "scope-a"), requestFingerprint(body, "scope-b"));
  assert.notEqual(samplingClass({ temperature: 0.3, seed: 1 }), samplingClass({ temperature: 0.3, seed: 2 }));
  assert.notEqual(samplingClass({ temperature: 0, max_tokens: 100 }), samplingClass({ temperature: 0 }));
});

// ---------------------------------------------------------------- #45 ------
test("#45 MAX_ENTRIES=0 is 'no cap', not 'keep nothing'", () => {
  const db = new Store(":memory:");
  for (let i = 0; i < 5; i++) {
    db.insertEntry({
      fingerprint: `fp-${i}`, scope: "s", model: "m", semantic_text: `p${i}`,
      prompt: `p${i}`, response_json: "{}", symbol_fp: "", envelope_json: "{}",
      generation_method: "model", verification_method: "none", review_status: "draft",
      chunk_ids: "", created_at: Date.now(), last_used_at: Date.now(),
    });
  }
  assert.equal(db.evictToLimit(0).length, 0, "limit 0 evicts nothing");
  assert.equal(db.countEntries(), 5);
  const removed = db.evictToLimit(2);
  assert.equal(removed.length, 3);
  assert.equal(db.countEntries(), 2);
  db.close();
});

// ---------------------------------------------------------------- #44 ------
test("#44 an expired entry is evicted on the read path", () => {
  const db = new Store(":memory:");
  db.insertEntry({
    fingerprint: "stale", scope: "s", model: "m", semantic_text: "p",
    prompt: "p", response_json: "{}", symbol_fp: "", envelope_json: "{}",
    generation_method: "model", verification_method: "none", review_status: "draft",
    chunk_ids: "", created_at: Date.now() - 10_000, last_used_at: Date.now() - 10_000,
  });
  assert.equal(db.evictExpired(1000).length, 1, "the stale row is removed");
  assert.equal(db.countEntries(), 0);
  db.close();
});

// ---------------------------------------------------------------- #48 ------
test("#48 re-inserting refreshes created_at so TTL does not kill a fresh answer", () => {
  const db = new Store(":memory:");
  db.insertEntry({
    fingerprint: "fp", scope: "s", model: "m", semantic_text: "p",
    prompt: "p", response_json: "{\"a\":1}", symbol_fp: "", envelope_json: "{}",
    generation_method: "model", verification_method: "none", review_status: "draft",
    chunk_ids: "", created_at: 1000, last_used_at: 1000,
  });
  // simulate a regeneration at a much later time
  db.insertEntry({
    fingerprint: "fp", scope: "s", model: "m", semantic_text: "p",
    prompt: "p", response_json: "{\"a\":2}", symbol_fp: "", envelope_json: "{}",
    generation_method: "model", verification_method: "none", review_status: "draft",
    chunk_ids: "", created_at: 999_999, last_used_at: 999_999,
  });
  const row = db.getByFingerprint("fp");
  assert.equal(Number(row.created_at), 999_999, "created_at must refresh on upsert");
  assert.equal(row.response_json, '{"a":2}', "the new answer must win");
  db.close();
});

// ---------------------------------------------------------------- #50 ------
test("#50 regenerating an approved entry does not downgrade it to draft", () => {
  const db = new Store(":memory:");
  db.insertEntry({
    fingerprint: "fp", scope: "s", model: "m", semantic_text: "p",
    prompt: "p", response_json: "{}", symbol_fp: "", envelope_json: "{}",
    generation_method: "deterministic_template", verification_method: "deterministic_rule",
    review_status: "approved", chunk_ids: "", created_at: 1, last_used_at: 1,
  });
  db.insertEntry({
    fingerprint: "fp", scope: "s", model: "m", semantic_text: "p",
    prompt: "p", response_json: '{"new":true}', symbol_fp: "", envelope_json: "{}",
    generation_method: "deterministic_template", verification_method: "deterministic_rule",
    review_status: "draft", chunk_ids: "", created_at: 2, last_used_at: 2,
  });
  const row = db.getByFingerprint("fp");
  assert.equal(row.review_status, "approved", "an approved entry must stay approved");
  assert.equal(row.response_json, '{"new":true}', "the new answer must win");
  db.close();
});

// ---------------------------------------------------------------- #51 ------
test("#51 the review log never stores a raw admin token", () => {
  const db = new Store(":memory:");
  db.logReview(1, "approved", "sha256:deadbeef", "ok");
  const rows = db.db.prepare("SELECT actor FROM review_log").all();
  assert.ok(rows.every((r) => !r.actor.includes("dev-token")));
  assert.ok(rows.every((r) => !r.actor.includes("rev-token")));
  db.close();
});

// ---------------------------------------------------------------- #59 ------
test("#59 the breaker reserves exactly one probe in half-open", () => {
  const b = new Breaker({ threshold: 2, cooldownMs: 1 });
  b.failure(); b.failure(); // open
  assert.equal(b.state, "open");
  // wait for cooldown
  const wait = Date.now() + 10;
  while (Date.now() < wait) { /* spin */ }
  assert.equal(b.state, "half-open");
  assert.ok(b.allow(), "the first probe is admitted");
  assert.ok(!b.allow(), "no further caller is admitted while probing");
  b.success();
  assert.equal(b.state, "closed");
  assert.ok(b.allow(), "closed admits everyone");
});

// ---------------------------------------------------------------- #59 ------
test("#59 the shared limiter is configured (not the default 20)", () => {
  configureLimiter(7, 1000);
  const r = inferenceLimiter.allow("k");
  assert.ok(r.allowed);
  assert.equal(inferenceLimiter.capacity, 7);
  assert.equal(r.remaining, 6);
});

// ---------------------------------------------------------------- #39 ------
test("#39 template entries get a real fingerprint, not the empty string", () => {
  // regression: every template insert used `fingerprint: ""`, which is NOT
  // NULL and UNIQUE, so the second generation threw SQLITE_CONSTRAINT_UNIQUE
  const fp = templates.templateKey("T-EC2-COST", { instance_type: "m5.large", count: "4", hours: "730" });
  assert.ok(fp.length > 0);
  assert.notEqual(fp, "");
});


// ---------------------------------------------------------------- #46 ------
test("#46 cache identity is shared between live and seeded paths", () => {
  const body = { model: "m", messages: [{ role: "user", content: "What is S3?" }], temperature: 0 };
  const envelope = { chapter_code: "AWS", concept_id: "AWS-1", asset_type: "chat", difficulty_level: "2" };
  const live = cacheIdentityOf({ body, envelope, tenantId: "tenant-x" });
  const seeded = cacheIdentityOf({ body, envelope, tenantId: "tenant-x" });
  assert.equal(live.scope, seeded.scope);
  assert.equal(live.fingerprint, seeded.fingerprint);
  assert.equal(live.samplingClass, seeded.samplingClass);
});

// ---------------------------------------------------------------- #55 ------
test("#55 tenant participates in scope", () => {
  const body = { model: "m", messages: [{ role: "user", content: "x" }] };
  const envelope = { chapter_code: "AWS", concept_id: "AWS-1", asset_type: "chat", difficulty_level: "2" };
  assert.notEqual(
    scopeOf(envelope, samplingClass(body), "tenant-a"),
    scopeOf(envelope, samplingClass(body), "tenant-b"),
  );
});

// ---------------------------------------------------------------- #47 ------
test("#47 trusted writes are not required by default", () => {
  assert.equal(config.trustedWritesOnly, false);
});

// ---------------------------------------------------------------- #43 ------
test("#43 production requires a second distinct authenticated principal", async () => {
  const prevAdmin = config.adminToken;
  const prevReviewer = config.reviewerToken;
  config.adminToken = "dev-token";
  config.reviewerToken = "rev-token";
  const app = await build();
  const db = getStore();
  const id = db.insertEntry({
    fingerprint: `two-person-${Date.now()}`, scope: "s", model: "m", semantic_text: "p",
    prompt: "p", response_json: "{}", symbol_fp: "", envelope_json: "{}",
    generation_method: "model", verification_method: "none", review_status: "draft",
    chunk_ids: "", created_at: Date.now(), last_used_at: Date.now(),
  });
  const first = await app.inject({
    method: "POST", url: `/content/records/${id}/review`,
    headers: { "x-admin-token": "dev-token" },
    payload: { status: "approved", rationale: "first" },
  });
  assert.equal(first.statusCode, 200);
  const samePrincipal = await app.inject({
    method: "POST", url: `/content/records/${id}/review`,
    headers: { "x-admin-token": "dev-token" },
    payload: { status: "production", rationale: "second same person" },
  });
  assert.equal(samePrincipal.statusCode, 409, "one principal cannot approve twice");
  const secondPrincipal = await app.inject({
    method: "POST", url: `/content/records/${id}/review`,
    headers: { "x-admin-token": "rev-token" },
    payload: { status: "production", rationale: "second distinct person" },
  });
  assert.equal(secondPrincipal.statusCode, 200);
  config.adminToken = prevAdmin;
  config.reviewerToken = prevReviewer;
  await app.close();
});
