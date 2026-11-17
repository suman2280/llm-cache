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
 *   MODEL_IDLE_S = 120  kill after 2 idle minutes (default)
 *   MODEL_IDLE_S = 0    kill immediately after each request (max saving)
 *   MODEL_IDLE_S = -1   never kill (min latency)
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

/**
 * Start the model once. All concurrent callers join `startingPromise`, so a
 * burst of cold misses cannot spawn two ~4.6 GB processes and orphan one.
 * A child that exits during startup is a TERMINAL error: the old loop reset
 * `stopped` back to `starting`, so every request waited the full 90-120 s
 * even though the model was already dead.
 */
let startingPromise = null;
let startupError = null;

async function startModel() {
  const t0 = Date.now();
  const [bin, ...args] = config.modelCommand ? config.modelCommand.split(" ") : defaultCmd();
  let child;
  try {
    child = spawn(bin, args, {
      cwd: config.modelCwd || undefined,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, LLAMA_API_KEY: config.upstreamKey },
    });
  } catch (err) {
    throw new Error(`model spawn failed: ${err.message}`);
  }

  proc = child;
  let exited = false;
  let out = "";
  const collect = (d) => { out = (out + d.toString()).slice(-4000); };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  child.on("exit", (code) => {
    console.log(`[model] exited (code ${code}) after ${Date.now() - t0} ms`);
    collect(`\n[model exited with code ${code}]`);
    exited = true;
    if (proc === child) { proc = null; }
    if (state === "starting") state = "stopped";
  });

  spawns += 1;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (exited) break; // fail fast, never wait out the timeout on a dead child
    if (await healthy()) {
      state = "running";
      lastUsedAt = Date.now();
      console.log(`[model] ready in ${Date.now() - t0} ms (spawn #${spawns})`);
      startIdleTimer();
      return config.upstreamUrl;
    }
    await sleep(300);
  }

  if (exited) {
    throw new Error(`model exited during startup: ${out.slice(-500)}`);
  }
  await shutdown();
  throw new Error(`model did not become healthy within 120s.\n${out.slice(-500)}`);
}

export async function ensureModel() {
  if (state === "running" && proc) {
    lastUsedAt = Date.now();
    return config.upstreamUrl;
  }
  if (startingPromise) {
    try {
      await startingPromise;
    } catch (err) {
      throw err;
    }
    if (state === "running") { lastUsedAt = Date.now(); return config.upstreamUrl; }
    throw startupError ?? new Error("model did not start");
  }

  // #49: the guard is installed SYNCHRONOUSLY before any await. Previously
  // `await healthy()` ran before the guard, so two concurrent callers could
  // both observe "stopped" and both spawn a ~4.6 GB process.
  state = "starting";   // synchronous, no await yet
  startupError = null;
  const promise = (async () => {
    // An already-running external server needs no spawn.
    if (await healthy()) {
      state = "running";
      lastUsedAt = Date.now();
      return config.upstreamUrl;
    }
    const url = await startModel();
    return url;
  })();
  startingPromise = promise;
  try {
    const url = await promise;
    return url;
  } catch (err) {
    startupError = err;
    state = "stopped";
    throw err;
  } finally {
    startingPromise = null;
  }
}

/**
 * Run inference and account for it.
 *
 * `prefill` starts the assistant turn so the model continues from it instead
 * of choosing where to start -- see src/knowledge.js PREFILL. llama.cpp needs
 * continue_final_message with add_generation_prompt: false; setting both
 * flags is an error.
 */
export async function infer(body, { maxTokens, prefill } = {}) {
  const base = await ensureModel();
  const t0 = performance.now();
  const payload = { ...body };
  // #41: clamp ALWAYS. The old fallback only applied when the caller omitted
  // max_tokens, so a body value of 100000 still reached the model and could
  // occupy the single inference slot for the full timeout.
  const ceiling = config.maxAnswerTokens * 2;
  const requested = Number(payload.max_tokens ?? maxTokens ?? 0);
  if (requested > 0) payload.max_tokens = Math.min(requested, ceiling);

  // Anti-repetition sampling. The caller may set any of these; the defaults
  // only fill in what the caller left out.
  const sampler = {
    frequency_penalty: config.frequencyPenalty,
    presence_penalty: config.presencePenalty,
    repeat_penalty: config.repeatPenalty,
    dry_multiplier: config.dryMultiplier,
    dry_base: config.dryBase,
    dry_allowed_length: config.dryAllowedLength,
    dry_penalty_last_n: config.dryPenaltyLastN,
  };
  for (const [k, v] of Object.entries(sampler)) {
    if (payload[k] === undefined) payload[k] = v;
  }
  if (prefill) {
    payload.messages = [
      ...(Array.isArray(payload.messages) ? payload.messages : []),
      { role: "assistant", content: prefill },
    ];
    payload.continue_final_message = true;
    payload.add_generation_prompt = false;
  }
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