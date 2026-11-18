#!/usr/bin/env node
/**
 * #67: reindex the vector store for the currently configured embedder.
 *
 *   node scripts/reindex_vectors.mjs
 *
 * Re-embeds every cache_entries.semantic_text with EMBEDDER_MODEL / VECTOR_DIM
 * and rebuilds the Redis index, WITHOUT touching SQLite provenance. Idempotent:
 * re-running simply rebuilds the same index. Reports progress and updates the
 * stored index identity so startup no longer flags a mismatch.
 */

import config from "../src/config.js";
import { getStore as db } from "../src/store.js";
import * as vectors from "../src/vectors.js";
import { embed, embedderInfo } from "../src/embedder.js";

const info = embedderInfo();
console.log(`Reindex: model=${info.id} provider=${info.provider} dim=${info.dim}`);

const rows = db().listEntries({ limit: 1_000_000 });
console.log(`Found ${rows.length} cached document(s).`);

const purged = await vectors.purgeIndex().catch((e) => { console.error("purge failed:", e.message); return 0; });
console.log(`Purged ${purged} vector document(s).`);

let built = 0;
let failed = 0;
for (const row of rows) {
  const text = row.semantic_text || row.prompt;
  let vec = null;
  try { vec = await embed(text); } catch (e) { failed += 1; console.error(`  embed failed for ${row.id}: ${e.message}`); }
  if (!vec) { failed += 1; continue; }
  try {
    await vectors.indexDocument(`e${row.id}`, {
      scope: row.scope, model: row.model, fingerprint: row.fingerprint,
      generation_method: row.generation_method, review_status: row.review_status,
      prompt: row.prompt, chunks: String(row.chunk_ids || "").split(",").filter(Boolean),
    }, vec);
    built += 1;
  } catch (e) { failed += 1; console.error(`  index failed for ${row.id}: ${e.message}`); }
  if (built && built % 50 === 0) console.log(`  ... ${built}/${rows.length}`);
}

vectors.recordIndexIdentity();
console.log(`Done: rebuilt=${built} failed=${failed} total=${rows.length}`);
db().close();
process.exit(failed ? 1 : 0);
