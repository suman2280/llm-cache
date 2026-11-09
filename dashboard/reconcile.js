// llm-cache dashboard — pure reconciliation planner for the unified event log.
//
// Why this file exists: the log re-polls /stats every second, and a naive
// full re-render would collapse <details> rows, fight scroll, and burn FLIP
// opportunities. The risky part of that design is *deciding* the DOM ops —
// so it lives here as a pure function, unit-tested with Node's built-in
// runner (see reconcile.test.js) with no browser and no DOM. The DOM
// application (~20 lines in app.js) just executes the plan.
//
// Contract: both id lists are newest-first, as returned by GET /stats
// (Redis LPUSH + LRANGE). Ids are unique (stats:event_seq is monotonic and
// deliberately survives /stats/reset — store.py). In the steady state only
// head-prepends and tail-trims occur, but the planner is correct for any
// reordering: rows present in both lists are *repositioned* by the position
// walk (app.js insertBefore each row at its index), not by ops.
//
// (The first version of this planner tried to derive move-ops from index
// deltas and produced duplicate inserts for reordered ids — caught by the
// exhaustive permutation test before it ever shipped. docs/validation.md.)

/**
 * Diff the currently-rendered event ids against a fresh /stats payload.
 *
 * @param {number[]} prevIds - ids currently in the DOM, newest-first.
 * @param {number[]} nextIds - ids from the new payload, newest-first.
 * @returns {Array<{type: "insert", id: number, index: number}
 *                | {type: "remove", id: number}>} structural ops only:
 *          inserts ascending by index, then removals. Repositioning of
 *          surviving rows is handled by applyPlan's position walk (and by
 *          app.js walking every incoming row).
 */
export function planUpdates(prevIds, nextIds) {
  const prevSet = new Set(prevIds);
  const nextSet = new Set(nextIds);
  const ops = [];
  const seen = new Set();
  for (let i = 0; i < nextIds.length; i++) {
    const id = nextIds[i];
    if (seen.has(id)) continue; // defensive: ids are unique by contract
    seen.add(id);
    if (!prevSet.has(id)) {
      ops.push({ type: "insert", id, index: i });
    }
  }
  for (const id of prevIds) {
    if (!nextSet.has(id)) {
      ops.push({ type: "remove", id });
    }
  }
  return ops;
}

/**
 * Simulate the DOM application: create inserts, drop removals, then walk
 * nextIds moving each row to its index (the app.js position walk).
 * Used by the tests; `order` is the payload the plan was made against.
 */
export function applyPlan(ids, ops, order) {
  const out = ids.slice();
  for (const op of ops) {
    if (op.type === "insert") {
      out.splice(op.index, 0, op.id);
    } else {
      const i = out.indexOf(op.id);
      if (i !== -1) out.splice(i, 1);
    }
  }
  for (let i = 0; i < order.length; i++) {
    const at = out.indexOf(order[i]);
    if (at !== -1 && at !== i) {
      out.splice(i, 0, ...out.splice(at, 1));
    }
  }
  return out;
}
