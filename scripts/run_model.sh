#!/usr/bin/env bash
# Run llama-server standalone with the base model + the AWS-QLoRA adapter.
#
# The app can ALSO spawn this itself (MODEL_IDLE_S); this script is for
# inspecting the model directly, benchmarking it, or pinning it resident with
# MODEL_IDLE_S=-1.
#
#   bash scripts/run_model.sh
#
# Memory: configured for the smallest honest footprint. See the flags in
# scripts/setup_model.sh -- GGML_CPU_REPACK must be OFF or the 7B model exists
# twice in memory.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLS_DIR="${LLM_TOOLS_DIR:-$HOME/llm-cache-tools}"
LLAMA_DIR="$TOOLS_DIR/llama.cpp"
PORT="${UPSTREAM_URL_PORT:-8080}"

[ -x "$LLAMA_DIR/build/bin/llama-server" ] || {
  echo "llama-server not built. Run: bash scripts/setup_model.sh" >&2; exit 1;
}

exec "$LLAMA_DIR/build/bin/llama-server" \
  -m "$REPO/models/qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf" \
  --lora-scaled "$REPO/models/lora/aws-adapter.gguf:1.0" \
  --host 127.0.0.1 --port "$PORT" \
  -c "${MODEL_CTX:-512}" \
  --threads "${MODEL_THREADS:-12}" \
  --parallel 1 -ngl 0 --no-warmup \
  --api-key "${UPSTREAM_KEY:-local-dev-key}"