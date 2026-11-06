"""Canonical request serialization for the exact-match tier.

The exact tier must key on *everything that can change the answer*: model,
messages, and the sampling params. Anything else (boilerplate, unknown future
fields) is ignored deliberately so that semantically identical requests hit.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

# Only these request params are hashed: they are the OpenAI-compatible sampling
# fields Ollama documents support for (docs.ollama.com/openai).
CACHEABLE_PARAMS = (
    "temperature",
    "top_p",
    "max_tokens",
    "seed",
    "stop",
    "frequency_penalty",
    "presence_penalty",
    "response_format",
)


def canonical_request_hash(model: str, messages: list[dict], body: dict[str, Any]) -> str:
    """Stable sha256 over (model, messages, cacheable sampling params)."""
    params = {k: body[k] for k in CACHEABLE_PARAMS if k in body}
    payload = {"model": model, "messages": messages, "params": params}
    blob = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def last_user_text(messages: list[dict]) -> str | None:
    """Text content of the last user message, or None if it has no text.

    OpenAI messages can carry ``content`` as a plain string or as a list of
    typed parts (``{"type": "text", "text": ...}`` / image parts). The semantic
    tier embeds this text only.
    """
    for msg in reversed(messages):
        if msg.get("role") != "user":
            continue
        content = msg.get("content")
        if isinstance(content, str):
            return content if content.strip() else None
        if isinstance(content, list):
            texts = [
                part["text"]
                for part in content
                if isinstance(part, dict) and part.get("type") == "text" and part.get("text")
            ]
            joined = "\n".join(texts)
            return joined if joined.strip() else None
    return None


def normalize_prompt_text(text: str) -> str:
    """Whitespace-insensitive form used for the semantic doc key.

    "What  is Redis?" and "What is Redis?" map to the same document so a
    semantically identical restatement updates the cached answer instead of
    creating a duplicate entry in the vector pool.
    """
    return " ".join(text.split())


def semantic_doc_key(model: str, prompt: str) -> str:
    """Redis key for the vector document: one per (model, normalized prompt)."""
    normalized = normalize_prompt_text(prompt)
    digest = hashlib.sha256(f"{model}\x00{normalized}".encode()).hexdigest()
    return digest


def model_tag(model: str) -> str:
    """TAG-safe stand-in for a model name.

    Model names contain syntax characters (`.`, `:`) that would need escaping
    inside a Redis tag term, so we index a hex digest instead.
    """
    return hashlib.sha256(model.encode("utf-8")).hexdigest()[:16]


def temperature_class(body: dict) -> str:
    """Deterministic vs sampled answers: semantic reuse never crosses this.

    ``t0``    -> temperature is absent/0 (deterministic)
    ``thot``  -> temperature > 0 (sampled; answers legitimately vary)

    Serving a t0 answer for a thot request (or vice versa) would be silently
    wrong, so the class is a hard filter on the semantic tier. The exact tier
    already keys on the full params, so it is unaffected.
    """
    temp = body.get("temperature", 0) or 0
    return "t0" if float(temp) == 0.0 else "thot"
