/**
 * Deterministic templates -- the tier that never calls the model.
 *
 * The SOP is explicit (line 595): "Start with deterministic templates whenever
 * the answer can be computed from controlled parameters." and (line 597):
 * "Verify the answer by code/rule ... do not mark verified only because the
 * generator produced an answer."
 *
 * Every template here takes parameters, renders the prompt, and computes the
 * answer in code. Same (template, params) -> same answer, always, with no model
 * call at all. Different params -> a *different* answer, even though the prompt
 * is 95% the same text -- which is exactly the case that defeats a
 * similarity-only cache, and the reason the verifier exists.
 */

const EC2_PRICES = { // USD/hour, us-east-1, on-demand, mid-2026 snapshot
  "t3.micro": 0.0104, "t3.small": 0.0208, "t3.medium": 0.0416,
  "m5.large": 0.096, "m5.xlarge": 0.192, "m5.2xlarge": 0.384,
  "c5.large": 0.085, "c5.xlarge": 0.17, "r5.large": 0.126,
};
const S3_TIERS = { // USD per GB-month, first tier
  standard: 0.023, infrequent_access: 0.0125, glacier: 0.004,
};
const QUOTAS = {
  vpc: "5 VPCs per Region (default)",
  subnet: "200 subnets per VPC (default)",
  iam_role: "1,000 roles per account (default)",
  s3_bucket: "100 buckets per account (default)",
  lambda_concurrency: "1,000 concurrent executions per Region (default)",
  ec2_instance: "5 vCPUs for on-demand instances (default, P- and T- instances)",
};

const isNum = (v) => Number.isFinite(Number(v));

/** EC2 monthly cost: instances x price x hours. */
const ec2Cost = (p) => {
  const price = EC2_PRICES[p.instance_type];
  if (price === undefined) return { ok: false, why: `unknown instance type '${p.instance_type}'` };
  if (!isNum(p.count) || Number(p.count) < 1) return { ok: false, why: "count must be >= 1" };
  if (!isNum(p.hours) || Number(p.hours) <= 0 || Number(p.hours) > 744) {
    return { ok: false, why: "hours must be 1..744 (a month is at most 744h)" };
  }
  const n = Number(p.count);
  const h = Number(p.hours);
  const total = price * n * h;
  return {
    ok: true,
    answer: `$${total.toFixed(2)} for the month`,
    explanation:
      `${p.count} x ${p.instance_type} at $${price.toFixed(4)}/hour x ${p.hours} hours ` +
      `= $${price.toFixed(4)} x ${n} x ${h} = $${total.toFixed(2)}. ` +
      `On-demand list price in us-east-1; the instance type matters far more than the running hours.`,
  };
};

/** S3 monthly storage cost: GB x tier price. */
const s3Cost = (p) => {
  const price = S3_TIERS[p.storage_class];
  if (price === undefined) return { ok: false, why: `unknown storage class '${p.storage_class}'` };
  if (!isNum(p.gb) || Number(p.gb) <= 0) return { ok: false, why: "gb must be > 0" };
  const gb = Number(p.gb);
  const total = price * gb;
  return {
    ok: true,
    answer: `$${total.toFixed(2)} for the month`,
    explanation:
      `${gb} GB at the ${p.storage_class} rate of $${price.toFixed(4)}/GB-month ` +
      `= $${total.toFixed(2)}. This is storage only: requests, retrievals and ` +
      `data transfer are billed separately.`,
  };
};

/** Service quota: a fixed lookup. */
const quota = (p) => {
  const q = QUOTAS[p.service];
  if (!q) return { ok: false, why: `no quota recorded for '${p.service}'` };
  return {
    ok: true,
    answer: q,
    explanation:
      `The default quota for ${p.service} is ${q.toLowerCase()}. Defaults are soft ` +
      `limits and can be raised with a service-quota case.`,
  };
};

/**
 * Compare two services on a fixed dimension from a matrix.
 * Deliberately asymmetric: comparing A-to-B is not the same as B-to-A.
 */
const MATRIX = {
  "s3|dynamodb": {
    storage_model: "S3 stores objects (files up to 5 TB) in buckets; DynamoDB stores items (max 400 KB) in tables with a primary key.",
    consistency: "S3 offers strong read-after-write consistency for new objects; DynamoDB offers strongly consistent reads (and eventually consistent reads that cost less).",
    lookup: "S3 looks objects up by key inside a bucket; DynamoDB looks items up by primary key, or by secondary index.",
  },
  "ec2|lambda": {
    pricing: "EC2 bills for the instance hours you reserve or run; Lambda bills per request and per GB-second actually used.",
    scaling: "EC2 scales when you add instances (auto-scaling groups); Lambda scales per request automatically, up to your concurrency quota.",
    state: "EC2 instances are stateful and long-lived; Lambda functions are stateless and short-lived.",
  },
};

const compare = (p) => {
  const a = String(p.service_a || "").toLowerCase();
  const b = String(p.service_b || "").toLowerCase();
  const dim = String(p.dimension || "").toLowerCase();
  const forward = MATRIX[`${a}|${b}`];
  const reverse = MATRIX[`${b}|${a}`];
  if (forward) {
    const cell = forward[dim];
    if (!cell) return { ok: false, why: `no data for dimension '${p.dimension}'` };
    return {
      ok: true,
      answer: cell,
      explanation: `Comparing ${a} to ${b} on ${dim}. Note the direction: comparing ${b} to ${a} is a different question with a different emphasis.`,
    };
  }
  if (reverse) {
    const cell = reverse[dim];
    if (!cell) return { ok: false, why: `no data for dimension '${p.dimension}'` };
    return {
      ok: true,
      answer: cell,
      explanation: `Comparing ${a} to ${b} on ${dim} (the reverse pair is recorded).`,
    };
  }
  return { ok: false, why: `no comparison recorded for ${a} vs ${b}` };
};

export const TEMPLATES = [
  {
    id: "T-EC2-COST",
    concept_id: "AWS-04",
    asset_type: "practice_question",
    skill_type: "calculate",
    difficulty_level: 2,
    required: ["instance_type", "count", "hours"],
    render: (p) =>
      `What is the monthly cost of running ${p.count} ${p.instance_type} instance${Number(p.count) === 1 ? "" : "s"} ` +
      `for ${p.hours} hours per month at on-demand rates?`,
    solve: ec2Cost,
  },
  {
    id: "T-S3-COST",
    concept_id: "AWS-06",
    asset_type: "practice_question",
    skill_type: "calculate",
    difficulty_level: 2,
    required: ["gb", "storage_class"],
    render: (p) =>
      `What is the monthly storage cost for ${p.gb} GB in S3 ${p.storage_class.replace(/_/g, " ")}?`,
    solve: s3Cost,
  },
  {
    id: "T-QUOTA",
    concept_id: "AWS-09",
    asset_type: "learning_object",
    skill_type: "recall",
    difficulty_level: 1,
    required: ["service"],
    render: (p) => `What is the default service quota for ${String(p.service).toUpperCase()}?`,
    solve: quota,
  },
  {
    id: "T-COMPARE",
    concept_id: "AWS-11",
    asset_type: "learning_object",
    skill_type: "compare",
    difficulty_level: 3,
    required: ["service_a", "service_b", "dimension"],
    render: (p) => `How does ${p.service_a} compare to ${p.service_b} on ${p.dimension.replace(/_/g, " ")}?`,
    solve: compare,
  },
];

export const TEMPLATE_BY_ID = new Map(TEMPLATES.map((t) => [t.id, t]));

export function getTemplate(id) {
  return TEMPLATE_BY_ID.get(id) ?? null;
}

/** Deterministic cache key: (template, parameters). Computable, not semantic. */
export function templateKey(templateId, params) {
  const sorted = Object.keys(params).sort().map((k) => [k, params[k]]);
  return `${templateId}:${JSON.stringify(sorted)}`;
}

/** Validate params against the template's required set. */
export function validateParams(template, params) {
  const missing = template.required.filter((k) => params?.[k] === undefined || params[k] === null);
  const unknown = Object.keys(params || {}).filter((k) => !template.required.includes(k));
  return { missing, unknown };
}

export function renderTemplate(template, params) {
  const v = validateParams(template, params);
  if (v.missing.length) return { ok: false, why: `missing required parameter(s): ${v.missing.join(", ")}` };
  const prompt = template.render(params);
  const result = template.solve(params);
  return { ok: result.ok, why: result.why, prompt, answer: result.answer, explanation: result.explanation };
}