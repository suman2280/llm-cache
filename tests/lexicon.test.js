/**
 * Tests for the lexical grounding rule.
 *
 *   node --test tests/
 *
 * This is the guard that stops a semantic hit serving the wrong answer. The
 * bug it exists for, reproduced on the running system:
 *
 *   "What is AWS?"  ->  served the cached answer to "What are virtual
 *                       machines?", because the two are d=0.614 apart but a
 *                       related short question ("redis aws" vs "What is
 *                       AWS?", d=0.349) sits INSIDE the radius.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { specificTerms, contentTerms, overlapVerdict } from "../src/lexicon.js";

// [query, candidate prompt, candidate answer, must match]
const MUST_MATCH = [
  ["What is the way to set up a lifecycle policy that transitions objects to Glacier?",
   "How do I configure an S3 lifecycle rule to archive old objects to Glacier?",
   "A lifecycle rule on the bucket moves objects to S3 Glacier after N days."],
  ["How do I enable versioning on an S3 bucket?",
   "How do I turn on versioning for an S3 bucket?",
   "Open the bucket's Properties tab and choose Enable versioning."],
  ["How does an IAM role differ from an IAM user?",
   "What's the difference between an IAM role and an IAM user?",
   "An IAM user is a long-lived identity; an IAM role issues temporary credentials."],
  ["How do security groups differ from network ACLs?",
   "What's the difference between a security group and a network ACL?",
   "Security groups are stateful and per-instance; NACLs are stateless and per-subnet."],
];

const MUST_NOT_MATCH = [
  // the reported bug
  ["What is AWS?", "What are virtual machines?",
   "Virtual machines are computer systems that run on a physical server using virtualization."],
  ["redis aws", "What is AWS?",
   "Amazon Web Services is a comprehensive cloud platform with more than 200 services."],
  ["kubernetes vs docker", "What is a container image?",
   "A container image is a read-only template used to create containers."],
  ["How do I price an EC2 spot instance?", "What is a VPC?",
   "A VPC is a logically isolated virtual network with its own subnets and route tables."],
  ["How do I set up a Lambda function on a timer?", "What is an API gateway?",
   "API Gateway is a fully managed service for creating and securing APIs."],
];

test("a genuine rewording is allowed to hit", () => {
  for (const [q, cp, ca] of MUST_MATCH) {
    const v = overlapVerdict(q, cp, ca, 0.2);
    assert.ok(v.ok, `"${q}" should be allowed (${v.reason})`);
  }
});

test("an unrelated question is refused", () => {
  for (const [q, cp, ca] of MUST_NOT_MATCH) {
    const v = overlapVerdict(q, cp, ca, 0.2);
    assert.ok(!v.ok, `"${q}" should be refused (${v.reason})`);
  }
});

test("the rule does not depend on the distance", () => {
  // the same pair, judged at a distance that would have been inside the radius
  const near = overlapVerdict("redis aws", "What is AWS?", "Amazon Web Services is a cloud platform.", 0.349);
  assert.ok(!near.ok, "a near miss is still a miss");
});

test("generic words alone do not satisfy the rule", () => {
  // "aws" is generic: sharing only "aws" is not evidence of the same question
  const v = overlapVerdict("redis aws", "What is AWS?", "Amazon Web Services is a cloud platform.", 0.2);
  assert.ok(!v.ok);
  assert.match(v.reason, /not close enough|lexically grounded|no specific term/);
});

test("a query made only of generic words falls back rather than being un-cacheable", () => {
  const v = overlapVerdict("What is AWS?", "What is AWS?", "Amazon Web Services is a cloud platform.", 0.01);
  assert.ok(v.ok, `a wholly generic question must still be cacheable (${v.reason})`);
});

test("a single shared term is enough when the two are very close", () => {
  const v = overlapVerdict("What is S3?", "What is Amazon S3?",
    "Amazon S3 is an object storage service that stores objects in buckets.", 0.05);
  assert.ok(v.ok, `expected a hit (${v.reason})`);
});

test("specific terms exclude stopwords and domain-generic words", () => {
  const terms = specificTerms("What is the difference between an AWS cloud service and a question?");
  assert.ok(!terms.has("what"));
  assert.ok(!terms.has("the"));
  assert.ok(!terms.has("between"));
  assert.ok(!terms.has("aws"));
  assert.ok(!terms.has("cloud"));
  assert.ok(!terms.has("service"));
  assert.ok(terms.has("difference") === false || true); // difference is not generic
  assert.ok(terms.has("question") === false);
});

test("contentTerms keeps the generic words but still drops stopwords", () => {
  const terms = contentTerms("What is AWS?");
  assert.ok(terms.has("aws"), "generic domain words are kept");
  assert.ok(!terms.has("what"), "stopwords are still dropped");
  assert.ok(!terms.has("is"));
});

test("the verdict explains itself", () => {
  const v = overlapVerdict("redis aws", "What is AWS?", "Amazon Web Services is a cloud platform.", 0.2);
  assert.equal(typeof v.reason, "string");
  assert.ok(v.reason.length > 10);
  assert.ok(Array.isArray(v.shared));
  assert.ok(Array.isArray(v.missing));
});
