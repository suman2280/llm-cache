/**
 * Grounding: retrieve reference material and put it in the prompt.
 *
 * The model card says the fine-tune gives "grounded, accurate responses" --
 * but it attributes that to a RAG layer (FAISS over 211 chunks scraped from 53
 * AWS documentation pages) that is NOT part of the checkpoint. Without it the
 * model answers from parametric memory, and what it produces is generic:
 *
 *   "What are virtual machines?"
 *     -> "Virtual machines (VMs) are computer systems that run on a physical
 *         server using virtualization technology."      (no mention of EC2)
 *
 * So grounding is rebuilt here, from a knowledge base that ships with the
 * repo (knowledge/aws-knowledge.json -- curated, citable, offline). The same
 * MiniLM embedder that serves the semantic cache serves the retrieval, so
 * there is no second model and no second toolchain.
 *
 * Retrieved chunks go into the system prompt as reference material, with
 * their source, and the answer is asked to use them. That is what makes an
 * answer specific ("EC2 instances live in exactly one Availability Zone")
 * rather than generic, and it is what makes it long enough to be useful.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { embed } from "./embedder.js";

const HERE = dirname(fileURLToPath(import.meta.url));

let _kb = null;
let _vectors = null;

export function knowledgeBase() {
  if (_kb) return _kb;
  const path = join(HERE, "..", "knowledge", "aws-knowledge.json");
  _kb = JSON.parse(readFileSync(path, "utf8"));
  return _kb;
}

/** Embed every chunk once, lazily. */
async function vectors() {
  if (_vectors) return _vectors;
  const kb = knowledgeBase();
  _vectors = [];
  for (const c of kb) {
    _vectors.push(await embed(`${c.title}\n${c.text}`));
  }
  return _vectors;
}

/**
 * Retrieve the most relevant chunks for a query.
 *
 * `margin` is a RELATIVE cutoff: only chunks within `margin` of the best
 * score are kept. Without it, a broad question pulls in several unrelated
 * chunks and the model writes a grab-bag -- "aws" retrieved the overview, RDS
 * *and* the troubleshooting chunk, and the answer came back about RDS and
 * billing rather than about AWS.
 *
 * Measured spreads (distance below the top chunk):
 *
 *   "aws"                                    0.078  0.118   -> one chunk
 *   "What is AWS?"                           0.076  0.134   -> one chunk
 *   "How do I enable versioning on S3?"      0.124  0.161   -> one chunk
 *   "How do security groups differ from NACLs?" 0.117        -> one chunk
 *   "What is the shared responsibility model?"  0.278        -> one chunk
 *   "redis aws"                             0.017  0.093   -> two chunks (a tie)
 *
 * A margin of 0.05 separates the two groups cleanly.
 *
 * @returns {Promise<Array<{id,topic,title,source,text,score}>>}
 */
export async function retrieve(query, topK = 3, { margin = 0.05 } = {}) {
  const kb = knowledgeBase();
  if (!kb.length) return [];
  const vecs = await vectors();
  const q = await embed(query);
  const scored = [];
  for (let i = 0; i < kb.length; i++) {
    let dot = 0;
    for (let j = 0; j < q.length; j++) dot += q[j] * vecs[i][j];
    scored.push({ ...kb[i], score: Number(dot.toFixed(4)) });
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored[0]?.score ?? 0;
  const kept = scored.filter((c) => top - c.score <= margin);
  return kept.slice(0, topK);
}

/**
 * Render retrieved chunks as reference material for the system prompt.
 */
export function renderContext(chunks) {
  if (!chunks?.length) return "";
  const body = chunks
    .map((c, i) => `[${i + 1}] ${c.title}\n${c.text}\n(source: ${c.source})`)
    .join("\n\n");
  return `\n\nReference material -- use these facts in your answer, and prefer their\nspecifics over general knowledge:\n\n${body}\n`;
}

/**
 * The assistant-turn prefill.
 *
 * Instructions alone do not make this 7B write a longer answer: asked to
 * "write at least 200 words" or to use a bullet shape, it ignored both and
 * produced a tight paragraph (measured: 65 tokens for a question that deserves
 * 200). Its prior for a definitional question is prose, and prose it produces.
 *
 * Prefilling the assistant turn beats instructing it. The turn is started at
 * "Key points:" and the model continues from there, so it cannot choose to
 * stop after one sentence. Measured on "What are virtual machines?":
 *
 *   no prefill, instruction to use bullets   ->  65 tokens, prose, no bullets
 *   no prefill, "write at least 200 words"   ->  65 tokens, prose, ignored
 *   prefill "- "                            ->  48 tokens, one bullet
 *   prefill "Key points:\n"                 -> 236 tokens, a clean bullet list
 *
 * llama.cpp exposes this as `continue_final_message` with
 * `add_generation_prompt: false`; setting both flags is an error.
 */
export const PREFILL = "Key points:\n";

/**
 * Fold the prefill back into the answer and remove the heading the model
 * repeats. With the prefill "Key points:\n" the model continues with
 * "Key points:\n- ...", so the heading appears twice.
 */
export function assembleAnswer(prefill, continuation) {
  let text = `${prefill}${continuation ?? ""}`;
  // collapse a repeated leading heading
  text = text.replace(/^(Key points:)\s*\n\s*\1\s*\n/i, "$1\n");
  return text.trim();
}

/**
 * The system prompt for the authoring model. It carries the domain, the
 * grounding, and the shape of the answer we want.
 *
 * ORDER MATTERS. The shape instruction comes BEFORE the reference material.
 * With it after, the model copies the instruction lines into the answer as
 * bullet points -- measured, a 7B will literally emit "Three to five bullet
 * points with the specific facts: the AWS service and resource names..." as
 * one of its bullets. With the instruction first, the reference material reads
 * as the content and the shape is followed rather than quoted.
 */
export function buildSystemPrompt(base, chunks, domain) {
  const domainLine = domain?.description
    ? `You answer only about ${domain.description}. If a question is outside that domain, say so plainly.`
    : "";
  const shape =
    "Write the answer as one direct opening sentence, then three to five short bullet\n" +
    "points of specific facts (the AWS service and resource names, the console path or\n" +
    "API action, the limits and defaults, and the caveats), and finish with a single\n" +
    "sentence on what to watch out for. Be specific and complete rather than brief.";
  return `${base || "You are an AWS enterprise assistant."} ${domainLine}\n\n${shape}${renderContext(chunks)}`;
}

/**
 * Return a copy of the request with the grounding folded into the system
 * message. The ORIGINAL messages stay the cache key -- the grounding is an
 * inference-time detail and must not change what the cache is keyed on.
 */
export function groundRequest(body, chunks, domain) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const systemIdx = messages.findIndex((m) => m?.role === "system");
  const grounded = buildSystemPrompt(
    systemIdx >= 0 ? messages[systemIdx].content : null, chunks, domain,
  );
  const out = messages.map((m) => ({ ...m }));
  if (systemIdx >= 0) out[systemIdx] = { ...out[systemIdx], content: grounded };
  else out.unshift({ role: "system", content: grounded });
  return { ...body, messages: out };
}
