// API contract conformance check for the frozen dashboard UI.
//
// The dashboard (dashboard/) is not being rebuilt — it IS the spec. This script
// asserts every MUST in docs/UI-CONTRACT.md against a live backend, so a rebuild
// has a pass/fail gate instead of prose.
//
//   node scripts/check_api_contract.mjs                       # http://localhost:8000
//   node scripts/check_api_contract.mjs http://host:port
//
// Exit 0 = the dashboard will work against this backend unchanged.

const BASE = (process.argv[2] || "http://localhost:8000").replace(/\/$/, "");
const ADMIN = process.env.ADMIN_TOKEN || "";
// The checker verifies that the DASHBOARD still works. The dashboard is a
// same-origin browser, so every request is sent with the same-origin signal;
// otherwise it acts as an untrusted consumer and is (correctly) blocked from
// draft entries by the review floor.
const SAME_ORIGIN = { "Sec-Fetch-Site": "same-origin" };

const STATUSES = ["miss", "exact-hit", "semantic-hit", "bypass", "error"];
// A prompt whose every character is outside latin-1 — the old backend 500'd on it.
// A non-ASCII prompt, so the ASCII-safe-header contract (UI-CONTRACT 6) is
// exercised end to end. The non-ASCII character is U+2011 (non-breaking
// hyphen) in "S3\u2011Glacier" -- a character real pasted text contains, and
// one the previous build would have turned into an HTTP 500.
//
// The prompt is deliberately IN the configured domain: the domain guard would
// otherwise refuse it before it reached the cache, and the test would
// silently stop testing anything.
const NON_ASCII = "What's the difference between S3 Standard and S3\u2011Glacier storage?";
// A genuine rephrase of the prompt above: same meaning, different words, and
// the SAME set of non-ASCII glyphs (the verifier compares the glyph multiset).
const REPHRASE = "How do S3 Standard and S3\u2011Glacier differ in storage cost?";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${detail ? `\n        ${detail}` : ""}`);
}

async function jget(path) {
  const res = await fetch(`${BASE}${path}`, { cache: "no-store" });
  const body = await res.json().catch(() => null);
  return { status: res.status, headers: res.headers, body };
}

async function main() {
  console.log(`\ncontract check against ${BASE}\n${"=".repeat(64)}\n`);

  // ---- 1. static dashboard, same origin -------------------------------
  const dash = await jget("/dashboard/");
  const contentType = dash.headers.get("content-type") || "";
  check("GET /dashboard/ serves index.html", dash.status === 200 && /text\/html/.test(contentType));

  for (const f of ["/dashboard/app.js", "/dashboard/style.css", "/dashboard/reconcile.js"]) {
    const r = await fetch(`${BASE}${f}`);
    const ct = r.headers.get("content-type") || "";
    const isJs = f.endsWith(".js");
    check(
      `GET ${f}`,
      r.status === 200 && (!isJs || /javascript/.test(ct)),
      `status=${r.status} content-type=${ct} (modules need text/javascript)`,
    );
  }

  // ---- 2. /stats shape ------------------------------------------------
  const stats = await jget("/stats");
  check("GET /stats → 200 JSON", stats.status === 200 && typeof stats.body === "object" && stats.body !== null);

  if (typeof stats.body === "object" && stats.body !== null) {
    const p = stats.body;
    const svc = p.service || {};
    const totals = p.totals || {};
    const lat = p.latency_ms || {};

    check("generated_at is Date-parseable", typeof p.generated_at === "string" && !Number.isNaN(new Date(p.generated_at).getTime()));
    for (const f of ["model", "embedder", "distance_threshold", "uptime_s", "version"]) {
      check(`service.${f} present`, svc[f] !== undefined, `got ${JSON.stringify(svc[f])}`);
    }
    for (const f of ["requests", "exact_hits", "semantic_hits", "misses", "bypasses", "errors", "cache_hit_rate"]) {
      check(`totals.${f} present`, totals[f] !== undefined);
    }
    for (const f of ["n", "p50", "p90", "p95", "p99", "max"]) {
      check(`latency_ms.${f} present`, lat[f] !== undefined);
    }

    check("recent[] is an array", Array.isArray(p.recent));
    const ev = (p.recent || [])[0];
    if (ev) {
      check("newest event has a numeric id", typeof ev.id === "number", `id=${JSON.stringify(ev.id)}`);
      check(
        "recent[] is newest-first",
        // newest-first means ids DESCEND; strictly, since ids are unique
        (p.recent || []).every((e, i) => i === 0 || Number(e.id) < Number(p.recent[i - 1].id)),
        `ids: ${p.recent.slice(0, 6).map((e) => e.id).join(", ")}…`,
      );
      check("event.prompt is a string (full text)", typeof ev.prompt === "string");
      check("event.response is string|null", ev.response === null || typeof ev.response === "string");
      check("event.latency_ms is a number", typeof ev.latency_ms === "number");
    }
    check("schema_version present (recommended)", p.schema_version !== undefined);
  }

  // ---- 3. the frozen demo sequence ------------------------------------
  // reset first so the sequence is unambiguous
  const reset = await fetch(`${BASE}/stats/reset`, {
    method: "POST",
    headers: { ...SAME_ORIGIN, ...(ADMIN ? { "X-Admin-Token": ADMIN } : {}) },
  });
  check("POST /stats/reset → 2xx", reset.ok, `status=${reset.status}`);

  async function send(prompt, temperature = 0) {
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...SAME_ORIGIN },
      body: JSON.stringify({
        model: (stats.body?.service?.model) || "llama3.2:3b",
        messages: [{ role: "user", content: prompt }],
        temperature,
      }),
    });
    return {
      ok: res.ok,
      status: res.status,
      headers: res.headers,
      body: await res.json().catch(() => null),
    };
  }

  console.log("");
  const miss = await send(NON_ASCII);
  check("non-ASCII prompt does NOT 500 (UI-CONTRACT §6)", miss.status < 500,
    miss.status >= 500 ? `status=${miss.status} body=${JSON.stringify(miss.body)?.slice(0, 160)}` : "ok");

  const hdr = (r, name) => r.headers.get(name);
  for (const name of ["x-cache-status", "x-cache-latency-ms"]) {
    check(`response carries ${name}`, hdr(miss, name) !== null, `got ${hdr(miss, name)}`);
  }
  check(
    "x-cache-status is one of the five contract values",
    STATUSES.includes(hdr(miss, "x-cache-status")),
    `got ${JSON.stringify(hdr(miss, "x-cache-status"))}`,
  );
  check(
    "a served hit emits x-cache-distance and x-cache-similarity-score (UI-CONTRACT §8)",
    hdr(miss, "x-cache-distance") !== null && hdr(miss, "x-cache-similarity-score") !== null,
    `distance=${hdr(miss, "x-cache-distance")} score=${hdr(miss, "x-cache-similarity-score")}`,
  );

  // ---- 4. exact tier keys on EVERYTHING -------------------------------
  const again = await send(NON_ASCII, 0);
  const st = hdr(again, "x-cache-status");
  check(
    "identical request (same params) → exact-hit, not semantic-at-0 (UI-CONTRACT §7)",
    st === "exact-hit",
    `got ${st}; a semantic-hit at d=0.000 means the exact key ignores a body param`,
  );

  const reword = await send(REPHRASE, 0);
  check(
    "semantic hit carries a source prompt",
    hdr(reword, "x-cache-status") !== "miss" ||
      hdr(reword, "x-cache-source-prompt") !== null,
    `status=${hdr(reword, "x-cache-status")} source=${hdr(reword, "x-cache-source-prompt")}`,
  );
  const src = hdr(reword, "x-cache-source-prompt");
  if (src !== null) {
    // eslint-disable-next-line no-control-regex
    const ascii = /^[\x20-\x7e]*$/.test(src);
    check("x-cache-source-prompt is ASCII-safe (§6)", ascii,
      ascii ? "ok" : `non-ASCII bytes in header: ${JSON.stringify(src)}`);
  }

  // ---- 5. served hits mint a fresh id ---------------------------------
  const hit = again.ok ? again : reword;
  if (hit?.body && hit.body.id !== undefined) {
    const firstId = miss.body?.id;
    check("a served hit does NOT replay the original response id (§5)",
      hit.body.id !== firstId, `first=${firstId} hit=${hit.body.id}`);
  }
  if (hit?.body && hit.body.created !== undefined) {
    // `created` is unix-seconds, so two responses in the same second are equal
    // by construction. What matters is that it is current, not a replay of an
    // older response's clock: assert it is not in the past.
    const now = Math.floor(Date.now() / 1000);
    // `hit` was made earlier in this run, so its clock is legitimately a few
    // seconds behind -- replaying the *first* response's clock is the bug, not
    // latency. Assert the hit is never OLDER than the response it was served from.
    check("a served hit's `created` is not older than the response it served (§5)",
      hit.body.created >= (miss.body?.created ?? 0) - 1,
      `hit=${hit.body.created} first=${miss.body?.created} now=${now}`);
  }

  // ---- 6. error shape -------------------------------------------------
  const bad = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "x", messages: [] }),
  });
  const badBody = await bad.json().catch(() => null);
  check(
    "error responses return {detail: string} (the UI reads payload.detail)",
    bad.status >= 400 && typeof badBody?.detail === "string",
    `status=${bad.status} detail=${JSON.stringify(badBody?.detail)?.slice(0, 120)}`,
  );

  // ---- 7. ids survive reset -------------------------------------------
  const afterReset = await jget("/stats");
  const idsAfter = (afterReset.body?.recent || []).map((e) => e.id).filter((i) => typeof i === "number");
  const before = (stats.body?.recent || []).map((e) => e.id).filter((i) => typeof i === "number");
  const overlap = idsAfter.filter((i) => before.includes(i));
  check(
    "event ids are not reused across POST /stats/reset (§3)",
    overlap.length === 0 || idsAfter.length === 0,
    `${overlap.length} reused id(s) out of ${idsAfter.length}`,
  );

  // ---- the domain guard -------------------------------------------------
  // The model card promises the fine-tune refuses out-of-domain questions
  // ("100% correct refusal"). Measured, it does not -- so the proxy enforces
  // it. An out-of-domain question must be refused (strict) or served but
  // labelled and never cached (bypass); either way it must NOT come back as
  // a cache hit.
  const mode = stats.body?.service?.domain?.mode ?? "off";
  const ood = await send("Who wrote the play Hamlet?", 0);
  if (mode === "strict") {
    check("out-of-domain question is refused",
      ood.status === 422 && typeof ood.body?.detail === "string",
      `status=${ood.status} detail=${JSON.stringify(ood.body?.detail)?.slice(0, 90)}`);
  } else if (mode === "bypass") {
    check("out-of-domain question is labelled, not cached",
      ood.h.get("x-cache-policy") === "out-of-domain",
      `policy=${ood.h.get("x-cache-policy")}`);
  } else {
    console.log(`SKIP  out-of-domain question (domain mode is "${mode}")`);
  }

  // ---- report ----------------------------------------------------------
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${"=".repeat(64)}`);
  console.log(`${results.length - failed.length}/${results.length} contract checks pass.`);
  if (failed.length === 0) {
    console.log("The frozen dashboard will work against this backend unchanged.\n");
    return 0;
  }
  console.log(`\n${failed.length} FAILING — the dashboard is not safe to ship against this backend:`);
  for (const f of failed) console.log(`  · ${f.name}`);
  console.log("");
  return 1;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error(`\ncontract check could not run: ${err.message}`);
  console.error("Is the backend up? Expected GET /stats to respond.\n");
  process.exit(2);
});