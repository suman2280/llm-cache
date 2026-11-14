/**
 * Regression tests for the keying rules.
 *
 *   node --test tests/
 *
 * Every case here corresponds to a bug that actually shipped in a previous
 * build of this project, or to a rule that has to survive a refactor.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  requestFingerprint, semanticText, lastUserText, scopeOf, samplingClass,
  symbolFingerprint, asciiHeaderValue, parseEnvelope, encodeEnvelope,
} from "../src/keying.js";

// ---------------------------------------------------------------------------
// The exact tier must respect every answer-affecting parameter.
// (Previous build: an 8-param allowlist, so top_k / min_p / num_predict /
//  repeat_penalty / n / logit_bias all hashed identically to the bare body.)

test("the exact fingerprint changes when any answer-affecting param changes", () => {
  const messages = [{ role: "user", content: "What is Redis?" }];
  const base = requestFingerprint({ model: "m", messages });
  for (const extra of [
    { temperature: 0.5 }, { top_p: 0.9 }, { top_k: 1 }, { top_k: 40 },
    { min_p: 0.05 }, { max_tokens: 10 }, { max_tokens: 500 },
    { num_predict: 10 }, { num_predict: 500 }, { repeat_penalty: 1.2 },
    { seed: 1 }, { seed: 2 }, { n: 3 }, { logit_bias: { "123": -100 } },
    { stop: ["\n"] }, { presence_penalty: 0.5 }, { frequency_penalty: 0.5 },
    { response_format: { type: "json_object" } },
    { penalty: "abs" }, { mirostat: 2 }, { mirostat_tau: 0.5 },
    { penalize_new_token: true }, { top_logprobs: 3 }, { logprobs: true },
  ]) {
    assert.notEqual(
      requestFingerprint({ model: "m", messages, ...extra }), base,
      `param ${JSON.stringify(extra)} must change the fingerprint`,
    );
  }
});

test("the exact fingerprint ignores inert params", () => {
  const messages = [{ role: "user", content: "hi" }];
  const base = requestFingerprint({ model: "m", messages });
  for (const inert of [
    { keep_alive: "30m" }, { stream: false }, { metadata: { a: 1 } },
    { user: "u1" }, { request_id: "r1" }, { stream_options: { include_usage: true } },
  ]) {
    assert.equal(
      requestFingerprint({ model: "m", messages, ...inert }), base,
      `inert param ${JSON.stringify(inert)} must NOT change the fingerprint`,
    );
  }
});

test("the exact fingerprint is stable under key reordering", () => {
  const a = requestFingerprint({ model: "m", messages: [{ role: "user", content: "x" }], temperature: 0, top_p: 1 });
  const b = requestFingerprint({ top_p: 1, temperature: 0, messages: [{ role: "user", content: "x" }], model: "m" });
  assert.equal(a, b);
});

// ---------------------------------------------------------------------------
// The semantic tier must see the whole conversation.
// (Previous build: embedded only the last user message, so two requests with
//  different system prompts had embedding distance 0.0 and shared one entry.)

test("semantic text includes the system prompt and every turn", () => {
  const messages = [
    { role: "system", content: "You are a maths reviewer." },
    { role: "user", content: "First question" },
    { role: "assistant", content: "An answer" },
    { role: "user", content: "Second question" },
  ];
  const text = semanticText(messages);
  assert.match(text, /maths reviewer/);
  assert.match(text, /First question/);
  assert.match(text, /An answer/);
  assert.match(text, /Second question/);
});

test("different system prompts produce different semantic text", () => {
  const user = [{ role: "user", content: "same question" }];
  const a = semanticText([{ role: "system", content: "A" }, ...user]);
  const b = semanticText([{ role: "system", content: "B" }, ...user]);
  assert.notEqual(a, b);
});

test("lastUserText returns the last user message only", () => {
  assert.equal(lastUserText([
    { role: "user", content: "first" },
    { role: "assistant", content: "reply" },
    { role: "user", content: "second" },
  ]), "second");
});

// ---------------------------------------------------------------------------
// Scope: the semantic tier may only search inside it.
// (Previous build: search by distance alone, so one concept's asset could be
//  served for another's.)

test("scope separates concepts, asset types, chapters and difficulty bands", () => {
  const base = { chapter_code: "C1", concept_id: "X", asset_type: "learning_object", difficulty_level: "2" };
  const s = scopeOf(base, "det");
  assert.notEqual(s, scopeOf({ ...base, concept_id: "Y" }, "det"));
  assert.notEqual(s, scopeOf({ ...base, asset_type: "practice_question" }, "det"));
  assert.notEqual(s, scopeOf({ ...base, chapter_code: "C2" }, "det"));
  assert.notEqual(s, scopeOf({ ...base, difficulty_level: "5" }, "det"));
  assert.notEqual(s, scopeOf(base, "sample"));
  assert.equal(s, scopeOf({ ...base }, "det"), "same scope for the same identity");
});

test("difficulty is banded, not exact", () => {
  const a = scopeOf({ chapter_code: "C", concept_id: "X", asset_type: "o", difficulty_level: "1" }, "det");
  const b = scopeOf({ chapter_code: "C", concept_id: "X", asset_type: "o", difficulty_level: "2" }, "det");
  const c = scopeOf({ chapter_code: "C", concept_id: "X", asset_type: "o", difficulty_level: "4" }, "det");
  assert.equal(a, b, "1 and 2 are both 'easy'");
  assert.notEqual(a, c, "2 and 4 are different bands");
});

// ---------------------------------------------------------------------------
// Sampling class: the semantic tier must not cross sampling regimes.

test("sampling class separates deterministic, sampled and constrained requests", () => {
  assert.equal(samplingClass({}), "det");
  assert.equal(samplingClass({ temperature: 0 }), "det");
  assert.equal(samplingClass({ temperature: 0.3 }), "sample");
  assert.equal(samplingClass({ temperature: 0.3, top_k: 1 }), "sample-constrained-1");
  assert.equal(samplingClass({ temperature: 0.3, top_p: 0.9 }), "sample-constrained-1");
  assert.equal(samplingClass({ temperature: 0.3, top_k: 1, min_p: 0.1 }), "sample-constrained-2");
});

// ---------------------------------------------------------------------------
// The symbol fingerprint: capture meaning, not punctuation.
// (Previous build had no guard at all and served wrong answers to 10 of 11
//  maths pairs whose answers differed.)

test("the symbol fingerprint refuses meaning-changing differences", () => {
  const differ = [
    ["Is 2 ∈ A?", "Is 2 ∉ A?"],            // membership flipped
    ["Give A ∪ B", "Give A ∩ B"],            // union vs intersection
    ["x ≤ 3", "x ≥ 3"],                      // inequality flipped
    ["730 hours", "160 hours"],              // different number
    ["{1,2,3,4,5}", "{1,2,3,4,5,6}"],        // different set size
    ["a ⊂ b", "a ⊆ b"],                      // subset vs subset-or-equal
  ];
  for (const [a, b] of differ) {
    assert.notEqual(symbolFingerprint(a), symbolFingerprint(b),
      `"${a}" and "${b}" must not share a fingerprint`);
  }
});

test("the symbol fingerprint allows prose differences through", () => {
  const same = [
    ["Let A = {1,2,3}. Is 2 ∈ A? Give A ∪ B where B = {2,3,4}.",
     "Let A = {1,2,3}. Is 2 ∈ A? And give A ∪ B where B = {2,3,4}."],
    ["What is a VPC?", "Explain what a VPC is."],
    ["Is 2 an element of A?", "Is 2 a member of A?"],
  ];
  for (const [a, b] of same) {
    assert.equal(symbolFingerprint(a), symbolFingerprint(b),
      `"${a}" and "${b}" should share a fingerprint`);
  }
});

// ---------------------------------------------------------------------------
// Header safety.
// (Previous build: a raw prompt in a latin-1 header -> HTTP 500 on any cache
//  hit whose prompt contained a maths symbol. This is the whole JEE domain.)

test("header values are always ASCII-safe", () => {
  const nasty = [
    "Let A = {1,2,3}. Is 2 ∈ A? Give A ∪ B where B = {2,3,4}?",
    "समुच्चय",
    "emoji 🎓 and a tab\there",
    "new\nline",
    "quote\" and backslash\\",
  ];
  for (const s of nasty) {
    const out = asciiHeaderValue(s);
    // eslint-disable-next-line no-control-regex
    assert.ok(/^[\x20-\x7e]*$/.test(out), `not ASCII-safe: ${JSON.stringify(out)}`);
  }
});

test("header values are truncated to the limit", () => {
  assert.ok(asciiHeaderValue("x".repeat(500), 50).length <= 50);
});

test("an empty header value stays empty", () => {
  assert.equal(asciiHeaderValue(undefined), "");
  assert.equal(asciiHeaderValue(null), "");
});

// ---------------------------------------------------------------------------
// The content envelope round-trips.

test("the envelope round-trips through base64url", () => {
  const env = {
    chapter_code: "MATH-01-AWS", concept_id: "AWS-04", asset_type: "practice_question",
    difficulty_level: "2", template_id: "T-EC2-COST", params: { count: "2", hours: "730" },
  };
  const back = parseEnvelope(encodeEnvelope(env));
  assert.equal(back.chapter_code, "MATH-01-AWS");
  assert.equal(back.concept_id, "AWS-04");
  assert.equal(back.template_id, "T-EC2-COST");
  assert.deepEqual(back.params, { count: "2", hours: "730" });
});

test("a malformed envelope degrades to empty, never throws", () => {
  for (const bad of ["not-base64!!", "eyJ", "{}", "", null, undefined]) {
    assert.doesNotThrow(() => parseEnvelope(bad));
  }
  assert.deepEqual(parseEnvelope("not-base64!!"), {});
});
