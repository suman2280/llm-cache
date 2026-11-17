/**
 * Keying, scoping and fingerprinting.
 *
 * Three bugs from the previous build are designed out here:
 *
 *  1. The exact tier hashed only an 8-param allowlist, so `top_k`, `min_p`,
 *     `num_predict`, `repeat_penalty`, `n` and `logit_bias` all hashed
 *     identically and served the wrong answer. -> DENYLIST: hash everything
 *     except a small, explicit set of inert keys, and hash unknown params.
 *
 *  2. The semantic tier embedded ONLY the last user message, so two requests
 *     with different system prompts had embedding distance 0.0 and shared one
 *     cache document. -> the semantic text is the WHOLE conversation.
 *
 *  3. A raw prompt went into an HTTP header, which is latin-1 encoded, so any
 *     character above U+00FF (in: every maths symbol) raised
 *     UnicodeEncodeError and returned 500 on a cache hit. -> headers are
 *     ASCII-safe by construction.
 */

import { createHash } from "node:crypto";

/**
 * Request keys that cannot change the completion. Everything else -- including
 * keys we have never seen -- is hashed. Fails closed on new parameters.
 */
const INERT_KEYS = new Set([
  // transport / api housekeeping
  "stream", "stream_options", "metadata", "user", "request_id",
  // ollama/vllm server-side knobs that do not change the answer text
  "keep_alive",
]);

export function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Stable JSON: sorts keys so a reordered body hashes identically. */
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
}

/** The request body with inert keys removed. Everything else is answer-affecting. */
export function answerAffecting(body) {
  const out = {};
  for (const [k, v] of Object.entries(body ?? {})) {
    if (INERT_KEYS.has(k)) continue;
    if (v === undefined || v === null) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Exact-tier fingerprint: sha256 over model + messages + every answer-affecting
 * param. Byte-identical requests -> identical fingerprint.
 */
export const requestFingerprint = (body, scope = "") => sha256(canonical({
  // #11: scope is part of the identity. Identical text under two concepts
  // used to collide on one row and inherit the other's provenance.
  scope,
  model: body?.model,
  messages: body?.messages,
  params: answerAffecting(body),
}));

/** One Redis key per (model, scope, fingerprint). */
export const exactKey = (body, scope) => `${scope}:${requestFingerprint(body, scope)}`;

/**
 * The text the semantic tier embeds: the WHOLE conversation.
 *
 * The old build embedded only the last user message, which made the system
 * prompt -- the chapter, the asset type, the difficulty rubric, the output
 * schema, i.e. the entire meaning of the job -- invisible to the cache.
 */
export function semanticText(messages) {
  if (!Array.isArray(messages)) return "";
  return messages
    .map((m) => {
      const content = typeof m?.content === "string"
        ? m.content
        : Array.isArray(m?.content)
          ? m.content.filter((p) => p?.type === "text").map((p) => p.text).join("\n")
          : "";
      return `${(m?.role ?? "unknown").toUpperCase()}:\n${content}`;
    })
    .join("\n\n");
}

/** Last user message text (display / prompt preview only, never the key). */
export function lastUserText(messages) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    const c = typeof m.content === "string"
      ? m.content
      : Array.isArray(m.content)
        ? m.content.filter((p) => p?.type === "text").map((p) => p.text).join("\n")
        : "";
    if (c.trim()) return c;
  }
  return "";
}

// ---------------------------------------------------------------------------
// The content envelope -- the SOP's identity carried on every request.

/**
 * The envelope is the SOP's concept_id / asset_type / source_section /
 * difficulty / review_status, sent as a header. It is what makes the cache a
 * *content* cache rather than a keyword cache.
 *
 * I-0002 base64 JSON: accepts the compact wire form.
 */
const ENVELOPE_FIELDS = [
  "chapter_code", "concept_id", "asset_type", "source_section",
  "difficulty_level", "skill_type", "template_id", "review_status",
  "generation_method", "role",
];

/** `params` is an object (template parameters), not a string field. */
const OBJECT_FIELDS = ["params"];

export function parseEnvelope(raw) {
  if (!raw) return {};
  try {
    let json = raw;
    if (!/^\s*[{[]/.test(raw)) {
      json = Buffer.from(raw, "base64url").toString("utf8");
      if (json.startsWith("b:")) json = json.slice(2);
    }
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== "object") return {};
    const out = {};
    for (const f of [...ENVELOPE_FIELDS, ...OBJECT_FIELDS]) {
      if (parsed[f] === undefined || parsed[f] === null) continue;
      out[f] = OBJECT_FIELDS.includes(f) ? parsed[f] : String(parsed[f]);
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * The scope the semantic tier is allowed to search inside.
 *
 * Deliberately narrow: the old build searched the whole index by distance
 * alone, so SET-07's learning object could be served for SET-08's. Now the two
 * are in different scopes and the vector query is pre-filtered by it.
 *
 * Difficulty is banded (not exact) so "difficulty 2" may reuse "difficulty 3"
 * within a concept but never across concepts.
 */
export function scopeOf(envelope, samplingClass, tenant = "local") {
  const chapter = envelope.chapter_code || "_";
  const asset = envelope.asset_type || "chat";
  const concept = envelope.concept_id || "_";
  const band = difficultyBand(envelope.difficulty_level);
  // #33: a semantic cache is tenant-scoped by construction. The tenant is
  // server-side config, NEVER a client header, so one caller cannot read
  // another's partition by guessing a name.
  return sha256([tenant || "_", chapter, asset, concept, band,
    samplingClass || "_"].join("\u0000")).slice(0, 32);
}

/**
 * Coarse signing class for the sampling parameters that change the answer.
 *
 * Two requests with identical text and different sampling regimes can
 * legitimately produce different answers, so the semantic tier must not cross
 * that boundary. Exact values do NOT go in the scope -- only the class -- so
 * "temperature 0.3" and "temperature 0.4" may still share, while
 * "temperature 0.3 + top_k 1" may not reuse "temperature 0.3 + default".
 */
const SAMPLING_KEYS = [
  "temperature", "top_p", "top_k", "min_p", "seed", "stop",
  "frequency_penalty", "presence_penalty", "repeat_penalty", "mirostat",
  "mirostat_tau", "mirostat_eta", "max_tokens", "num_predict", "n",
  "logit_bias", "logprobs", "top_logprobs", "grammar", "dry_multiplier",
  "dry_base", "dry_allowed_length", "dry_penalty_last_n",
];

/**
 * Identity of the sampling regime for the SEMANTIC scope.
 *
 * #8: the old version only distinguished temperature=0 from the presence of
 * top_p/top_k/min_p. Requests with the same text but a different seed,
 * repeat_penalty or max_tokens landed in the same scope, so a cached answer
 * could be served for a materially different generation request.
 */
export function samplingClass(body) {
  const b = body ?? {};
  const base = Number(b.temperature ?? 0) === 0 ? "det" : "sample";
  const params = {};
  for (const k of SAMPLING_KEYS) {
    if (b[k] === undefined || b[k] === null) continue;
    // temperature 0 is the default; an explicit 0 must not create a distinct
    // scope from an omitted temperature.
    if (k === "temperature" && Number(b[k]) === 0) continue;
    params[k] = b[k];
  }
  return `${base}:${sha256(canonical(params)).slice(0, 12)}`;
}

export function difficultyBand(v) {
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) return "_";
  if (n <= 2) return "easy";
  if (n <= 4) return "medium";
  return "hard";
}

/**
 * Fingerprint of the tokens that change the MEANING of a prompt.
 *
 * A generic sentence embedder cannot tell `⊂` from `∪`, or `15%` from `25%`:
 * measured on the previous build, 10 of 11 maths prompt pairs needing different
 * answers landed inside the shipped 0.20 cosine radius. This is the cheap,
 * deterministic guard that runs BEFORE the expensive verifier: if the
 * meaning-bearing tokens differ, the two prompts are not interchangeable.
 *
 * Captured: digit runs (730 vs 160), non-ASCII glyphs (∈ vs ∉, ∪ vs ∩, ≤ vs ≥)
 * and structural/operator characters (= < > + - * / % ^ { } [ ] ( ) |).
 *
 * NOT captured: letters, whitespace, and sentence punctuation (. , ; : ? ! " ').
 * Punctuation must be excluded or a trailing "?" versus "." -- pure prose
 * punctuation -- would block a legitimate reuse, which is the opposite of what
 * this guard is for.
 */
const SENTENCE_PUNCT = new Set([".", ",", ";", ":", "?", "!", '"', "'"]);

export function symbolFingerprint(text) {
  if (!text) return "";
  const counts = new Map();
  const bump = (tok) => counts.set(tok, (counts.get(tok) || 0) + 1);

  // digit runs: "730" is one token, "1,2,3" is three
  for (const m of text.matchAll(/\d+(?:\.\d+)?/g)) bump(`n:${m[0]}`);

  for (const ch of text) {
    if (/\s/.test(ch)) continue;
    if (/[A-Za-z0-9]/.test(ch)) continue;
    if (SENTENCE_PUNCT.has(ch)) continue;
    bump(`s:${ch.codePointAt(0).toString(16)}`);
  }

  return [...counts.entries()].sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([t, n]) => `${t}:${n}`).join(",");
}

// ---------------------------------------------------------------------------
// Header safety (bug 3)

/**
 * ASCII-safe header value. Non-ASCII and control bytes are percent-encoded so
 * the framework never raises UnicodeEncodeError while building the response.
 *
 * The limit applies to the ENCODED length, because percent-encoding expands:
 * "…" is 1 character but 9 bytes of UTF-8, or "%E2%80%A6" after encoding.
 * The result is always decodable: each non-ASCII character becomes one
 * %XX per UTF-8 byte, and a literal "%" becomes %25.
 */
export function asciiHeaderValue(value, limit = 100) {
  if (value === undefined || value === null) return "";
  const s = String(value);
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0);
    let token;
    if (code >= 0x20 && code <= 0x7e) {
      token = ch === "%" ? "%25" : ch;
    } else {
      token = [...Buffer.from(ch, "utf8")]
        .map((b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`)
        .join("");
    }
    if (out.length + token.length > limit) {
      out += out.length + 3 <= limit ? "..." : "";
      break;
    }
    out += token;
  }
  return out;
}

export function encodeEnvelope(envelope) {
  if (!envelope || Object.keys(envelope).length === 0) return "";
  const clean = {};
  for (const f of [...ENVELOPE_FIELDS, ...OBJECT_FIELDS]) {
    if (envelope[f] !== undefined) clean[f] = envelope[f];
  }
  return Buffer.from(JSON.stringify(clean), "utf8").toString("base64url");
}