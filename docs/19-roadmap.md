# 19 · The roadmap

What to build next, why, and what not to build. Written after a twelve-agent
research pass (codebase audit, unused platform affordances, smart-glasses
market, integration landscape, wearable-agent UX; three independent roadmaps;
three hostile critiques). **Every claim about this repo below was verified
against the code**, not taken from the research.

> **The verdict.** Kavi does not have a feature problem. It has six correctness
> problems, and three of them are the product confidently telling the wearer
> something untrue. Fix those before adding anything.

---

## 0. What is actually true today

Verified, with file references. This section exists because four of these were a
surprise.

### 0.1 A stranger's biometric template is written on every identify

`supabase/functions/face/index.ts`, inside `if (!enrolling)`:

```
match_face(...)            ->  hit
recent_captures.upsert({ embedding, thumb })   <-- runs here, unconditionally
delete recent_captures older than RECENT_CAPTURE_MS
if (!hit) return unknownCard()                 <-- the miss is handled AFTER
```

So pointing "Kavi halo" at someone who was never enrolled still writes their
128-dimension SFace template and a thumbnail to the database. The code's own
comment names it: *"just a biometric vector sitting in a table."*

There is a TTL sweeper, and it runs. That is a **retention** control.
**BIPA §15(b) attaches to collection**, not retention — the claim "Kavi only
knows people you introduced it to" is false as shipped.

### 0.2 `kind` gates nothing

`kind: 'read' | 'write' | 'send'` is declared 13 times across `config.js` and
`supabase/functions/connections/index.ts`. The only code that touches it is
`utils/connections.js:30`, copying it through:

```js
kind: t.kind || 'read',
```

Every other `.kind` in the codebase is `turn.kind` in `pages/index/index.ink` —
the turn view-model discriminator, unrelated. **No confirmation gate exists.**
`GOOGLECALENDAR_QUICK_ADD` executes directly from `utils/agent.js`.

### 0.3 Both "send" capabilities are unreachable

`GMAIL_SEND_EMAIL` and `SLACK_SEND_MESSAGE` appear **only** as registry
declarations. No call site anywhere. `utils/connplan.js` `plan()` has exactly two
branches, both reads, with no verb split — so *"Kavi gmail send an email to
Tracy"* becomes a Gmail **search** for that phrase and returns "Nothing new."

Slack's read passes no channel id (`args: { limit: MAX_ROWS }`); the comment
concedes it is "best-effort until a channel picker exists".

### 0.4 A second note destroys the first

`supabase/functions/face-people/index.ts`:

```ts
for (const field of ['name', 'note', 'email']) {
  if (body[field] !== undefined) patch[field] = String(body[field]).slice(0, MAX_LEN[field]);
}
```

`note` is a single 500-char column and this is a replace. *"Note that we met at
the offsite"* erases *"note that she runs the security review."* Silent data loss
inside the feature the product is named for.

### 0.5 Colleague questions cannot work on glasses

`buildDirectory()` is called at exactly one site — `pages/index/index.ink:316`,
inside `refresh()`. The utterance branch in `onLoad` goes straight to
`handleUtterance` and never reaches it. On glasses **every dispatch is cold**, so
`this.directory` is `[]` and *"what does Kevin have today"* answers *"I do not
know who Kevin is"* about someone in the wearer's own calendar.

### 0.6 The planner is calendar-only

Every `rulePlanner` return is `GOOGLECALENDAR_EVENTS_LIST`,
`GOOGLECALENDAR_QUICK_ADD`, or `unknown-person`. There is no path by which a
non-calendar tool is ever planned. Kavi is a calendar app that steps aside when
you say a magic prefix.

### 0.7 The `default` tenant is served, not refused

`_shared/http.ts` `resolveOwner()` returns `'default'` when there is no device
token and `OWNER_SIGNING_SECRET` is unset. Demonstrated live: a Craft run with no
sign-in read back three enrolled people. `OWNER_SIGNING_SECRET` being unset is
*correct* for a single-wearer deployment — the problem is that an unauthenticated
caller gets served rather than refused.

---

## 1. What "universal" should mean

Not more connectors. Each one adds phrasings the wearer must memorise — which
worsens the discoverability failure that the abandonment literature blames for
non-use — and `connections/index.ts` polls `composio.status` serially per
connection, so it degrades sign-in linearly too.

**Universality = three generic verbs — *see this* / *remember this* / *do this* —
over one memory and one server-side brain.** Every new capability then arrives as
an Edge Function deploy instead of a pack → Craft upload → "update resources"
cycle.

The market evidence is blunt. Ray-Ban Stories sold roughly 300k units and
retained roughly 27k monthly actives, and the named causes were reliability
failures, not missing features. Across devices, the conversational assistant is
consistently the **first** capability abandoned; what survives is passive reading
(captions, navigation) and zero-friction capture.

**The one job worth being best in the world at: "know what I owe the person in
front of me."** It is the only capability that compounds with wear time, and the
only one where the alternative is a social insult rather than an inconvenience.
Calendar and quick capture are not the product — they are the frequency engine
that gives it somewhere to be delivered.

---

## 2. Build order

### Phase 0 — stop lying (~1 week, no new capability)

| Item | Where |
|---|---|
| Gate the `recent_captures` write on a non-null `hit` | `face/index.ts` |
| Append notes instead of replacing them | `face-people/index.ts` |
| Restore directory + own-day rows before `handleUtterance` | `index.ink`, new `utils/context.js` |
| Refuse `default` when `AUTH.required` | `_shared/http.ts` |
| Split the failure taxonomy | `utils/agent.js` says "I could not reach your calendar" for *any* tool failure. "Reconnect Gmail" and "you have no signal" demand opposite actions |
| Render transcript + resolved intent **before** acting | Reading a line of green costs ~0s; a spoken confirmation costs 2–3s. The only way a wearer catches "remember her as Tracy" aimed at the wrong person |
| Drop `pages/schedule/schedule` from `app.json` | Host-dispatchable, description competes with `index.ink`, no voice loop, no cache, no agent face |
| `playTTS` fall-through + `lang` on all speak/listen sites | Kavi advertises Vietnamese and answers in an American accent |

### Phase 1 — find out what the hardware does (days)

`docs/10`'s own status table lists the camera, wake word, TTS, temple touch and
on-device model as **untried on real glasses**. `docs/06` adds TTS, ASR, IMU and
MP3 as field-reported unstable. Six candidate features depend on one of those.

Ship one probe build and read the log: `typeof setTimeout`/`setInterval`;
`<scroll-view>` painting at a literal WXSS pixel height; `Accelerometer` first
reading; `wx.request` `timeout` and `abort()`; `takePhoto` gate on a **voice**
dispatch vs press-first; `BarcodeDetector.getSupportedFormats()`.

Two questions outrank the rest:

1. **Does the hardware capture LED fire for `wx.media` `takePhoto()`?** If not,
   every camera feature is indefensible. This is a blocker, not a nit.
2. **Can the agent be summoned by name on current firmware?** `docs/12` says
   routing all voice commands to a custom agent is not supported, and reports the
   AI-shortcut target returning "AI assistant service error" for multiple
   developers. The entire `Kavi <thing> <action>` grammar rests on this.

### Phase 2 — foundations you cannot retrofit (2–3 weeks)

- **Durable owner identity.** `pair/index.ts` mints `owner_id = crypto.randomUUID()`
  when no `device_uid` is presented, and that uid lives in `wx.getStorageSync`. A
  reinstall, a resource update that clears storage, or a warranty replacement
  orphans every person, embedding and note with no recovery. Capture the Google
  `sub` at pair completion and make it the owner key; demote `device_uid_hash` to
  a fast path. **Ship before the memories table, not after** — today the cost is a
  handful of faces; later it is the entire relationship history.
- **Make `kind` real, server-side.** Any tool with `kind !== 'read'` returns
  `{confirm:{line, tool, args}}` instead of executing, so the property holds
  regardless of input surface and a repacked `.aix` cannot skip it. Confirm by
  temple press or spoken "yes". Silence and hide cancel. **Never a timeout.**
- **Server-side response projection.** `connections/index.ts` returns
  `result.data` unshaped. Five HTML newsletters with inline base64 crosses the
  ~135KB threshold where the fetch promise never settles. Project to
  `{title, subtitle}[]`, capped, with a hard byte ceiling.
- **First JS tests.** `utils/planner.js` is 591 lines of order-dependent regex
  whose own comment warns "Order matters", with zero coverage. Freeze a corpus of
  real utterances — Vietnamese included — and run it in CI.
- **Single-source the registry.** `config.js` and `connections/index.ts` are
  hand-copied duplicates with nothing validating one against the other. Drift means
  the glasses route an alias the backend refuses, silently. Fail the build on drift
  the way `dev/check-face.mjs` already does for the face CSS.
- **The legal floor.** A `consent` row written at enrolment with a spoken
  disclosure the *subject* hears; a retention sweeper on `people`/`face_embeddings`
  (only `recent_captures` is swept today); an audible shutter on every capture; a
  region on `owners` enforced server-side; a written prohibition on affect
  inference while it is still free.

### Phase 3 — the brain (3–4 weeks)

One `turn` action on an Edge Function:
`{utterance, deviceId, cachedContext}` → `{page, params, title, lines, spoken, confirm?}`.

This is the single change that makes Kavi multi-service, because it replaces the
hardcoded calendar fall-through with real intent classification across the
registry. It also makes every future grammar correction a function deploy rather
than a reinstall. The repo already reached this conclusion once, for wording:
`_shared/card.ts` puts response text server-side *"so fixing a sentence is a
function deploy rather than rebuilding and reinstalling the .aix."* Routing is
that argument one level up.

Constraints on the implementation:

- **Do not upload the directory.** Resolve names server-side from the wearer's own
  Postgres. Shipping third-party names and emails every turn is an undisclosed transfer.
- **Scrub request bodies from function logs.** Utterances contain names, health
  details and negotiation terms by default.
- **Keep `rulePlanner` as a genuine offline path**, not a nominal one: last agenda
  from cache, face verbs handled entirely locally, and honest wording — *"no
  signal; this is from 40 minutes ago"* rather than a confident stale answer.
- **Cost ceiling per owner, enforced in the function.** `_shared/http.ts` enforces
  `MAX_UPLOAD_BYTES` and nothing else. Every turn spends the wearer's money.
- **Paint a mood frame and the transcript within ~200ms, before the fetch.**
  `utils/mood.js` is the latency contract, not decoration.
- **Measure when it is wrong.** One repair verb — *"Kavi no, I meant…"* — that both
  fixes the turn and files the example into the corpus.

### Phase 4 — capabilities, in this order

1. **Quick capture and reminders (S).** The highest-frequency verbs and Kavi has
   none. `GOOGLECALENDAR_QUICK_ADD` is already registered and already called; the
   only reason "remind me" fails is that the create branch matches
   `/(add|create|book|schedule|set up|put)/` and "remind" is not in it. Never build
   a Kavi-owned task store.
2. **Memories: append-only, back-filled (M, transformative).** One migration:
   `memories(id, owner_id, kind, person_id, text, occurred_at, expires_at NOT NULL)`.
   **v1 recall is structural, not semantic** — every embedding column is
   `vector(128)` because that is SFace's output, and there is no text embedding
   model anywhere in `_shared`. **The idea that makes it work on day one:**
   back-fill relationship history from the wearer's own past calendar events —
   *"you have met 4 times; last was Security Review on 12 June"* — real content
   requiring no dictation. An empty relationship card teaches the wearer the
   feature is fake on their first real test.
3. **The handshake brief (M).** Recognise → who → when you last met → what you owe
   them → what you share today. Two hard rules: **never resolve an unmatched face
   against the directory**, and below the confident threshold say "I think" or
   nothing — never a name.
4. **Send actions (M, the market wedge).** Missing Gmail/Slack is the one omission
   reviewers name as a reason to switch off Ray-Ban Display, and Meta structurally
   cannot fix it. Build the **action vocabulary, not a keyboard**: archive, snooze,
   on-my-way, accept, three canned replies.
5. **"Kavi read this" (M).** Press-first, not voice-first — the gate throws at the
   *shutter*, not only at `createCameraContext()` (see `pages/face/face.ink`).
   Run YuNet server-side and blur or reject detected faces before the image
   reaches any VLM, unless the wearer used an explicit face verb.

---

## 3. Do not build

| Not this | Because |
|---|---|
| Passive / always-on face recognition, ambient proactive AI | Forbidden by the platform (no background execution), empirically failed (Meta's Live AI ~30 min per charge), and legally fatal — a wearer cannot obtain bystander consent |
| Live captions, conversation translation, turn-by-turn nav | Rokid ships all three first-party. A third-party `.aix` loses on latency, offline capability and render quality on day one |
| Badge / business-card auto-enrolment | Creates a face template bound to a name with the subject absent from their own enrolment. Destroys the only defence the product has. Badge OCR may *prefill* an already-enrolled person and must never create a `people` row |
| Nod-to-confirm for sends | `docs/06` records IMU among the unreliable surfaces. A motion heuristic's false-positive rate becomes the product's false-send rate |
| WhatsApp, Telegram, LinkedIn | All ship as broken promises. Composio's WhatsApp is the Business Cloud API; Telegram is the Bot API; **LinkedIn has no name-based person search**, so the integration everyone assumes pairs with face memory architecturally cannot |
| Notion read, Drive read, Docs, GitHub browse | Wrong shape. The rule that sorts the long tail: **any toolkit whose payoff is reading a document is out; any whose payoff is depositing a sentence is in** |
| More connectors as the growth strategy | Grows breadth linearly *in grammar*, worsening discoverability, and degrades sign-in. Add a connector only where it backs a verb that already exists |
| Free-text composition on the HUD | No keyboard, and dictating a message body aloud destroys the HUD's one real advantage — private output |
| Location sampling, BLE place awareness | The calendar already says where the wearer is meant to be, with far less noise. Grow context by **more joins on the calendar event**, not more sensors |

---

## 4. The strategic decision

**The privacy story and the server-side brain are in direct contradiction.**

Kavi's differentiator — the thing Meta structurally cannot copy — is *"your face
embeddings live in your own Supabase project."* That is only true because the
wearer self-hosts. But the brain, the vision pipe and any queue all require
infrastructure the wearer must fund and operate: a model call per turn, ONNX
inference already fighting the HTTP 546 worker limit, and a per-owner spend
ceiling to stop a looping client billing them.

- **Stay self-hosted** → most of this roadmap is impossible for a normal wearer,
  and Kavi remains a well-engineered demo for people who can deploy Edge Functions.
- **Go hosted** → it all becomes shippable, and the strongest form of the privacy
  claim dies.

**Recommendation: go hosted, and keep the claim in the form that survives** — a
per-wearer isolated store, no cross-wearer face index, no template of anyone the
wearer did not introduce, full export, hard delete, named region. Meta still
cannot say that, and it is a claim you can keep. Offer self-hosting as a
documented option, and state in the docs which claims hold in which mode.

**Decide before Phase 3**, because it determines whether the turn function is a
product component or a per-wearer ops burden.

### Runner-up risk, and it is existential

Kavi may not be reliably summonable at all. See Phase 1. If the answer is bad, it
outranks everything above it.

---

## 5. Note on embeddings

There is no hosted embedding key and none is needed. Face embeddings are produced
locally inside the Edge Function — YuNet detect → 5-point align → SFace int8 ONNX
(`_shared/pipeline.ts`, `_shared/sface.ts`) — so no third party ever sees a face
and there is no per-embedding cost. Deployed secrets are `COMPOSIO_API_KEY`,
`CONNECT_PAGE_URL` and the Supabase-managed set.

If semantic text memory is ever added it needs a **new** embedding provider, and
that key must be a Supabase secret. It must never enter `config.js`, which ships
inside the `.aix`.
