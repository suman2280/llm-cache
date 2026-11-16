/**
 * Tests for multi-intent detection and composition.
 *
 *   node --test tests/
 *
 * A message can contain two questions on two lines. Serving the nearest
 * single cached answer silently drops the other one -- exactly what happened
 * with "tell me about AWS\ntell me about EC2", which came back as the EC2
 * answer alone.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { splitIntents, isMultiIntent } from "../src/intents.js";
import { coverageVerdict, stemmedTerms } from "../src/lexicon.js";

test("two questions on separate lines are two intents", () => {
  const parts = splitIntents("tell me about AWS\ntell me about EC2");
  assert.deepEqual(parts, ["tell me about AWS", "tell me about EC2"]);
  assert.ok(isMultiIntent("tell me about AWS\ntell me about EC2"));
});

test("two questions in one line are two intents", () => {
  assert.deepEqual(splitIntents("What is AWS? What is EC2?"), ["What is AWS", "What is EC2"]);
});

test("a single question stays a single intent", () => {
  for (const q of [
    "What are virtual machines?",
    "How do I enable versioning on an S3 bucket?",
    "tell me about AWS",
    "redis aws",
  ]) {
    assert.equal(splitIntents(q).length, 1, q);
    assert.ok(!isMultiIntent(q), q);
  }
});

test("short fragments from blank lines are discarded", () => {
  const parts = splitIntents("tell me about AWS\n\n\nx");
  assert.deepEqual(parts, ["tell me about AWS"]);
});

test("a wholly generic question still has coverage", () => {
  // "tell me about AWS" has ZERO specific terms: the framing verbs are
  // stopwords and "aws" is domain-generic. It used to score 0 and be
  // rejected, which broke resolution of the first half of the multi-intent
  // prompt. The fallback to content words fixes it.
  assert.equal(stemmedTerms("tell me about AWS").size, 0);
  const v = coverageVerdict(
    "tell me about AWS",
    "tell me about AWS",
    "Amazon Web Services (AWS) is a cloud platform with over 200 services.",
    true,
  );
  assert.ok(v.ok, v.reason);
  assert.equal(v.coverage, 1);
});

test("a generic question against a different topic is still refused", () => {
  const v = coverageVerdict(
    "tell me about AWS",
    "tell me about EC2",
    "Amazon EC2 provides resizable virtual servers in the cloud.",
    false,
  );
  assert.ok(!v.ok, v.reason);
});
