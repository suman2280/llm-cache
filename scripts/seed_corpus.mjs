#!/usr/bin/env node
/**
 * Seed the demonstration corpus (29 Chapter-1 assets) into the running app.
 *
 *   ADMIN_TOKEN=dev-token node scripts/seed_corpus.mjs [baseUrl]
 *
 * Puts the cache into the state the preview demonstrates from: approved
 * learning objects, misconceptions and deterministic practice items, all
 * indexed for the semantic tier.
 */

const BASE = (process.argv[2] || "http://127.0.0.1:8000").replace(/\/$/, "");
const TOKEN = process.env.ADMIN_TOKEN || "dev-token";

const res = await fetch(`${BASE}/demo/seed`, {
  method: "POST",
  headers: { "X-Admin-Token": TOKEN, "Content-Type": "application/json" },
  body: "{}", // Fastify rejects an empty body when the content type is json
});
const text = await res.text();
if (!res.ok) {
  console.error(`seed failed (HTTP ${res.status}): ${text}`);
  console.error(`\nIs the app running with ALLOW_SEED=1 and ADMIN_TOKEN matching? e.g.:`);
  console.error(`  ALLOW_SEED=1 ADMIN_TOKEN=dev-token node src/main.js`);
  process.exit(1);
}
const body = JSON.parse(text);
console.log(`seeded ${body.seeded} assets into ${BASE}`);

const stats = await (await fetch(`${BASE}/stats`)).json();
console.log(`  cache entries : ${stats.service.cache_entries}`);
console.log(`  model state   : ${stats.service.model_state.state} (resident=${stats.service.model_state.resident})`);
console.log(`  embedder      : ${stats.service.embedder_loaded ? "loaded" : "not loaded (lazy)"}`);