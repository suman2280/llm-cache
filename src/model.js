/**
 * Model supervisor.
 *
 * The point of this project is that requests should avoid the model. So the
 * model is not a resident service -- it is a resource that is spawned on the
 * first genuine miss and shut down when it goes idle.
 *
 * Memory consequence (this is the whole memory strategy):
 *   - model idle  -> process gone -> the box holds only Node + SQLite
 *   - model busy  -> ~4.6 GB RSS, of which ~4.5 GB is file-backed weights that
 *                    the kernel can reclaim under pressure
 *
 * Config:
 *   LLM_MODEL_IDLE_S = 120  kill after 2 idle minutes (default)
 *   LLM_MODEL_IDLE_S = 0    kill immediately after each request (max saving)
 *   LLM_MODEL_IDLE_S = -1   never kill (min latency)
 */

import { spawn } from "node:child_process";
import config from "./config.js";

let proc = null;
let state = "stopped"; // stopped | starting | running | stopping
let lastUsedAt = 0;
let idleTimer = null;
let spawns = 0;
let totalInferMs = 0;
let totalInferences = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function defaultCmd() {
  return [
    config.llamaServerBin,
    "-m", config.modelGguf,
    "--lora-scaled", `${config.modelAdapter}:1.0`,
    "--host", "127.0.0.1", "--port", String(portOf(config.upstreamUrl)),
    "-c", String(config.modelCtx),
    "--threads", String(config.modelThreads),
    "--parallel", "1", "-ngl", "0",
    "--no-warmup",
    "--api-key", config.upstreamKey,
  ];
}

const portOf = (url) => {
  try { return new URL(url).port || "8080"; } catch { return "8080"; }
};

async function healthy() {
  try {
    const res = await fetch(`${config.upstreamUrl}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function ensureModel() {
  if (state === "running") { lastUsedAt = Date.now(); return config.upstreamUrl; }
  if (state === "starting") {
    // wait for the in-flight spawn
    const deadline = Date.now() + 90_000;
    while (state === "starting" && Date.now() < deadline) await sleep(150);
    if (state === "running") { lastUsedAt = Date.now(); return config.upstreamUrl; }
    throw new Error("model did not start in time");
  }

  // If something else already serves the port, use it (external llama-server).
  if (await healthy()) {
    state = "running";
    lastUsedAt = Date.now();
    return config.upstreamUrl;
  }

  state = "starting";
  const t0 = Date.now();
  const [bin, ...args] = config.modelCommand ? config.modelCommand.split(" ") : defaultCmd();
  try {
    proc = spawn(bin, args, {
      cwd: config.modelCwd || undefined,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, LLAMA_API_KEY: config.upstreamKey },
    });
  } catch (err) {
    state = "stopped";
    throw new Error(`model spawn failed: ${err.message}`);
  }

  let out = "";
  proc.stdout.on("data", (d) => {
    out += d.toString();
    if (out.length > 4000) out = out.slice(-4000);
  });
  proc.stderr.on("data", (d) => {
    out += d.toString();
    if (out.length > 4000) out = out.slice(-4000);
  });
  proc.on("exit", (code) => {
    console.log(`[model] exited (code ${code}) after ${Date.now() - t0} ms`);
    proc = null;
    state = "stopped";
  });

  spawns += 1;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (proc === null) state = "starting";
    if (await healthy()) {
      state = "running";
      lastUsedAt = Date.now();
      console.log(`[model] ready in ${Date.now() - t0} ms (spawn #${spawns})`);
      startIdleTimer();
      return config.upstreamUrl;
    }
    await sleep(300);
  }
  await shutdown();
  throw new Error(`model did not become healthy.\n${out.slice(-500)}`);
}

/** Run inference and account for it. */
export async function infer(body, { maxTokens } = {}) {
  const base = await ensureModel();
  const t0 = performance.now();
  const payload = { ...body };
  if (maxTokens && payload.max_tokens === undefined) payload.max_tokens = maxTokens;
  try {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.upstreamKey}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(config.modelTimeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`upstream ${res.status}: ${text.slice(0, 300)}`);
    }
    const json = await res.json();
    totalInferMs += performance.now() - t0;
    totalInferences += 1;
    return json;
  } finally {
    lastUsedAt = Date.now();
  }
}

export async function shutdown() {
  if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
  if (!proc) { state = "stopped"; return; }
  state = "stopping";
  const p = proc;
  proc = null;
  await new Promise((resolve) => {
    const done = () => resolve();
    p.once("exit", done);
    p.kill("SIGTERM");
    setTimeout(() => { try { p.kill("SIGKILL"); } catch {} done(); }, 8000).unref?.();
  });
  state = "stopped";
}

function startIdleTimer() {
  if (idleTimer || config.modelIdleS < 0) return;
  idleTimer = setInterval(async () => {
    if (config.modelIdleS === 0) {
      // unload the instant a request finishes
      if (state === "running" && Date.now() - lastUsedAt > 0) { await shutdown(); console.log("[model] unloaded (idle 0)"); }
      return;
    }
    if (state === "running" && Date.now() - lastUsedAt > config.modelIdleS * 1000) {
      await shutdown();
      console.log(`[model] unloaded after ${config.modelIdleS}s idle`);
    }
  }, 5000);
  idleTimer.unref?.();
}

export function modelStats() {
  return {
    state,
    spawns,
    idle_s: config.modelIdleS,
    resident: state === "running",
    last_used_at: lastUsedAt ? new Date(lastUsedAt).toISOString() : null,
    inferences: totalInferences,
    total_infer_ms: Math.round(totalInferMs),
  };
}

/** Auto-unload when the app is asked to stop everything. */
export function registerCleanup() {
  const stop = async () => { await shutdown(); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}