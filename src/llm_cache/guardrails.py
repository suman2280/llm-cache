"""Cacheability policy for incoming /v1/chat/completions requests.

MVP policy is deliberately permissive ("cache everything") *except* where
caching would be outright wrong:

- ``stream: true``            -> rejected up front (MVP is non-streaming only)
- tool calls / tool_choice    -> not cached (tool output changes with the world)
- no extractable user text    -> not cached (vision-only / empty prompts)

Everything else (including temperature > 0) is cached; the response always
carries ``X-Cache-Status``/``X-Cache-Policy`` headers so the caller knows.
"""

from __future__ import annotations

from dataclasses import dataclass

from .canonical import last_user_text


@dataclass(frozen=True)
class Policy:
    cacheable: bool
    reason: str | None


def evaluate_cacheability(body: dict) -> Policy:
    if body.get("tools"):
        return Policy(False, "tools")
    if body.get("tool_choice"):
        return Policy(False, "tool_choice")

    messages = body.get("messages")
    if not isinstance(messages, list) or not messages:
        return Policy(False, "no_messages")
    if not body.get("model"):
        return Policy(False, "no_model")
    if last_user_text(messages) is None:
        return Policy(False, "no_user_text")
    return Policy(True, None)
