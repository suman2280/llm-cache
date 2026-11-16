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
 * Two rules, because a broad question pulls in several unrelated chunks and
 * the model writes a grab-bag -- "aws" retrieved the overview, RDS *and* the
 * troubleshooting chunk, and the answer came back about RDS and billing
 * rather than about AWS.
 *
 *  1. RELATIVE MARGIN -- a chunk joins the context if it is within `margin`
 *     of the best score. Measured spreads (distance below the top chunk):
 *
 *       "aws"                                       0.078  -> one chunk
 *       "What is AWS?"                              0.076  -> one chunk
 *       "How do I enable versioning on S3?"         0.124  -> one chunk
 *       "How do security groups differ from NACLs?" 0.117  -> one chunk
 *       "What is the shared responsibility model?"  0.278  -> one chunk
 *       "redis aws"                                0.017  -> two chunks (a tie)
 *
 *  2. SAME-TOPIC EXPANSION -- chunks from the TOP CHUNK'S TOPIC also join,
 *     up to `maxExtra` of them. A question about EC2 gets the other EC2
 *     chunks (instance types, pricing, auto scaling) as complementary detail;
 *     a question about S3 versioning gets the rest of the S3 material. This
 *     is what makes the answers substantial: "What are virtual machines?"
 *     goes from one chunk (111 tokens) to four (EC2 instances, instance types,
 *     pricing, auto scaling), and the answer can cover the instance, the type
 *     and the bill.
 *
 * @returns {Promise<Array<{id,topic,title,source,text,score}>>}
 */
export async function retrieve(query, topK = 3, { margin = 0.05, topicMargin = 0.25, maxExtra = 2 } = {}) {
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

  const top = scored[0];
  if (!top) return [];
  const kept = [top];
  let extra = 0;
  for (const c of scored.slice(1)) {
    if (kept.length >= topK) break;
    const gap = top.score - c.score;
    const byMargin = gap <= margin;
    const byTopic = c.topic === top.topic && gap <= topicMargin && extra < maxExtra;
    if (!byMargin && !byTopic) continue;
    kept.push(c);
    if (byTopic) extra += 1;
  }
  return kept;
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
export function buildSystemPrompt(base, chunks, domain, { closedBook = false } = {}) {
  const domainLine = domain?.description
    ? `You answer only about ${domain.description}. If a question is outside that domain, say so plainly.`
    : "";
  // The shape that measured best: six to nine bullets, each a COMPLETE
  // sentence carrying the specific detail. Compared on three queries:
  //
  //   "four to six bullet points, one fact per bullet"    118-207 tokens
  //   "six to nine bullet points"                          137-181 tokens
  //   "six to nine bullets, each a complete sentence"     146-381 tokens  <- this one
  //
  // Asking for more is only safe because the answer is checked against the
  // reference material: a small model asked for more detail than the material
  // supports invents it ("aws" with six to nine bullets produced a "t2.micro"
  // free-tier instance type that appears nowhere in the reference).
  const shape =
    "Write the answer as one direct opening sentence, then six to nine short bullet\n" +
    "points. Each bullet must be a complete sentence giving the specific detail --\n" +
    "the service and resource names, the console path or API action, the limits or\n" +
    "defaults, the cost or billing, the caveats, and the related services. Finish\n" +
    "with a single sentence on what to watch out for. Be specific and complete\n" +
    "rather than brief.";
  // The closed-book variant is used on the retry, when the first answer was not
  // grounded in the reference material.
  const grounding = closedBook
    ? "Answer from the reference material below and nothing else. Do not add facts that\n" +
      "are not in it. If the reference material does not cover part of the question, say\n" +
      "which part is missing.\n\n"
    : "";
  return `${base || "You are an AWS enterprise assistant."} ${domainLine}\n\n${grounding}${shape}${renderContext(chunks)}`;
}

/**
 * Return a copy of the request with the grounding folded into the system
 * message. The ORIGINAL messages stay the cache key -- the grounding is an
 * inference-time detail and must not change what the cache is keyed on.
 */
export function groundRequest(body, chunks, domain, opts = {}) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const systemIdx = messages.findIndex((m) => m?.role === "system");
  const grounded = buildSystemPrompt(
    systemIdx >= 0 ? messages[systemIdx].content : null, chunks, domain, opts,
  );
  const out = messages.map((m) => ({ ...m }));
  if (systemIdx >= 0) out[systemIdx] = { ...out[systemIdx], content: grounded };
  else out.unshift({ role: "system", content: grounded });
  return { ...body, messages: out };
}
