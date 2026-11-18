/**
 * Redis vector index for the semantic tier.
 *
 * Redis 8 (Open Source) ships vector search, so redis-stack is not needed.
 * Query shape (dialect facts verified against redis:8 in the previous build,
 * and still holding):
 *   - VECTOR_RANGE needs a LITERAL radius and DIALECT 2 (params are not
 *     accepted inside the range brackets)
 *   - TAG terms cannot contain PARAMS bindings; values are inlined and
 *     backslash-escaped
 *   - the query vector itself IS passed as a binary param
 *
 * The query is pre-filtered by scope before the vector search runs, so a
 * SET-07 learning object can never be a candidate for SET-08's request.
 */

import { createClient } from "redis";
import config from "./config.js";
import { getStore as db } from "./store.js";
import { embedderInfo } from "./embedder.js";

/**
 * #67: detect an embedder/index mismatch on startup and fail loudly instead
 * of writing vectors of the wrong width or mixing two models' vectors.
 */
export function checkIndexIdentity() {
  const info = embedderInfo();
  const store = db();
  const storedDim = store.getMeta("vector_index_dim");
  const storedModel = store.getMeta("vector_index_model");
  if (!storedDim && !storedModel) { recordIndexIdentity(); return { ok: true, fresh: true, model: info.id, dim: info.dim }; }
  if (storedDim && Number(storedDim) !== info.dim) {
    throw new Error(
      `Vector index dimension mismatch: index was built with ${storedDim}-dim vectors ` +
      `but EMBEDDER_MODEL '${info.id}' / VECTOR_DIM=${info.dim}. Set VECTOR_DIM=${storedDim} ` +
      `or run node scripts/reindex_vectors.mjs to rebuild the index for the new model.`
    );
  }
  if (storedModel && storedModel !== info.id) {
    throw new Error(
      `Embedder model changed from '${storedModel}' to '${info.id}'. Run ` +
      `node scripts/reindex_vectors.mjs before serving, or set EMBEDDER_MODEL='${storedModel}'.`
    );
  }
  return { ok: true, fresh: false, model: info.id, dim: info.dim };
}

export function recordIndexIdentity() {
  const info = embedderInfo();
  db().setMeta("vector_index_dim", String(info.dim));
  db().setMeta("vector_index_model", info.id);
}

let client = null;
let connecting = null;
let _memory = null; // Map<key, {fields, vec}> for in-process tests

/** Test seam: use an in-memory vector store instead of Redis. */
export function useMemoryVectors(on = true) {
  _memory = on ? new Map() : null;
  client = null;
  connecting = null;
}

export async function redis() {
  if (_memory) return null;
  if (client?.isOpen) return client;
  if (connecting) return connecting;
  connecting = (async () => {
    const c = createClient({ url: config.redisUrl });
    c.on("error", (e) => console.warn("[redis] error:", e.message));
    await c.connect();
    client = c;
    await ensureIndex();
    return c;
  })();
  return connecting;
}

export function isUp() { return Boolean(client?.isOpen) || Boolean(_memory); }

const TAG_SPECIAL = new Set(",.<>{}[]\"':;!@#$%^&()-=~| \\");

function escapeTag(value) {
  return String(value).split("").map((c) => (TAG_SPECIAL.has(c) ? `\\${c}` : c)).join("");
}

async function indexExists(c) {
  try {
    const names = await c.sendCommand(["FT._LIST"]);
    return names.some((n) => (typeof n === "string" ? n : String(n)) === config.vectorIndex);
  } catch {
    return false;
  }
}

export async function ensureIndex() {
  if (_memory) return;
  const c = await redis(); // establishes the connection first
  if (!c) return;
  if (await indexExists(c)) return;
  await c.sendCommand([
    "FT.CREATE", config.vectorIndex, "ON", "HASH", "PREFIX", "1", `${config.redisKeyPrefix}:`,
    "SCHEMA",
    "scope", "TAG",
    "model", "TAG",
    "fingerprint", "TAG",
    "generation_method", "TAG",
    "review_status", "TAG",
    "chunks", "TAG", // the KB chunks that grounded the entry
    "prompt", "TEXT",
    "embedding", "VECTOR", "FLAT", "6", "TYPE", "FLOAT32", "DIM", String(config.vectorDim),
    "DISTANCE_METRIC", "COSINE",
  ]);
  console.log(`[redis] created index ${config.vectorIndex} (dim ${config.vectorDim})`);
}

function cosineDistance(a, b) {
  if (!a || !b || a.length !== b.length) return 2;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  // normalized vectors: distance = 1 - cosine similarity
  return 1 - dot;
}

function memSearch(vec, { scope, model, chunks, radius, limit }) {
  const out = [];
  for (const [key, doc] of _memory.entries()) {
    const f = doc.fields || {};
    if (scope && f.scope !== scope) continue;
    if (model && f.model !== model) continue;
    if (chunks?.length) {
      const have = String(f.chunks || "").split(",").filter(Boolean);
      if (!chunks.some((c) => have.includes(String(c)))) continue;
    }
    const dist = cosineDistance(vec, doc.vec);
    if (dist > radius) continue;
    out.push({
      id: key,
      fingerprint: f.fingerprint, prompt: f.prompt, scope: f.scope,
      generation_method: f.generation_method, review_status: f.review_status,
      dist,
    });
  }
  out.sort((a, b) => a.dist - b.dist);
  return out.slice(0, limit);
}

function f32Bytes(vec) {
  return Buffer.from(Float32Array.from(vec).buffer);
}

function parseDocs(res) {
  if (!res) return [];
  if (typeof res === "object" && !Array.isArray(res)) {
    const total = res.totalResults ?? 0;
    const results = res.results ?? [];
    return { total, docs: results.map(flatten) };
  }
  // raw RESP2 array: [total, id, [f,v,...], id, [f,v,...]]
  if (Array.isArray(res) && res.length >= 1) {
    const total = Number(res[0]) || 0;
    const docs = [];
    for (let i = 1; i < res.length; i += 2) {
      const flat = res[i + 1];
      if (Array.isArray(flat)) docs.push(flatten({ id: res[i], extra_attributes: pairsToObject(flat) }));
    }
    return { total, docs };
  }
  return { total: 0, docs: [] };
}

function flatten(r) {
  const attrs = r?.extra_attributes ?? r?.values ?? {};
  const doc = {};
  if (Array.isArray(attrs)) {
    for (let i = 0; i < attrs.length; i += 2) doc[decode(attrs[i])] = decode(attrs[i + 1]);
  } else {
    for (const [k, v] of Object.entries(attrs)) doc[decode(k)] = decode(v);
  }
  if (r?.id) doc.id = decode(r.id);
  return doc;
}
const decode = (v) => (typeof v === "string" ? v : Buffer.isBuffer(v) ? v.toString("utf8") : String(v));
function pairsToObject(flat) { return flat; }

/**
 * Nearest documents INSIDE the scope, within the radius.
 * Returns up to `limit` docs with their cosine distance.
 */
export async function searchScope(vec, { scope, model, limit = 3 }) {
  if (_memory) return memSearch(vec, { scope, model, chunks: null, radius: Number(config.distanceThreshold), limit });
  const c = await redis();
  const filters = [`@scope:{${escapeTag(scope)}}`];
  if (model) filters.push(`@model:{${escapeTag(model)}}`);
  const query = `${filters.join(" ")} @embedding:[VECTOR_RANGE ${Number(config.distanceThreshold)} $v]=>{$YIELD_DISTANCE_AS: dist}`;
  const res = await c.sendCommand([
    "FT.SEARCH", config.vectorIndex, query,
    "PARAMS", "2", "v", f32Bytes(vec),
    "SORTBY", "dist", "ASC",
    "LIMIT", "0", String(limit),
    "RETURN", "6", "fingerprint", "prompt", "dist", "scope", "generation_method", "review_status",
    "DIALECT", "2",
  ]);
  const { docs } = parseDocs(res);
  return docs.map((d) => ({ ...d, dist: Number(d.dist) }));
}

/**
 * Documents grounded in the SAME knowledge-base chunk as the query.
 *
 * This is the precise equivalence signal. Two questions are the same when
 * they ground in the same curated chunk -- and the embedding distance is a
 * poor proxy for it: "What are virtual machines?" and "What is EC2?" are the
 * same question but sit 0.792 apart, because they share no vocabulary.
 *
 * The radius here is deliberately wide (cosine distance over normalised
 * vectors runs to 2.0): inside one chunk the distance is a RANKING, not a
 * filter. The verifier decides what is acceptable; this only decides what is
 * worth looking at.
 */
export async function searchByChunks(vec, { chunks, scope, model, limit = 5 }) {
  if (!chunks?.length) return [];
  if (_memory) return memSearch(vec, { scope, model, chunks, radius: 1.2, limit });
  const c = await redis();
  const filters = [`@chunks:{${chunks.map(escapeTag).join("|")}}`];
  if (scope) filters.push(`@scope:{${escapeTag(scope)}}`);
  if (model) filters.push(`@model:{${escapeTag(model)}}`);
  const query = `${filters.join(" ")} @embedding:[VECTOR_RANGE 1.2 $v]=>{$YIELD_DISTANCE_AS: dist}`;
  const res = await c.sendCommand([
    "FT.SEARCH", config.vectorIndex, query,
    "PARAMS", "2", "v", f32Bytes(vec),
    "SORTBY", "dist", "ASC",
    "LIMIT", "0", String(limit),
    "RETURN", "6", "fingerprint", "prompt", "dist", "scope", "generation_method", "review_status",
    "DIALECT", "2",
  ]);
  const { docs } = parseDocs(res);
  return docs.map((d) => ({ ...d, dist: Number(d.dist) }));
}

export async function indexDocument(key, fields, vec) {
  if (_memory) {
    const payload = { ...fields };
    if (Array.isArray(payload.chunks)) payload.chunks = payload.chunks.join(",");
    _memory.set(`${config.redisKeyPrefix}:${key}`, { fields: payload, vec: Array.from(vec) });
    return;
  }
  const c = await redis();
  const payload = { ...fields, embedding: f32Bytes(vec) };
  // the chunk list is a multi-value TAG: RediSearch indexes each value, so
  // "@chunks:{a|b}" finds a document grounded in either chunk
  if (Array.isArray(payload.chunks)) payload.chunks = payload.chunks.join(",");
  await c.sendCommand(["HSET", `${config.redisKeyPrefix}:${key}`, ...flattenArgs(payload)]);
}

function flattenArgs(obj) {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    // The vector MUST be written as raw binary: stringifying a Buffer corrupts
    // it (a 384-dim FLOAT32 vector came back as 1451 mangled bytes) and the
    // index then silently holds 0 documents.
    if (Buffer.isBuffer(v)) { out.push(k, v); continue; }
    out.push(k, typeof v === "string" ? v : String(v));
  }
  return out;
}

export async function deleteDocument(key) {
  if (_memory) { _memory.delete(`${config.redisKeyPrefix}:${key}`); return 1; }
  const c = await redis();
  return c.del(`${config.redisKeyPrefix}:${key}`);
}

export async function purgeIndex() {
  if (_memory) { const n = _memory.size; _memory.clear(); return n; }
  const c = await redis();
  const keys = await c.keys(`${config.redisKeyPrefix}:*`);
  if (keys.length) await c.del(keys);
  return keys.length;
}

export async function vectorCount() {
  if (_memory) return _memory.size;
  try {
    const c = await redis();
    if (!c) return 0;
    const { total } = parseDocs(await c.sendCommand([
      "FT.SEARCH", config.vectorIndex, "*", "LIMIT", "0", "0", "DIALECT", "2",
    ]));
    return total;
  } catch {
    return 0;
  }
}