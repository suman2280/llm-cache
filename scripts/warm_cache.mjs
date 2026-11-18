#!/usr/bin/env node
/**
 * #63: warm the cache from expected queries / a query log.
 *
 *   node scripts/warm_cache.mjs --file queries.jsonl
 *   node scripts/warm_cache.mjs --demo
 *   node scripts/warm_cache.mjs --file queries.json --dry-run
 *
 * Input is a JSON array of strings or {messages, envelope} objects, or a
 * JSONL file with one such value per line. Every query goes through the same
 * guard/grounding/verifier path as live traffic; concurrency is bounded.
 */

import { readFile, writeFile } from "node:fs/promises";

import { warmQueries } from "../src/warm.js";
import config from "../src/config.js";
import { DEMO_PROMPTS } from "../src/corpus.js";

function argv(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}
const has = (flag) => process.argv.includes(flag);

async function loadQueries() {
  if (has("--demo")) {
    return DEMO_PROMPTS.map(({ q }) => ({ messages: [{ role: "user", content: q }] }));
  }
  const file = argv("--file") || argv("--input");
  if (!file) {
    console.error("provide --file <queries.jsonl|queries.json> or --demo");
    process.exit(2);
  }
  const text = await readFile(file, "utf8");
  const trimmed = text.trim();
  if (trimmed.startsWith("[")) return JSON.parse(trimmed);
  return trimmed.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

const queries = await loadQueries();
const dryRun = has("--dry-run");
const concurrency = Number(argv("--concurrency", String(config.warmConcurrency)));
console.log(`Cache warm: ${queries.length} quer${queries.length === 1 ? "y" : "ies"} ` +
  `(${dryRun ? "DRY RUN" : `concurrency ${concurrency}`})`);

const result = await warmQueries(queries, { dryRun, concurrency });

for (const d of result.details) {
  const prompt = d.prompt || (d.reason ? `error: ${d.reason}` : `#${d.index}`);
  console.log(`  [${d.status}] ${String(prompt).slice(0, 90)}`);
}
console.log("---");
console.log(`total=${result.total} warmed=${result.warmed} skipped=${result.skipped} ` +
  `failed=${result.failed} model_invocations=${result.model_invocations}` +
  (dryRun ? ` would_hit=${result.would_hit} would_miss=${result.would_miss}` : ""));
console.log(`last_warm=${result.last_warm}`);

const out = argv("--json");
if (out) { await writeFile(out, JSON.stringify(result, null, 2)); console.log(`wrote ${out}`); }
