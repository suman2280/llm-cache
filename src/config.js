/**
 * Runtime configuration. All LLM_* env vars; defaults work out of the box.
 *
 * The build is deliberately memory-lean. Anything that costs RAM is
 * lazy-loaded and unloaded when idle -- see src/model.js and src/embedder.js.
 */

const REQUIRED = ["port", "redisUrl", "upstreamUrl", "modelIdleS"];

const env = (k, d) => (process.env[k] === undefined || process.env[k] === "" ? d : process.env[k]);
const envInt = (k, d) => Number.parseInt(env(k, String(d)), 10);
const envFloat = (k, d) => Number.parseFloat(env(k, String(d)));
const envBool = (k, d) => ["1", "true", "yes", "on"].includes(String(env(k, d)).toLowerCase());

export const config = {
  // ---- http ------------------------------------------------------------
  port: envInt("PORT", 8000),
  host: env("HOST", "127.0.0.1"),
  // Serves dashboard/ from the same origin -- the frozen UI's contract.
  // resolved relative to this file: src/ -> repo root -> dashboard/
  dashboardDir: env("DASHBOARD_DIR", new URL("../dashboard", import.meta.url).pathname),

  // ---- upstream model --------------------------------------------------
  upstreamUrl: env("UPSTREAM_URL", "http://127.0.0.1:8080"),
  upstreamKey: env("UPSTREAM_KEY", "local-dev-key"),
  model: env("MODEL_ID", "qwen2.5-7b-instruct"),
  modelTimeoutMs: envInt("MODEL_TIMEOUT_MS", 300_000),

  // The model supervisor: spawn on a real miss, kill after N idle seconds.
  // modelIdleS = 0 unloads immediately (max memory saving, every miss pays
  // the ~3s spawn); -1 never unloads (min latency). Default 120s.
  modelIdleS: envInt("MODEL_IDLE_S", 120),
  modelCommand: env("MODEL_CMD", ""), // empty => use defaults below
  modelCwd: env("MODEL_CWD", ""),
  llamaServerBin: env("LLAMA_SERVER_BIN", "/tmp/opencode/llamacpp-probe/build/bin/llama-server"),
  modelGguf: env("MODEL_GGUF", "/home/suman/Desktop/Project/llm-cache/models/qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf"),
  modelAdapter: env("MODEL_ADAPTER", "/home/suman/Desktop/Project/llm-cache/models/lora/aws-adapter.gguf"),
  // The adapter was fine-tuned at max_seq_len=512, but the BASE model handles
  // 32k positions. The grounding (reference chunks) needs room: three chunks
  // plus the question and a full answer is ~1600 tokens. 2048 keeps the KV
  // cache at ~115MB, which is a fair price for answers that are actually
  // specific.
  modelCtx: envInt("MODEL_CTX", 2048),
  modelThreads: envInt("MODEL_THREADS", 12),

  // ---- redis (vector index for the semantic tier) ----------------------
  redisUrl: env("REDIS_URL", "redis://127.0.0.1:6379/0"),
  redisKeyPrefix: env("REDIS_PREFIX", "vec"),
  vectorIndex: env("VECTOR_INDEX", "idx_content"),
  vectorDim: envInt("VECTOR_DIM", 384),
  // Cosine radius. Deliberately tight: the SOP's safety gate is the verifier,
  // and a loose radius is what the old build got wrong.
  distanceThreshold: envFloat("DISTANCE_THRESHOLD", 0.35),

  // ---- sqlite (durable cache, provenance, review state, events) --------
  dbPath: env("DB_PATH", new URL("../data/llm-cache.sqlite", import.meta.url).pathname),

  // ---- grounding --------------------------------------------------------
  // Reference chunks retrieved per request and folded into the system prompt.
  groundingTopK: envInt("GROUNDING_TOP_K", 3),
  // Floor on the answer length. Without grounding the model returned
  // 100-token summaries; with it, 3-6 sentences of specifics.
  // 400 completion tokens is ~50s at 7.5 tok/s -- a long miss, but a miss is
  // supposed to be long: that is what the cache exists to avoid. 700 was
  // ~90s and read as a hang.
  maxAnswerTokens: envInt("MAX_ANSWER_TOKENS", 400),
  // Start the assistant turn at "Key points:" so the model continues from a
  // bullet list instead of choosing to write one tight paragraph. Measured:
  // 236 tokens with the prefill, 65 without, and instructions alone ("write at
  // least 200 words", "use bullet points") are ignored by this 7B.
  answerPrefill: envBool("ANSWER_PREFILL", true),

  // ---- anti-repetition sampling ----------------------------------------
  // A 7B on a CPU will fall into a repetition loop and emit one line over and
  // over ("s3 HTTPS encryption" produced the same bullet 15 times).
  //
  // frequency_penalty and presence_penalty stop it, and -- importantly --
  // they do NOT cost answer length. Measured on "What are virtual machines?":
  //
  //   frequency + presence only            392 tokens, 17 bullets
  //   + repeat_penalty 1.15                 81 tokens,  4 bullets
  //   + DRY 0.8                            94 tokens,  4 bullets
  //
  // repeat_penalty and DRY penalise any repeated token sequence, and a bullet
  // list inherently repeats phrasing ("An instance...", "Instances...", "The
  // AMI..."), so they suppress the structure itself. Five runs of the question
  // that looped before were clean with frequency + presence alone, and
  // src/degenerate.js is the backstop for anything that slips through.
  //
  // The caller may override any of them per request.
  frequencyPenalty: envFloat("FREQUENCY_PENALTY", 0.4),
  presencePenalty: envFloat("PRESENCE_PENALTY", 0.3),
  repeatPenalty: envFloat("REPEAT_PENALTY", 1.0),
  dryMultiplier: envFloat("DRY_MULTIPLIER", 0.0),
  dryBase: envFloat("DRY_BASE", 1.75),
  dryAllowedLength: envInt("DRY_ALLOWED_LENGTH", 2),
  dryPenaltyLastN: envInt("DRY_PENALTY_LAST_N", 64),
  // A degenerate answer is retried once with a hotter sample and a different
  // seed. If it still degenerates it is NOT cached and the request fails.
  degenerateRetries: envInt("DEGENERATE_RETRIES", 1),

  // ---- domain guard ----------------------------------------------------
  // The fine-tune's model card promises it refuses out-of-domain questions.
  // Measured, it does not (0 of 6), so the proxy enforces it:
  //   off     no restriction
  //   bypass  out-of-domain requests are answered but NEVER cached
  //   strict  out-of-domain requests are refused with 422
  // The domain itself comes from the corpus (src/corpus.js DOMAIN).
  domainMode: env("DOMAIN_MODE", "strict"),

  // ---- governance ------------------------------------------------------
  // Only entries at or above this review_status may be served to the tutor
  // path. The SDK/content endpoints pass their own role.
  minReviewStatus: env("MIN_REVIEW_STATUS", "approved"),
  requireApproval: envBool("REQUIRE_APPROVAL", false),
  adminToken: env("ADMIN_TOKEN", ""),

  // ---- observability ---------------------------------------------------
  statsEventLimit: envInt("STATS_EVENT_LIMIT", 100),
  serviceName: env("SERVICE_NAME", "llm-cache"),
  serviceVersion: env("SERVICE_VERSION", "0.2.0"),

  // ---- embedder (lazy) --------------------------------------------------
  embedderModel: env("EMBEDDER_MODEL", "Xenova/all-MiniLM-L6-v2"),
  embedderIdleS: envInt("EMBEDDER_IDLE_S", 300),

  allowSeed: envBool("ALLOW_SEED", false),
};

REQUIRED.forEach((k) => {
  if (config[k] === undefined || config[k] === null) {
    throw new Error(`Missing required config: ${k}`);
  }
});

export default config;