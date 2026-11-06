"""MiniLM embedder singleton (Phase 3). Not needed for the /stats UI phase."""
from __future__ import annotations


class EmbedderNotReady(RuntimeError):
    pass


def get_embedder() -> None:
    raise EmbedderNotReady("Embedder lands in Phase 3 (plan.md S15).")
