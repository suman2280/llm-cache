"""Runtime configuration.

All settings are overridable via environment variables prefixed with
``LLM_CACHE_`` (e.g. ``LLM_CACHE_DISTANCE_THRESHOLD=0.12``) or a local ``.env``.

The ``service``-identity fields (name, version, model, ttl_s) are surfaced
verbatim in ``GET /stats`` so a dashboard stays truthful (docs/ui-plan.md §3).
"""

from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="LLM_CACHE_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # Service identity (also reported by /stats)
    name: str = "llm-cache"
    version: str = "0.1.0"
    model: str = "llama3.2:3b"

    # Redis
    redis_url: str = "redis://localhost:6379/0"
    cache_prefix: str = "sem"
    stats_prefix: str = "stats"
    stats_event_limit: int = 100
    ttl_s: int = 86_400

    # Ollama (native on the host)
    ollama_base_url: str = "http://localhost:11434"
    ollama_timeout_s: float = 600.0
    app_base_url: str = "http://localhost:8000"

    # Embedding / semantic tier
    embedding_model: str = "sentence-transformers/all-MiniLM-L6-v2"
    # Cosine radius for the semantic tier. Calibrated on the bundled dataset
    # (docs/validation.md E0 + the benchmark in results/): rephrases cluster
    # <=0.21 while the nearest off-topic distractor sits at 0.62 -> 0.20 hits
    # ~93% with 0% false positives on the reference machine.
    distance_threshold: float = 0.20

    # Redis Search index
    index_name: str = "idx_llm_cache"

    # Demo/dev: gated POST /stats/record-event for dashboard seeding.
    allow_seed: bool = False


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
