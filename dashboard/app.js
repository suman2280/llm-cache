// llm-cache dashboard — polls GET /stats, renders per docs/ui-plan.md U4-U5,
// plus the U8 prompt playground (try-it panel).
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
let configuredModel = null; // from GET /stats service.model

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
  // The playground sends to the configured model (never an input — there is
  // exactly one model in this deployment); keep the label truthful from /stats.
  if (svc.model) configuredModel = svc.model;
  const modelLabel = $("try-model-label");
  if (modelLabel && svc.model) modelLabel.textContent = svc.model;
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
  initTry();
}

// ------------------------------------------------------------- try-it panel
// Real requests through the cache: POST /v1/chat/completions from the same
// origin the dashboard is served from, and render the X-Cache-* response
// headers so a miss / exact-hit / semantic-hit is visible per prompt.
// XSS-safe: every value is written with textContent (docs/ui-plan.md U4).

function initTry() {
  const form = $("try-form");
  const prompt = $("try-prompt");
  const send = $("try-send");
  const status = $("try-status");
  const log = $("try-log");

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const text = prompt.value.trim();
    if (!text || send.disabled) return;

    setSending(true, "waiting for /stats…");
    let finalNote = "";
    let finalError = false;
    try {
      // The model is fixed by deployment; learn it from the (already in-flight)
      // first /stats poll rather than failing a submit that races it.
      const model = await resolveModel();
      if (!model) {
        setSending(false, "model unknown — is /stats reachable?", true);
        return;
      }
      const messages = [];
      const system = $("try-system").value.trim();
      if (system) messages.push({ role: "system", content: system });
      messages.push({ role: "user", content: text });
      const body = { model, messages };
      const temp = $("try-temp").value;
      if (temp !== "") body.temperature = Number(temp);
      setSending(true, "sending… (a miss runs inference — seconds)");

      const res = await fetch("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await res.json().catch(() => null);
      addTryCard({
        status: res.headers.get("x-cache-status") || (res.ok ? "unknown" : "error"),
        similarity: res.headers.get("x-cache-similarity"),
        sourcePrompt: res.headers.get("x-cache-source-prompt"),
        latencyMs: res.headers.get("x-cache-latency-ms"),
        embedMs: res.headers.get("x-embed-ms"),
        redisMs: res.headers.get("x-redis-ms"),
        policy: res.headers.get("x-cache-policy"),
        prompt: text,
        answer: pickAnswer(payload),
        httpStatus: res.status,
        detail: pickDetail(payload, res.status),
      });
      finalNote = res.ok ? `served · HTTP ${res.status}` : `HTTP ${res.status}`;
      finalError = !res.ok;
    } catch (err) {
      addTryCard({ status: "error", prompt: text, detail: String(err && err.message ? err.message : err) });
      finalNote = "request failed — is the proxy running?";
      finalError = true;
    } finally {
      setSending(false, finalNote, finalError);
      tick(); // refresh counters without waiting for the next poll
    }

    function setSending(on, note, isError) {
      send.disabled = on;
      send.textContent = on ? "Sending…" : "Send";
      if (on) {
        setTryStatus(note, false);
      } else {
        setTryStatus(note || "", Boolean(isError));
        prompt.focus();
      }
    }

    async function resolveModel(timeoutMs = 10_000) {
      const started = Date.now();
      while (!configuredModel && Date.now() - started < timeoutMs) {
        await new Promise((r) => setTimeout(r, 150));
      }
      return configuredModel;
    }
  });

  $("try-clear").addEventListener("click", () => {
    log.replaceChildren();
    $("try-empty").hidden = false;
    setTryStatus("");
  });

  $("try-reset").addEventListener("click", async () => {
    if (!confirm("Reset all counters and clear the event feed?")) return;
    try {
      const res = await fetch("/stats/reset", { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setTryStatus("counters reset");
      tick();
    } catch (err) {
      setTryStatus(`reset failed: ${err.message}`, true);
    }
  });

  prompt.addEventListener("keydown", (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key === "Enter") form.requestSubmit();
  });

  function setTryStatus(text, isError) {
    status.textContent = text || "";
    status.classList.toggle("try-status-error", Boolean(isError));
  }
}

function pickAnswer(payload) {
  try {
    return payload.choices[0].message.content ?? "";
  } catch {
    return "";
  }
}

function pickDetail(payload, httpStatus) {
  if (payload && typeof payload.detail === "string") return payload.detail;
  return httpStatus >= 400 ? `request failed (HTTP ${httpStatus})` : null;
}

function addTryCard(c) {
  const log = $("try-log");
  const empty = $("try-empty");
  const li = document.createElement("li");
  li.className = `try-card${c.status === "error" ? " try-card-error" : ""}${
    ["miss", "exact-hit", "semantic-hit", "bypass"].includes(c.status) ? ` try-card-${c.status}` : ""}`;

  const head = document.createElement("div");
  head.className = "try-card-head";
  const badge = document.createElement("span");
  badge.className = `badge ${badgeClass(c.status)}`;
  badge.textContent = c.status || "unknown";
  const metaBits = [];
  if (c.latencyMs) metaBits.push(`${Math.round(Number(c.latencyMs) || 0)} ms`);
  if (c.similarity) metaBits.push(`d=${c.similarity}`);
  if (c.embedMs != null || c.redisMs != null) {
    metaBits.push(`embed ${Math.round(Number(c.embedMs) || 0)} / redis ${Math.round(Number(c.redisMs) || 0)}`);
  }
  if (c.policy) metaBits.push(`policy: ${c.policy}`);
  if (c.httpStatus) metaBits.push(`HTTP ${c.httpStatus}`);
  const meta = document.createElement("span");
  meta.className = "try-card-meta";
  meta.textContent = metaBits.join(" · ");
  head.append(badge, meta);

  const q = document.createElement("p");
  q.className = "try-q";
  q.textContent = c.prompt || "";

  li.append(head, q);

  if (c.answer) {
    const a = document.createElement("p");
    a.className = "try-a";
    a.textContent = c.answer;
    li.appendChild(a);
  }
  if (c.sourcePrompt) {
    const src = document.createElement("p");
    src.className = "try-src";
    src.textContent = `served from: ${c.sourcePrompt}`;
    li.appendChild(src);
  }
  if (c.detail) {
    const d = document.createElement("p");
    d.className = "try-src try-detail";
    d.textContent = c.detail;
    li.appendChild(d);
  }

  empty.hidden = true;
  log.appendChild(li);
  li.scrollIntoView({ block: "nearest" });
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) tick();
});

start();
