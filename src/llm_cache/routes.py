"""HTTP routes for llm-cache.

Implemented now (UI phase): GET /healthz, GET /stats, POST /stats/reset,
POST /stats/record-event (demo/dev, gated by LLM_CACHE_ALLOW_SEED=1).
Deferred to later phases (plan.md): /v1/chat/completions, /v1/models.
"""
from __future__ import annotations

import os
from typing import Any

from fastapi import APIRouter, HTTPException

from .config import Settings
from .store import StatsStore, build_stats_payload

START_TIME = {"t0": 0.0}


def init_routers(settings: Settings, store: StatsStore, started_at: float) -> APIRouter:
    START_TIME["t0"] = started_at

    api = APIRouter()

    @api.get("/healthz")
    def healthz() -> dict:
        return {"status": "ok", "service": settings.name, "version": settings.version}

    @api.get("/stats")
    def get_stats() -> dict:
        return build_stats_payload(settings, store, START_TIME["t0"])

    @api.post("/stats/reset")
    def post_stats_reset() -> dict:
        store.reset()
        return build_stats_payload(settings, store, START_TIME["t0"])

    @api.post("/stats/record-event")
    def post_record_event(body: dict[str, Any]) -> dict:
        """Dev/demo helper (UI validation U-4): record one event.

        Gated by LLM_CACHE_ALLOW_SEED=1 so production never exposes it.
        """
        if os.environ.get("LLM_CACHE_ALLOW_SEED") != "1":
            raise HTTPException(status_code=404, detail="demo seed disabled")
        status = body.get("status", "miss")
        if status not in ("miss", "exact-hit", "semantic-hit", "bypass", "error"):
            raise HTTPException(status_code=400, detail="invalid status")
        store.record_event(
            status=status,
            model=body.get("model", settings.model),
            similarity=body.get("similarity"),
            threshold=body.get("threshold", settings.distance_threshold),
            latency_ms=body.get("latency_ms", 10),
            embed_ms=body.get("embed_ms", 2),
            redis_ms=body.get("redis_ms", 1),
            prompt_preview=body.get("prompt_preview", "demo prompt"),
        )
        return build_stats_payload(settings, store, START_TIME["t0"])

    return api


# Backwards-compatible default router (no state) for tools that import it directly.
import time
router = init_routers(Settings(), StatsStore(), time.time())
