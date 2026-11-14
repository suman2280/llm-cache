#!/usr/bin/env node
// Measure the inference layer: memory, cold vs warm latency, throughput, and
// whether the LoRA adapter actually changes behaviour (domain + refusal).
//
//   node scripts/bench_model.mjs [requests] [maxTokens]
//
// Defaults to 4 requests x 150 tokens -- enough to see cold/warm separation
// without burning minutes on a CPU box.
const BASE = process.env.LLAMA_URL || "http://127.0.0.1:8080";
const KEY = process.env.LLAMA_API_KEY || "local-dev-key";
const N = Number(process.argv[2] || 4);
const MAXTOK = Number(process.argv[3] || 150);
const MODEL = "qwen2.5-7b-instruct";

const PROMPTS = [
  "What is the difference between an IAM role and an IAM user?",
  "How does S3 server-side encryption work?",
  "Explain Lambda reserved concurrency.",
  "What is a VPC and what does it contain?",
];
// Out of domain: should be refused by design.
const OOD = "What is the boiling point of water in Celsius?";
// Non-English-free maths-free domain probe: does the adapter leak JEE answers?
const JEE = "If A is a subset of B, what is A union B?";

async function chat(prompt, maxTokens = MAXTOK) {
  const t0 = performance.now();
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: "You are an expert AWS cloud assistant." },
        { role: "user", content: prompt },
      ],
      max_tokens: maxTokens,
      temperature: 0.3,
    }),
  });
  const wall = performance.now() - t0;
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  return { wall, body, text: body.choices?.[0]?.message?.content ?? "" };
}

function stats(v) {
  const s = [...v].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
  return { min: s[0], p50: q(50), p95: q(95), max: s[s.length - 1] };
}

async function main() {
  console.log(`\ninference-layer measurement  ·  ${BASE}`);
  console.log(`model=${MODEL}  max_tokens=${MAXTOK}  requests=${N}\n${"=".repeat(64)}`);

  const walls = [];
  const tokps = [];
  const rows = [];
  for (let i = 0; i < N; i++) {
    const { wall, body, text } = await chat(PROMPTS[i % PROMPTS.length]);
    const usage = body.usage || {};
    const comp = usage.completion_tokens ?? null;
    if (comp) tokps.push((comp / wall) * 1000);
    walls.push(wall);
    rows.push({ i, wall, comp, text: text.slice(0, 70).replace(/\s+/g, " ") });
    console.log(
      `  #${i + 1}  wall ${wall.toFixed(0).padStart(7)} ms  ` +
      `completion_tokens ${String(comp).padStart(4)}  ` +
      `${comp ? ((comp / wall) * 1000).toFixed(1) + " tok/s" : ""}`,
    );
    console.log(`       "${text.slice(0, 90).replace(/\s+/g, " ")}"`);
  }

  const w = stats(walls);
  console.log(`\n${"=".repeat(64)}`);
  console.log(`latency:  min ${w.min.toFixed(0)} ms   p50 ${w.p50.toFixed(0)} ms   p95 ${w.p95.toFixed(0)} ms   max ${w.max.toFixed(0)} ms`);
  if (tokps.length) {
    const t = stats(tokps);
    console.log(`throughput: p50 ${t.p50.toFixed(1)} tok/s   max ${t.max.toFixed(1)} tok/s`);
  }
  console.log(`COLD (first request) vs WARM (rest): ${walls[0].toFixed(0)} ms vs ${w.p50.toFixed(0)} ms -> cold penalty ${(walls[0] - w.p50).toFixed(0)} ms`);

  // ---- adapter behaviour checks ------------------------------------------
  console.log(`\n--- adapter behaviour ---`);
  const ood = await chat(OOD, 120);
  console.log(`  out-of-domain  (expect a refusal):        ${ood.wall.toFixed(0)} ms  "${ood.text.slice(0, 100).replace(/\s+/g, " ")}"`);
  const refused = /(can only|cannot|sorry|not able|outside|only answer|unrelated|as an ai)/i.test(ood.text);
  console.log(`  -> looks like a refusal: ${refused ? "YES" : "no"}`);

  const jee = await chat(JEE, 120);
  console.log(`  jee maths probe (expect refusal/noise):   ${jee.wall.toFixed(0)} ms  "${jee.text.slice(0, 100).replace(/\s+/g, " ")}"`);

  const json = { model: MODEL, maxTokens: MAXTOK, requests: N, walls: walls.map((v) => +v.toFixed(1)), tokps: tokps.map((v) => +v.toFixed(2)) };
  console.log(`\nJSON ${JSON.stringify(json)}`);
}

main().catch((e) => {
  console.error(`\nmeasurement failed: ${e.message}`);
  process.exit(1);
});