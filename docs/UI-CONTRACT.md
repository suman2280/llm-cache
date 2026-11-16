# The UI Contract — the new backend's non-negotiable spec

**Status: frozen.** The dashboard (`dashboard/`) is not being rebuilt. It is the acceptance
test for whatever backend is built next. This document is the contract it enforces, extracted
line-by-line from `dashboard/app.js` and `dashboard/index.html` rather than from a design that
no longer exists.

If the rebuilt backend satisfies every **MUST** here, the dashboard works unchanged. Where a
contract item is *wrong* but the UI depends on it, it is marked **[UI-FROZEN]** — keep it, and
fix it in a follow-up that changes the UI.

Run the checker: `node scripts/check_api_contract.mjs http://localhost:8000`

---

## 1. HTTP surface

| Method | Path | Purpose | Source |
|---|---|---|---|
| `POST` | `/v1/chat/completions` | The one chat route. Body is an OpenAI-compatible completion request. | `app.js:387` |
| `GET` | `/stats` | The dashboard's entire world. One poll per second by default. | `app.js:126` |
| `POST` | `/stats/reset` | Zero counters + clear the event feed. Response must be `2xx`. **Not admin-gated** — see below. | `app.js:547` |
| `GET` | `/demo/prompts` | The questions the *Run the demo* button asks. Optional but recommended — see §7. | `app.js:501` |
| `GET` | `/healthz` | Linked from the footer; also used by the old benchmark's server probe. | `index.html:126` |
| `GET` | `/` | API root. Must return an object (the UI never reads it; keep it for humans). | `index.html:124` |

**MUST** serve the `dashboard/` directory from the same origin as the API, at `/dashboard/`
(`index.html`, `style.css`, `app.js`, `reconcile.js` with correct MIME types — `text/javascript`
for the modules). The UI makes **zero external requests**; a rebuild must not introduce any.

**MUST** make all API paths same-origin as the dashboard (no CORS surface).

### The one deliberate exception: `/stats/reset` is not admin-gated

The dashboard's *Reset counters* button POSTs to `/stats/reset` with **no credentials**
(`app.js:547`). Since the UI is frozen and that button is part of it, gating the route
would break the shipped product.

The exposure is small and bounded: it clears **counters and the event ring only**. It cannot
touch a cache document, delete content, promote a review status, or invalidate anything.
The endpoints that *can* do those things — `/cache/scope/:scope`, `/cache/chapter/:code`
and `/content/records/:id/review` — **are** admin-gated and return 404 without
`X-Admin-Token`.

If the UI is ever unfrozen, gate this route too and pass the token from the client.

---

## 2. `GET /stats` payload

The dashboard reads only the fields below. `app.js:141-181` and `app.js:249-320`.

```
{
  "generated_at":       ISO-8601 string, parseable by new Date()   // fmtClock
  "service": {
    "model":             string      // drives the composer: cfg-model + hero-model
    "embedder":          string      // rendered via split("/").pop()
    "distance_threshold": number      // cfg-thresh
    "uptime_s":          number       // fmtUptime
    "version":           string       // rendered as "v" + version
  },
  "totals": {
    "requests": number, "exact_hits": number, "semantic_hits": number,
    "misses": number, "bypasses": number, "errors": number,
    "cache_hit_rate": number | null    // null only when requests == 0
  },
  "latency_ms": { "n": number, "p50": number, "p80"?: …,
                  "p90": number, "p95": number, "p99": number, "max": number },
  "recent": [ Event, … ]                // NEWEST FIRST, max 100 by default
}
```

**MUST** — `recent[]` is **newest-first** and ordered by a stable, strictly numeric `id`
(see §3). `logSignature` reads `events[0].id`; if it is not a number the UI re-renders every poll
and View Transitions break.

**MUST** — every event carries a **numeric `id`**. `applyLog` filters
`typeof e.id === "number"` and silently drops anything else (`app.js:220`), so a missing id
makes the row vanish rather than error. Ids MUST be unique across `POST /stats/reset` — the
reconciler keys row identity on id, and a repeated id after a reset duplicates a DOM row.

**SHOULD** — include `schema_version`. The frozen UI does not read it, but every consumer that
isn't this dashboard should be able to detect a breaking change.

### Event object

`app.js:254-320` (`buildRow`) reads exactly:

| Field | Type | How the UI uses it | Requirement |
|---|---|---|---|
| `id` | number | row identity, reconciliation | MUST, MUST survive reset |
| `ts` | ISO string | `fmtClock` → `new Date(ts)` | MUST be parseable |
| `status` | string | badge + row class + "served from" logic | MUST be one of the five in §4 |
| `model` | string | stored, not currently rendered | SHOULD |
| `similarity` | number \| null | rendered `d=<toFixed(3)>` | MAY be null |
| `threshold` | number \| null | not rendered | MAY |
| `latency_ms` | number | row latency + percentiles | MUST |
| `embed_ms` | number \| null | row "overhead" + verdict line | MAY |
| `redis_ms` | number \| null | row "overhead" + verdict line | MAY |
| `prompt` | string | full-question block on expand | MUST (full text, not a preview) |
| `response` | string \| null | full-answer block on expand | MUST (full text; null on bypass/error) |
| `source_prompt` | string \| null | "served from:" line on semantic hits | MUST when status is a hit that reused another prompt |
| `reason` | string \| null | error/bypass detail line | MUST when status is bypass or error |
| `distance` | number \| null | optional alias for `similarity` | MAY |

**MUST** — `prompt` and `response` are the **full** texts. The UI renders them verbatim inside
`<details>`, and the v2 contract explicitly exists so expanded rows show the whole answer.
(My old review's P1-11 note — cap or redact them — is a *new* requirement that needs a UI
change; the frozen contract today is "full text".)

**MUST** — `prompt` is written with `textContent` only (`qaBlock`), so the backend may send
arbitrary Unicode safely. **This is the one place the design is right and the old backend was
wrong**: Unicode belongs in the JSON body, never in an HTTP header.

---

## 3. Event ids and reconciliation

`dashboard/reconcile.js` is the load-bearing pure logic (9 Node tests in
`dashboard/reconcile.test.js`). Its requirements, which the backend must satisfy:

1. Ids are **integers**.
2. Ids are **monotonically increasing** (the UI assumes newest = highest id).
3. Ids are **never reused**, including across `POST /stats/reset`.
4. `recent[]` is sorted newest-first.

That is the whole interface. Any backend that assigns a strictly increasing integer per event
and never reuses one works.

---

## 4. `POST /v1/chat/completions` — response headers

`app.js:399-411` reads exactly seven headers on every response:

| Header | Read as | Requirement |
|---|---|---|
| `x-cache-status` | the verdict badge | **MUST** be exactly one of: `miss`, `exact-hit`, `semantic-hit`, `bypass`, `error` |
| `x-cache-latency-ms` | number, rendered as ms/s | MUST |
| `x-cache-similarity` | `d=<toFixed(3)>` | MUST on the statuses where a match distance exists |
| `x-cache-source-prompt` | rendered verbatim in the verdict line | **MUST be ASCII-only** — see §6 |
| `x-cache-policy` | `policy: <reason>` | MUST on `bypass`, SHOULD elsewhere |
| `x-embed-ms` | number | MAY be absent |
| `x-redis-ms` | number | MAY be absent |

Unknown `x-cache-status` values are styled as **bypass** (`badgeClass`, `app.js:77-85`), so a
new status must also be added to the UI's class map or it will silently look like a bypass.

### **[UI-FROZEN] `x-cache-similarity` carries a *distance*, not a similarity**

The name says similarity; the value rendered by every consumer (including my old review's
finding **P3-5**) is a cosine **distance** where higher = *less* similar. The frozen UI reads
`x-cache-similarity` and renders `d=`, so:

- **MUST** emit `x-cache-similarity` (to keep the UI working) whose value is the distance.
- **MUST** additionally emit `x-cache-distance` with the same value, so new consumers have a
  correctly-named field.
- **SHOULD** emit `x-cache-similarity-score` = `1 - distance` for consumers that want a real
  similarity in [0,1].
- **MUST NOT** change the meaning of `x-cache-similarity` without changing the UI.

---

## 5. `POST /v1/chat/completions` — response body

The body must be a valid OpenAI-compatible completion object. Two things the UI does with it:

- On `2xx`: it ignores the body entirely and trusts the headers.
- On `>=400`: it reads `payload.detail` (a **string**) to build the error line
  (`app.js:392-398`). So error responses **MUST** return `{"detail": "<human-readable string>"}`.

**MUST NOT** replay a previous response's identity on a served hit — the response's `id` and
`created` MUST be freshly minted (old review finding **P1-2**).

---

## 6. Headers must be ASCII-safe — the bug that must not come back

**The single most important rule in this document.**

`X-Cache-Source-Prompt` carries a *user-supplied prompt* into an HTTP header. Starlette (and
every other WSGI/ASGI framework) encodes header values as `latin-1`, and `latin-1` has no code
point above `U+00FF`. Any prompt containing `∈ ∪ ⊂ π √ ≤ ≥ ≠ × →` — i.e. essentially every
prompt in the JEE mathematics domain this project serves — raises `UnicodeEncodeError` and
returns **HTTP 500 on a cache hit**.

Verified against the old backend:

```
=== non-ASCII header (math symbols) ===
HTTP 500
body: Internal Server Error
```

**MUST** — any header derived from user input is ASCII-safe before it is set (percent-encode,
or truncate to `[\\x20-\\x7e]`, or both). The full, un-escaped prompt travels in the `/stats`
event's `source_prompt` field instead, which is safe because the UI uses `textContent`.

---

## 7. The demo the UI drives

`app.js` (`loadDemoPool` → `nextDemoSteps` → `demoBtn`) sends **three** sequential
requests, all with `temperature: 0` and no system prompt:

1. `pick.q` — a fresh question → expected `miss` (runs inference).
2. `pick.q` — **byte-identical** to step 1, *including* the same params → expected `exact-hit`.
3. `pick.rephrase` — a rewording → expected `semantic-hit` with a distance and a source prompt.

### Where the questions come from

**SHOULD** serve the pool from `GET /demo/prompts`:

```json
{ "chapter_code": "MATH-01-AWS",
  "prompts": [ { "q": "...", "rephrase": "...", "concept_id": "AWS-01", "topic": "..." } ] }
```

The demo must be in the **same domain as the loaded content**. The first build hard-coded
generic dev-ops trivia (load balancers, DNS) in the page while the corpus behind it was
AWS — so the demo showed a general-purpose chat cache rather than the product. Serving the
pool from the backend means swapping the corpus (AWS → the JEE *Sets* chapter) changes the
demo with **no dashboard edit**.

The page keeps its own list as a **fallback** for when the backend is unreachable, so the
demo still works offline.

Two properties the backend must guarantee about the pool it serves:

- **Each `rephrase` must be within the semantic radius of its `q`** (measured: 0.034–0.257
  against a 0.35 radius), or step 3 will not be a semantic hit.
- **No two `q`s may be within the radius of each other**, or one demo entry would collide
  with another.

Frozen behaviours the backend MUST honour:

- **Step 2 must be an `exact-hit`, not a `semantic-hit`.** The exact tier's key must cover the
  *full* request (model, messages, and every parameter that changes the answer) and nothing
  else. The old backend got this wrong — omitting `temperature` from step 2 made the hash
  differ → semantic-hit-at-`d=0.000` instead. Latitude: the exact tier must hash **all**
  answer-changing params (denylist-style, not the old allowlist of 8 — see REBUILD §R-3).
- **Step 3 must carry a source prompt** (`x-cache-source-prompt`) and a distance.
- The demo pool questions are **load balancers / DNS / reverse proxies** — dev-ops trivia, not
  JEE content. **[UI-FROZEN]** they live in `app.js:467-474` and are a *content* change only;
  re-pointing them at SOP content needs no backend work, but see REBUILD §DEC-2.

---

## 8. The domain guard

The fine-tune's model card promises it *"refuses questions outside the AWS domain by
design"*, and reports **100% correct refusal**. Measured on this build, that promise does
**not** hold — the adapter is 2.5 M parameters (0.03 %) trained for 17 minutes on 407 Q&A
pairs; it learned the AWS *style* but not the refusal:

```
"What is the boiling point of water in Celsius?" -> "The boiling point of water in Celsius is 100 degrees."
"Who wrote the play Hamlet?"                     -> "Hamlet was written by William Shakespeare."
```

**0 of 6** out-of-scope questions refused. So the behaviour the card advertises is enforced
by the **proxy**, before any tier can serve or store an answer — see `src/domain.js`.

### What the backend MUST do

- **MUST** classify each request against the domain described by the loaded corpus.
- **MUST** refuse out-of-domain requests with **`422`** and a JSON body whose `detail` is a
  **string** explaining the restriction (the frozen UI renders `payload.detail` verbatim in
  its error line — see `app.js:392-398`).
- **MUST NOT** cache an out-of-domain answer, in any mode. It must never resurface later as
  a cache hit for something else.
- **MUST** keep the domain in `GET /stats` → `service.domain` (`name`, `description`, `mode`,
  `threshold`), so the UI can show it. Additive: the frozen UI ignores fields it does not read.
- **SHOULD** accept a mode of `off` (no restriction) and `bypass` (answered, labelled
  `x-cache-policy: out-of-domain`, never cached) alongside the default `strict`.

### Why the guard must be domain-agnostic in the contract checks

The contract checker sends an **in-domain** non-ASCII prompt (a U+2011 non-breaking hyphen in
`S3‑Glacier`), so the ASCII-safe-header contract in §6 is still exercised end to end in every
domain mode. A prompt outside the domain would be refused before it reached the cache, and the
test would silently stop testing anything.

---

## 9. Conformance checklist

`scripts/check_api_contract.mjs <base_url>` asserts every MUST above against a live server.
The rebuild is done — from the UI's point of view — when that script exits 0.

- [ ] `/dashboard/` serves from the same origin, correct MIME types, no external requests
- [ ] `GET /stats` has every field in §2 with the right types
- [ ] `recent[]` newest-first, numeric ids, ids survive reset
- [ ] `POST /v1/chat/completions` returns all four headers on every one of the five statuses
- [ ] error responses carry `{"detail": "<string>"}`
- [ ] a non-ASCII prompt produces a 2xx, not a 500
- [ ] the UI demo reads `miss → exact-hit → semantic-hit`
- [ ] a served hit carries a fresh `id`/`created`
- [ ] the UI polls 1/s with zero external requests