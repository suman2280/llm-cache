# UI Plan — Dashboard on `/stats`

Companion to [`plan.md`](./plan.md). Defines the `/stats` JSON contract (built in Phase 3) and
the demo dashboard that consumes it (Phase 5). The dashboard is the *first consumer* of a stats
API designed from day one for future UIs — it is not a one-off debug page.

## U1. Goal

Give a reviewer, in one browser tab, live evidence of the proxy's core claim:

- how many requests were served,
- how many never reached inference (exact vs semantic hits),
- how fast cache hits are vs. inference (latency percentiles + event feed),
- what the cache is doing right now (config strip) and where it last *failed* (bypass/error rows).

## U2. Scope boundary (MVP dashboard)

**In:** static HTML/CSS/JS, no build step, no framework, no CDN, offline-capable; served by the
FastAPI app itself; polls `GET /stats`.

**Out (future, not now):** login/multi-user views, charts (benchmark report owns charts),
event filtering/search UI, websockets/SSE, threshold adjustment controls, mobile-first design.

> **Update (post-MVP):** a read-only dashboard could not demonstrate *its own* thesis — that a
> rephrase never reaches inference — so §U8 adds the **Try a prompt** panel: the one write action
> in the UI, going through the normal `/v1/chat/completions` endpoint a client uses (no new
> backend surface). Nothing else in §U2 changes: still no websockets, no threshold controls, no
> login.

## U3. The `/stats` contract (design target)

Single endpoint, JSON, `schema_version`-ed, Redis-backed (counters via `INCR`, events via
`LPUSH/LTRIM 100`), survives restarts.

```jsonc
GET /stats
{
  "schema_version": 1,
  "generated_at": "2026-11-06T12:00:00Z",
  "service": {
    "name": "llm-cache",
    "version": "0.1.0",
    "uptime_s": 123.4,
    "model": "llama3.2:3b",
    "embedder": "sentence-transformers/all-MiniLM-L6-v2",
    "distance_threshold": 0.10,
    "ttl_s": 86400
  },
  "totals": {
    "requests": 0,
    "exact_hits": 0,
    "semantic_hits": 0,
    "misses": 0,
    "bypasses": 0,
    "errors": 0,
    "cache_hit_rate": 0.0            // (exact+semantic)/requests, 4dp; null if requests==0
  },
  "latency_ms": {
    "n": 0, "p50": 0, "p90": 0, "p95": 0, "p99": 0, "mean": 0, "max": 0
  },
  "recent": [                        // newest first, newest 100 events (LPUSH/LTRIM)
    {
      "ts": "2026-11-06T12:00:00Z",
      "status": "miss | exact-hit | semantic-hit | bypass | error",
      "model": "llama3.2:3b",
      "similarity": 0.031,           // cosine distance; null on miss/bypass/error
      "threshold": 0.10,             // radius applied at request time
      "latency_ms": 9821,
      "embed_ms": 19,
      "redis_ms": 2,
      "prompt_preview": "What is Redis?"  // last user msg, truncated ~80 chars
    }
  ]
}
```

`POST /stats/reset` → clears counters and event feed, returns the fresh (zeroed) payload above.

### Contract rules

- `schema_version` is stable per major change; the dashboard must not break on added fields.
- Percentiles are computed server-side from the event window (`n` = window size, ≤ 100) and
  reflect *recent* latency, not lifetime. Stated in the UI so nobody misreads it.
- `latency_ms` per event = total proxy time; `embed_ms`/`redis_ms` break out the cache overhead
  (the "cache overhead ≪ inference" claim, made visible).
- No secrets, no prompt content beyond a truncated last-user-message preview (PoC; documented).

## U4. Design & Layout

Vanilla HTML + CSS + JS in one page; system font stack; dark, high-contrast, color + text labels
(status is never color-only — badges carry text). Polling only (`setInterval`, default 1 s,
`?poll=<ms>` override, pause when `document.hidden`).

```
┌───────────────────────────────────────────────────────────────┐
│ llm-cache   ● live    model: llama3.2:3b · embedder: MiniLM-6 │
│               (stale) thresh: 0.10 · uptime: 3m 20s · v0.1.0  │  config strip
├─────────────┬─────────────┬─────────────┬─────────────────────┤
│ Requests    │ Hit rate    │ Exact hits  │ Semantic hits       │  KPI cards
│ 128         │ 84.4%       │ 43          │ 65                  │  (aria-live)
├─────────────┼─────────────┼─────────────┼─────────────────────┤
│ Misses 20   │ Bypasses 0  │ Errors 0    │ Inferences avoided: │
│             │             │             │ 108                 │
├───────────────────────────────────────────────────────────────┤
│ Cache-hit latency (last 100 events)                           │
│ p50 14ms · p90 31ms · p95 58ms · p99 96ms · max 210ms · n 100 │
├───────────────────────────────────────────────────────────────┤
│ Recent events                                   [newest ▾]    │
│ 12:00:41  exact-hit    d=0.031   9ms   (embed 2 / redis 1)    │
│ 12:00:39  semantic-hit d=0.042   12ms  (embed 3 / redis 1)    │
│ 12:00:31  miss          —        9.8s   (embed 21 / redis 2)  │
│ 12:00:30  bypass        —        0.4s   reason: stream=true    │
└───────────────────────────────────────────────────────────────┘
```

**States**

- *Empty* (fresh Redis): "No requests yet — send a chat completion, see [`plan.md`](./plan.md) §7".
- *Stale/error* (fetch failure): gray header chip `● stale`, banner "`/stats` unreachable —
  showing last data at HH:MM:SS", keep last payload.
- *n = 0*: percentiles row shows `—` instead of zeros.

**Accessibility & honesty notes:** `<table>` for the feed with `<caption>`/scope headers;
`aria-live="polite"` only on KPI cards; `updated_at` always visible; percentiles labeled
"last 100 events".

## U5. Technical design

- Served by the app itself: `app.mount("/dashboard", StaticFiles(directory="dashboard",
  html=True))`, reachable at `/dashboard/` (proxy endpoints stay at `/v1/...`, so no route
  collisions).
- One file trio: `dashboard/index.html`, `dashboard/app.js` (ES module), `dashboard/style.css`.
  `fetch('/stats')` → render into template literals → full re-render per tick (100-row cap,
  1 s tick: trivially cheap; no virtual DOM needed).
- Config for the page itself: `?poll=<ms>` (clamped 500–60000, default 1000); pause polling when
  the tab is hidden, refresh immediately on visibility return.
- No external requests of any kind (offline claim preserved); footer links to repo + plan docs.
- Future handoff: the contract in §3 is the UI's API — a richer UI (charts, filters, multi-instance)
  can be built against the same JSON without proxy changes.

## U6. Implementation steps

| Step | Work | Output | Validation criteria |
| --- | --- | --- | --- |
| U-1 | Implement `GET /stats` + `POST /stats/reset` per §3, Redis-backed (`INCR`, `LPUSH/LTRIM`) | working JSON via curl | Contract test: counters match event feed; reset zeroes; schema_version present |
| U-2 | Serve `dashboard/` statically from the app | `/dashboard/` loads with no proxy state | Page loads with `/stats` unreachable → shows stale/empty state, not a blank page |
| U-3 | Config strip + KPI cards + empty/error states | dashboard skeleton | Kill the app → banner appears, last payload retained, no console errors |
| U-4 | Latency table + event feed rendering | full dashboard | Against live traffic: 20 mixed requests render correct statuses/distances/latencies |
| U-5 | Polish + docs | README "Dashboard" section + screenshot | Fresh clone follows README; nothing fetched from the network (devtools: all requests local) |

## U7. Risks

- **Misreading percentiles:** window (last 100) vs lifetime — mitigated by labeling in UI and
  returning `latency_ms.n`.
- **Stats volume:** event previews could confuse; capped at 100 events, prompts truncated.
- **`usage` unavailability from Ollama** (see `plan.md` §13 Q2): tokens-saved is *not* part of
  the dashboard contract; "inferences avoided" (hits count) is available regardless.
- **Scope creep:** filtering/charts/controls are explicitly out of MVP (§2).

## U8. Try a prompt (playground)

The dashboard's one write action: a form that sends a real completion through the proxy so the
cache tiers can be demonstrated without curl. **No backend change** — it POSTs the same
`/v1/chat/completions` an OpenAI-compatible client uses, from the same origin the page is served
from (`http://localhost:8000/dashboard/`), so there is no CORS surface and no new endpoint.

### Model

```
<form> <textarea prompt — the primary control, 5.5rem min height>
       temp · system (secondary row)
       [Send] status … [Clear log] [Reset counters]   ← Ctrl/Cmd+Enter submits

cards (oldest → newest, aria-live="polite"):
  semantic-hit · 13 ms · d=0.058 · embed 12 / redis 1 · HTTP 200
  Can you explain what a load balancer does?
  A load balancer is a device or software that distributes incoming …
  served from: What is a load balancer?
```

### Rules

- **Verdict comes from the response headers, not re-derived client-side:** `X-Cache-Status`,
  `X-Cache-Similarity`, `X-Cache-Source-Prompt`, `X-Cache-Latency-Ms`, `X-Embed-Ms`,
  `X-Redis-Ms`, `X-Cache-Policy`. The card is a rendering of the proxy's own truth.
- **Answer body** = `choices[0].message.content`; HTTP ≥ 400 or a transport failure renders an
  `error`-badged card carrying `detail` (e.g. Ollama's 404 for an unknown model) so failures are
  visible rather than swallowed.
- **No model input.** One model per deployment → the panel POSTs `service.model` as reported by
  `GET /stats` and displays it in the panel header. If a submit races the very first poll, the
  panel waits for the in-flight poll (button disabled, "waiting for /stats…") rather than failing —
  and says so plainly if `/stats` stays unreachable (`plan.md` §7: config surfaced here must stay
  truthful, never invented).
- **In-flight state:** Send disables and reads "Sending…" (a miss runs inference — seconds), so
  double-submits are impossible and the wait is explained rather than looking like a hang.
- **Reset counters** → `POST /stats/reset` behind `confirm()` — it wipes lifetime counters and
  the event feed, which must never happen by mis-click.
- **XSS safety:** every prompt/answer/detail string is written with `textContent`; no
  `innerHTML`, matching the rest of the dashboard (§U4).
- **Stale handling:** inherits the existing `● stale` chip/banner; a down proxy produces error
  cards, not a blank panel.

### Why this matters

The three-tier claim becomes self-demonstrating in one tab: send a question (**miss**, seconds),
send the identical text (**exact-hit**, ~1 ms), reword it (**semantic-hit**, ~15 ms with `d=` and
the prompt the answer came from). The benchmark proves it at scale (§`plan.md` §14); the panel
proves it interactively.

### Validation

- Unit (no services): all `$("…")` ids in `app.js` resolve in `index.html`; `node --check`
  passes; the "Clear log" path restores the empty state.
- Live: real Chrome via CDP filled the form and clicked Send — `miss` / `exact-hit` /
  `semantic-hit` cards rendered with correct headers, `d=0.058`, and the source prompt; KPI cards
  updated to 66.7% hit rate without a manual refresh; Reset counters and Clear log verified.
