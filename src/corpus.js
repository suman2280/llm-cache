/**
 * The AWS-shaped demonstration corpus.
 *
 * Domain framing chosen: the pipeline is the SOP's seven steps; the content is
 * AWS, so every SOP gate (source grounding, verification, review, near-duplicate
 * rejection) maps 1:1 onto real assets. Swapping the corpus to JEE sets is a
 * data change, not a code change -- the cache never depends on the domain.
 *
 * Seeding puts the cache in a state where a chapter regeneration can be served
 * largely WITHOUT the model, which is the thing being demonstrated.
 */

import config from "./config.js";
import * as store from "./store.js";
import * as templates from "./templates.js";
import {
  requestFingerprint, scopeOf, semanticText, symbolFingerprint,
} from "./keying.js";

const CHAPTER = "MATH-01-AWS";

/** Learning objects (SOP step 3) minus the model: written here, not generated. */
const LEARNING_OBJECTS = [
  { concept_id: "AWS-01", object_type: "definition", title: "Amazon S3",
    content: "Amazon S3 is an object storage service that stores data as objects inside buckets, addressed by key.", source_section: "1.1" },
  { concept_id: "AWS-02", object_type: "definition", title: "Amazon EC2",
    content: "Amazon EC2 provides resizable virtual servers, called instances, in the cloud.", source_section: "1.2" },
  { concept_id: "AWS-03", object_type: "definition", title: "AWS Lambda",
    content: "AWS Lambda runs code in response to events without provisioning or managing servers.", source_section: "1.3" },
  { concept_id: "AWS-04", object_type: "definition", title: "EC2 pricing dimensions",
    content: "EC2 on-demand cost is billed per instance-hour, and the hourly price depends on the instance type.", source_section: "2.1" },
  { concept_id: "AWS-06", object_type: "definition", title: "S3 storage classes",
    content: "S3 storage classes differ in price per GB-month and in retrieval latency and cost.", source_section: "2.2" },
  { concept_id: "AWS-09", object_type: "definition", title: "Service quotas",
    content: "Service quotas are the default limits on how many of each resource you can create in an account or Region.", source_section: "3.1" },
  { concept_id: "AWS-11", object_type: "definition", title: "S3 vs DynamoDB",
    content: "S3 is object storage for large values addressed by key; DynamoDB is a NoSQL table service addressed by primary key.", source_section: "3.2" },
];

const MISCONCEPTIONS = [
  { concept_id: "AWS-04", misconception: "Stopping an EC2 instance stops all charges.",
    correct_understanding: "A stopped instance still pays for its attached EBS volumes; only the instance-hour charge stops.",
    diagnostic: "You stop an EC2 instance for 30 days. Which charges continue?" },
  { concept_id: "AWS-06", misconception: "Glacier is always the cheapest place to put data.",
    correct_understanding: "Glacier has the lowest storage rate but the highest retrieval cost and latency; for frequently-read data it is more expensive overall.",
    diagnostic: "Which data belongs in S3 Glacier rather than S3 Standard?" },
  { concept_id: "AWS-09", misconception: "Quotas exist only to restrict you.",
    correct_understanding: "Quotas protect account stability and are adjustable on request through a service-quota case.",
    diagnostic: "Your default quota is exhausted. What is the correct next step?" },
];

/**
 * The questions the dashboard's "Run the demo" button asks.
 *
 * These live HERE, next to the corpus, not in the dashboard, for two reasons:
 *
 *  1. The demo must be in the same domain as the loaded content. The previous
 *     build hard-coded generic dev-ops trivia (load balancers, DNS) in the
 *     page, so the demo showed a general-purpose chat cache while the corpus
 *     behind it was AWS -- the demo did not look like the product.
 *
 *  2. Swapping the corpus (AWS -> the JEE *Sets* chapter) must change the
 *     demo too, with no dashboard edit. The page asks the backend for the
 *     pool and falls back to its own list only if the backend is unreachable.
 *
 * They are deliberately OPERATIONAL rather than definitional: the learning
 * objects above answer "what is X", so a demo question that asked that would
 * already be cached and the first step would be a hit instead of a miss. Each
 * rephrase must land within the semantic radius of its question, and must not
 * land near any other entry.
 */
export const DEMO_PROMPTS = [
  {
    concept_id: "AWS-01", topic: "s3-lifecycle",
    q: "How do I configure an S3 lifecycle rule to archive old objects to Glacier?",
    rephrase: "What is the way to set up a lifecycle policy that transitions objects to Glacier?",
  },
  {
    concept_id: "AWS-12", topic: "vpc-firewall",
    q: "What's the difference between a security group and a network ACL?",
    rephrase: "How do security groups differ from network ACLs?",
  },
  {
    concept_id: "AWS-01", topic: "s3-versioning",
    q: "How do I enable versioning on an S3 bucket?",
    rephrase: "What steps do I take to turn on versioning for an S3 bucket?",
  },
  {
    concept_id: "AWS-13", topic: "iam",
    q: "What's the difference between an IAM role and an IAM user?",
    rephrase: "How does an IAM role differ from an IAM user?",
  },
  {
    concept_id: "AWS-03", topic: "lambda-schedule",
    q: "How do I run a Lambda function on a schedule?",
    rephrase: "What is the way to trigger a Lambda function on a timer?",
  },
  {
    concept_id: "AWS-04", topic: "ec2-purchase-model",
    q: "What's the difference between a spot instance and an on-demand instance?",
    rephrase: "How do spot instances differ from on-demand instances?",
  },
];

/**
 * Seed the corpus: 7 learning objects, 3 misconceptions, and N deterministic
 * practice items. Every seeded item is created with the provenance the SOP
 * requires and `review_status: approved` so the tutor path can serve it.
 */
export async function seedDemoCorpus(db, { practiceCount = 24 } = {}) {
  let seeded = 0;
  const now = Date.now();

  for (const lo of LEARNING_OBJECTS) {
    const body = {
      model: config.model,
      messages: [
        { role: "system", content: "You are an AWS enterprise assistant." },
        { role: "user", content: `Define ${lo.title}.` },
      ],
    };
    const envelope = {
      chapter_code: CHAPTER, concept_id: lo.concept_id, asset_type: "learning_object",
      source_section: lo.source_section, difficulty_level: "2", skill_type: "recall",
      review_status: "approved", generation_method: "curated", object_type: lo.object_type,
    };
    const fp = requestFingerprint(body);
    const text = semanticText(body.messages);
    const question = `What is ${lo.title}?`;
    const answer = `${lo.title}: ${lo.content}`;
    db.insertEntry({
      fingerprint: fp,
      scope: scopeOf(envelope, 'sample'),
      model: config.model,
      semantic_text: text,
      prompt: question,
      response_json: JSON.stringify({
        id: `seed-${lo.concept_id}`, object: "chat.completion",
        created: Math.floor(now / 1000), model: config.model,
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: answer } }],
      }),
      symbol_fp: symbolFingerprint(text),
      envelope_json: JSON.stringify(envelope),
      generation_method: "curated", verification_method: "human_review",
      review_status: "approved", source_prompt: question,
      created_at: now, last_used_at: now,
    });
    seeded += 1;
  }

  for (const mc of MISCONCEPTIONS) {
    const envelope = {
      chapter_code: CHAPTER, concept_id: mc.concept_id, asset_type: "misconception",
      source_section: "3.3", difficulty_level: "2", skill_type: "diagnose",
      review_status: "approved", generation_method: "curated",
    };
    db.insertEntry({
      fingerprint: `mc-${mc.concept_id}-${seeded}`,
      scope: scopeOf(envelope, 'sample'),
      model: config.model,
      semantic_text: mc.diagnostic,
      prompt: mc.diagnostic,
      response_json: JSON.stringify({
        id: `mis-${mc.concept_id}`, object: "chat.completion",
        created: Math.floor(now / 1000), model: config.model,
        choices: [{ index: 0, finish_reason: "stop",
          message: { role: "assistant", content: `${mc.correct_understanding}` } }],
      }),
      symbol_fp: symbolFingerprint(mc.diagnostic),
      envelope_json: JSON.stringify(envelope),
      generation_method: "curated", verification_method: "human_review",
      review_status: "approved", source_prompt: mc.diagnostic,
      created_at: now, last_used_at: now,
    });
    seeded += 1;
  }

  // Deterministic practice items: same template, DIFFERENT parameters. This is
  // the corpus that proves the verifier -- the prompts are near-identical text
  // but the answers differ, so only the (template, params) key can be right.
  const paramsPool = [
    { template_id: "T-EC2-COST", concept_id: "AWS-04", sets: [
      { instance_type: "t3.micro", count: "1", hours: "100" },
      { instance_type: "t3.micro", count: "1", hours: "200" },
      { instance_type: "m5.large", count: "2", hours: "730" },
      { instance_type: "m5.large", count: "4", hours: "730" },
      { instance_type: "c5.large", count: "1", hours: "160" },
    ] },
    { template_id: "T-S3-COST", concept_id: "AWS-06", sets: [
      { gb: "50", storage_class: "standard" },
      { gb: "500", storage_class: "standard" },
      { gb: "500", storage_class: "infrequent_access" },
      { gb: "500", storage_class: "glacier" },
      { gb: "50", storage_class: "glacier" },
    ] },
    { template_id: "T-QUOTA", concept_id: "AWS-09", sets: [
      { service: "vpc" }, { service: "subnet" }, { service: "iam_role" },
      { service: "s3_bucket" }, { service: "lambda_concurrency" },
    ] },
    { template_id: "T-COMPARE", concept_id: "AWS-11", sets: [
      { service_a: "s3", service_b: "dynamodb", dimension: "storage_model" },
      { service_a: "s3", service_b: "dynamodb", dimension: "consistency" },
      { service_a: "ec2", service_b: "lambda", dimension: "pricing" },
      { service_a: "ec2", service_b: "lambda", dimension: "scaling" },
    ] },
  ];

  for (const group of paramsPool) {
    for (const params of group.sets) {
      const tpl = templates.getTemplate(group.template_id);
      if (!tpl) continue;
      const rendered = templates.renderTemplate(tpl, params);
      if (!rendered.ok) continue;
      const envelope = {
        chapter_code: CHAPTER, concept_id: group.concept_id,
        asset_type: "practice_question", source_section: "4.1",
        difficulty_level: String(tpl.difficulty_level), skill_type: tpl.skill_type,
        template_id: tpl.id, params, review_status: "approved",
        generation_method: "deterministic_template",
      };
      db.insertEntry({
        fingerprint: templates.templateKey(tpl.id, params),
        scope: scopeOf(envelope, 'det'),
        model: config.model,
        semantic_text: rendered.prompt,
        prompt: rendered.prompt,
        response_json: JSON.stringify({
          id: `tpl-${tpl.id}`, object: "chat.completion",
          created: Math.floor(now / 1000), model: config.model,
          choices: [{ index: 0, finish_reason: "stop",
            message: { role: "assistant", content: rendered.answer } }],
        }),
        symbol_fp: symbolFingerprint(rendered.prompt),
        envelope_json: JSON.stringify(envelope),
        template_id: tpl.id, params_json: JSON.stringify(params),
        actual_answer: rendered.answer,
        generation_method: "deterministic_template",
        verification_method: "deterministic_rule",
        review_status: "approved", source_prompt: rendered.prompt,
        created_at: now, last_used_at: now,
      });
      seeded += 1;
    }
  }

  // ---- index everything for the semantic tier -------------------------
  // The exact and deterministic tiers are SQLite-only, but a *semantic* hit
  // needs the entry in the vector index. Seeding therefore pays the one-time
  // embedder load (~250 MB) and writes every entry to Redis. This is the only
  // thing the seed path spends memory on, and it is why the app can start cold
  // at ~150 MB and stay there until the semantic tier is actually used.
  let indexed = 0;
  try {
    const { embed } = await import("./embedder.js");
    const { indexDocument } = await import("./vectors.js");
    for (const row of db.listEntries({ limit: 10_000 })) {
      try {
        const vec = await embed(row.semantic_text || row.prompt);
        if (!vec) continue;
        await indexDocument(`e${row.id}`, {
          scope: row.scope,
          model: config.model,
          fingerprint: row.fingerprint,
          generation_method: row.generation_method,
          review_status: row.review_status,
          prompt: row.prompt,
        }, vec);
        indexed += 1;
      } catch (e) {
        console.warn(`[seed] index ${row.id} failed: ${e.message}`);
      }
    }
  } catch (err) {
    console.warn(`[seed] vector indexing skipped: ${err.message}`);
  }

  console.log(`[seed] ${seeded} assets, ${indexed} indexed for the semantic tier`);
  return seeded;
}