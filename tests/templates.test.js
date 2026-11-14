/**
 * Tests for the deterministic tier -- the tier that never calls the model.
 *
 *   node --test tests/
 *
 * The SOP requires (line 597): "Verify the answer by code/rule ... do not mark
 * verified only because the generator produced an answer." So these templates
 * are checked against independently computed arithmetic, not against
 * themselves.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  TEMPLATES, getTemplate, templateKey, validateParams, renderTemplate,
} from "../src/templates.js";

test("every template has the fields the SOP requires", () => {
  for (const t of TEMPLATES) {
    assert.ok(t.id, "template needs an id");
    assert.ok(t.concept_id, `${t.id} needs a concept_id`);
    assert.ok(t.asset_type, `${t.id} needs an asset_type`);
    assert.ok(t.skill_type, `${t.id} needs a skill_type`);
    assert.ok(Number.isFinite(t.difficulty_level), `${t.id} needs a difficulty_level`);
    assert.ok(Array.isArray(t.required) && t.required.length, `${t.id} needs required params`);
    assert.equal(typeof t.render, "function");
    assert.equal(typeof t.solve, "function");
  }
});

test("template ids are unique", () => {
  const ids = TEMPLATES.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("EC2 cost is computed correctly and independently", () => {
  const t = getTemplate("T-EC2-COST");
  // 4 x m5.large ($0.096/h) x 730h = 4 * 0.096 * 730 = 280.32
  const r = renderTemplate(t, { instance_type: "m5.large", count: "4", hours: "730" });
  assert.ok(r.ok, r.why);
  assert.equal(r.answer, "$280.32 for the month");
  // and recompute it here, independently of the template
  assert.equal(Number(r.answer.match(/\$([\d.]+)/)[1]), 0.096 * 4 * 730);
});

test("the same template with different parameters gives a different answer", () => {
  const t = getTemplate("T-EC2-COST");
  const a = renderTemplate(t, { instance_type: "m5.large", count: "4", hours: "730" });
  const b = renderTemplate(t, { instance_type: "m5.large", count: "4", hours: "160" });
  assert.notEqual(a.answer, b.answer);
  assert.equal(b.answer, "$61.44 for the month");
  // the prompts are near-identical -- this is the case that defeats a
  // similarity-only cache
  assert.notEqual(a.prompt, b.prompt);
});

test("the template key separates different parameters", () => {
  const a = templateKey("T-EC2-COST", { instance_type: "m5.large", count: "4", hours: "730" });
  const b = templateKey("T-EC2-COST", { instance_type: "m5.large", count: "4", hours: "160" });
  assert.notEqual(a, b);
  // key order must not matter
  assert.equal(
    templateKey("T-EC2-COST", { hours: "730", count: "4", instance_type: "m5.large" }), a,
  );
});

test("S3 storage cost is computed correctly", () => {
  const t = getTemplate("T-S3-COST");
  const r = renderTemplate(t, { gb: "500", storage_class: "standard" });
  assert.ok(r.ok, r.why);
  assert.equal(r.answer, "$11.50 for the month"); // 500 * 0.023
  const glacier = renderTemplate(t, { gb: "500", storage_class: "glacier" });
  assert.notEqual(glacier.answer, r.answer);
});

test("the quota template answers from its table", () => {
  const t = getTemplate("T-QUOTA");
  const r = renderTemplate(t, { service: "vpc" });
  assert.ok(r.ok, r.why);
  assert.match(r.answer, /VPC/);
  assert.equal(renderTemplate(t, { service: "nope" }).ok, false);
});

test("the comparison template is direction-sensitive", () => {
  const t = getTemplate("T-COMPARE");
  const forward = renderTemplate(t, { service_a: "s3", service_b: "dynamodb", dimension: "storage_model" });
  assert.ok(forward.ok, forward.why);
  // S3->DynamoDB and DynamoDB->S3 are different questions
  assert.notEqual(
    forward.answer,
    renderTemplate(t, { service_a: "dynamodb", service_b: "s3", dimension: "storage_model" }).answer,
  );
});

test("invalid parameters are refused rather than guessed", () => {
  const t = getTemplate("T-EC2-COST");
  assert.equal(renderTemplate(t, { instance_type: "m5.large", count: "1" }).ok, false, "missing param");
  assert.equal(renderTemplate(t, { instance_type: "x1.huge", count: "1", hours: "10" }).ok, false, "unknown type");
  assert.equal(renderTemplate(t, { instance_type: "m5.large", count: "0", hours: "10" }).ok, false, "count < 1");
  assert.equal(renderTemplate(t, { instance_type: "m5.large", count: "1", hours: "9999" }).ok, false, "hours > a month");
});

test("validation reports missing and unknown parameters", () => {
  const t = getTemplate("T-EC2-COST");
  const v = validateParams(t, { instance_type: "m5.large", nope: "1" });
  assert.deepEqual(v.missing, ["count", "hours"]);
  assert.deepEqual(v.unknown, ["nope"]);
});

test("an unknown template id resolves to null", () => {
  assert.equal(getTemplate("T-NOPE"), null);
});
