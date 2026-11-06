"""Ollama httpx client (Phase 1 passthrough). Placeholder for the UI phase."""
from __future__ import annotations


class OllamaClient:
    def __init__(self, base_url: str = "http://localhost:11434") -> None:
        self.base_url = base_url.rstrip("/")
