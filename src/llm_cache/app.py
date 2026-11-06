"""FastAPI application factory.

``app`` is the production entrypoint (``uvicorn llm_cache.app:app``); the
dashboard is mounted at ``/dashboard/`` (docs/ui-plan.md U5).

``create_app()`` accepts injected components so tests can run without Redis,
Ollama, or the embedding model.
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import redis
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from . import routes
from .config import Settings, get_settings
from .ollama import OllamaClient
from .store import RedisCache


def create_app(
    settings: Settings | None = None,
    store: Any = None,
    embedder: Any = None,
    ollama: Any = None,
) -> FastAPI:
    settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.settings = settings
        if embedder is not None:
            app.state.embedder = embedder
        else:
            from .embedder import Embedder

            app.state.embedder = await asyncio.to_thread(Embedder, settings.embedding_model)
        if store is not None:
            app.state.store = store
        else:
            client = redis.Redis.from_url(settings.redis_url, decode_responses=True)
            cache_instance = RedisCache(client, settings)
            cache_instance.ensure_index(app.state.embedder.dim)
            app.state.store = cache_instance
        if ollama is not None:
            app.state.ollama = ollama
        else:
            app.state.ollama = OllamaClient(settings.ollama_base_url, settings.ollama_timeout_s)
        yield
        if isinstance(app.state.ollama, OllamaClient):
            await app.state.ollama.close()

    app = FastAPI(
        title="llm-cache",
        version=settings.version,
        description="Offline OpenAI-compatible caching proxy (exact + semantic).",
        lifespan=lifespan,
    )
    # Eagerly expose injected components so TestClient fixtures that never enter
    # the lifespan context still work; the lifespan (re)assigns everything.
    app.state.settings = settings
    if store is not None:
        app.state.store = store
    if embedder is not None:
        app.state.embedder = embedder
    if ollama is not None:
        app.state.ollama = ollama
    app.include_router(routes.router)

    # Dashboard: vanilla HTML/CSS/JS served from repo-root/dashboard/.
    dashboard_dir = Path(__file__).resolve().parents[2] / "dashboard"
    if dashboard_dir.is_dir():
        app.mount("/dashboard", StaticFiles(directory=str(dashboard_dir), html=True),
                  name="dashboard")

    @app.get("/", include_in_schema=False)
    def root() -> dict[str, Any]:
        return {
            "service": settings.name,
            "version": settings.version,
            "health": "/healthz",
            "stats": "/stats",
            "chat": "/v1/chat/completions",
            "dashboard": "/dashboard/",
        }

    return app


app = create_app()
