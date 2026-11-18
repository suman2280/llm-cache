#!/usr/bin/env node
/**
 * Entrypoint.
 *
 *   node src/main.js                    # serve on :8000
 *   MODEL_IDLE_S=0 node src/main.js # unload the model after every miss
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

  // #59: configure the limiter BEFORE listen(), so the first burst is capped.
  const { configureLimiter } = await import("./ratelimit.js");
  configureLimiter(config.maxInferencesPerMinute);

  // Model generation can take up to modelTimeoutMs (default 300s). Node's
  // default headersTimeout (60s) would otherwise close the socket mid-request
  // and make clients retry, which then observes a just-inserted exact hit.
  app.server.headersTimeout = Math.max(config.modelTimeoutMs + 30_000, 120_000);
  app.server.keepAliveTimeout = 0;
  app.server.maxRequestsPerSocket = 1;
  await app.listen({ port: config.port, host: config.host });
  console.log(`[app] ${config.serviceName} ${config.serviceVersion} on http://${config.host}:${config.port}`);
  console.log(`[app] dashboard  http://${config.host}:${config.port}/dashboard/`);
  console.log(`[app] stats      http://${config.host}:${config.port}/stats`);
  console.log(`[app] model      ${config.model} via ${config.upstreamUrl} (idle unload ${config.modelIdleS}s)`);
  console.log(`[app] sqlite     ${config.dbPath}`);
  console.log(`[app] model is NOT loaded and the embedder is NOT loaded -- both are lazy`);
  if (!isUp()) console.warn(`[app] redis is not up at ${config.redisUrl}; the semantic tier will degrade`);

  // #28: without this the embedder's unload timer was dead code and the ONNX
  // runtime (~250 MB) stayed resident once the semantic tier had used it.
  const { startIdleTimer } = await import("./embedder.js");
  startIdleTimer();
  // #64: unload the optional reranker on the same idle lifecycle as the embedder.
  const { maybeUnloadReranker } = await import("./reranker.js");
  setInterval(() => { maybeUnloadReranker().catch(() => {}); }, 30_000).unref?.();
}

main().catch((err) => {
  console.error(`[app] startup failed: ${err.message}`);
  process.exit(1);
});