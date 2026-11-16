#!/usr/bin/env bash
# Set up the inference layer: llama.cpp + the base GGUF + the adapter.
#
# Idempotent — safe to re-run. Keeps the build OUT of /tmp, because a reboot
# otherwise destroys ~10 minutes of compile work (learned the hard way).
#
#   bash scripts/setup_model.sh
#
# Memory note: llama.cpp MUST be configured with -DGGML_CPU_REPACK=OFF.
# With it on (the default), the 7B model exists twice in memory: 7.7 GB RSS.
# With it off: 4.6 GB RSS, ~110 MB of it anonymous, and identical tok/s.
# See docs/MODEL-FINDINGS.md.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLS_DIR="${LLM_TOOLS_DIR:-$HOME/llm-cache-tools}"
LLAMA_DIR="$TOOLS_DIR/llama.cpp"
MODELS_DIR="$REPO/models"
BASE_FILE="qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf"
BASE_URL="https://huggingface.co/Qwen/Qwen2.5-7B-Instruct-GGUF/resolve/main"
ADAPTER_REPO="Debarun12/aws-enterprise-assistant-qwen2.5-7b-qlora"

log() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

# ---- 1. llama.cpp ------------------------------------------------------
if [ ! -x "$LLAMA_DIR/build/bin/llama-server" ]; then
  log "building llama-server in $LLAMA_DIR"
  mkdir -p "$TOOLS_DIR"
  [ -d "$LLAMA_DIR/.git" ] || git clone --depth 1 https://github.com/ggml-org/llama.cpp "$LLAMA_DIR"
  cmake -B "$LLAMA_DIR/build" -S "$LLAMA_DIR" \
    -DCMAKE_BUILD_TYPE=Release \
    -DGGML_NATIVE=ON \
    -DGGML_CPU_REPACK=OFF \
    -DLLAMA_BUILD_SERVER=ON
  cmake --build "$LLAMA_DIR/build" --target llama-server -j"$(nproc)"
else
  log "llama-server already built: $LLAMA_DIR/build/bin/llama-server"
fi
"$LLAMA_DIR/build/bin/llama-server" --version 2>&1 | head -2 || true

# ---- 2. the base model (prebuilt GGUF: no 15GB conversion needed) ------
log "base model in $MODELS_DIR"
mkdir -p "$MODELS_DIR"
if [ -s "$MODELS_DIR/$BASE_FILE" ]; then
  echo "  already present: $BASE_FILE ($(du -h "$MODELS_DIR/$BASE_FILE" | cut -f1))"
else
  for f in qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf \
           qwen2.5-7b-instruct-q4_k_m-00002-of-00002.gguf; do
    echo "  downloading $f"
    curl -L --retry 3 -C - -o "$MODELS_DIR/$f" "$BASE_URL/$f"
  done
fi

# ---- 3. the LoRA adapter -> GGUF --------------------------------------
log "adapter in $MODELS_DIR/lora"
mkdir -p "$MODELS_DIR/lora"
if [ ! -s "$MODELS_DIR/lora/adapter_model.safetensors" ]; then
  for f in adapter_config.json adapter_model.safetensors tokenizer.json \
           tokenizer_config.json special_tokens_map.json merges.txt vocab.json \
           added_tokens.json; do
    curl -sL -o "$MODELS_DIR/lora/$f" \
      "https://huggingface.co/$ADAPTER_REPO/resolve/main/$f"
  done
  echo "  downloaded adapter ($(du -h "$MODELS_DIR/lora/adapter_model.safetensors" | cut -f1))"
fi

if [ ! -s "$MODELS_DIR/lora/aws-adapter.gguf" ]; then
  # torch-cpu lives in its own venv on a pinned Python: the system Python has
  # no torch wheels, and the project runtime is Node (no Python at all).
  log "converting adapter to GGUF (needs torch-cpu)"
  if [ ! -x "$TOOLS_DIR/loratools/bin/python" ]; then
    uv venv --clear --python 3.12 "$TOOLS_DIR/loratools"
    uv pip install --python "$TOOLS_DIR/loratools/bin/python" torch \
      --index-url https://download.pytorch.org/whl/cpu
    uv pip install --python "$TOOLS_DIR/loratools/bin/python" transformers safetensors gguf
  fi
  (
    cd "$LLAMA_DIR"
    "$TOOLS_DIR/loratools/bin/python" convert_lora_to_gguf.py \
      "$MODELS_DIR/lora" --outfile "$MODELS_DIR/lora/aws-adapter.gguf"
  )
else
  echo "  already converted: aws-adapter.gguf"
fi

log "done"

# Write a working .env so a fresh clone needs no manual path editing. Node's
# --env-file does NOT expand "~" or variables, so these must be absolute.
ENV_FILE="$REPO/.env"
if [ -f "$ENV_FILE" ]; then
  echo ""
  echo "A .env already exists; it was left alone. If the paths below differ from"
  echo "yours, update the three lines:"
  echo "  LLAMA_SERVER_BIN=$LLAMA_DIR/build/bin/llama-server"
  echo "  MODEL_GGUF=$MODELS_DIR/$BASE_FILE"
  echo "  MODEL_ADAPTER=$MODELS_DIR/lora/aws-adapter.gguf"
else
  cp "$REPO/.env.example" "$ENV_FILE"
  {
    echo ""
    echo "# --- paths written by scripts/setup_model.sh ---"
    echo "LLAMA_SERVER_BIN=$LLAMA_DIR/build/bin/llama-server"
    echo "MODEL_GGUF=$MODELS_DIR/$BASE_FILE"
    echo "MODEL_ADAPTER=$MODELS_DIR/lora/aws-adapter.gguf"
  } >> "$ENV_FILE"
  echo ""
  echo "Wrote $ENV_FILE with absolute paths for this machine."
fi

cat <<EOF

Next:
  bash scripts/dev.sh --wipe      # start Redis + the app
  node scripts/seed_corpus.mjs    # seed the demo corpus
  open http://localhost:8000/dashboard/
EOF