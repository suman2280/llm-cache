"""Async client for Ollama's OpenAI-compatible API.

The proxy forwards the *original* request body unchanged on cache misses, so
Ollama stays the single source of API-shape truth.
"""

from __future__ import annotations

from typing import Any

import httpx


class OllamaError(RuntimeError):
    def __init__(self, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


class OllamaClient:
    def __init__(self, base_url: str, timeout_s: float = 600.0) -> None:
        self._client = httpx.AsyncClient(
            base_url=base_url.rstrip("/"),
            timeout=httpx.Timeout(timeout_s, connect=10.0),
        )

    async def chat_completions(self, body: dict[str, Any]) -> dict[str, Any]:
        try:
            resp = await self._client.post("/v1/chat/completions", json=body)
        except httpx.TimeoutException as exc:
            raise OllamaError(f"Ollama timed out: {exc}", status=504) from exc
        except httpx.HTTPError as exc:
            raise OllamaError(f"Ollama unreachable: {exc}", status=502) from exc
        if resp.status_code >= 400:
            raise OllamaError(
                f"Ollama returned {resp.status_code}: {resp.text[:500]}",
                status=resp.status_code,
            )
        return resp.json()

    async def models(self) -> dict[str, Any]:
        try:
            resp = await self._client.get("/v1/models")
        except httpx.HTTPError as exc:
            raise OllamaError(f"Ollama unreachable: {exc}", status=502) from exc
        if resp.status_code >= 400:
            raise OllamaError(f"Ollama returned {resp.status_code}", status=resp.status_code)
        return resp.json()

    async def get(self, path: str) -> httpx.Response:
        try:
            return await self._client.get(path)
        except httpx.HTTPError as exc:
            raise OllamaError(f"Ollama unreachable: {exc}", status=502) from exc

    async def reachable(self) -> bool:
        try:
            resp = await self._client.get("/api/version", timeout=2.0)
            return resp.status_code == 200
        except httpx.HTTPError:
            return False

    async def close(self) -> None:
        await self._client.aclose()
