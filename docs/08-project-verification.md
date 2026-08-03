# Project verification against the guidance

*Checks this repository (the **People Memory** `.aix` agent) against the guidance in `main.md`. Every finding below was read directly from source; file:line references are load-bearing.*

## Verdict

The project follows `main.md`'s **architecture** guidance well — it is exactly the report's recommended case (Rokid Glasses with supported AIUI, native `.aix` workflow, thin client plus cloud services). Where it diverges is in the **security, privacy, and robustness** guidance, and one of those divergences is more serious than the "demo shortcut" the README acknowledges: the face backend is **cross-tenant readable and writable**, exposing one wearer's biometric data to any holder of the shipped key.

Legend: ✅ compliant · ⚠️ partial · ❌ violation.

## Update — fixes applied (2026-08-03)

Most findings below have since been addressed in code. Summary of what changed; the per-finding sections retain the original analysis for context.

| # | Finding | Status | What changed |
|---|---|---|---|
| 1 | Cross-tenant biometric access | **Fixed** | `_shared/http.ts` `resolveOwner()` replaces the trust-the-header `ownerId()`. With no `OWNER_SIGNING_SECRET` set, only the `default` bucket is reachable (single-tenant safe by default); with it set, an HMAC `x-owner-token` is required per wearer. Both functions verify on every method; failures return 403. Device sends an optional `FACE.ownerToken`. |
| 3 | Retention + forget | **Fixed** | `forget` now clears the wearer's `recent_captures`; `identify` sweeps expired captures on write; new migration `20260803000000_capture_retention.sql` adds `purge_stale_captures()` + a best-effort pg_cron sweep. |
| 4 | No max request size | **Fixed** | `parseRequest()` rejects oversized bodies with 413 (`MAX_UPLOAD_BYTES`), checking `content-length` and the base64 length before decoding. |
| 8 | Calendar transport timeout | **Fixed** | `utils/composio.js` wraps every fetch in a feature-detected `withDeadline` (`composioConfig.timeoutMs`, 15 s). |
| 5 | Cancellation / staleness | **Fixed** | `face.ink` gains a per-action epoch + `live()` guard on every async render, a `cancel()` path, and a guarded speech-result handler; `schedule.ink` uses an instance `busy` flag instead of `this.data.loading`. |
| 6 | Face page stops work when hidden | **Fixed** | `face.ink` adds `onShow`/`onHide`; hiding invalidates the in-flight turn and releases the mic. |
| 7 | Capture user-initiated / cancel | **Improved** | A hardware-independent cancel affordance now exists (press/tap during a capture cancels it). Auto-capture on dispatch is retained by design (the page is the disclosed feature) and still gated by the host interaction gate. |
| 9 | PII in logs / raw errors | **Fixed** | `failure()` no longer returns raw internal error strings; stage logging drops `plan.args`; spoken-text logging is gated behind `DEBUG.logSpeech` (off on device, on for the dev bundle). Also added length caps on stored name/note/email. |
| 2 | Secrets ship in the `.aix` | **Unchanged (by design)** | The Composio key remains a documented demo tradeoff; the fix (proxy or `mcp`) is a deployment choice, left to the operator. |

Backend fixes require a redeploy to take effect: `npm run db:push` (migration) and `npm run deploy` (functions).

---

## Where the project matches the guidance ✅

| Guidance (`main.md`) | Evidence |
|---|---|
| Rokid-AIUI target → use the native `.aix` workflow, don't wrap in an APK (§07 recommendations) | `dev/pack.mjs` builds a real OAF zip with `VERSION`; `AGENTS.md` + `app.json` present; verified with Rokid's own `aix` reader (`dev/aix-check.html`) |
| Thin glasses client + cloud services split (§04/§05) | Device takes the photo and renders; recognition (YuNet + SFace + pgvector) runs in `supabase/functions/face/index.ts`. Device owns capture, consent, presentation |
| Abstract the transport (§04 networking) | `utils/composio.js:123-323` — MCP and REST behind one `ComposioClient` interface |
| Implement only documented globals; timers may be absent (§04 JS semantics) | `setInterval`/`setTimeout` feature-detected before use (`utils/faceservice.js:47`, `utils/planner.js:191`, `pages/index/index.ink:186`); `config.js:196` ships polling off |
| Storage through the verified API, not `localStorage` (§04) | `utils/store.js:15-32` uses `wx.setStorageSync`/`getStorageSync`; `localStorage` confined to the dev backend |
| Bound lists/images/caches (§06 performance) | `capRows()` + `MAX_VISIBLE_ROWS:4`; `clip()` per-row text; int8 SFace over the 38 MB float build; `MAX_EMBEDDINGS:6` pruning (`face/index.ts:262-270`) |
| No native machine code in the package; keep assets small (§02) | `.aix` is 23 files, no images/audio/fonts; the 10 MB ONNX models stay in a private Storage bucket, never in the bundle |
| Real-device results are the final basis for judging (§06 debugging) | `README.md` "What the real runtime changed" documents four defects found only on the Ink WASM engine, all fixed — this is exactly the discipline the report asks for |
| Don't retain raw media after deriving the result (§07) — *for photos* | `_shared/http.ts:72` drops the base64 after decode; no JPEG is written to any table or bucket. Only a 32×32 luminance thumb and a 128-d vector persist |
| Service-role key never in the client (§07 auth) | `_shared/http.ts:38-41` reads it from `Deno.env`; `dev/server.mjs` keeps the Composio key server-side and rewrites `config.js` to an empty key for the browser bundle |

---

## Where the project violates the guidance ❌ / ⚠️

### 1. ❌ Cross-tenant biometric access — the most serious gap

`main.md` §07: *"Each native API should validate arguments, enforce size and rate limits, check an explicit capability grant, and return controlled errors."*

The wearer identity `owner_id` is taken from a **client-controlled header**:

```ts
// supabase/functions/_shared/http.ts:52-55
export function ownerId(req, body = {}) {
  const header = req.headers.get('x-owner-id');
  return String(header || body.owner_id || 'default').slice(0, 64);
}
```

Every query *is* scoped by that owner (`face-people/index.ts:37,67,93`; `face/index.ts:127,159,187,226`), so the scoping is consistent — but the owner is whatever the caller says it is. The only gate in front of the functions is the Supabase publishable key, which **ships inside the `.aix`** (`config.js:149`) and is designed to be extractable. So any holder of that key can send `x-owner-id: <another wearer>` and:

- `GET /face-people` → read another wearer's full people list: **names, private notes, emails, thumbnails** (`face-people/index.ts:34-53`)
- `DELETE /face-people?id=…` → forget their people (`:63-68`)
- `POST /face-people` → rewrite their names/notes/emails (`:89-95`)
- `POST /face` → match a face against their enrolments (`face/index.ts:157-162`)

`config.js` and `20260728000000_face_memory.sql:22` both describe `owner_id` as the boundary that keeps wearers apart; in practice it is not a boundary at all. The RLS-with-no-policies design (correctly) blocks *direct* table access, which is what the README's "why the key is safe" argument covers — but that argument does not extend to the functions, which run as service role and trust the header. This one is worth fixing before any multi-wearer or public use: it is biometric data belonging to third parties who never consented. Fix: derive `owner_id` from a verified JWT claim (per-wearer token minted by a trusted party), not a header.

### 2. ❌ Long-lived secrets ship inside the `.aix`

`main.md` §06 pitfall *"Embedding secrets in `.aix`"* and §07 *"Do not embed long-lived API keys, client secrets, or signing keys in … `.aix` packages."*

`config.js` — which `dev/pack.mjs:27` ships verbatim — contains the Composio API key `ak_VmhhR_…` (`:22`), the end-user id (`:27`), and the connected-account id (`:33`). Together they are enough to execute Google Calendar tools against the wearer's account. The README acknowledges this ("The Composio key ships inside the app bundle under the `rest` transport. Acceptable for a demo; for production put a proxy…"), so it is a known shortcut — but it is still a live divergence from the guidance, and the recommended fix (the proxy that `dev/server.mjs` already implements, or the `mcp` transport) is not wired into the pack path.

### 3. ❌ Biometric retention exceeds need; "forget" is incomplete

`main.md` §07 *"avoid retaining raw media after deriving the required result"* and the project's own promise (`face-people/index.ts:8-11`) that forgetting *"should leave nothing behind, including the vectors."*

`recent_captures` stores a **128-d face vector + thumbnail per wearer** on every identify (`face/index.ts:169-174`). The table has **no TTL, no cron, and no delete job** (`20260729000000_recent_capture.sql` — the row is only *logically* ignored past 5 minutes, `face/index.ts:130-131`), and `forget` deletes from `people` only. The `face_embeddings` cascade works (`…face_memory.sql:44`), but `recent_captures` is keyed by `owner_id` with no FK, so after a wearer forgets someone the **last-captured face vector and thumb of that person persist** until the wearer's next capture overwrites the row. Fix: delete the wearer's `recent_captures` row inside `forget`, and add a scheduled purge of rows older than the freshness window.

### 4. ❌ No maximum request size on the face function

`main.md` §05 safe-loader *"reject oversized package … enforce file type and per-file limits"* and §04 resource limits.

`parseRequest` decodes the entire base64 body before any check (`_shared/http.ts:66-77`); `face/index.ts:86` enforces only a **minimum** (`< 128` bytes). Given the project's own documented `WORKER_RESOURCE_LIMIT` battle (README "The resource ceiling"), an unbounded inbound photo is the same failure waiting on the ingress side. Fix: cap body length and reject early with a 413.

### 5. ⚠️ No cancellation / staleness guards

`main.md` §06 pitfall *"No cancellation → Old AI result overwrites a newer user action → Add request IDs, generation counters, and cancellation."*

A search for `requestId` / `generation` / `seq` / `AbortController` across `utils/`, `pages/`, and `supabase/functions/` returns **zero hits**. Concretely: in `pages/face/face.ink` the speech-result path (`:374-379`) calls `save()` directly, bypassing the `this.busy` guard, so a name spoken while a key-press capture is in flight can resolve later and overwrite the newer card. `pages/schedule/schedule.ink:53` guards `onShow` with `if (!this.data.loading …)` — but `this.data` is `setData`-async, the exact re-entrancy trap the project already documented and fixed on the index page with an instance flag (`index.ink:238` `this.busy`). The index page guards overlap but not stale ordering.

### 6. ⚠️ Face page does not stop work when hidden

`main.md` §04 lifecycle; the project's own principle *"no work happens while the card is out of view"* (honored by `pages/index/index.ink` via `onHide`→`stopPolling`).

`pages/face/face.ink` implements only `onLoad` + `onUnload` (`:131,162`) — **no `onShow`, no `onHide`**. In-flight `takePhoto()` and `service.identify/remember` awaits, and a started `SpeechRecognition` (`:372`), keep running after the card leaves view; the mic stays hot until `onUnload`.

### 7. ⚠️ Capture is not always user-initiated

`main.md` §07 *"Access should be initiated by an unambiguous user action or an explicitly disclosed feature,"* with a hardware-independent cancel path.

`onLoad` → `run()` → `capture()` fires with **no gesture** (`face.ink:159,199,210`), and `service.warm()` sends a network call on every page open. It relies entirely on the host's interaction gate throwing where a gesture is required (`:269-284`); where the host allows it, the camera fires on page open. There is also **no cancel/abort affordance** — every input (`onKeyUp:167`, `onCardTap:600`) starts *another* capture. The report treats the gate as a should, not a guarantee, so this is partial rather than a clean pass.

### 8. ⚠️ Calendar transport has no timeout or retry

`main.md` §04 networking *"implement retries, backoff, session resumption"* and §06 *"Define timeouts and fallbacks per operation."*

`utils/faceservice.js` does this correctly (30 s deadline `:46-52`, retry-once on 546 `:71`, friendly errors `:19-30`). But `utils/composio.js` has **no timeout, retry, or deadline** on any `fetch` (`:148,258,279,298`); a hung calendar request strands the card. The 135 KB-body hang is only worked around by skipping discovery, not by a general deadline.

### 9. ⚠️ PII in device logs; raw error returned to client

`main.md` §06 *"Do not log … transcripts … complete user prompts by default."*

`pages/index/index.ink:393` logs `JSON.stringify(detail)` for `calling-tool`, which includes `plan.args` — calendar search terms and attendee/`calendarId` addresses. `index.ink:507` and `face.ink:576` log the spoken text, which for a face is the **person's name plus their private note**. Separately, `_shared/http.ts:83-84` logs the raw error and **returns it verbatim to the client**, leaking internal Postgres/RPC detail.

### 10. ⚠️ Unversioned cache reads on the face page

`main.md` §04 storage; the project's own hard rule to version-stamp cached rows (`REFRESH.cacheVersion`).

`pages/face/face.ink:150-151` reads `REFRESH.cacheKey` and `FACE.directoryKey` with **no `cacheVersion` check**, then ships `cached.rows` to the server (`:246`). The index page writes those with a version (`index.ink:283`) but the directory is written unversioned (`index.ink:279`). A stale-shaped cache can therefore be POSTed to the edge function.

---

## Minor / non-blocking

- `face/index.ts:73-81` (`warmup`, 100 s timer) and `:93-100` (`decodeOnly`, returns image dimensions) are reachable by any caller with no rate limit.
- `face-people` GET returns **all** people for an owner with no pagination (`:34-38`).
- No `supabase/config.toml`, so `verify_jwt` is the platform-gateway default rather than explicit in the repo.
- No correlation id joins a device turn to its edge invocation (`app.js` logs `BUILD`, but nothing threads through).
- `config.js:173 contextKey` aliases `config.js:194 cacheKey` and is referenced nowhere.

---

## Suggested priority order

1. **Cross-tenant access (#1)** — derive `owner_id` from a verified per-wearer token, not the `x-owner-id` header. This is the only finding that exposes third parties' biometric data.
2. **Retention + forget (#3)** — clear `recent_captures` in `forget` and add a scheduled purge.
3. **Request size cap (#4)** and **calendar timeout (#8)** — small changes, and both are failure modes the project has already hit elsewhere.
4. **Secrets (#2)** — move the Composio call behind the existing proxy or `mcp` for anything beyond a demo.
5. **Lifecycle / cancellation / logging (#5, #6, #7, #9, #10)** — robustness and privacy hygiene, each localized.
