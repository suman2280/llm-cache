// llm-cache dashboard v2 — one poll, one log.
//
// The dashboard is stateless on the client: /stats is the whole world, polled
// every second. The log reconciles by event id (reconcile.js — pure, tested
// with `npm test`), so <details> rows keep their open/closed state, focus, and
// scroll position across polls; new rows FLIP in via View Transitions.
// The two write paths (composer, Run the demo) POST the same
// /v1/chat/completions any client uses — they are not a second view.
//
// No external requests. XSS-safe: every value is written with textContent.

import { planUpdates } from "./reconcile.js";

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ elements
const chip = $("live-chip");
const banner = $("stale-banner");
const staleText = $("stale-text");
const updatedAt = $("updated-at");

const form = $("send-form");
const promptEl = $("send-prompt");
const tempEl = $("send-temp");
const systemEl = $("send-system");
const sendBtn = $("send-btn");
const demoBtn = $("demo-btn");
const sendStatus = $("send-status");

const logEl = $("log");
const logEmpty = $("log-empty");

// -------------------------------------------------------------------- state
let lastPayload = null;
let lastOkAt = null;
let lastLogSignature = "";
let timer = null;
let configuredModel = null;
let busy = false;
let pendingFlash = null;
const rows = new Map(); // event id -> <details> element

const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");

// ---------------------------------------------------------------- formatting
const fmtInt = new Intl.NumberFormat("en-US");

function fmtLatency(ms) {
  if (ms === null || ms === undefined) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

function fmtClock(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString();
}

function fmtUptime(s) {
  if (!Number.isFinite(s)) return "—";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return m ? `${m}m ${sec}s` : `${sec}s`;
}

function fmtHitRate(r) {
  return r === null || r === undefined ? "—" : `${(r * 100).toFixed(1)}%`;
}

function fmtOverhead(ev) {
  if (ev.embed_ms != null || ev.redis_ms != null) {
    return `embed ${Math.round(ev.embed_ms ?? 0)} / redis ${Math.round(ev.redis_ms ?? 0)}`;
  }
  return "—";
}

function badgeClass(status) {
  return {
    "exact-hit": "badge-exact-hit",
    "semantic-hit": "badge-semantic-hit",
    miss: "badge-miss",
    bypass: "badge-bypass",
    error: "badge-error",
  }[status] || "badge-bypass";
}

// ------------------------------------------------------------ number tickers
// One shared rAF loop for every active ticker (never one per element).
const tickers = new Set();
let rafId = 0;

function tickerFrame(now) {
  for (const t of tickers) {
    const p = Math.min(1, (now - t.t0) / t.dur);
    const e = 1 - Math.pow(1 - p, 3); // ease-out-cubic
    t.el.textContent = t.fmt(t.from + (t.to - t.from) * e);
    if (p === 1) tickers.delete(t);
  }
  rafId = tickers.size ? requestAnimationFrame(tickerFrame) : 0;
}

function tickNumber(el, to, fmt = (v) => fmtInt.format(Math.round(v))) {
  to = Number(to) || 0;
  const from = Number(el.dataset.value ?? 0);
  if (from === to) return;
  el.dataset.value = String(to);
  if (reduceMotion.matches) {
    el.textContent = fmt(to);
    return;
  }
  tickers.add({ el, from, to, fmt, t0: performance.now(), dur: 600 });
  if (!rafId) rafId = requestAnimationFrame(tickerFrame);
}

// ------------------------------------------------------------------- polling
function pollMs() {
  const raw = new URLSearchParams(location.search).get("poll");
  const n = Number(raw);
  if (!raw || !Number.isFinite(n)) return 1000;
  return Math.min(60000, Math.max(500, n));
}

async function tick() {
  try {
    const res = await fetch("/stats", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    render(await res.json());
  } catch {
    showStale();
  }
}

function render(payload) {
  lastPayload = payload;
  lastOkAt = new Date();
  chip.textContent = "● live";
  chip.className = "chip chip-live";
  banner.hidden = true;

  const svc = payload.service || {};
  $("cfg-model").textContent = `model: ${svc.model ?? "—"}`;
  $("cfg-embedder").textContent = `embedder: ${svc.embedder ? String(svc.embedder).split("/").pop() : "—"}`;
  $("cfg-thresh").textContent = `thresh: ${svc.distance_threshold ?? "—"}`;
  $("cfg-uptime").textContent = `uptime: ${fmtUptime(svc.uptime_s)}`;
  $("cfg-version").textContent = `v${svc.version ?? "—"}`;
  // The deployment has exactly one model; learn it from /stats, never invent it.
  if (svc.model) {
    configuredModel = svc.model;
    $("hero-model").textContent = svc.model;
  }

  const t = payload.totals || {};
  tickNumber($("kpi-requests"), t.requests ?? 0);
  tickNumber($("kpi-exact"), t.exact_hits ?? 0);
  tickNumber($("kpi-semantic"), t.semantic_hits ?? 0);
  tickNumber($("kpi-misses"), t.misses ?? 0);
  tickNumber($("kpi-bypasses"), t.bypasses ?? 0);
  tickNumber($("kpi-errors"), t.errors ?? 0);
  tickNumber($("kpi-avoided"), (t.exact_hits ?? 0) + (t.semantic_hits ?? 0));
  // hit rate ticks in percent points but keeps its "x.y%" form
  const rateEl = $("kpi-hitrate");
  const rate = t.cache_hit_rate;
  if (rate == null) {
    rateEl.textContent = "—";
    rateEl.dataset.value = "0";
  } else {
    tickNumber(rateEl, rate * 100, (v) => `${v.toFixed(1)}%`);
  }

  const lat = payload.latency_ms || { n: 0 };
  $("lat-n").textContent = lat.n ?? 0;
  $("lat-p50").textContent = lat.n ? fmtLatency(lat.p50) : "—";
  $("lat-p90").textContent = lat.n ? fmtLatency(lat.p90) : "—";
  $("lat-p95").textContent = lat.n ? fmtLatency(lat.p95) : "—";
  $("lat-p99").textContent = lat.n ? fmtLatency(lat.p99) : "—";
  $("lat-max").textContent = lat.n ? fmtLatency(lat.max) : "—";

  updatedAt.textContent = fmtClock(payload.generated_at);

  renderLog(payload.recent || []);
}

function showStale() {
  chip.textContent = "● stale";
  chip.className = "chip chip-stale";
  banner.hidden = false;
  const when = lastOkAt ? lastOkAt.toLocaleTimeString() : "never";
  staleText.textContent = `/stats unreachable — showing last data at ${when}`;
}

// ------------------------------------------------------- the unified log
// Row identity is the event id, so element identity survives polls:
// <details> open state, focus, and scroll all persist for free. View
// Transitions FLIP new rows in. Events without an id are pre-contract-v2
// leftovers in the Redis ring; they self-heal within 100 events and are
// skipped here rather than churning every poll.

function logSignature(events) {
  return `${events.length}:${events[0] && typeof events[0].id === "number" ? events[0].id : "none"}`;
}

function renderLog(events) {
  const sig = logSignature(events);
  if (sig === lastLogSignature) return; // nothing new since last poll
  lastLogSignature = sig;
  const apply = () => applyLog(events);
  if (reduceMotion.matches || !document.startViewTransition) {
    apply();
    return;
  }
  document.startViewTransition(apply);
}

function applyLog(events) {
  const keyed = events.filter((e) => typeof e.id === "number");
  const nextIds = keyed.map((e) => e.id);

  const ops = planUpdates([...rows.keys()], nextIds);

  for (const op of ops) {
    if (op.type !== "remove") continue;
    const row = rows.get(op.id);
    if (row) row.remove();
    rows.delete(op.id);
  }
  for (const op of ops) {
    if (op.type !== "insert") continue;
    const row = buildRow(keyed[op.index]);
    rows.set(op.id, row);
    logEl.insertBefore(row, logEl.children[op.index] ?? null);
  }
  // position walk: every incoming row to its index (covers reorders and
  // makes multi-prepend polls land in the right order)
  keyed.forEach((e, i) => {
    const row = rows.get(e.id);
    if (row && logEl.children[i] !== row) {
      logEl.insertBefore(row, logEl.children[i] ?? null);
    }
  });

  logEmpty.hidden = keyed.length > 0;
}

function buildRow(ev) {
  const row = document.createElement("details");
  row.className = `row row-${ev.status || "bypass"}`;
  row.dataset.prompt = ev.prompt ?? "";

  const summary = document.createElement("summary");
  summary.className = "row-summary";

  const time = document.createElement("span");
  time.className = "cell-time mono";
  time.textContent = fmtClock(ev.ts);

  const badge = document.createElement("span");
  badge.className = `badge ${badgeClass(ev.status)}`;
  badge.textContent = ev.status || "unknown";

  const dist = document.createElement("span");
  dist.className = "cell-dist mono";
  dist.textContent = ev.similarity == null ? "—" : `d=${Number(ev.similarity).toFixed(3)}`;

  const lat = document.createElement("span");
  lat.className = "cell-lat mono";
  lat.textContent = fmtLatency(ev.latency_ms);

  const overhead = document.createElement("span");
  overhead.className = "cell-break mono";
  overhead.textContent = fmtOverhead(ev);

  const prompt = document.createElement("span");
  prompt.className = "cell-prompt";
  prompt.textContent = ev.prompt || "";

  const twisty = document.createElement("span");
  twisty.className = "cell-twisty";
  twisty.setAttribute("aria-hidden", "true");

  summary.append(time, badge, dist, lat, overhead, prompt, twisty);
  row.appendChild(summary);

  const detail = document.createElement("div");
  detail.className = "row-detail";

  if (ev.prompt) {
    detail.append(qaBlock("question", ev.prompt));
  }
  if (ev.response) {
    detail.append(qaBlock("answer", ev.response));
  } else if (ev.status === "error") {
    const p = document.createElement("p");
    p.className = "qa-src";
    p.textContent = "no answer — the request failed before one existed";
    detail.appendChild(p);
  }
  if (ev.status === "semantic-hit" && ev.source_prompt) {
    const src = document.createElement("p");
    src.className = "qa-src";
    src.textContent = "served from: ";
    const b = document.createElement("b");
    b.textContent = ev.source_prompt;
    src.appendChild(b);
    detail.appendChild(src);
  }
  if (ev.reason) {
    const r = document.createElement("p");
    r.className = "qa-reason";
    r.textContent = `${ev.status === "bypass" ? "bypass reason" : "reason"}: ${ev.reason}`;
    detail.appendChild(r);
  }
  row.appendChild(detail);
  return row;
}

function qaBlock(label, text) {
  const block = document.createElement("div");
  block.className = "qa";
  const l = document.createElement("span");
  l.className = "qa-label";
  l.textContent = label;
  const p = document.createElement("p");
  p.className = "qa-text";
  p.textContent = text;
  block.append(l, p);
  return block;
}

// A just-sent request flashes once when it lands in the log — the demo
// moment made visible without a second view.
function flashNewestMatching(prompt) {
  if (!prompt) return;
  for (const row of rows.values()) {
    if (row.dataset.prompt === prompt) {
      row.classList.add("row-flash");
      row.scrollIntoView({ block: "nearest" });
      setTimeout(() => row.classList.remove("row-flash"), 2400);
      return;
    }
  }
}

// ------------------------------------------------------------- write paths
// Both paths POST the same /v1/chat/completions a normal client uses and
// report the proxy's own verdict headers. No new backend surface.

function setBusy(on, note) {
  busy = on;
  sendBtn.disabled = on;
  demoBtn.disabled = on;
  if (on) {
    sendBtn.textContent = "Sending…";
    setStatus(note, false);
  } else {
    sendBtn.textContent = "Send";
  }
}

function setStatus(text, isError) {
  sendStatus.textContent = text || "";
  sendStatus.dataset.error = isError ? "1" : "0";
}

async function resolveModel(timeoutMs = 10_000) {
  const started = Date.now();
  while (!configuredModel && Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, 150));
  }
  return configuredModel;
}

async function sendPrompt(text, temp, system) {
  const model = await resolveModel();
  if (!model) throw new Error("model unknown — is /stats reachable?");
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: text });
  const body = { model, messages };
  if (temp !== "" && temp != null) body.temperature = Number(temp);

  const res = await fetch("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await res.json().catch(() => null);
  const detail =
    payload && typeof payload.detail === "string"
      ? payload.detail
      : res.status >= 400
        ? `request failed (HTTP ${res.status})`
        : null;
  return {
    ok: res.ok,
    httpStatus: res.status,
    status: res.headers.get("x-cache-status") || (res.ok ? "unknown" : "error"),
    similarity: res.headers.get("x-cache-similarity"),
    sourcePrompt: res.headers.get("x-cache-source-prompt"),
    latencyMs: res.headers.get("x-cache-latency-ms"),
    embedMs: res.headers.get("x-embed-ms"),
    redisMs: res.headers.get("x-redis-ms"),
    policy: res.headers.get("x-cache-policy"),
    detail,
  };
}

function verdictLine(v) {
  if (!v.ok) return `HTTP ${v.httpStatus}${v.detail ? ` — ${v.detail}` : ""}`;
  const bits = [v.status, fmtLatency(Number(v.latencyMs) || 0)];
  if (v.similarity) bits.push(`d=${Number(v.similarity).toFixed(3)}`);
  if (v.embedMs != null || v.redisMs != null) {
    bits.push(`embed ${Math.round(Number(v.embedMs) || 0)} / redis ${Math.round(Number(v.redisMs) || 0)}`);
  }
  if (v.sourcePrompt) bits.push(`served from: ${v.sourcePrompt}`);
  if (v.policy) bits.push(`policy: ${v.policy}`);
  return bits.join(" · ");
}

form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (busy) return;
  const text = promptEl.value.trim();
  if (!text) return;
  setBusy(true, "sending… (a miss runs inference — seconds on CPU)");
  let note = "";
  let isError = false;
  try {
    const v = await sendPrompt(text, tempEl.value, systemEl.value);
    note = verdictLine(v);
    isError = !v.ok;
  } catch (err) {
    note = `request failed — is the proxy running? (${err.message})`;
    isError = true;
  }
  pendingFlash = text;
  try {
    await tick(); // the server recorded the event; pull it into the log now
    flashNewestMatching(pendingFlash);
  } catch {
    /* tick already surfaces staleness */
  }
  setBusy(false, "");
  setStatus(note, isError);
  promptEl.focus();
});

// ------------------------------------------------------------ run the demo
// Three requests make the thesis self-demonstrating: a question (miss),
// the same text (exact-hit), a rewording (semantic-hit). It sends REAL
// requests through the real cache — the first runs inference.
//
// Two deliberate choices:
//  - temperature is sent explicitly (0): the composer's default field is
//    temperature=0, and the exact tier hashes params — omitting it would
//    make "the same text" a *semantic* hit served from itself (d=0.000).
//    Caught by scripts/ui_smoke.mjs; see docs/validation.md.
//  - the base question rotates through a pool: a warm cache (this question
//    already answered) would turn step 1 into a hit. Fresh deployments get
//    the canonical sequence on the first run; later runs report whatever
//    the cache actually says — the verdict line is always the proxy's truth.
const DEMO_POOL = [
  { q: "What is a load balancer?", rephrase: "Can you explain what a load balancer does?" },
  { q: "What is a reverse proxy?", rephrase: "Explain what a reverse proxy does." },
  { q: "What is DNS?", rephrase: "Can you explain what DNS does?" },
  { q: "What is a container image?", rephrase: "Explain what a container image is." },
  { q: "What is an API gateway?", rephrase: "What does an API gateway do?" },
  { q: "What is a connection pool?", rephrase: "Explain what a connection pool is." },
];
const DEMO_RUN_KEY = "llm-cache:demo-run";

function nextDemoSteps() {
  const n = Number(localStorage.getItem(DEMO_RUN_KEY) || "0");
  localStorage.setItem(DEMO_RUN_KEY, String(n + 1));
  const pick = DEMO_POOL[n % DEMO_POOL.length];
  return [
    { prompt: pick.q, note: `1/3 · new question — miss, running inference (seconds)…` },
    { prompt: pick.q, note: "2/3 · the exact same text — expecting exact-hit…" },
    { prompt: pick.rephrase, note: "3/3 · a rewording — expecting semantic-hit…" },
  ];
}

demoBtn.addEventListener("click", async () => {
  if (busy) return;
  setBusy(true, "starting demo…");
  const steps = nextDemoSteps();
  for (const step of steps) {
    setStatus(step.note, false);
    try {
      const v = await sendPrompt(step.prompt, "0", "");
      setStatus(verdictLine(v), !v.ok);
    } catch (err) {
      setStatus(`demo stopped — ${err.message}`, true);
      break;
    }
    pendingFlash = step.prompt;
    try {
      await tick();
      flashNewestMatching(pendingFlash);
    } catch {
      /* staleness already surfaced */
    }
  }
  setBusy(false, "");
  setStatus("demo done — one inference, two cache serves (or the cache already knew)", false);
});

// -------------------------------------------------------------------- reset
function resetCounters() {
  if (!confirm("Reset all counters and clear the event feed? (Cache documents are kept.)")) return;
  rows.forEach((row) => row.remove());
  rows.clear();
  lastLogSignature = "";
  fetch("/stats/reset", { method: "POST" })
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStatus("counters reset — cache documents kept", false);
    })
    .catch((err) => setStatus(`reset failed: ${err.message}`, true))
    .finally(tick);
}

// Composer draft survives reloads (the one piece of client state worth keeping).
const DRAFT_KEY = "llm-cache:draft";
promptEl.value = localStorage.getItem(DRAFT_KEY) || "";
promptEl.addEventListener("input", () => localStorage.setItem(DRAFT_KEY, promptEl.value));

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) tick();
});

function start() {
  if (timer) clearInterval(timer);
  tick();
  timer = setInterval(() => {
    if (!document.hidden) tick();
  }, pollMs());
  $("reset-btn").addEventListener("click", resetCounters);
}

start();
