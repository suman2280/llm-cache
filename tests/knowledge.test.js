/**
 * Tests for the grounding layer.
 *
 *   node --test tests/
 *
 * The model card credits the fine-tune with "grounded, accurate responses",
 * but attributes that to a FAISS RAG layer over scraped AWS documentation --
 * which is not part of the checkpoint. Without grounding the model answers
 * from parametric memory:
 *
 *   "What are virtual machines?" -> a definition of virtualization with no
 *   mention of EC2 at all.
 *
 * So grounding is rebuilt from the knowledge base that ships in the repo.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  knowledgeBase, retrieve, renderContext, buildSystemPrompt, groundRequest,
  PREFILL, assembleAnswer,
} from "../src/knowledge.js";

test("the knowledge base is well formed", () => {
  const kb = knowledgeBase();
  assert.ok(kb.length >= 30, `expected a substantial knowledge base, got ${kb.length} chunks`);
  const ids = new Set();
  for (const c of kb) {
    assert.ok(c.id, "every chunk needs an id");
    assert.ok(!ids.has(c.id), `duplicate chunk id: ${c.id}`);
    ids.add(c.id);
    assert.ok(c.topic, `${c.id} needs a topic`);
    assert.ok(c.title, `${c.id} needs a title`);
    assert.ok(c.text, `${c.id} needs text`);
    assert.ok(c.source, `${c.id} needs a source`);
    assert.ok(c.text.length > 200, `${c.id} looks too short to be useful`);
  }
});

test("the knowledge base covers the demo topics", () => {
  const topics = new Set(knowledgeBase().map((c) => c.topic));
  for (const t of ["aws-overview", "ec2", "s3", "iam", "vpc", "lambda", "cloudwatch", "governance"]) {
    assert.ok(topics.has(t), `the knowledge base should cover "${t}"`);
  }
});

test("retrieval finds the right chunk for a question", async () => {
  const cases = [
    ["How do I enable versioning on an S3 bucket?", "s3-versioning"],
    ["What's the difference between an IAM role and an IAM user?", "iam-roles"],
    ["How do I run a Lambda function on a schedule?", "lambda-triggers"],
    ["How do security groups differ from network ACLs?", "vpc-security-groups"],
    ["What is the difference between a spot instance and an on-demand instance?", "ec2-purchase-options"],
    ["What is the default service quota?", "quotas-limits"],
    ["How do I configure an S3 lifecycle rule to archive old objects to Glacier?", "s3-lifecycle"],
    ["What is the shared responsibility model?", "aws-shared-responsibility"],
  ];
  for (const [q, id] of cases) {
    const chunks = await retrieve(q, 3);
    assert.ok(chunks.length > 0, `no chunks for "${q}"`);
    assert.ok(chunks.some((c) => c.id === id),
      `"${q}" should retrieve the "${id}" chunk, got [${chunks.map((c) => c.id).join(", ")}]`);
  }
});

test("retrieval returns the chunks in descending relevance", async () => {
  const chunks = await retrieve("How do I configure an S3 lifecycle rule to archive old objects to Glacier?", 4);
  assert.ok(chunks.length >= 1);
  for (let i = 1; i < chunks.length; i++) {
    assert.ok(chunks[i - 1].score >= chunks[i].score, "chunks must be ordered by score");
  }
});

test("a canonical question retrieves ONE chunk, not a grab-bag", async () => {
  // Without the relative margin, "aws" pulled in the overview, RDS *and* the
  // troubleshooting chunk, and the answer came back about RDS and billing
  // rather than about AWS.
  const chunks = await retrieve("aws", 3);
  assert.equal(chunks.length, 1, `expected one canonical chunk, got [${chunks.map((c) => c.id).join(", ")}]`);
  assert.equal(chunks[0].id, "aws-overview");
});

test("a genuine tie retrieves more than one chunk", async () => {
  // "redis aws" is a near-tie between the overview and the encryption chunk,
  // and both are needed for a correct answer.
  const chunks = await retrieve("redis aws", 3);
  assert.ok(chunks.length >= 2, `expected at least two chunks, got [${chunks.map((c) => c.id).join(", ")}]`);
  assert.equal(chunks[0].id, "aws-overview");
});

test("the margin is configurable", async () => {
  const tight = await retrieve("How do security groups differ from network ACLs?", 4, { margin: 0.001 });
  assert.equal(tight.length, 1, "a zero margin keeps only the best chunk");
  const loose = await retrieve("How do security groups differ from network ACLs?", 4, { margin: 0.5 });
  assert.ok(loose.length > 1, "a wide margin keeps more");
});

test("the context is rendered with its source", async () => {
  const chunks = await retrieve("What are virtual machines?", 2);
  const rendered = renderContext(chunks);
  assert.match(rendered, /Reference material/);
  assert.match(rendered, /source:/);
  for (const c of chunks) assert.ok(rendered.includes(c.title));
});

test("the system prompt carries the domain and the shape of the answer", () => {
  const p = buildSystemPrompt("You are an expert AWS cloud assistant.", [], {
    description: "Amazon Web Services",
  });
  assert.match(p, /expert AWS cloud assistant/);
  assert.match(p, /Amazon Web Services/);
  assert.match(p, /bullet/i);
  assert.match(p, /watch out for/i);
});

test("the shape instruction comes BEFORE the reference material", () => {
  // With the instruction after the reference material, the model copies the
  // instruction lines into the answer as bullet points -- measured, a 7B will
  // emit "Three to five bullet points with the specific facts: ..." as one of
  // its own bullets.
  const chunks = [{ id: "x", topic: "s3", title: "S3 versioning", source: "AWS Docs", text: "Enable versioning in Properties." }];
  const p = buildSystemPrompt("Base.", chunks, { description: "Amazon Web Services" });
  const shapeAt = p.search(/bullet/i);
  const contextAt = p.search(/Reference material/i);
  assert.ok(shapeAt >= 0 && contextAt >= 0);
  assert.ok(shapeAt < contextAt, "the shape instruction must precede the reference material");
});

test("the prefill assembles a clean answer", () => {
  assert.match(PREFILL, /Key points/);
  // the model repeats the heading when the turn starts with it
  const assembled = assembleAnswer(PREFILL, "Key points:\n- one\n- two\n");
  assert.equal(assembled, "Key points:\n- one\n- two");
  // a continuation that does not repeat it is left alone
  assert.equal(assembleAnswer(PREFILL, "- one\n- two\n"), "Key points:\n- one\n- two");
});

test("grounding folds into the system message and leaves the rest alone", () => {
  const body = {
    model: "m",
    messages: [
      { role: "system", content: "You are terse." },
      { role: "user", content: "How do I enable versioning?" },
    ],
  };
  const chunks = [{ id: "x", topic: "s3", title: "S3 versioning", source: "AWS Docs", text: "Enable versioning in Properties." }];
  const out = groundRequest(body, chunks, { description: "Amazon Web Services" });

  assert.equal(out.messages.length, 2);
  assert.match(out.messages[0].content, /You are terse\./);
  assert.match(out.messages[0].content, /S3 versioning/);
  assert.match(out.messages[0].content, /Amazon Web Services/);
  // the user's message is untouched
  assert.deepEqual(out.messages[1], body.messages[1]);
  // the ORIGINAL body is not mutated
  assert.equal(body.messages[0].content, "You are terse.");
});

test("a request with no system message gets one", () => {
  const body = { model: "m", messages: [{ role: "user", content: "hi" }] };
  const out = groundRequest(body, [], null);
  assert.equal(out.messages.length, 2);
  assert.equal(out.messages[0].role, "system");
  assert.equal(out.messages[1].content, "hi");
});
