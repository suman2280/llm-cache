"""Cacheability guardrails (Phase 3). Placeholder for the UI phase.

Policy per plan.md S7: stream -> 400; tools/vision -> bypass uncached.
"""
from __future__ import annotations

from typing import Any


def is_cacheable(body: dict[str, Any]) -> tuple[bool, str | None]:
    """Return (cacheable, bypass_reason)."""
    if body.get("stream") is True:
        return False, "stream=true"
    if body.get("tools"):
        return False, "tools-present"
    for m in body.get("messages", []):
        content = m.get("content")
        if isinstance(content, list) and any(
            isinstance(p, dict) and p.get("type") in ("image_url", "input_audio")
            for p in content
        ):
            return False, "vision-content"
    return True, None
