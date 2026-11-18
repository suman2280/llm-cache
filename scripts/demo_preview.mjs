#!/usr/bin/env node
/**
 * The preview: does the project let requests avoid the model?
 *
 *   node scripts/demo_preview.mjs [baseUrl]
 *
 * Walks the pipeline from the cache side:
 *
 *   1. deterministic   template + params -> CODE, no model, correct by construction
 *   2. exact           same fingerprint -> O(1), no model
 *   3. semantic        reworded prompt  -> embed + verify, no model
 *   4. miss            genuinely new    -> the model SPAWNS, exactly once
 *
 * Then it reads the model's own counters to prove the claim: the number of
 * model invocations across the whole run must be 1.
 */

const BASE = (process.argv[2] || "http://127.0.0.1:8000").replace(/\/$/, "");
const CHAPTER = "MATH-01-AWS";
const b64 = (o) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;

const env = (extra) => b64({ chapter_code: CHAPTER, ...extra });

async function post(path, body, headers = {}) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return {
    ok: res.ok, status: res.status, json, h: res.headers,
    detail: json?.detail,
  };
}

function show(label, r, extra = "") {
  const hdr = r.h.get("x-cache-status") ?? "-";
  const ms = r.h.get("x-cache-latency-ms") ?? "-";
  const color = hdr === "miss" ? red : green;
  console.log(`  ${bold(label.padEnd(22))} ${color(hdr.padEnd(16))} ${String(ms).padStart(8)} ms  ${dim(extra)}`);
}

async function modelState() {
  const res = await fetch(`${BASE}/healthz`);
  return res.ok ? (await res.json()).checks.model : null;
}

async function totals() {
  const res = await fetch(`${BASE}/stats`);
  return res.ok ? (await res.json()).totals : null;
}

async function main() {
  console.log(`\n${bold("llm-cache preview — can requests avoid the model?")}`);
  console.log(dim(`against ${BASE}\n${"=".repeat(78)}`));

  const before = await modelState();
  console.log(`\n${dim("state before the run:")}`);
  console.log(`  model: ${before?.state ?? "?"} (resident=${before?.resident}, spawns=${before?.spawns}, inferences=${before?.inferences})`);

  // ------------------------------------------------------------------ 1
  console.log(`\n${bold("1. deterministic tier — a template answered by CODE")}`);
  const tplParams = { instance_type: "m5.large", count: "4", hours: "730" };
  const r1 = await post("/v1/chat/completions", {
    model: "qwen2.5-7b-instruct",
    messages: [{ role: "user", content: "What is the monthly cost of running 4 m5.large instances for 730 hours per month at on-demand rates?" }],
    temperature: 0, max_tokens: 400,
  }, { "x-content-envelope": env({ template_id: "T-EC2-COST", params: tplParams, asset_type: "practice_question", concept_id: "AWS-04", difficulty_level: "2" }) });
  show("template T-EC2-COST", r1, r1.h.get("x-cache-policy") ?? "");
  console.log(`     ${dim("answer:")} ${r1.json?.choices?.[0]?.message?.content}`);

  // Same template, different parameters: near-identical prompt, different answer.
  const tplParams2 = { instance_type: "m5.large", count: "4", hours: "160" };
  const r2 = await post("/v1/chat/completions", {
    model: "qwen2.5-7b-instruct",
    messages: [{ role: "user", content: "What is the monthly cost of running 4 m5.large instances for 160 hours per month at on-demand rates?" }],
    temperature: 0, max_tokens: 400,
  }, { "x-content-envelope": env({ template_id: "T-EC2-COST", params: tplParams2, asset_type: "practice_question", concept_id: "AWS-04", difficulty_level: "2" }) });
  show("same template, 160h", r2, `differ from 730h by ONE number`);
  console.log(`     ${dim("answer:")} ${r2.json?.choices?.[0]?.message?.content}`);
  const correct = r2.json?.choices?.[0]?.message?.content?.includes("61.44");
  console.log(`     ${correct ? green("correct: $61.44, NOT the 730h answer") : red("WRONG ANSWER — see notes")}`);

  // ------------------------------------------------------------------ 2
  console.log(`\n${bold("2. exact tier — a byte-identical request")}`);
  const q = "How does S3 server-side encryption work?";
  const body = { model: "qwen2.5-7b-instruct", messages: [
    { role: "system", content: "You are an AWS enterprise assistant." },
    { role: "user", content: q }], temperature: 0.3, max_tokens: 250 };
  const e1 = await post("/v1/chat/completions", body, { "x-content-envelope": env({ concept_id: "AWS-06", asset_type: "learning_object", difficulty_level: "2" }) });
  show("first ask", e1);
  const e2 = await post("/v1/chat/completions", body, { "x-content-envelope": env({ concept_id: "AWS-06", asset_type: "learning_object", difficulty_level: "2" }) });
  show("identical re-send", e2);

  // a different answer-affecting param must NOT hit
  const e3 = await post("/v1/chat/completions", { ...body, top_k: 1 }, { "x-content-envelope": env({ concept_id: "AWS-06", asset_type: "learning_object", difficulty_level: "2" }) });
  show("with top_k=1", e3, "different param -> must not be a hit");

  // ------------------------------------------------------------------ 3
  console.log(`\n${bold("3. semantic tier — a rewording (the model is still stopped)")}`);
  const s1 = await post("/v1/chat/completions", { model: "qwen2.5-7b-instruct", messages: [
    { role: "system", content: "You are an AWS enterprise assistant." },
    { role: "user", content: "Explain how S3 server-side encryption works." }], temperature: 0.3, max_tokens: 250 },
    { "x-content-envelope": env({ concept_id: "AWS-06", asset_type: "learning_object", difficulty_level: "2" }) });
  show("rewording", s1, s1.h.get("x-cache-source-prompt") ? `from: "${decodeURIComponent(s1.h.get("x-cache-source-prompt"))}"` : "");

  // ------------------------------------------------------------------ 4
  console.log(`\n${bold("4. miss — the one request that genuinely needs the model")}`);
  const m1 = await post("/v1/chat/completions", { model: "qwen2.5-7b-instruct", messages: [
    { role: "system", content: "You are an AWS enterprise assistant." },
    { role: "user", content: "What are the durability and availability targets of S3 Standard storage class, and how do they differ from One Zone-IA?" }],
    temperature: 0.3, max_tokens: 200 },
    { "x-content-envelope": env({ concept_id: "AWS-06", asset_type: "learning_object", difficulty_level: "2" }) });
  show("genuinely new", m1);
  const m2 = await post("/v1/chat/completions", { model: "qwen2.5-7b-instruct", messages: [
    { role: "system", content: "You are an AWS enterprise assistant." },
    { role: "user", content: "What are the durability and availability targets of S3 Standard storage class, and how do they differ from One Zone-IA?" }],
    temperature: 0.3, max_tokens: 200 },
    { "x-content-envelope": env({ concept_id: "AWS-06", asset_type: "learning_object", difficulty_level: "2" }) });
  show("asked again", m2);

  // ------------------------------------------------------------------
  const after = await modelState();
  const t = await totals();
  console.log(`\n${"=".repeat(78)}`);
  console.log(`${bold("the claim")}`);
  console.log(`  model invocations for the whole run : ${bold(String(after?.inferences ?? "?"))}`);
  console.log(`  model spawns                       : ${after?.spawns}`);
  console.log(`  model state now                    : ${after?.state}${after?.resident ? "" : dim("  (gone)")}`);
  console.log(`  requests served                   : ${t?.requests}  (deterministic + exact + semantic hits: ${dim(`${(t?.exact_hits ?? 0) + (t?.semantic_hits ?? 0)}`)} misses: ${t?.misses})`);
  console.log(`  semantic hits rejected by verifier: ${t?.rejected_hits}`);

  const avoided = (t?.requests ?? 0) - (t?.misses ?? 0);
  const pct = t?.requests ? Math.round((avoided / t.requests) * 100) : 0;
  console.log(`  requests that never touched the model: ${bold(`${avoided} of ${t?.requests} (${pct}%)`)}`);

  console.log(`\n${dim("The model process can now be left to idle out (MODEL_IDLE_S),")}`);
  console.log(dim("after which the box serves everything above at Node-speed with no"));
  console.log(dim("4.6 GB model resident at all."));
  console.log();
}

main().catch((e) => { console.error(`\npreview failed: ${e.message}`); process.exit(1); });