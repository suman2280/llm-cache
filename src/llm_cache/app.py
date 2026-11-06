"""FastAPI application entrypoint.

Run:  uvicorn llm_cache.app:app --reload --port 8000
      (dashboard at http://localhost:8000/dashboard/)
"""
from __future__ import annotations

import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from .config import Settings, load_settings
from .routes import init_routers
from .store import StatsStore


def create_app(settings: Settings | None = None, store: StatsStore | None = None) -> FastAPI:
    settings = settings or load_settings()
    started_at = time.time()
    store = store or StatsStore(redis_url=settings.redis_url)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.settings = settings
        app.state.store = store
        app.state.started_at = started_at
        yield

    app = FastAPI(
        title="llm-cache",
        version=settings.version,
        description="Offline OpenAI-compatible caching proxy (exact + semantic).",
        lifespan=lifespan,
    )
    app.state.settings = settings
    app.state.store = store
    app.state.started_at = started_at

    app.include_router(init_routers(settings, store, started_at))

    # Serve dashboard/ statically (UI plan U5). Path is repo-root/dashboard
    # in dev, and packaged alongside source in any future wheel layout.
    dashboard_dir = Path(__file__).resolve().parents[2] / "dashboard"
    if dashboard_dir.is_dir():
        app.mount("/dashboard", StaticFiles(directory=str(dashboard_dir), html=True),
                  name="dashboard")

    @app.get("/", include_in_schema=False)
    def root() -> dict:
        return {
            "service": settings.name,
            "version": settings.version,
            "health": "/healthz",
            "stats": "/stats",
            "dashboard": "/dashboard/",
        }

    return app


app = create_app()
