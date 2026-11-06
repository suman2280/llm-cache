"""Request canonicalization for exact-tier hashing (Phase 2). Placeholder."""
from __future__ import annotations

import hashlib
import json


def canonical_hash(model: str, messages: list, params: dict | None = None) -> str:
    payload = json.dumps(
        {"model": model, "messages": messages, "params": params or {}},
        sort_keys=True, separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode()).hexdigest()
