// Gate test (brainstorm brief Phase 1, G1): the reconciliation pattern is
// the one load-bearing frontend assumption. Run: npm test  (node --test).
// No browser, no DOM, no dependencies — Node's built-in runner only.

import { test } from "node:test";
import assert from "node:assert/strict";

import { planUpdates, applyPlan } from "./reconcile.js";

test("identical payload -> no ops", () => {
  const ids = [5, 4, 3, 2, 1];
  assert.deepEqual(planUpdates(ids, ids), []);
});

test("empty previous -> insert everything in payload order", () => {
  const ops = planUpdates([], [3, 2, 1]);
  assert.deepEqual(ops, [
    { type: "insert", id: 3, index: 0 },
    { type: "insert", id: 2, index: 1 },
    { type: "insert", id: 1, index: 2 },
  ]);
});

test("new events prepend at the head (the normal 1s-poll case)", () => {
  const ops = planUpdates([4, 3, 2, 1], [6, 5, 4, 3, 2, 1]);
  assert.deepEqual(ops, [
    { type: "insert", id: 6, index: 0 },
    { type: "insert", id: 5, index: 1 },
  ]);
});

test("ring overflow: dropped tail rows are removed, head preserved", () => {
  // a 4-row window that scrolled: ids 1 and 2 fell off the LTRIM ring
  const ops = planUpdates([4, 3, 2, 1], [4, 3]);
  assert.deepEqual(ops, [
    { type: "remove", id: 2 },
    { type: "remove", id: 1 },
  ]);
});

test("mixed: prepends and removals in one plan", () => {
  const ops = planUpdates([5, 4, 3, 2], [7, 5, 3]);
  assert.deepEqual(ops, [
    { type: "insert", id: 7, index: 0 },
    { type: "remove", id: 4 },
    { type: "remove", id: 2 },
  ]);
});

test("middle reorder: no structural ops; the position walk handles it", () => {
  // 4 exists on both sides but at a different index -> NOT an insert.
  // (The first planner version got this wrong: duplicate insert + orphan.
  // Caught by the exhaustive permutation test below.)
  const ops = planUpdates([4, 5, 3], [5, 4, 3]);
  assert.deepEqual(ops, []);
  assert.deepEqual(applyPlan([4, 5, 3], ops, [5, 4, 3]), [5, 4, 3]);
});

test("duplicate ids in a payload are ignored (defensive)", () => {
  const ops = planUpdates([], [3, 3, 2]);
  assert.deepEqual(ops, [
    { type: "insert", id: 3, index: 0 },
    { type: "insert", id: 2, index: 2 },
  ]);
});

// The property app.js depends on: applying any plan (plus the position
// walk) to any previous state reproduces the payload exactly. Exhaustive
// over all permutations of 5 ids.
test("apply(plan) reproduces nextIds for every permutation pair", () => {
  const perms = (arr) =>
    arr.length <= 1
      ? [arr]
      : arr.flatMap((x, i) =>
          perms([...arr.slice(0, i), ...arr.slice(i + 1)]).map((p) => [x, ...p]),
        );
  const all = perms([1, 2, 3, 4, 5]);
  for (const prev of all) {
    for (const next of all) {
      const ops = planUpdates(prev, next);
      assert.deepEqual(applyPlan(prev, ops, next), next, `prev=${prev} next=${next}`);
    }
  }
});

test("plan application is repeatable (idempotent at convergence)", () => {
  const prev = [5, 4, 3, 2, 1];
  const next = [7, 5, 3];
  const once = applyPlan(prev, planUpdates(prev, next), next);
  assert.deepEqual(once, next);
  assert.deepEqual(planUpdates(once, next), []); // converged -> steady state
});
