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
 * Per-service facts, so a comparison can be composed in EITHER direction
 * without swapping facts onto the wrong service. Comparing A to B and B to A
 * are genuinely different questions and must produce different answers --
 * otherwise the cache would happily reuse one for the other.
 */
const SERVICE_FACTS = {
  s3: {
    label: "S3",
    storage: "objects (files up to 5 TB) inside buckets",
    address: "a key inside a bucket",
    consistency: "strong read-after-write consistency for new objects",
    lookup: "by key, within a bucket",
    price: "storage per GB-month, plus per-request and transfer charges",
    scale: "grows by adding buckets and prefixes, with partition limits",
    state: "objects are durable and independent of any running server",
  },
  dynamodb: {
    label: "DynamoDB",
    storage: "items (up to 400 KB) inside tables with a primary key",
    address: "a primary key, or a secondary index",
    consistency: "strongly consistent reads, or eventually consistent reads that cost less",
    lookup: "by primary key, or by secondary index",
    price: "per request and per GB of stored data",
    scale: "scales by partitioning the table across shards",
    state: "items are durable and independent of any running server",
  },
  ec2: {
    label: "EC2",
    storage: "virtual servers (instances), each with its own attached EBS volumes",
    address: "an instance id or a private IP address",
    consistency: "not applicable -- there is no shared data plane",
    lookup: "not applicable -- you address the instance itself",
    price: "per instance-hour for the time it runs, plus volumes and networking",
    scale: "by adding instances, typically through an auto-scaling group",
    state: "instances are stateful and long-lived",
  },
  lambda: {
    label: "Lambda",
    storage: "short-lived, stateless function invocations",
    address: "an event source that triggers the function",
    consistency: "not applicable -- invocations are independent",
    lookup: "not applicable -- you address the function, not stored data",
    price: "per request and per GB-second actually used",
    scale: "per request, automatically, up to the concurrency quota",
    state: "functions are stateless; state belongs in a service like S3 or DynamoDB",
  },
};

/** Dimensions are composed from the two services' facts, in order. */
const DIMENSIONS = {
  storage_model: {
    question: "what each one stores",
    compose: (a, b) => `${a.label} stores ${a.storage}; ${b.label} stores ${b.storage}.`,
  },
  consistency: {
    question: "how consistent reads are",
    compose: (a, b) => `${a.label} offers ${a.consistency}; ${b.label} offers ${b.consistency}.`,
  },
  lookup: {
    question: "how you address the data",
    compose: (a, b) => `You address ${a.label} data by ${a.address}, and ${b.label} data by ${b.address}.`,
  },
  pricing: {
    question: "how it is billed",
    compose: (a, b) => `${a.label} is billed ${a.price}; ${b.label} is billed ${b.price}.`,
  },
  scaling: {
    question: "how it scales",
    compose: (a, b) => `${a.label} scales ${a.scale}; ${b.label} scales ${b.scale}.`,
  },
  state: {
    question: "how state is handled",
    compose: (a, b) => `${a.label}: ${a.state}. ${b.label}: ${b.state}.`,
  },
};

const compare = (p) => {
  const a = SERVICE_FACTS[String(p.service_a || "").toLowerCase()];
  const b = SERVICE_FACTS[String(p.service_b || "").toLowerCase()];
  if (!a || !b) {
    return { ok: false, why: `no comparison recorded for ${p.service_a} vs ${p.service_b}` };
  }
  const dim = DIMENSIONS[String(p.dimension || "").toLowerCase()];
  if (!dim) return { ok: false, why: `no data for dimension '${p.dimension}'` };
  const answer = dim.compose(a, b);
  return {
    ok: true,
    answer,
    explanation:
      `Comparing ${a.label} to ${b.label} on ${dim.question}. ` +
      `The direction matters: comparing ${b.label} to ${a.label} is a different question ` +
      `and produces a different answer.`,
  };
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