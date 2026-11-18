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

/** #68: exported so spawn args (incl. prefix caching) are testable. */
export function defaultCmd() {
  const args = [
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
  // #68/#74: llama.cpp enables prompt caching by DEFAULT, so disabling the
  // knob must pass the explicit off switch -- omitting the flag was inert.
  args.push(config.modelCachePrompt ? "--cache-prompt" : "--no-cache-prompt");
  return args;
}

/** Extract prefill/decode timing + token counts from an upstream response. */
export function extractTimings(json, wallStart) {
  const u = json?.usage || {};
  const t = json?.timings || {};
  const now = performance.now();
  const cached = u.prompt_tokens_details?.cached_tokens
    ?? u.cached_tokens ?? t.cached_n ?? null;
  return {
    // llama.cpp reports prompt_ms / predicted_ms; OpenAI-compatible servers
    // may not, in which case these stay null rather than being invented.
    prompt_eval_ms: numOrNull(t.prompt_ms ?? u.prompt_eval_ms),
    eval_ms: numOrNull(t.predicted_ms ?? u.eval_ms),
    ttft_ms: numOrNull(t.prompt_ms ?? u.ttft_ms),
    prompt_tokens: numOrNull(u.prompt_tokens ?? t.prompt_n),
    completion_tokens: numOrNull(u.completion_tokens ?? t.predicted_n),
    cached_tokens: numOrNull(cached),
    wall_ms: Math.round(now - wallStart),
  };
}
function numOrNull(v) { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) / 100 : null; }

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

let _inferForTests = null;
/** Test seam: replace inference with a deterministic stub (no spawn/fetch). */
export function setInferForTests(fn) { _inferForTests = fn; }

/**
 * Run inference and account for it.
 *
 * `prefill` starts the assistant turn so the model continues from it instead
 * of choosing where to start -- see src/knowledge.js PREFILL. llama.cpp needs
 * continue_final_message with add_generation_prompt: false; setting both
 * flags is an error.
 */
export async function infer(body, { maxTokens, prefill } = {}) {
  if (_inferForTests) {
    const t0 = performance.now();
    const out = await _inferForTests(body, { maxTokens, prefill });
    totalInferMs += performance.now() - t0;
    totalInferences += 1;
    lastUsedAt = Date.now();
    return { ...out, _timings: out._timings || extractTimings(out, t0) };
  }
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
    return { ...json, _timings: extractTimings(json, t0) };
  } finally {
    lastUsedAt = Date.now();
  }
}

/**
 * #62: stream inference from the upstream (OpenAI-compatible SSE), invoking
 * `onDelta(text)` for each content delta. Returns a normal completion object
 * whose message content is the accumulated text, so the caller can run the
 * same degeneracy/grounding checks and cache write-back as the non-streaming
 * path. Accounters are updated once, on completion.
 */
export async function inferStream(body, { maxTokens, prefill } = {}, onDelta = () => {}) {
  if (_inferForTests) {
    const t0 = performance.now();
    // #71: pass the delta sink to the stub so tests can emit tokens
    // incrementally. A stub that returns message content still emits it once.
    const out = await _inferForTests(body, { maxTokens, prefill }, onDelta);
    totalInferMs += performance.now() - t0;
    totalInferences += 1;
    lastUsedAt = Date.now();
    const text = out?.choices?.[0]?.message?.content ?? "";
    if (text) onDelta(text);
    return { ...out, _timings: out._timings || extractTimings(out, t0) };
  }
  const base = await ensureModel();
  const t0 = performance.now();
  const payload = { ...body, stream: true };
  const ceiling = config.maxAnswerTokens * 2;
  const requested = Number(payload.max_tokens ?? maxTokens ?? 0);
  if (requested > 0) payload.max_tokens = Math.min(requested, ceiling);
  const sampler = {
    frequency_penalty: config.frequencyPenalty,
    presence_penalty: config.presencePenalty,
    repeat_penalty: config.repeatPenalty,
    dry_multiplier: config.dryMultiplier,
    dry_base: config.dryBase,
    dry_allowed_length: config.dryAllowedLength,
    dry_penalty_last_n: config.dryPenaltyLastN,
  };
  for (const [k, v] of Object.entries(sampler)) if (payload[k] === undefined) payload[k] = v;
  if (prefill) {
    payload.messages = [...(Array.isArray(payload.messages) ? payload.messages : []),
      { role: "assistant", content: prefill }];
    payload.continue_final_message = true;
    payload.add_generation_prompt = false;
  }

  try {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.upstreamKey}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(config.modelTimeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`upstream ${res.status}: ${text.slice(0, 300)}`);
    }
    const reader = res.body?.getReader();
    if (!reader) throw new Error("upstream returned no stream body");
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let finishReason = "stop";
    let firstDeltaMs = null; // #68: time-to-first-token on the warm prefix
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          let obj;
          try { obj = JSON.parse(data); } catch { continue; }
          const delta = obj?.choices?.[0]?.delta?.content ?? "";
          if (delta) {
            if (firstDeltaMs === null) firstDeltaMs = performance.now() - t0;
            content += delta; onDelta(delta);
          }
          if (obj?.choices?.[0]?.finish_reason) finishReason = obj.choices[0].finish_reason;
        }
      }
    }
    totalInferMs += performance.now() - t0;
    totalInferences += 1;
    return {
      id: `stream-${Date.now().toString(36)}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: payload.model || config.model,
      choices: [{ index: 0, finish_reason: finishReason, message: { role: "assistant", content } }],
      _timings: { ...extractTimings({}, t0), ttft_ms: firstDeltaMs ?? null },
    };
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