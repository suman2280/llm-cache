/**
 * Tests for the grounding check on generated answers.
 *
 *   node --test tests/
 *
 * Asking a small model for MORE makes it fabricate. Measured: "aws", asked
 * for six to nine bullets, produced
 *
 *   "AWS offers an EC2 instance type called 't2.micro' which is free-tier
 *    eligible ... billed at a rate of $0.0000002 per second"
 *
 * None of that is in the reference material. It reads well and it is false,
 * which is exactly what the SOP forbids: "No derived content is approved only
 * because an AI generated it."
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  referenceTerms, referenceIdentifiers, checkGrounding, specificIdentifiers,
} from "../src/grounding.js";

const CHUNKS = [{
  title: "What Amazon Web Services is",
  text: "Amazon Web Services (AWS) is a cloud platform provided by Amazon that offers over 200 services from data centres all over the world. A customer runs in its own logically isolated Virtual Private Cloud (VPC).",
}];

const GROUNDED = `Key points:
- Amazon Web Services (AWS) offers over 200 services from data centres all over the world.
- A customer runs in its own logically isolated Virtual Private Cloud.
- The console path or API action for it is to open the AWS Management Console.`;

const FABRICATED = `Key points:
- AWS offers an EC2 instance type called 't2.micro' which is free-tier eligible.
- To access it, go to the EC2 Dashboard or use the RunInstances API action.
- Each account is limited to 200 t2.micro instances.
- These instances are billed at a rate of $0.0000002 per second.`;

test("the identifiers of a grounded answer are in the reference", () => {
  const ids = specificIdentifiers("AWS offers over 200 services. Run RunInstances on m7i.large.");
  assert.ok(ids.has("c:RunInstances"), "a multi-word API name is a specific identifier");
  assert.ok(ids.has("d:m7i.large"), "a dotted instance type is a specific identifier");
  assert.ok(ids.has("a:AWS"), "a service acronym is a specific identifier");
  // plain integers and single-CamelCase words are prose, not evidence
  assert.ok(!ids.has("n:200"));
  assert.ok(!ids.has("c:Console"));
});

test("a grounded answer passes the check", () => {
  const g = checkGrounding(GROUNDED, referenceTerms(CHUNKS), referenceIdentifiers(CHUNKS));
  assert.ok(g.grounded, `a grounded answer must pass (${g.reason ?? g.novel.join(", ")})`);
});

test("a fabricated answer fails the check", () => {
  const g = checkGrounding(FABRICATED, referenceTerms(CHUNKS), referenceIdentifiers(CHUNKS));
  assert.ok(!g.grounded, "a fabricated answer must fail");
  const novel = g.novel.join(" ");
  assert.match(novel, /t2|RunInstances|0000002|micro/i);
});

test("the check is about identifiers, not vocabulary", () => {
  // The instruction itself asks for "the console path or API action", so those
  // words will never appear verbatim in the reference -- they must not count
  // as evidence of fabrication.
  const g = checkGrounding(GROUNDED, referenceTerms(CHUNKS), referenceIdentifiers(CHUNKS));
  assert.equal(g.novelIdentifiers.length, 0, "no fabricated identifiers");
  assert.ok(g.grounded);
  // the ordinary rewording is still reported, but separately and harmlessly
  assert.ok(g.novelTerms.includes("console"));
});

test("generic acronyms are not evidence of fabrication", () => {
  const ids = specificIdentifiers("Use the API and the CLI to do it.");
  assert.ok(!ids.has("c:API"), "API is a generic acronym, not a service name");
  assert.ok(!ids.has("c:CLI"));
});

test("an AWS-specific acronym IS evidence", () => {
  const ids = specificIdentifiers("Use KMS to encrypt it.");
  assert.ok(ids.has("a:KMS"));
});

test("the 'Key points:' heading is ours, not the model's content", () => {
  const withHeading = "Key points:\n- AWS offers over 200 services.";
  const g = checkGrounding(withHeading, referenceTerms(CHUNKS), referenceIdentifiers(CHUNKS));
  assert.ok(g.grounded);
});
