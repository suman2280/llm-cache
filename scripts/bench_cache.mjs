#!/usr/bin/env node
/**
 * Cache benchmark: measure the VERIFIER, not the model.
 *
 *   node scripts/bench_cache.mjs [--json out.json]
 *
 * The project's central safety claim is that the verifier prevents wrong
 * answers being served. Until now that rested on 10-14 labelled pairs, which
 * cannot bound a false-positive rate. This harness exercises the same
 * accept/reject rule on a larger labelled set and reports:
 *
 *   recall   of requests that SHOULD hit, what fraction did
 *   FPR      of requests that must NOT hit, what fraction did
 *   Wilson 95% confidence intervals for both
 *   scaling how the decision changes with candidate corpus size
 *
 * No model or Redis needed: it exercises retrieval + coverageVerdict, which
 * are the two components that make the accept/reject decision.
 */

import { retrieve } from "../src/knowledge.js";
import { coverageVerdict } from "../src/lexicon.js";

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

async function decide(query, cachedQuestion, topK = 3) {
  const chunks = await retrieve(query, topK);
  const chunkIds = chunks.map((c) => c.id);
  const chunkText = chunks.map((c) => `${c.title} ${c.text}`).join(" ");
  const cachedChunks = (await retrieve(cachedQuestion, topK)).map((c) => c.id);
  const overlap = Boolean(chunkIds[0] && cachedChunks[0] === chunkIds[0]);
  return coverageVerdict(query, cachedQuestion, "", overlap, 0.75, chunkText);
}

const TOPK = Number(process.argv.find((a) => a.startsWith("--topk="))?.split("=")[1] || 3);
console.log(`Cache verifier benchmark — ${CASES.length} labelled pairs, topK=${TOPK}`);
console.log("=".repeat(70));

let tp = 0, fp = 0, tn = 0, fn = 0;
for (const [query, cached, shouldHit] of CASES) {
  const v = await decide(query, cached, TOPK);
  if (v.ok && shouldHit) tp++;
  else if (v.ok && !shouldHit) fp++;
  else if (!v.ok && !shouldHit) tn++;
  else fn++;
}

const recall = tp / (tp + fn);
const fpr = fp / (fp + tn);
const [rl, rh] = wilson(tp, tp + fn);
const [fl, fh] = wilson(fp, fp + tn);
console.log(`recall (hits among should-hit) : ${tp}/${tp + fn} = ${(recall * 100).toFixed(1)}%  95% CI ${(rl * 100).toFixed(1)}-${(rh * 100).toFixed(1)}%`);
console.log(`FPR    (hits among must-not)  : ${fp}/${fp + tn} = ${(fpr * 100).toFixed(1)}%  95% CI ${(fl * 100).toFixed(1)}-${(fh * 100).toFixed(1)}%`);
console.log(`confusion: TP=${tp} FP=${fp} TN=${tn} FN=${fn}`);
if (fp) {
  console.log("\nfalse positives:");
  for (const [q, c, want] of CASES) {
    if (!want) {
      const v = await decide(q, c, TOPK);
      if (v.ok) console.log(`  ${q}  <-  ${c}`);
    }
  }
}

console.log(`\nCorpus-size scaling (same pairs, varying candidate count):`);
for (const k of [1, 3, 5, 10]) {
  let t = 0, f = 0;
  for (const [q, c, want] of CASES) {
    const v = await decide(q, c, k);
    if (v.ok && want) t++;
    if (v.ok && !want) f++;
  }
  console.log(`  topK=${String(k).padStart(2)}  recall ${(100 * t / 20).toFixed(1)}%  FPR ${(100 * f / 20).toFixed(1)}%`);
}

process.exit(fp === 0 && recall >= 0.8 ? 0 : 1);
