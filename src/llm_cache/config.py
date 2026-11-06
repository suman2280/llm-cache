"""Runtime configuration for llm-cache.

All settings are env-overridable. Contract per docs/ui-plan.md U3:
service.name/version/model/embedder/distance_threshold/ttl_s are
surfaced verbatim in GET /stats so the dashboard stays truthful.
"""
from __future__ import annotations

import os
from dataclasses import dataclass


def _env(name: str, default: str) -> str:
    return os.environ.get(name, default)


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return default


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


@dataclass(frozen=True)
class Settings:
    name: str = "llm-cache"
    version: str = "0.1.0"
    model: str = "llama3.2:3b"
    embedder: str = "sentence-transformers/all-MiniLM-L6-v2"
    distance_threshold: float = 0.10
    ttl_s: int = 86400
    redis_url: str = "redis://localhost:6379/0"
    ollama_base_url: str = "http://localhost:11434"
    app_base_url: str = "http://localhost:8000"


def load_settings() -> Settings:
    return Settings(
        name=_env("LLM_CACHE_NAME", "llm-cache"),
        version=_env("LLM_CACHE_VERSION", "0.1.0"),
        model=_env("LLM_CACHE_MODEL", "llama3.2:3b"),
        embedder=_env("LLM_CACHE_EMBEDDER", "sentence-transformers/all-MiniLM-L6-v2"),
        distance_threshold=_env_float("LLM_CACHE_DISTANCE_THRESHOLD", 0.10),
        ttl_s=_env_int("LLM_CACHE_TTL_S", 86400),
        redis_url=_env("LLM_CACHE_REDIS_URL", "redis://localhost:6379/0"),
        ollama_base_url=_env("LLM_CACHE_OLLAMA_BASE_URL", "http://localhost:11434"),
        app_base_url=_env("LLM_CACHE_APP_BASE_URL", "http://localhost:8000"),
    )
