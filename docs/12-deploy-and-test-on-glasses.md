# Deploying and testing on a real Rokid device

*How to get this agent — and its sign-in backend — onto physical Rokid Glasses,
how it is invoked there, and what to watch for.*

*The build-and-test procedure below follows Rokid's official quickstart for
AIUI **0.17.0** (`js.rokid.com/AIUI/guide/quickstart/quickstart`, whose source is
`jsar-project/AIUI` at tag `v0.17.0`). The "known beta gotchas" at the end come
from the developer forum instead — those are developer reports and
current-beta behaviour, not documented guarantees. Sources at the end.*

## Two things get deployed, not one

This agent has a client and a backend, and they ship through completely
different channels:

1. **The agent** (`.aix`) → bound to an AIUI Agent in **AIUI Studio**, uploaded,
   then pulled down by the glasses.
2. **The Supabase backend** (face recognition + the sign-in `pair` function) →
   deployed to Supabase with the CLI.

Sign-in needs **both**: the glasses run `pages/signin`, but it talks to the
`pair` Edge Function, which must be live first.

---

## 1. Deploy the Supabase backend

```bash
npm run db:push     # applies migrations: face tables, pairing_sessions, devices
npm run deploy      # deploys the functions: face, face-people, pair, connections, console
```

Then, in the Supabase dashboard, set the Edge Function secrets the backend needs
(Project → Edge Functions → Secrets): `COMPOSIO_API_KEY` (required — the glasses
never hold it), and optionally `PAIR_VERIFY_URL` (a short domain to show on the
HUD instead of the long Supabase URL) and `OWNER_SIGNING_SECRET` (see `docs/08`).

Verify the function answers before touching the glasses:

```bash
curl -s -X POST "https://<project-ref>.supabase.co/functions/v1/pair" \
  -H "apikey: <supabase-publishable-key>" \
  -H "content-type: application/json" \
  -d '{"action":"start"}'
# → { "ok": true, "user_code": "green-tiger-42", "verification_url": "…", … }
```

That `verification_url` is what the glasses show and the wearer taps. It is long,
so set a `PAIR_VERIFY_URL` secret (or a Supabase custom domain) if you want it
easier to read — there is no built-in short domain.

---

## 2. Package the agent

```bash
npm run pack        # → dist/people-memory-<version>.aix
```

`dev/pack.mjs` wraps `@yodaos-pkg/aix`. Rokid also ships a standalone CLI, which
is what the official docs use and what Craft's **Pack** button runs behind the
scenes:

```bash
npm install -g @yodaos-pkg/aix-cli
aix pack .                 # → an .aix from this directory
aix pack . --optimize      # compress images and JSON
aix list dist/people-memory-1.7.3.aix
```

Both honour `.aixignore` (same syntax as `.gitignore`), which is what keeps
`dev/`, `supabase/`, `docs/` and `test/` out of the shipped package. Packing
also mints the `VERSION` file — a UUID the platform uses for version validation
and hot updates, so it is generated, never hand-written.

Locally you can pre-check the result with `dev/aix-check.html`; a build is ready
when Rokid's reader parses it (title, pages, and one tool per page).

---

## 3. Bind the agent in AIUI Studio, and upload

**This must happen before the glasses can run anything.** A `.aix` sitting on
your disk is not reachable from the device — there is no `adb install` path.

1. **AIUI Studio Global** — <https://aiui-global.rokid.com/space>. Sign in with a
   developer account (registration and developer verification first, if new).
2. **Application Management → Create Application**, type **AIUI Agent**. Fill in:
   - **Name** — how it appears in the store. Ours is **Kavi**.
   - **Icon** — square, per the design guidelines. **You must replace the default
     icon: a submission that still carries it is rejected at review.**
   - **Description** — keep it in step with `AGENTS.md`.
3. A freshly created agent is not yet bound to a project, so **a load failure
   message on first open is expected**. Close it and bind the project.
4. **Bind**, either way round:
   - upload the AIUI project directly after closing that message, or
   - **Craft → Editor Settings → Local Management**, and bind the agent there.
     Craft Global is <https://js.rokid.com/craft?region=global>; it imports from
     a local folder, a local `.aix`, or a GitHub subdirectory.
5. **Package and upload** the project to AIUI Studio (Craft's Pack button, or
   upload the `.aix` from `npm run pack`).
6. **Declare the permissions** the agent uses on the upload screen, and enter the
   agent description beside them. Ours: **camera, microphone, network, audio,
   storage** — the same five listed in `AGENTS.md`. Declare only what you use.

Developers report an agent can stay in **draft** status for personal debugging;
you do not have to submit for review to test on your own glasses.

---

## 4. Sync the build to the glasses

Once the agent is bound, packaged and uploaded, pull it down:

> **Glasses settings → Developer → AIUI → Update glasses resources**

**You trigger this from the phone, and watch it land on the glasses.** The
quickstart's wording ("On the glasses, go to Settings > Developer > AIUI") reads
as if the menu were on the HUD, but the screenshot beside it is a phone
screenshot: the Developer page listing *Glasses ADB debugging*, *Agent debug*,
*Retail Demo Mode*, and **AIUI → Update glasses resources**. That is the Hi Rokid
companion app's settings *for the glasses* — the same "更新眼镜资源" the forum
write-ups describe. There is no equivalent menu in the HUD.

What you see on the glasses is the result:

1. A **download indicator** (⤓) appears in the HUD's lower-right, beside the
   signal and battery icons, while the package pulls.
2. When it finishes the indicator disappears and a toast reads
   **"<agent> 已就绪" / "<agent> is ready"**.

Then invoke it (§5). Re-syncing after a new upload is the same three steps —
there is no separate "reinstall".

### How it knows *which* glasses and *which* agent

Nothing in the sync flow asks you to pick either one, and the prose never
explains it. The Craft binding dialog does:

> **Link AIUI Agent** — "Fetch the available AIUI agents for **the current
> account** and link this directory to the selected agent."
>
> CURRENT BINDING · Hello AIUI · `Project Key: project:a2475b1b-7f9d-…`

So the whole chain is scoped by **one Rokid account**, with a `Project Key`
joining your local directory to one agent record:

```
your local directory ──Link (Project Key)──▶ AIUI Agent record in Studio
                                                      │
                                            (same Rokid account)
                                                      │
        Hi Rokid app, signed into that account ◀───────┘
                    │
            paired glasses  ──▶  "Update glasses resources" pulls that
                                  account's agent resources
```

- **Which agent** — the one your directory is *linked* to in
  **Craft → Editor Settings → Local Directory → Link AIUI Agent**. An unlinked
  project shows **"AIUI Not Linked"** there, and `Pack`/`Submit` have nowhere to
  put the build. `Unlink` / `Update` re-point it at a different agent.
- **Which glasses** — the pair currently paired to the phone whose Hi Rokid app
  you tapped in. There is no device picker: the sync targets the paired device.

**The failure mode this creates:** if the account signed into Craft/AIUI Studio
is not the same account signed into the Hi Rokid app, the sync completes and
pulls nothing relevant — the agent you just uploaded is not in *that* account's
list. Nothing in the UI explains this. Check the account before debugging
anything else, and note the same account-level listing is what the forum's
"zombie agent" reports (§7) are about.

*(The "current account" wording is verbatim from the Craft dialog; the rest of
this section is read off those screenshots and the pairing model, not stated in
the prose.)*

### Two things the screenshots give away

- **`Glasses ADB debugging` is a toggle on that same page**, which is how the
  ADB log access described in §7 gets enabled.
- **The HUD's idle line names the system wake word.** It reads
  *唤起AI助手，请说"乐奇"* — "to wake the AI assistant, say **乐奇** (lèqí)". That
  is the `leqi` default AIUI 0.17.0 documents for `onVoiceWakeup`'s
  `event.keyword`, seen in the wild — and the reason `pages/index` no longer
  drops a wakeup whose keyword is not our own name (docs/20 §4).

---

## 5. How it is invoked on the glasses

This is the part that shapes the design, and it is why this agent recognises its
**own** trigger words rather than trusting the platform to route them. A custom
AIUI agent is **not** the main assistant. It is reached two ways:

- **By name, after the assistant is awake.** Rokid's quickstart is explicit:
  *wake the AI assistant, then say the name of the agent.* Ours is **"Kavi"** —
  the Name in `AGENTS.md`, coined so it is unique rather than an everyday
  English or Vietnamese word another agent could also claim, and clean for both
  languages' ASR.
- **By the AI-shortcut gesture** — a double two-finger tap on the touchpad
  invokes whichever agent is selected as the **"call target"** in the companion
  app's AI-shortcut list.

Routing **all** voice commands to a custom agent (making it the default
assistant) is **not supported today**. So once your agent is foregrounded, *it*
must interpret what it hears.

### Which is why sign-in has explicit triggers

Because the platform will not reliably catch a bare "sign in" and open your page,
this agent reaches sign-in two ways of its own (both in code):

- **A unique trigger phrase** — `signinCommand()` in `utils/planner.js` requires
  the coined word **"Kavi"** *plus* a sign-in verb — `START_VERB`
  (**"Kavi start"**, "begin", **"Kavi bắt đầu"**, "khởi động") or `SIGNIN_VERB`
  (**"Kavi sign in"**, "log in", **"Kavi đăng nhập"**). Matching is
  accent-insensitive and tolerates the common ASR spellings of Kavi (c/k, i/y,
  optional space). Requiring the unique word — not a bare
  "sign in", which the assistant or another agent could also claim — is the
  whole point. `pages/index` routes it straight to `pages/signin`.
- **The gate** — `requireSignin()` in `utils/gate.js` redirects any page to
  sign-in on a launch with no stored token (active when `AUTH.required = true`).

The page's `<script def>` description is kept too, so the host model *can*
dispatch it where that path works — but nothing depends on it.

---

## 6. On-device test checklist

The desktop harness proves layout and logic; only the glasses prove the rest.
Rokid's own tooling guidance says the same — prioritise real-device results as
the final basis for judging the experience, and pair log output with remote
debugging to locate runtime issues. Verify on hardware:

- **Invocation** — the assistant wakes, and "Kavi" opens the agent. Test the
  touchpad AI-shortcut separately; it has its own failure mode (§7).
- **Sign-in** — say a trigger phrase (or launch gated): the code and link are
  legible; the phone flow completes; the confirm word matches; the temple press
  finishes and stores a token; a relaunch skips sign-in.
- **Legibility at 480 × 352** — code, URL, and confirm word readable at a
  glance, nothing overflowing the card, nothing crowding the 16px safe inset.
  Check the narrower **448 × 150** Interactive InkView surface too; a card that
  fits full screen can still clip there.
- **Voice** — the wake word and ASR actually trigger, and the sign-in phrases
  route to sign-in.
- **Camera + TTS** — `takePhoto()` fires from a tap or temple press; spoken lines
  play.
- **Temple key** — `GlobalHook` reaches `onKeyUp`.
- **Failure paths** — expired code, denied camera, no network: each shows a
  clear state, not a blank card.
- **Weak network** — Rokid singles this out; the calendar and face paths both
  make round trips that a marginal link will stall.

---

## 6a. Findings from the first on-device run

What the desktop harness could not have told us. All three came from one
session on real glasses.

### The ASR does not spell "Kavi" the way you do

Transcribed on-device: **Kavi**, **Kavie**, **Cavi**, **Carvi**. The matcher in
`utils/planner.js` accepted the first and third and rejected the other two —
`Kavie` because a trailing `e` defeated the ``, `Carvi` because a non-rhotic
"kah-" comes back as "car-" and there was no room for the `r`.

The failure was much worse than it sounds. `stripKavi()` leaves the name in the
string when the pattern misses, and every `Kavi <app> <action>` command is
anchored at `^` *after* the strip — so a single mis-heard vowel silently
disabled the entire command grammar, greeting included. Nothing errored; the
agent simply stopped listening.

`KAVI_SOUND` now covers `k`/`c`, an optional `r`/`h`, a doubled `v`, and the
`i`/`y`/`ie`/`ee`/`ey` endings, with the `` retained so *cavity*, *carvings*,
*cabinet* and *car video* still fail. 16 cases are pinned in
`test/planner-routing.test.mjs`.

**Whenever you change the agent's name, budget for this.** A coined word is
unique — which is exactly what makes it something the ASR has never been trained
on. Collect the real transcriptions before trusting a pattern.

### One greeting was not enough

`halo` was the only word most wearers reached for, and the only one they
reliably got. The greeting set is now **halo / hallo / hullo / hello / hey / hi
/ xin chào / chào**, and a comma after it (`"Kavi hello, Tracy"`) no longer
breaks the name capture. Bare greeting → identify; greeting plus a name →
enrol. Unchanged.

### "Google Calendar tomorrow" showed today's events

**Fixed.** Three faults, stacked, all now closed:

1. **No `'google calendar'` alias.** `connectionCommand()` matches a leading
   prefix against `['calendar','lich','agenda']`, so `"calendar tomorrow"`
   routed and `"google calendar tomorrow"` returned `null`. Added
   `'google calendar'` and `'gcal'` to `config.js` **and**
   `_shared/services/googlecalendar.ts` — they must not drift.
2. **`namedPerson` hijacked it.** With no alias match the raw utterance reached
   `rulePlanner`, whose `<word> calendar` pattern captured **"google"** and
   answered *"I do not know who google is."* `namedPerson` now skips any word
   that opens a service name, derived from the live alias table so a connection
   added later is protected the day it is added.
3. **`dayRange()` silently degraded any non-ISO date to today** — the fault that
   actually produced the reported symptom, because the live path for
   "Google Calendar" is host dispatch to `pages/schedule`, whose schema asks for
   `yyyy-mm-dd` that the host model cannot reliably compute. It now resolves day
   words through `resolveDay()` and returns a `fallback` flag; the card says
   *"Did not catch 'banana' — showing today"* instead of quietly showing today
   under a confident header.

A fourth, unrelated bug was found alongside them: **`AUTH.aliasKey` was read and
written by `pages/index` but never declared**, so every console-defined shortcut
was lost on the next cold dispatch — which is every voice command. Now declared.

### If a calendar call 404s

*Failed to list events, Status 404* is a different failure from the above, and
it is **not diagnosable from the HUD**. That sentence is not ours: it
comes from Composio, through the `connections` Edge Function, through
`utils/connections.js`, and reaches the card with every useful detail already
stripped. At least four different faults produce the same line:

1. `connections` is not deployed → Supabase's own 404;
2. the tool slug is wrong → Composio 404s the execute endpoint;
3. no connected Google account for this wearer;
4. Google returns 404 for the calendar id we asked for.

**Correction (this section was wrong).** It previously claimed `pages/index`
rewrites `Kavi google calendar tomorrow` to just `tomorrow`. It did not: there
was no `'google calendar'` alias, `connectionCommand()` returned `null`, and the
raw utterance reached `rulePlanner`, where `namedPerson()` captured **"google"**
from the `<word> calendar` pattern and answered *"I do not know who google is."*
No calendar call was made at all — which is why nothing in the connections
router explained it. Fixed in §6a: the alias exists now, and `namedPerson` can
no longer claim a service name.

There was a **second, independent** fault behind the same symptom, and it is the
one that produced "today's events instead of tomorrow's": host dispatch to
`pages/schedule` with `date: "tomorrow"`, which `dayRange()` silently degraded
to today. Also fixed in §6a.

Neither of those is the 404 below — that is a third, separate failure on the
tool call itself, and the four causes above still apply to it.

```bash
KAVI_DEV_TOKEN=<device token> npm run check:calendar
```

walks that same path and prints the raw JSON at each hop, including the same
call with **no arguments at all**. That comparison is the point: if the bare
call succeeds where the argued one 404s, the fault is the argument names, and
nothing else. Composio's published schema for `GOOGLECALENDAR_EVENTS_LIST` is
self-inconsistent — its toolkit page lists camelCase (`calendarId`, `timeMin`,
`singleEvents`, plus a `composio_replaced_calendar_id`), while other Composio
pages list snake_case (`calendar_id`, `time_min`, `single_events`) — so **read
the tool's schema in your own Composio dashboard** rather than trusting either
page. We currently send camelCase.

---

## 7. Known beta gotchas (from the forum)

Budget time for these — they are current-platform realities, not your bugs:

- **Deleting an agent may not fully remove it.** Deleted agents linger as
  selectable "zombie" entries in the companion app, re-uploading the same name
  creates duplicates, and even a factory reset did not clear them for one
  developer. The partial fix reported: remove the link in Craft, then delete
  again. Prefer **updating** a build over delete-and-recreate, and avoid churning
  agent names.
- **Custom agent as call target can fail.** Selecting a custom agent for the
  AI-shortcut and triggering it has returned *"AI assistant service error"* for
  multiple developers; the requirements to be invocable are not documented. Test
  invocation-by-name as well.
- **No display/power API.** There is no documented way to sleep the panel or exit
  to a dark screen; `wx.exitMiniProgram()` hands back to the (lit) assistant
  home, and `this.finish()` only ends the current page's task. Don't design a
  flow that depends on the glasses going dark.
- **ADB is for logs, not for installing the agent.** The `.aix` goes through
  AIUI Studio and the on-glasses updater, never `adb install`. ADB over the
  5-pin dev cable is available for logs but is reported flaky (can fail to
  enumerate on Windows 11); use a data/debug cable, not a charge-only one.

---

## 8. Submitting to the store

When the build is ready (see `docs/15` for the readiness review):

1. In AIUI Studio, **Upload Version** with the current `.aix`. The platform
   validates the `VERSION` file and the `AGENTS.md` declaration automatically.
2. Fill the **Preview Media** tab: 3–5 JPG/PNG images or MP4 videos, including
   at least one image *and* one video. `npm run shots` renders these from the
   real pages on the real Ink runtime at 480 × 352 — see `docs/15`.
3. **Submit for Review**, and accept the User Agreement. Rokid reviews
   performance, interaction compliance, and security.
4. On approval it is listed in the Hi Rokid Agent Store. Later versions are the
   same loop: `npm run pack` → Upload Version → Submit; approved updates reach
   devices as a hot update keyed on `VERSION`.

---

## Sources

- **Rokid AIUI 0.17.0 documentation** — Quick Start (build, Craft, on-glasses
  debug, submission), *Publish to the Hi Rokid Agent Store*, *aix-cli*,
  *What Is AIX?*, *On-Device Debugging*, *Craft Platform*. Rendered at
  `js.rokid.com/AIUI`; source in `jsar-project/AIUI` under `documentation/`,
  tag `v0.17.0`.
- Rokid developer forum post **3481** — an agent's build-and-on-device-test
  writeup (`forum.rokid.com/post/detail/3481`).
- Post **3493** — agent lifecycle, the AI-shortcut "call target" list,
  invocation by name, and the "main assistant → custom agent" limitation.
- Post **3564** — exit behaviour, the absence of a display/power API, and ADB
  over the dev cable.
- Platform/runtime background: `docs/02`, `docs/03`; the build loop: `docs/09`;
  what changed in 0.17.0 and what it means here: `docs/20`.
