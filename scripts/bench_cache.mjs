#!/usr/bin/env node
/**
 * Cache benchmark: measure the VERIFIER, not the model.
 *
 *   node scripts/bench_cache.mjs [--json out.json]
 *
 * The project's central safety claim is that the verifier prevents wrong
 * answers being served. This harness drives the real verifier
 * (verifyCandidateCore) on a labelled set and reports recall/FPR at each
 * provenance-dependent threshold, plus FP rate as a function of corpus size N.
 */

import { retrieve } from "../src/knowledge.js";
import { verifyCandidateCore } from "../src/cache.js";
import config from "../src/config.js";

// (query, cached question, should hit)
const CASES = [
  // --- should hit: rewordings of the same question -----------------------
  ["How do I enable versioning on an S3 bucket?", "How do I turn on versioning for an S3 bucket?", true],
  ["What is Amazon EC2?", "What are virtual machines?", true],
  ["What are virtual machines?", "What is EC2?", true],
  ["EC2", "What is EC2?", true],
  ["What is the difference between an IAM role and an IAM user?", "How does an IAM role differ from an IAM user?", true],
  ["How do security groups differ from network ACLs?", "What's the difference between a security group and a network ACL?", true],
  ["How do I configure a lifecycle policy that transitions objects to Glacier?", "How do I set up an S3 lifecycle rule to archive old objects to Glacier?", true],
  ["What's the difference between S3 Standard and S3 Glacier storage?", "How do S3 Standard and S3 Glacier differ in storage cost?", true],
  ["How do I run a Lambda function on a schedule?", "What is the way to trigger a Lambda function on a timer?", true],
  ["What is the shared responsibility model?", "How do AWS and the customer divide security duties?", true],
  ["What are S3 storage classes?", "Which storage classes does S3 offer?", true],
  ["How do I price an EC2 instance?", "What does an EC2 instance cost per hour?", true],
  ["What is a VPC?", "Explain a Virtual Private Cloud.", true],
  ["How do I create an IAM role?", "What are the steps to make an IAM role?", true],
  ["Tell me about DynamoDB", "What is DynamoDB?", true],
  ["Explain CloudWatch metrics", "What are CloudWatch metrics?", true],
  ["How do I use a NAT gateway?", "What does a NAT gateway do?", true],
  ["What is a security group?", "Explain the security group concept.", true],
  ["Describe RDS backups", "How do automated backups work in RDS?", true],
  ["What is an AMI?", "Explain Amazon Machine Images.", true],

  // --- must NOT hit: a different question, often in the same domain ------
  ["redis aws", "What is AWS?", false],
  ["kubernetes vs docker", "What is a container image?", false],
  ["How do I price an EC2 spot instance?", "What is an EC2 instance?", false],
  ["How do security groups work?", "What is EC2?", false],
  ["What is AWS?", "What are virtual machines?", false],
  ["What was the AWS outage on 5 December 2021?", "What is AWS?", false],
  ["Who wrote Hamlet?", "What is Amazon Web Services?", false],
  ["What is the boiling point of water?", "What is S3?", false],
  ["Tell me about diamonds and jewelry", "What is IAM?", false],
  ["How many words are in this sentence?", "What is RDS?", false],
  ["How do I enable MFA?", "What is S3 versioning?", false],
  ["What is CloudFront?", "What is DynamoDB?", false],
  ["How do I configure a route table?", "What is a security group?", false],
  ["Explain Lambda layers", "What is a VPC subnet?", false],
  ["What is the capital of Australia?", "What is AWS?", false],
  ["Solve for x: 2x + 6 = 10", "What is EC2 pricing?", false],
  ["What is a network ACL?", "What is S3 Glacier?", false],
  ["How do I create a read replica?", "What is an IAM policy?", false],
  ["What is 17 times 23?", "What is CloudWatch?", false],
  ["Explain photosynthesis", "What is Amazon EC2?", false],
];

const wilson = (k, n, z = 1.96) => {
  if (!n) return [0, 1];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const half = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(c - half) / d, (c + half) / d];
};

const ORIGINS = ["curated", "deterministic_template", "model"];
const CACHED_CHUNKS = new Map();
async function cachedChunks(text) {
  if (CACHED_CHUNKS.has(text)) return CACHED_CHUNKS.get(text);
  const chunks = await retrieve(text, 3).catch(() => []);
  const ids = chunks.map((c) => c.id);
  CACHED_CHUNKS.set(text, ids);
  return ids;
}

async function decide(query, cachedQuestion, origin, candidateCount) {
  const chunks = await retrieve(query, 3);
  const chunkIds = chunks.map((c) => c.id);
  const chunkText = chunks.map((c) => `${c.title} ${c.text}`).join(" ");
  const ctx = {
    scope: "bench-scope",
    symbolFp: "",
    minReviewStatus: "approved",
    policy: null,
    queryText: query,
    chunkIds,
    chunkText,
  };

  // Fixed candidate count N: the intended cached entry plus distractors from
  // the rest of the corpus. topK stays fixed at 3; N is corpus size.
  const others = CASES.map((c) => c[1]).filter((c) => c !== cachedQuestion);
  const candidateQuestions = [cachedQuestion, ...others].slice(0, Math.max(1, candidateCount));

  for (const cached of candidateQuestions) {
    const candChunks = await cachedChunks(cached);
    const candFp = {
      scope: "bench-scope",
      prompt: cached,
      response_json: JSON.stringify({
        choices: [{ message: { content: "" } }],
      }),
      chunk_ids: candChunks.join(","),
      generation_method: origin,
      review_status: "approved",
      params_json: "{}",
      actual_answer: "",
      symbol_fp: "",
    };
    const candidate = { scope: "bench-scope", fingerprint: `bench:${cached}` };
    const verdict = await verifyCandidateCore(candidate, candFp, ctx);
    if (verdict.ok) return true;
  }
  return false;
}

async function runOrigin(origin, n) {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (const [query, cached, shouldHit] of CASES) {
    const hit = await decide(query, cached, origin, n);
    if (hit && shouldHit) tp++;
    else if (hit && !shouldHit) fp++;
    else if (!hit && !shouldHit) tn++;
    else fn++;
  }
  const recall = (tp + fn) ? tp / (tp + fn) : 0;
  const fpr = (fp + tn) ? fp / (fp + tn) : 0;
  const [rl, rh] = wilson(tp, tp + fn);
  const [fl, fh] = wilson(fp, fp + tn);
  return { origin, n, tp, fp, tn, fn, recall, fpr, rl, rh, fl, fh };
}

const N = 20;
console.log(`Cache verifier benchmark — ${CASES.length} labelled pairs, fixed topK=3`);
console.log("=".repeat(70));

const originResults = [];
for (const origin of ORIGINS) {
  const r = await runOrigin(origin, 1);
  originResults.push(r);
  console.log(`${origin.padEnd(22)} recall ${ (r.recall * 100).toFixed(1)}% (${r.tp}/${r.tp + r.fn})  FPR ${(r.fpr * 100).toFixed(1)}% (${r.fp}/${r.fp + r.tn})  95% CI recall ${(r.rl * 100).toFixed(1)}-${(r.rh * 100).toFixed(1)} FPR ${(r.fl * 100).toFixed(1)}-${(r.fh * 100).toFixed(1)}`);
}

const modelResult = originResults.find((r) => r.origin === "model");
console.log(`\nHeadline (model origin, threshold 0.85): recall ${(modelResult.recall * 100).toFixed(1)}%, FPR ${(modelResult.fpr * 100).toFixed(1)}%`);

console.log(`\nCorpus-size scaling (model origin, fixed topK=3):`);
const scaling = [];
for (const n of [1, 5, 10, 20, 40]) {
  const r = await runOrigin("model", n);
  scaling.push(r);
  console.log(`  N=${String(n).padStart(2)}  recall ${(r.recall * 100).toFixed(1)}%  FPR ${(r.fpr * 100).toFixed(1)}%  (TP=${r.tp} FP=${r.fp} TN=${r.tn} FN=${r.fn})`);
}

const jsonPath = process.argv.find((a) => a.startsWith("--json="))?.split("=")[1];
if (jsonPath) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(jsonPath, JSON.stringify({ originResults, scaling }, null, 2));
}

const targetFpr = Number(config.targetFpr ?? 0.01);
process.exit(modelResult.fpr <= targetFpr && modelResult.recall >= 0.8 ? 0 : 1);
