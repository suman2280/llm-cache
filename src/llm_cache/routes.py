"""HTTP routes: OpenAI-compatible proxy + cache + stats."""

from __future__ import annotations

import json
import logging
import os
import time
from typing import Any

import redis
from fastapi import APIRouter, Body, HTTPException, Request
from fastapi.responses import JSONResponse

from .canonical import (
    canonical_request_hash,
    last_user_text,
    model_tag,
    semantic_doc_key,
    temperature_class,
)
from .guardrails import evaluate_cacheability
from .ollama import OllamaError

router = APIRouter()

_STATUS_HEADERS = {
    "miss": "miss",
    "exact-hit": "exact-hit",
    "semantic-hit": "semantic-hit",
    "bypass": "bypass",
    "error": "error",
}


def _cache_headers(
    status: str,
    latency_ms: float,
    similarity: float | None = None,
    embed_ms: float | None = None,
    redis_ms: float | None = None,
    policy: str | None = None,
) -> dict[str, str]:
    headers = {
        "X-Cache-Status": status,
        "X-Cache-Latency-Ms": f"{latency_ms:.1f}",
        "X-Served-By": "llm-cache",
    }
    if similarity is not None:
        headers["X-Cache-Similarity"] = f"{float(similarity):.4f}"
    if embed_ms is not None:
        headers["X-Embed-Ms"] = f"{embed_ms:.1f}"
    if redis_ms is not None:
        headers["X-Redis-Ms"] = f"{redis_ms:.1f}"
    if policy:
        headers["X-Cache-Policy"] = policy
    return headers


@router.post("/v1/chat/completions")
async def chat_completions(
    request: Request, body: dict[str, Any] = Body(...)  # noqa: B008 - FastAPI idiom
) -> JSONResponse:
    app = request.app
    store = app.state.store
    embedder = app.state.embedder
    ollama = app.state.ollama
    settings = app.state.settings

    started = time.perf_counter()

    if body.get("stream"):
        raise HTTPException(
            status_code=400,
            detail=(
                "stream=true is not supported in this MVP (see docs/plan.md §9). "
                "Send stream=false, or plan future streaming support."
            ),
        )

    try:
        policy = evaluate_cacheability(body)
    except (TypeError, ValueError) as exc:  # malformed body shapes
        raise HTTPException(status_code=400, detail=f"malformed request: {exc}") from exc

    # --- Uncacheable: pass through to Ollama, label the response -----------
    if not policy.cacheable:
        try:
            upstream = await ollama.chat_completions(body)
        except OllamaError as exc:
            store.record_event(
                "error",
                latency_ms=(time.perf_counter() - started) * 1000,
                model=body.get("model"),
                reason=str(exc),
            )
            raise HTTPException(status_code=exc.status or 502, detail=str(exc)) from exc
        latency_ms = (time.perf_counter() - started) * 1000
        store.record_event(
            "bypass",
            latency_ms=latency_ms,
            model=body.get("model"),
            reason=policy.reason,
            prompt_preview=_preview(body),
        )
        return JSONResponse(
            upstream,
            headers=_cache_headers("bypass", latency_ms, policy=policy.reason),
        )

    model = body["model"]
    messages = body["messages"]

    # --- Tier 1: exact hash --------------------------------------------------
    redis_started = time.perf_counter()
    req_hash = canonical_request_hash(model, messages, body)
    stored_response = store.lookup_exact(req_hash)
    redis_ms = (time.perf_counter() - redis_started) * 1000
    if stored_response is not None:
        latency_ms = (time.perf_counter() - started) * 1000
        store.record_event(
            "exact-hit",
            latency_ms=latency_ms,
            model=model,
            redis_ms=redis_ms,
            prompt_preview=_preview(body),
        )
        return JSONResponse(
            json.loads(stored_response),
            headers=_cache_headers("exact-hit", latency_ms, redis_ms=redis_ms),
        )

    # --- Tier 2: semantic range ----------------------------------------------
    prompt = last_user_text(messages) or ""
    embed_started = time.perf_counter()
    vec = embedder.embed(prompt)
    embed_ms = (time.perf_counter() - embed_started) * 1000

    redis_started = time.perf_counter()
    similar = store.lookup_similar(
        embedder.to_bytes(vec), radius=settings.distance_threshold,
        mtag=model_tag(model), tclass=temperature_class(body),
    )
    redis_ms = (time.perf_counter() - redis_started) * 1000
    if similar is not None:
        latency_ms = (time.perf_counter() - started) * 1000
        store.record_event(
            "semantic-hit",
            latency_ms=latency_ms,
            model=model,
            similarity=similar.get("similarity"),
            threshold=settings.distance_threshold,
            embed_ms=embed_ms,
            redis_ms=redis_ms,
            prompt_preview=prompt,
        )
        headers = _cache_headers(
            "semantic-hit", latency_ms, similarity=similar.get("similarity"),
            embed_ms=embed_ms, redis_ms=redis_ms,
        )
        headers["X-Cache-Source-Prompt"] = (similar.get("prompt") or "")[:120]
        return JSONResponse(json.loads(similar["response"]), headers=headers)

    # --- Miss: forward, store, record ----------------------------------------
    try:
        upstream = await ollama.chat_completions(body)
    except OllamaError as exc:
        store.record_event(
            "error",
            latency_ms=(time.perf_counter() - started) * 1000,
            model=model,
            reason=str(exc),
        )
        raise HTTPException(status_code=exc.status or 502, detail=str(exc)) from exc

    try:
        store.store(
            doc_key=semantic_doc_key(model, prompt),
            req_hash=req_hash,
            model=model,
            prompt=prompt,
            response_json=json.dumps(upstream),
            vec_bytes=embedder.to_bytes(vec),
            mtag=model_tag(model),
            tclass=temperature_class(body),
        )
    except redis.RedisError as exc:
        # A storage failure must never fail the user's request.
        logging.getLogger("llm_cache").warning("cache store failed: %s", exc)

    latency_ms = (time.perf_counter() - started) * 1000
    store.record_event(
        "miss",
        latency_ms=latency_ms,
        model=model,
        threshold=settings.distance_threshold,
        embed_ms=embed_ms,
        redis_ms=redis_ms,
        prompt_preview=prompt,
    )
    return JSONResponse(
        upstream,
        headers=_cache_headers(
            "miss", latency_ms, embed_ms=embed_ms, redis_ms=redis_ms
        ),
    )


@router.get("/v1/models")
async def list_models(request: Request) -> JSONResponse:
    ollama = request.app.state.ollama
    try:
        return JSONResponse(await ollama.models())
    except OllamaError as exc:
        raise HTTPException(status_code=exc.status or 502, detail=str(exc)) from exc


@router.get("/v1/models/{model:path}")
async def get_model(request: Request, model: str) -> JSONResponse:
    ollama = request.app.state.ollama
    resp = await ollama.get(f"/v1/models/{model}")
    return JSONResponse(resp.json(), status_code=resp.status_code)


@router.get("/healthz")
async def healthz(request: Request) -> JSONResponse:
    app = request.app
    store = app.state.store
    memory_mode = bool(getattr(store, "memory_mode", False))
    try:
        redis_ok = bool(store.r.ping())
    except redis.RedisError:
        redis_ok = False
    embedder_ok = app.state.embedder is not None
    ollama_ok = await app.state.ollama.reachable()
    # A store in memory-mode is healthy for stats (the cache passes through).
    backend_ok = redis_ok or memory_mode
    status = "ok" if (backend_ok and embedder_ok and ollama_ok) else "degraded"
    return JSONResponse(
        {
            "status": status,
            "checks": {
                "redis": redis_ok,
                "stats_memory_fallback": memory_mode,
                "embedder": embedder_ok,
                "ollama": ollama_ok,
            },
        },
        status_code=200 if status == "ok" else 503,
    )


@router.get("/stats")
async def get_stats(request: Request) -> JSONResponse:
    return JSONResponse(request.app.state.store.get_stats())


@router.post("/stats/reset")
async def reset_stats(request: Request) -> JSONResponse:
    return JSONResponse(request.app.state.store.reset_stats())


@router.post("/stats/record-event")
async def record_demo_event(
    request: Request, body: dict[str, Any] = Body(...)  # noqa: B008 - FastAPI idiom
) -> JSONResponse:
    """Demo/dev helper: record one stats event so the dashboard can be exercised
    without a model. Gated by LLM_CACHE_ALLOW_SEED=1 (never on in production).
    """
    if not request.app.state.settings.allow_seed or os.environ.get("LLM_CACHE_ALLOW_SEED") != "1":
        raise HTTPException(status_code=404, detail="demo seed disabled")
    status = body.get("status", "miss")
    if status not in ("miss", "exact-hit", "semantic-hit", "bypass", "error"):
        raise HTTPException(status_code=400, detail="invalid status")
    request.app.state.store.record_event(
        status=status,
        latency_ms=body.get("latency_ms", 10),
        model=body.get("model", request.app.state.settings.model),
        similarity=body.get("similarity"),
        threshold=body.get("threshold", request.app.state.settings.distance_threshold),
        embed_ms=body.get("embed_ms", 2),
        redis_ms=body.get("redis_ms", 1),
        prompt_preview=body.get("prompt_preview", "demo prompt"),
    )
    return JSONResponse(request.app.state.store.get_stats())


def _preview(body: dict[str, Any]) -> str:
    try:
        return last_user_text(body.get("messages") or []) or ""
    except (TypeError, ValueError):
        return ""
