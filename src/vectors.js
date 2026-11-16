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

let client = null;
let connecting = null;

export async function redis() {
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

export function isUp() { return Boolean(client?.isOpen); }

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
  const c = await redis(); // establishes the connection first
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
  const c = await redis();
  if (!chunks?.length) return [];
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
  const c = await redis();
  return c.del(`${config.redisKeyPrefix}:${key}`);
}

export async function purgeIndex() {
  const c = await redis();
  const keys = await c.keys(`${config.redisKeyPrefix}:*`);
  if (keys.length) await c.del(keys);
  return keys.length;
}

export async function vectorCount() {
  try {
    const c = await redis();
    const { total } = parseDocs(await c.sendCommand([
      "FT.SEARCH", config.vectorIndex, "*", "LIMIT", "0", "0", "DIALECT", "2",
    ]));
    return total;
  } catch {
    return 0;
  }
}