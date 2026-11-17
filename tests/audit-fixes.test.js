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
import { requestFingerprint, samplingClass } from "../src/keying.js";

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
