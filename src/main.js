#!/usr/bin/env node
/**
 * Entrypoint.
 *
 *   node src/main.js                    # serve on :8000
 *   LLM_MODEL_IDLE_S=0 node src/main.js # unload the model after every miss
 *
 * Nothing here starts the model or loads the embedder -- both happen on first
 * use. A cold start costs ~250 MB of Node instead of gigabytes.
 */

import config from "./config.js";

const { build } = await import("./server.js");

async function main() {
  // Warm the parts we can warm cheaply; the model and the embedder stay lazy.
  const app = await build();
  // Build the domain policy up front: it embeds the exemplars, and doing that
  // on the first request would make it slower than the request it guards.
  const { getPolicy, purgeDegenerateEntries } = await import("./cache.js");
  const policy = await getPolicy();
  console.log(`[app] domain: ${policy.name} (${policy.mode}) - ${policy.description}`);
  // Evict any answer that is already degenerate, so a cached repetition loop
  // cannot be served (or leak into its neighbours) after a restart.
  const purged = await purgeDegenerateEntries();
  if (purged) console.log(`[app] evicted ${purged} degenerate cached answer(s)`);
  const { ensureIndex, isUp } = await import("./vectors.js");
  try { await ensureIndex(); } catch (e) { console.warn(`[redis] unavailable: ${e.message}`); }

  await app.listen({ port: config.port, host: config.host });
  console.log(`[app] ${config.serviceName} ${config.serviceVersion} on http://${config.host}:${config.port}`);
  console.log(`[app] dashboard  http://${config.host}:${config.port}/dashboard/`);
  console.log(`[app] stats      http://${config.host}:${config.port}/stats`);
  console.log(`[app] model      ${config.model} via ${config.upstreamUrl} (idle unload ${config.modelIdleS}s)`);
  console.log(`[app] sqlite     ${config.dbPath}`);
  console.log(`[app] model is NOT loaded and the embedder is NOT loaded -- both are lazy`);
  if (!isUp()) console.warn(`[app] redis is not up at ${config.redisUrl}; the semantic tier will degrade`);
}

main().catch((err) => {
  console.error(`[app] startup failed: ${err.message}`);
  process.exit(1);
});