// llm-cache dashboard — polls GET /stats, renders per docs/ui-plan.md U4-U5.
// No external requests. XSS-safe: all rendering via textContent.
// Pauses when tab hidden; refreshes immediately on visible again.

const $ = (id) => document.getElementById(id);
const chip = $("live-chip");
const banner = $("stale-banner");
const staleText = $("stale-text");
const updatedAt = $("updated-at");
const emptyState = $("empty-state");
const table = $("events-table");
const tbody = $("events-body");

let lastPayload = null;
let lastOkAt = null;
let timer = null;

function pollMs() {
  const raw = new URLSearchParams(location.search).get("poll");
  const n = Number(raw);
  if (!raw || !Number.isFinite(n)) return 1000;
  return Math.min(60000, Math.max(500, n));
}

function fmtMs(v) {
  return v === null || v === undefined ? "—" : `${Math.round(v)} ms`;
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

function badgeClass(status) {
  return { "exact-hit": "badge-exact", "semantic-hit": "badge-semantic", miss: "badge-miss", bypass: "badge-bypass", error: "badge-error" }[status] || "badge-bypass";
}

function render(payload) {
  lastPayload = payload;
  lastOkAt = new Date();
  chip.textContent = "● live";
  chip.className = "chip chip-live";
  banner.hidden = true;

  const svc = payload.service || {};
  $("cfg-model").textContent = `model: ${svc.model ?? "—"}`;
  const emb = svc.embedder ? String(svc.embedder).split("/").pop() : "—";
  $("cfg-embedder").textContent = `embedder: ${emb}`;
  $("cfg-thresh").textContent = `thresh: ${svc.distance_threshold ?? "—"}`;
  $("cfg-uptime").textContent = `uptime: ${fmtUptime(svc.uptime_s)}`;
  $("cfg-version").textContent = `v${svc.version ?? "—"}`;

  const t = payload.totals || {};
  $("kpi-requests").textContent = t.requests ?? 0;
  $("kpi-exact").textContent = t.exact_hits ?? 0;
  $("kpi-semantic").textContent = t.semantic_hits ?? 0;
  $("kpi-misses").textContent = t.misses ?? 0;
  $("kpi-bypasses").textContent = t.bypasses ?? 0;
  $("kpi-errors").textContent = t.errors ?? 0;
  $("kpi-avoided").textContent = (t.exact_hits ?? 0) + (t.semantic_hits ?? 0);
  $("kpi-hits").textContent = t.cache_hit_rate == null ? "—" : `${(t.cache_hit_rate * 100).toFixed(1)}%`;

  const lat = payload.latency_ms || { n: 0 };
  $("lat-n").textContent = lat.n ?? 0;
  $("lat-p50").textContent = lat.n ? fmtMs(lat.p50) : "—";
  $("lat-p90").textContent = lat.n ? fmtMs(lat.p90) : "—";
  $("lat-p95").textContent = lat.n ? fmtMs(lat.p95) : "—";
  $("lat-p99").textContent = lat.n ? fmtMs(lat.p99) : "—";
  $("lat-max").textContent = lat.n ? fmtMs(lat.max) : "—";

  updatedAt.textContent = fmtClock(payload.generated_at);

  const recent = Array.isArray(payload.recent) ? payload.recent : [];
  emptyState.hidden = recent.length > 0;
  table.hidden = recent.length === 0;
  tbody.replaceChildren();
  for (const ev of recent) {
    const tr = document.createElement("tr");
    const tdTime = document.createElement("td"); tdTime.className = "mono"; tdTime.textContent = fmtClock(ev.ts);
    const tdStatus = document.createElement("td");
    const badge = document.createElement("span"); badge.className = `badge ${badgeClass(ev.status)}`; badge.textContent = ev.status || "unknown";
    tdStatus.appendChild(badge);
    const tdDist = document.createElement("td"); tdDist.className = "mono";
    tdDist.textContent = ev.similarity != null ? `d=${Number(ev.similarity).toFixed(3)}` : "—";
    const tdLat = document.createElement("td"); tdLat.className = "mono"; tdLat.textContent = fmtMs(ev.latency_ms);
    const tdBreak = document.createElement("td"); tdBreak.className = "mono";
    tdBreak.textContent = ev.embed_ms != null || ev.redis_ms != null
      ? `(embed ${Math.round(ev.embed_ms ?? 0)} / redis ${Math.round(ev.redis_ms ?? 0)})` : "—";
    const tdPrompt = document.createElement("td"); tdPrompt.className = "prompt"; tdPrompt.textContent = ev.prompt_preview || "";
    tr.append(tdTime, tdStatus, tdDist, tdLat, tdBreak, tdPrompt);
    tbody.appendChild(tr);
  }
}

function showStale() {
  chip.textContent = "● stale";
  chip.className = "chip chip-stale";
  banner.hidden = false;
  const when = lastOkAt ? lastOkAt.toLocaleTimeString() : "never";
  staleText.textContent = `/stats unreachable — showing last data at ${when}`;
  // keep last payload on screen (rendered previously); nothing to clear.
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

function start() {
  if (timer) clearInterval(timer);
  tick();
  timer = setInterval(() => { if (!document.hidden) tick(); }, pollMs());
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) tick();
});

start();
