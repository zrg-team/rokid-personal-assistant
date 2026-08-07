# 15 — Submission review: ready for build & store?

A readiness check against the three criteria for the store build:
**no personal information**, **login works for every user**, and **a full list of
commands**. Written against the code as it stands after the connections rework
(docs/14) and the sign-in gate being turned on.

**Verdict: ready to submit** (build `people-memory-1.3.0.aix`, build 19).
Everything below is the evidence.

---

## Release review (v1.3.0)

A full pass over every flow, verified against the live backend and the real Ink
engine (`dev/runtime.html`, the same WASM the glasses run):

- **Sign-in** — live state machine confirmed: `start` → `poll` pending → `claim`
  stays pending until approved → `check` rejects a bad token → `?go=` **302s to
  Google's real consent** (Composio managed client). The gate was exercised in the
  Ink engine: with `AUTH.required` on and no token, a request routes to the
  sign-in page; `index.ink` and `signin.ink` both compile and run with no errors.
- **Calendar** — `connections execute` healthy and guarded (bad token → signed
  out). Fixed one inconsistency found in review: a spoken request now routes to
  sign-in on `signed-out`/`not-connected`, matching the silent refresh path.
- **Faces** — `face` / `face-people` healthy (`200`), scoped per-wearer by device
  token; gated behind sign-in. A revoked token falls back to the empty `default`
  bucket (no cross-wearer leak).
- **No secrets/PII** in the committed shipped tree; **build 19** confirmed running
  in the engine log.

**One thing only verifiable on hardware:** whether the Hi Rokid app opens the
sign-in link in the **system browser** (Google OAuth works) or an **in-app
webview** (Google may block OAuth with `disallowed_useragent`). If blocked, the
fix is to open the link in the system browser. Everything testable off-device
passes.

---

## Criterion 1 — No personal information

The shipped `.aix` is `app.js`, `app.json`, `AGENTS.md`, `config.js`, `utils/`,
and `pages/` — no backend code, no secrets file. It was scrubbed and re-scanned:

| Was in the bundle | Status |
| --- | --- |
| A real person's email in a `utils/people.js` comment | Removed → generic wording |
| Dead Composio test identity (`userId: pg-test-…`, `connectedAccountId: ca_…`) | Removed from `config.js` |
| A dead Composio API key (`ak_Vmhh…`) | Removed from `config.js` |
| Spoken-sentence logging (`DEBUG.logSpeech`) | Off by default; only logs a length |

**What still ships, and why it is safe:**

- **Supabase project URL + publishable key.** Designed to ship. The `people` and
  `face_embeddings` tables have row-level security **on with no policies**, so
  the key reads and writes nothing directly — only the Edge Functions (which hold
  the service-role key) can touch data, and they decide what each caller may see.
- **No third-party keys.** The **Composio API key lives only on the backend**
  (`COMPOSIO_API_KEY` secret). The glasses never hold it; they carry a single
  revocable **device token** issued at sign-in.
- **Biometric face data is personal** — and it is now scoped per-wearer, not
  pooled (see Criterion 2). That is the substantive privacy fix in this build.

The one dev-only leftover — a `localhost` camera stand-in — has been cleared:
`FACE.devCameraUrl` now ships empty, and `dev/server.mjs` injects the local URL
for the harness only. `npm run pack` runs with **no warnings**.

---

## Criterion 2 — Login works for every user

**The model:** there is no hardcoded account, and — deliberately — no email,
password, or login account at all. When the glasses start a pairing, the backend
mints a **device-scoped `owner_id`** for it. The wearer connects their Google
Calendar on a phone, and *that connection is the sign-in* — it gives the pairing
something real to belong to. The glasses then hold one revocable device token,
which the backend resolves back to that `owner_id` on every request. That single
identity isolates **both** features:

- **Calendar** — the Composio `user_id` is the wearer's `owner_id`, so tool calls
  read and write that wearer's own Google Calendar and nobody else's.
- **Faces** — the face functions resolve the device token to the same `owner_id`
  first (`owner_from_device_token`), so "who is this" and "remember her as Tracy"
  land in that wearer's own people, not a shared `default` bucket.

Why no email: the alternative meant either Supabase email OTP (whose template
can't be edited without paid custom SMTP, and whose default sender is rate-limited
— both real launch blockers) or a Supabase Google provider (which needs a Google
Cloud OAuth client, the very thing Composio's managed Google was chosen to avoid).
Making the Google connection double as the sign-in removes all of that.

**Sign-in is required** (`AUTH.required = true`). Every entry page — the agenda
hub, the schedule card, and the face card — calls `requireSignin()` at the top of
`onLoad`, so a fresh install routes to the sign-in card before anything runs. That
is what makes "works for every user" true rather than "works for whoever set it up
first." (Set it back to `false` only for local dev.)

**The sign-in flow itself** (docs/11, docs/14), which any user can complete:

1. Kavi shows a short word-code (e.g. `coral-ivory-24`) and a tappable link.
2. The wearer taps the link — it appears as a clickable link in the Hi Rokid app
   conversation, with an on-card hint telling them to tap it.
3. The link **redirects straight to Google's consent screen** (through Composio's
   managed client, so no per-user Google Cloud setup). There is no page to load,
   no email, no password, no code to type — the wearer picks their Google account
   and allows calendar access. That consent *is* the sign-in.
4. Google returns them to a one-line confirmation showing a word; they check it
   matches their glasses, press the temple key, and the card they asked for opens.

Why no web page at all: Supabase's functions domain refuses to render `text/html`
(it forces `text/plain` + `nosniff` to prevent phishing), so a hosted sign-in page
would show as source. Redirecting to Google's own consent screen sidesteps that
entirely — the only rich screen is Google's, and the confirmation is genuinely
plain text.

Verified end to end against the live project (this build): `pair start` returns a
`…/pair?go=<code>` link; that link **302-redirects to a real Composio→Google
consent URL** (confirmed in a browser — it lands on `accounts.google.com` with
calendar scopes and Composio's managed client id); the `?done=` return refuses
until Google is actually connected. The calendar execution and per-wearer face
path (`face` / `face-people` device-token scoped, both `200`) were verified
against the live project earlier and are unchanged.

---

## Criterion 3 — All commands

Kavi is invoked by its name — the coined word **"Kavi"** (its name in
`AGENTS.md`, its wake word, and the prefix on the sign-in phrase). Once it is the
active agent, calendar and people commands are spoken plainly; only sign-in needs
the name spoken, because bare "sign in" is too common and would collide with the
built-in assistant and other agents.

### Sign-in — say the name

Routes to the sign-in card. English or Vietnamese; the matcher folds away tone
marks and tolerates the common ASR spellings of "Kavi" (c/k, i/y, optional space).

- "**Kavi, sign in**"
- "**Kavi, log in**"
- "**Kavi, đăng nhập**"  *(Vietnamese; "dang nhap" without marks also matches)*

*(The sign-in card also opens on its own the first time, via the gate — this
phrase is for signing in again or re-linking later.)*

### Calendar — needs the Google Calendar connection

- **Today / a day's agenda** — "What's on my calendar today?", "What do I have
  tomorrow?", "What does Friday look like?"
- **Look up one thing** — "When does my flight start?", "Where is the standup?",
  "When is lunch with Tracy?"
- **Who is in a meeting** — "Who's in the engineering catch-up?", "Who's coming
  to the standup?", "Attendees for the review?"
- **Free time** (computed on-device from the day's events) — "Am I free
  tomorrow?", "When am I open?", "Do I have any gaps today?"
- **A colleague's day** (someone you share meetings with) — "What does Kevin have
  today?", "Is Sarah busy tomorrow?", "Show me David's schedule."
- **Someone you don't share meetings with** → an honest answer rather than a
  wrong one: "Is Tracy busy?" → *"I only know people you share meetings with."*
- **Add an event** — "Add lunch with Tracy at noon", "Book a meeting Friday 3pm",
  "Schedule the dentist tomorrow morning."  *(→ `GOOGLECALENDAR_QUICK_ADD`)*
- **Day words understood** anywhere in a request: today, tonight, tomorrow,
  yesterday, and weekday names.

### People / faces — a default feature, no connection needed

Photographs whoever is in front of the wearer; recognition runs in the backend.

- **Identify** — "Who is this?", "Who is she?", "Do I know them?", "Have I met
  her?", "What's his name?", "Remind me who this is."
- **Just capture** — "Take a photo", "Look at them", "Scan their face."
- **Remember a name** — "Remember her as Tracy", "Call him Kevin", "His name is
  David", "This is Sarah", "Save her as Mai."
- **Attach a note** — "Note that she runs the security review", "Remember that we
  met at the offsite", "Make a note that he prefers email."
- **Forget** — "Forget Kevin", "Delete Tracy from my people."
- **List** — "Who do I know?", "List my people", "How many people do I know?"

### Temple key

A press on the glasses' temple key confirms the sign-in approval (step 4 above)
and dismisses a finished card.

---

## What is deployed

- **Edge Functions** (all self-authenticating, `verify_jwt = false`):
  `pair` (device sign-in + phone page), `connections` (authorize / status /
  execute via Composio), `face` (detect + recognize + enrol), `face-people`
  (list / annotate / forget).
- **Secrets:** `COMPOSIO_API_KEY` set. Optional: `OWNER_SIGNING_SECRET` (only for
  a multi-wearer backend *without* sign-in — not needed now that sign-in is on),
  `PAIR_VERIFY_URL` (override the phone-page URL if you front it with a domain).
- **Migrations applied:** capture retention, device auth (`pairing_sessions`,
  `devices`, `owner_from_device_token`).
- **Pending for 1.5.0** (`npm run db:push`): device tenancy — `owners`,
  `ON DELETE CASCADE` from every memory table, `devices.device_uid_hash`,
  `owner_for_device_uid()`, `forget_owner()`. Verified against Postgres 16 with
  pgvector, applied over pre-existing rows, and re-applied for idempotency.
  **Deploy `pair` with it**: `start` sends and stores `device_uid`, so the
  function and the migration have to land together.
- The old direct-Google function and its `google_accounts` table (the retired
  approach in docs/13) have been removed / are orphaned — see below.

---

## Pre-flight checklist before you hit build

- [x] **`FACE.devCameraUrl` cleared** — ships empty; injected by the dev server
      for the harness only. `npm run pack` now runs with no warnings.
- [x] **`AUTH.devToken` empty** — confirmed; the dev server injects it from
      `KAVI_DEV_TOKEN` when needed.
- [x] **Re-packed** — `dist/people-memory-1.2.0.aix`, 28 files, 67.6 KB.
- [x] **`COMPOSIO_API_KEY` set** on the project.
- [x] **No email / SMTP dependency.** The earlier plan needed Supabase email OTP,
      which hit a wall — the OTP template can't be edited without paid custom SMTP,
      and the default sender is rate-limited. The redesign (Google connection *is*
      the sign-in) removes that dependency entirely, so there is no Auth console
      setting to get right and nothing that throttles at scale.
- [ ] **Google consent screen is publishable.** Because Google auth runs through
      Composio's managed client, this is Composio's configuration, not yours — but
      if you brand the connection, make sure the consent screen isn't stuck in
      Google "testing" mode (which caps it at 100 users). Nothing to do for the
      default managed client.

The current `dist/people-memory-1.2.0.aix` is the build to submit.

## Known limits (non-blocking)

- ~~**Orphaned `google_accounts` table.**~~ Fixed in 1.5.0: the device-tenancy
  migration drops it when it is empty, and says so in a `NOTICE` when it is not
  (a table holding live refresh tokens should not vanish silently).
- **Add-event confirmation is prompt-only.** The card asks before it writes but
  does not require a second explicit tap; see the README's known-limits note.
- **On-device LanguageModel is off** (`PLANNER.useLanguageModel = false`) by
  design — the rule planner covers every intent above. Turn it on only after
  confirming the model answers on your specific device.
- **`dev/preview.html`** still references a couple of removed config fields. It is
  a dev-only file, never packed, so it does not affect the build.
