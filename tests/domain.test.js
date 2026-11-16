/**
 * Tests for the domain guard.
 *
 *   node --test tests/
 *
 * The model card for this fine-tune promises:
 *   "refuses questions outside the AWS domain by design"
 *   Evaluation: out-of-scope (3 questions) -> refused correctly, 100%
 *
 * Measured on this build, that promise does not hold -- 0 of 6 out-of-scope
 * questions were refused -- so the guard lives in the proxy. These tests pin
 * the behaviour the card advertises, so it cannot quietly regress.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { DomainPolicy, MODES } from "../src/domain.js";
import { DOMAIN } from "../src/corpus.js";

const policy = new DomainPolicy({ ...DOMAIN, mode: "strict" });

const IN_DOMAIN = [
  "How do I configure an S3 lifecycle rule to archive old objects to Glacier?",
  "What's the difference between a security group and a network ACL?",
  "How do I enable versioning on an S3 bucket?",
  "What's the difference between an IAM role and an IAM user?",
  "How do I run a Lambda function on a schedule?",
  "What's the difference between a spot instance and an on-demand instance?",
  "What is the AWS shared responsibility model?",
  "How do I read a CloudWatch metric for my EC2 instances?",
  "Which VPC subnet should my RDS instance use?",
];

const OUT_OF_DOMAIN = [
  "Who wrote the play Hamlet?",
  "What is the boiling point of water in Celsius?",
  "What is 17 times 23?",
  "Who won the 2022 FIFA World Cup?",
  "What is the capital of Australia?",
  "Explain photosynthesis.",
  "Who is the President of France?",
  "What is the derivative of x squared?",
  "How many legs does a spider have?",
  "Summarize the plot of Pride and Prejudice.",
  "What is the speed of light in a vacuum?",
  "Solve for x: 2x + 6 = 10.",
];

test("domain questions are recognised as in-domain", async () => {
  for (const q of IN_DOMAIN) {
    const v = await policy.classify(q);
    assert.ok(v.inDomain, `"${q}" should be in-domain (${v.reason})`);
  }
});

test("general-purpose questions are recognised as out-of-domain", async () => {
  for (const q of OUT_OF_DOMAIN) {
    const v = await policy.classify(q);
    assert.ok(!v.inDomain, `"${q}" should be OUT of domain (${v.reason})`);
  }
});

test("the lexical signal is what carries the borderline cases", async () => {
  // "What is the derivative of x squared?" and "Explain photosynthesis." score
  // within 0.03 of each other on the semantic signal alone -- the semantic
  // score alone cannot separate them. The domain vocabulary can.
  const photo = await policy.classify("Explain photosynthesis.");
  const deriv = await policy.classify("What is the derivative of x squared?");
  assert.equal(photo.matched.length, 0, "no domain vocabulary in either");
  assert.equal(deriv.matched.length, 0);
  assert.ok(photo.outMatched.length > 0, "photosynthesis is an explicit out-of-domain term");
  assert.ok(!photo.inDomain && !deriv.inDomain);
});

test("an explicit out-of-domain term wins over everything", async () => {
  // Even with strong AWS vocabulary, an out-of-domain marker is decisive.
  const v = await policy.classify("Explain photosynthesis using S3 and Lambda");
  assert.ok(!v.inDomain, `should be out-of-domain (${v.reason})`);
  assert.ok(v.matched.length > 0);
});

test("a domain term is enough on its own", async () => {
  const v = await policy.classify("Explain the tradeoff between an S3 bucket and an EBS volume");
  assert.ok(v.inDomain);
  assert.ok(v.matched.includes("s3"));
});

test("the classification explains itself", async () => {
  const v = await policy.classify("How do I enable versioning on an S3 bucket?");
  assert.match(v.reason, /domain vocabulary|semantic similarity/);
  assert.equal(typeof v.semantic, "number");
  assert.equal(typeof v.lexical, "number");
});

test("modes are validated", () => {
  assert.deepEqual(MODES, ["off", "bypass", "strict"]);
  const p = new DomainPolicy({ ...DOMAIN, mode: "nonsense" });
  assert.equal(p.mode, "off", "an unknown mode falls back to off, never to strict");
});

test("an empty policy never restricts anything", async () => {
  const open = new DomainPolicy({ name: "open", exemplars: [], terms: [], threshold: 2, mode: "off" });
  for (const q of [...IN_DOMAIN, ...OUT_OF_DOMAIN]) {
    const v = await open.classify(q);
    assert.ok(v.inDomain, `"${q}" should pass an open policy`);
  }
});
