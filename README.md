# Kavi — a personal assistant for Rokid Glasses

Say **"Kavi"**, ask about your day in plain language, and the agent reads
Google Calendar through Composio, renders a heads-up card, and speaks a
one-breath summary. It also remembers people: look at someone and ask *"who is
this"* and it answers with their name, your notes about them, and whatever
meeting you share today ([Faces](#faces-who-am-i-talking-to)). Say *"Kavi sign
in"* and the glasses pair with your account through a short code opened on a
phone — no password ever touches the device (docs/11).

```
"Kavi"  →  onVoiceWakeup  →  SpeechRecognition  →  plan a tool call
                                                        ↓
        speechSynthesis  ←  card + summary  ←  Composio  →  Google Calendar
```

It answers six kinds of question, all verified against the live calendar:

| Ask | Route | Spoken answer |
| --- | --- | --- |
| "what's on my calendar today" | `EVENTS_LIST`, one day | "You have 4 events on Tuesday, Jul 28…" |
| "when does my flight start?" | `EVENTS_LIST` + free-text `q`, 60 days | "Tokyo - Ho Chi Minh City (VJ 823) starts at 08:55 on Sat Aug 1." |
| "who is in the engineering catch up" | `EVENTS_LIST` + `q`, then attendees | "Engineering Catch Up has 16 people… 11 have not replied." |
| "am I free tomorrow" | `EVENTS_LIST`, gaps computed locally | "You have 1 opening on Wednesday, Jul 29. The longest is 3h from 09:00." |
| "what does Kevin have today" | `EVENTS_LIST` on *his* calendar | "Kevin Nguyen has 4 events… 2 overlap with yours, including Focus time for technical at 16:00." |
| "is Tracy busy today" | unresolved name | "I do not know who Tracy is. I only know people you share meetings with." |

Two things make the people features work. Google matches `q` against title,
description, location **and attendees**, which is how "flight" finds an event
titled "Tokyo - Ho Chi Minh City (VJ 823)". And colleagues' calendars are
readable directly (`accessRole: reader`) even though the free/busy API is not.

## Run it

First, create your config — `config.js` is gitignored so credentials never land
in the repository:

```bash
cp config.example.js config.js
# then fill in: Composio scoped key + user id (calendar),
#               Supabase project URL + publishable key (faces & sign-in)
```

```bash
npm run dev
#   http://localhost:5178/dev/runtime.html   ← the REAL Ink runtime
#   http://localhost:5178/dev/preview.html   ← logic harness
```

**`dev/runtime.html` is the one that proves it works on the glasses.** It loads
`@yodaos-pkg/ink` 0.14.0 — Rokid's own "Ink Web SDK for browser rendering" —
initializes the WASM runtime at exactly 448 × 352, and calls `view.openBundle()`
with the project's real files. The actual `.ink` files are parsed and painted by
the same engine the device runs, so template syntax, WXSS, `script def` and the
page lifecycle are all genuinely exercised. The server's `/bundle` endpoint
assembles the bundle and rewrites `config.js` to point at the local Composio
proxy, so the API key never reaches the browser.

`dev/preview.html` is a faster loop for the logic: it imports the same
`utils/*.js` but reimplements the card in HTML, so it cannot validate anything
about `.ink` rendering. Use it for planner/agent work, and `runtime.html` before
believing anything about the UI.

Neither substitutes for on-device testing of the wake word, `LanguageModel`, or
TTS — the web host reports "Host capabilities are not configured on Web host"
for those.

### Testing a spoken request

Both hosts drive `onLoad(query)`, which is exactly how the platform model
dispatches to this agent — so typing a request exercises the real path
(planner → Composio → card → spoken summary).

**In Craft** (`js.rokid.com/craft`, no sign-in needed for preview): open the
dropdown beside **Run Agent** → **Run Configuration**. Craft reads `schema.data`
out of the page's `<script def>` and generates a field per property, so
`utterance` and `date` appear with their descriptions. Type
*"when does my flight start?"* into `utterance` and press **Run Current
Configuration**. Verified: it returns the "Matches for flight" card with
Tokyo - Ho Chi Minh City (VJ 823), Sat Aug 1, 08:55.

**In `dev/runtime.html`**: use the Ask box or a preset chip. It calls
`openBundle({ query: { utterance } })`, the same entry point. The page logs
whatever it speaks, and the harness shows it under SPOKEN.

Craft renders pages as **conversation-flow cards** — a short, auto-height
surface — while `runtime.html` renders the **full-screen** 448 × 352 form. Those
are the two AIUI forms, so a page tall enough for full-screen is cropped in
Craft's card viewport. `.card` therefore declares a height *range*
(`min-height` / `max-height`) rather than a fixed height.

The preview is a real harness, not a mock: `dev/preview.html` imports the same
`utils/*.js` modules the glasses execute, so the tool discovery, planning,
Composio call, event normalization and spoken summary you see are the shipping
code paths. Only two things are substituted — the browser has no on-device
`LanguageModel` (so it uses the keyword planner), and requests go through the
local proxy so the API key stays server-side.

It shows, side by side: the glasses viewport, the TTS transcript, the pipeline
timings, the resolved tool call with every argument, the discovered tool list,
and the raw Composio response.

## Packaging

```bash
npm run pack          # -> dist/people-memory-1.2.0.aix
```

`.aix` ("AI eXecutable") is an extension of the Open Agent Format, and the
container is an ordinary **ZIP** — `@yodaos-pkg/aix` is a zip reader, and its
wasm looks up `VERSION` and `app.json` by name. So the package is the agent's
own files plus a `VERSION` marker, zipped with paths relative to the project
root. Only `app.js`, `app.json`, `AGENTS.md`, `config.js`, `utils/` and
`pages/` go in; `dev/`, `node_modules/` and `.claude/` never ship.

`dev/pack.mjs` also checks that every page listed in `app.json` actually exists,
since a missing entry there means the framework silently never registers it.

Verify a build with Rokid's own reader rather than by assumption:

```
http://localhost:5178/dev/aix-check.html
```

It loads the archive through `@yodaos-pkg/aix` and prints the parsed title,
version, pages and the OpenAI-compatible tool definitions the host would expose.
A good build for this agent reads back as: title "People Memory", 23 entries,
3 pages, 3 tools, with each page's `schema.data` intact as the tool parameters.

### Deploying through Craft

Craft's **Pack** button (`js.rokid.com/craft`) produces the same artifact
through the hosted toolchain — but it bundles the **whole workspace**, not
`dev/pack.mjs`'s allowlist, which is why the repo carries a root `.aixignore`.
Three rules learned the expensive way (full walkthrough in docs/12):

- **Re-save `.aixignore` inside the Craft editor** (open it, make any edit,
  Cmd+S) after every workspace refresh, project switch, or page reload. A copy
  synced from disk is stored as binary and the packer *silently skips* the
  ignore rules. The package size tells you which happened: **~160 KB is right;
  23 MB means it was skipped** and the upload will die with HTTP 413.
- **The upload wizard regenerates the agent description on every upload** by
  concatenating the pages' `description` fields — and the cloud rejects
  anything over **512 characters** ("智能体描述长度不能超过512个字符"). The
  three page descriptions are deliberately short so the generated text fits
  (466 chars); re-check that budget before lengthening any of them.
- **Never press Submit for a personal agent.** Upload alone makes the version
  available to your own account. Submit files a publication review with
  Rokid, there is no withdraw in Craft, and Rokid's own guidance is that
  un-reviewed agents stay private to their owner — which is exactly what you
  want here, because `config.js` (with your keys) ships inside the package.

The Supabase side (Edge Functions + migration) deploys separately with
`npm run deploy` and `npm run db:push`; docs/12 has the end-to-end device
checklist.

## Layout

| File | Role |
| --- | --- |
| `AGENTS.md` | Agent identity, system prompt, capabilities (Open Agent Format) |
| `app.json` / `app.js` | Page set, window config, global lifecycle |
| `config.js` | Composio transport, credentials, toolkits, wake word |
| `utils/composio.js` | Composio client — MCP and REST transports behind one interface |
| `utils/planner.js` | Utterance → tool call, via `LanguageModel` or keyword rules |
| `utils/agent.js` | One voice turn: discover → plan → execute → shape |
| `utils/calendar.js` | Day ranges, search args, event normalization, spoken answers |
| `utils/people.js` | Attendees, the name→email directory, overlap detection |
| `utils/freeslots.js` | Free time derived locally from the day's events |
| `utils/store.js` | Cache for instant first paint, over an injected storage backend |
| `pages/index/index.ink` | The voice loop |
| `pages/schedule/schedule.ink` | Single-day schedule card, model-invocable |
| `utils/clock.js` | Date math that works around the Ink runtime's broken `Date` |
| `dev/server.mjs` | Static server, Composio proxy, and `/bundle` for the runtime |
| `dev/runtime.html` | Runs the app on the real Ink WASM engine at 448 × 352 |
| `dev/preview.html` | Fast logic harness (does not render `.ink`) |

## Nothing renders until you ask for something

An AIUI agent has no home screen. Each page is an MCP UI component: it declares
a `description` and a `schema.data`, and the **host model picks the page** that
answers the request and opens it with structured arguments. `app.json`'s `pages`
array orders the routes, and its first entry is only the *default landing page*
— a fallback for a bare launch, not the app's resting state.

That is worth stating plainly because the dev harness used to contradict it. It
opened `pages/index/index` at boot, so the calendar appeared before you had said
anything and every dispatch looked like it had "gone back" to the calendar. It
now boots to **"No page dispatched"** and stays blank until a command routes a
page, which is what the glasses do.

The Ask box compounded it: it sent every utterance to the agenda page and let
that page forward with `wx.navigateTo`. So even a correctly-routed face command
rendered the calendar first, and on a slow settle you never saw the handover.
It now parses with the app's own `faceCommand()` and dispatches straight to the
page that answers — the same choice the host model makes.

`pages/index/index` is still first in `app.json`, so a bare launch shows the
agenda. If the agent should instead open on nothing until spoken to, that is a
one-line change to the `pages` order.

## The two ways the agent starts

**Wake word.** `onVoiceWakeup(event)` fires with `event.keyword` (default
`kavi`, the agent's unique name) and opens the mic immediately. The temple touch — reported as key code
`GlobalHook` — and `Enter` do the same via `onKeyUp`, so the wearer can re-ask
without speaking the wake word again.

**Platform dispatch.** Both pages declare a `description` and `schema.data` in
their `<script def>` block, which makes them callable by the host model. When
it decides "People Memory" answers the request, it opens the page with the
parsed arguments and `onLoad(query)` receives them — `utterance` and `date` for
`pages/index`, `date` and `calendarId` for `pages/schedule`.

## Composio wiring

`config.js` picks a transport:

- **`rest`** (default) — `POST /api/v3/tools/execute/{slug}` for calls,
  `GET /api/v3/tools?toolkit_slug=…` for discovery.
- **`mcp`** — MCP JSON-RPC 2.0 over Streamable HTTP: `initialize` →
  `notifications/initialized` → `tools/list` → `tools/call`, carrying
  `Mcp-Session-Id` and parsing both plain-JSON and SSE-framed replies.

Discovered tools are handed to the on-device model as function declarations, so
the model chooses the tool; the app only executes it. Widening the agent's reach
is a config edit — add `gmail` or `slack` to `toolkits` and the new tools show up
in `tools/list`, in the model's declarations, and in the dev inspector, with no
code change.

### Why REST is the default

The provided key (`ak_VmhhR_…`) is a **scoped** key. Verified against the live
API:

| Operation | Result |
| --- | --- |
| `GET /api/v3/tools`, `/toolkits`, `/connected_accounts` | works |
| `POST /api/v3/tools/execute/{slug}` | works |
| `POST /api/v3/mcp/servers` | **403** — needs `sessions` *write*, key has *read* |
| `POST /api/v3/mcp/sessions` | **403** — not covered by any scoped-key permission |

So this key cannot provision the MCP server it would need to connect to. To use
the MCP transport: create a server with a full-access project key, put its URL
in `config.mcpUrl`, set `transport: 'mcp'`, and nothing else changes — the
planner and pages talk to the same interface.

### The glasses never authenticate

There is no OAuth flow on the device, by design. You authorized Google once in
the Composio dashboard; Composio stores the access and refresh tokens against
user `pg-test-b19b54c1-…` and injects them when a tool runs. The agent only ever
sends a user id:

```jsonc
POST /api/v3/tools/execute/GOOGLECALENDAR_EVENTS_LIST
{
  "user_id": "<composio-user-id>",
  "connected_account_id": "<connected-account-id>",   // optional, pins the connection
  "arguments": { "calendarId": "primary", … }
}
```

No Google token, consent screen, or redirect URI touches the glasses — they
could not host a redirect anyway. Because the connection is Composio-managed and
holds a `refresh_token`, the hourly access-token expiry is renewed server-side,
so the agent keeps working without the wearer doing anything.

`connectedAccountId` in `config.js` is optional. Without it Composio infers the
connection from the toolkit, which is unambiguous today because there is exactly
one active Google account; pinning it means a second account connected later
cannot silently change which calendar is read. Composio rejects
`connected_account_id` sent without a `user_id`, so the client always sends both.

### Google Calendar scope

Connected account `<connected-account-id>` (`googlecalendar`, `ACTIVE`) was granted
only `https://www.googleapis.com/auth/calendar.events`. Consequences, all
confirmed live:

- ✅ `GOOGLECALENDAR_EVENTS_LIST` — works, and is the path the agent uses
- ✅ `GOOGLECALENDAR_CREATE_EVENT`, `QUICK_ADD`, `UPDATE_EVENT`, `DELETE_EVENT`
- ✅ **Colleagues' calendars** — `EVENTS_LIST` with `calendarId: "<their email>"`
  returns their events with `accessRole: reader`, via workspace sharing
- ❌ `GOOGLECALENDAR_LIST_CALENDARS` — 403 insufficient scope
- ❌ `GOOGLECALENDAR_FIND_FREE_SLOTS`, `FREE_BUSY_QUERY` — 403, `freeBusy` needs
  a broader scope

The useful surprise is that reading another person's calendar works while asking
Google for their free/busy does not — so "what does Kevin have today" is
answered by reading his day and comparing it to yours, which also yields better
output (real event titles instead of opaque busy blocks).

The agent degrades cleanly where scope does bite: the failure is reduced to one
spoken sentence ("Request had insufficient authentication scopes") with the full
provider payload kept in the inspector. Reconnect the account requesting
`…/auth/calendar` to unlock the rest.

### Two Composio quirks worth knowing

**Argument casing is inconsistent within one toolkit.** `EVENTS_LIST` takes
`calendarId` / `timeMin` / `timeMax` (camelCase), `FIND_FREE_SLOTS` takes
`time_min` / `time_max`, and `QUICK_ADD` takes `calendar_id` (snake_case). The
rule planner encodes the correct form per tool; the model planner reads it from
each tool's own `inputSchema`.

**Response shape differs per tool.** `EVENTS_LIST` returns events at
`data.items`, but `FIND_EVENT` nests them at `data.event_data.event_data`.
`extractEvents()` in `utils/calendar.js` normalizes both, so either tool renders
the same card whichever one the model picks.

## People, availability, and overlap

**Who is in a meeting** comes from the attendees already inside the wearer's own
events — no extra scope, no extra call. Each person shows their RSVP (`yes` /
`maybe` / blank for no reply) and whether they organize or are optional.

**Whose calendar to read** is resolved through a directory the agent builds from
those same attendees. There is no directory API in scope, but every colleague the
wearer shares a meeting with appears there, which is enough to turn "Kevin" into
`kevin.nguyen@jitera.com`. A name that does not resolve produces "I do not know
who Tracy is" — never a silent fallback to the wearer's own day, which would be
a confidently wrong answer.

**Overlap** is computed in `utils/people.js` by intersecting their timed events
with the wearer's own, using half-open intervals so a meeting that ends exactly
when another begins is not a clash. Clashing rows get an accent left border and a
`clashes: <your meeting>` tag, and the spoken answer leads with the count.

**Free time is computed locally** in `utils/freeslots.js` rather than asked for.
`FIND_FREE_SLOTS` and `FREE_BUSY_QUERY` both hit Google's `freeBusy` endpoint,
which this connection's scope forbids (403, verified). Since the day's events are
already in hand, the gaps are derived directly: busy intervals are merged, the
working window (`WORKDAY`, 09:00–18:00) is applied, elapsed time is excluded when
the day is today, and openings shorter than 30 minutes are dropped. Same answer,
no extra scope, no extra round trip.

## Only three tools reach the model

Composio's `googlecalendar` toolkit exposes 28 tools. Handing all of them to a
small on-device model makes it choose badly, so `TOOL_ALLOWLIST` narrows the
surface to what is both needed and reachable:

```
GOOGLECALENDAR_EVENTS_LIST · GOOGLECALENDAR_QUICK_ADD · GOOGLECALENDAR_CREATE_EVENT
```

`EVENTS_LIST` alone covers the agenda, lookup, attendees, free slots and other
people's calendars — the difference is only which arguments it gets. Excluded on
purpose: `FIND_FREE_SLOTS`, `FREE_BUSY_QUERY` and `LIST_CALENDARS` (all 403 under
this scope), `FIND_EVENT` (`EVENTS_LIST` + `q` does the same job with a saner
response shape), `GET_CURRENT_DATE_TIME` (the device knows the date), and the
destructive `UPDATE`/`DELETE`/`CALENDARS`/`ACL` families. Narrowing happens in
`ComposioClient.narrow()`, so it applies to the MCP transport too.

## Staying fresh without being asked

The card is a personal always-on surface, so it refreshes itself:

- **`onLoad`** paints the last agenda from storage immediately, then fetches. A
  HUD should never open empty while the network settles.
- **`onShow`** refetches when the data is older than `REFRESH.staleAfterMs`
  (5 min) or the day rolled over while the card was hidden. Fresh data means no
  request at all.
- **`onHide`** stops everything — no work happens while the card is out of view.
- **Automatic refreshes never speak.** Only a wearer-initiated turn reaches
  `speechSynthesis`; a card that narrates itself every five minutes is unusable.
- **A failed background refresh keeps the last good agenda** on screen with a
  quiet staleness note, rather than replacing it with an error.

Interval polling is deliberately *not* the mechanism. `setInterval` is not in the
verified AIUI runtime API surface (see `.claude/skills/aiui-dev/apis.md`), so
`REFRESH.backgroundPollMs` is feature-detected and ships disabled; set it only
after confirming timers work on your device. Storage likewise goes through
`wx.setStorageSync` / `wx.getStorageSync` — the verified API — not
`localStorage`. `utils/store.js` takes an injected backend so the same cache code
runs on-device and in the browser harness.

## Design system compliance

The UI follows `.claude/skills/aiui-dev/design-system-green.md`, which is a
harder constraint than it first appears: **RokidGlasses1/2 render a single green
channel**, so there is no second hue available.

- Canvas is exactly **448 × 352**; the preview renders it at actual size.
- One hue, four opacity steps — `#40ff5e`, `60%`, `40%`, `08%` — on pure black.
- Every surface is an **outlined card**: 2px border, 12px radius, 12px padding.
- **No red for errors.** The `<error-state>` component uses a faint green fill
  with a muted border, per spec — red cannot render on this hardware.
- Emphasis is **outline and opacity, never shadow**. The in-progress row uses the
  accent-outline treatment (spec elevation level 3 — "active rows") rather than a
  bright fill, which would fight the green text on top of it.
- Colors come from `var(--color-*)` / `var(--spacing-*)` tokens with spec values
  as fallbacks, so host theming still applies.
- Monospace carries times and headings; the proportional face carries titles.
  With no color to differentiate emphasis, size and weight must do that work.

## What the real runtime changed

Running the app on the actual Ink WASM engine found four defects that the
HTML preview structurally could not. All are fixed; they are recorded because
they are properties of the runtime, not of this app.

**1. `Date` is largely unimplemented.** Measured on @yodaos-pkg/ink 0.14.0:

| Works | Broken |
| --- | --- |
| `Date.now()` | `getFullYear()` → **2060** |
| `Date.parse('…+09:00')` — honours the offset | `getMonth()`, `getDate()`, `getHours()` |
| `.valueOf()` | `getTimezoneOffset()` → **-17917542** |
| | `toISOString()` → `1044688-1044672-00T…` |
| | `toLocaleDateString()`; `Intl` is **undefined** |

The day window was being built with `new Date(y, m, d + 1)` and
`getTimezoneOffset()`, which produced `timeMax: "2079-12-20T00:00:00+298261:37"`
and a hard Composio rejection. All date handling now lives in `utils/clock.js`,
which uses epoch milliseconds plus integer civil-calendar arithmetic and never
calls a component getter or formatter.

**2. The runtime cannot report its timezone.** With `getTimezoneOffset()` broken
and no `Intl`, the offset has to come from somewhere else. `TIMEZONE.offsetMinutes`
seeds it, and `learnOffset()` then reads the true offset out of the calendar's own
event timestamps and caches it — so a wrong default self-corrects after one fetch.

**3. Expressions only evaluate as a whole attribute value.**
`class="{{ ok ? 'a' : '' }}"` works; `class="row {{ ok ? 'a' : '' }}"` does not —
Ink looks up a variable literally named `ok ? 'a' : ''`, warns
"missing from data", and silently yields nothing. Every conditional class is now
precomputed in JS (`rowClass`, `nameClass`, `clashLabel`, `staleNote`). Ink also
warns for any variable absent from the bound data, so rows declare all their
fields up front and the row cache is version-stamped.

**3b. The box model is content-box only.** `box-sizing: border-box` is ignored,
so `width: 448px` on a card with 12px padding and a 2px border paints 476px and
the right edge falls off the canvas. Widths here are content-box values
(`420px` card, `400px` row). Flex children also grow past the parent's content
box rather than being constrained by it, so the row width is pinned rather than
left to `flex: 1`. And because a border that appears only on the active row
would widen that row, every row reserves a 2px transparent border and the state
changes only its colour.

**3c. Heights must be definite — never `flex: 1`, never a bare `max-height`.**
This one is nasty because it fails silently and only in some hosts. A list
declared `flex: 1` inside a parent whose own height comes from its content is a
circular constraint; the engine resolves it to **zero**, `overflow: hidden`
clips the rows away, and the card still paints its header and item count. The
result looks like "the search returned nothing" when it actually returned a
match. It worked in `dev/runtime.html` — which hands the view a bounded
448 × 352 surface, giving `flex: 1` something real to fill — and failed in
Craft, which renders auto-height conversation cards. `.list` now carries a
definite `height`, which also gives the `scroll-view` something to scroll
within.

**3d. The surface height varies by host, so nothing may assume one.** Full-screen
is 448 × 352, Craft's chat card is auto-height, and Craft's Interactive InkView
reports `width=896 height=300 scale_factor=2` — a **448 × 150** CSS surface. A
list with a fixed `height: 236px` cannot fit there. Lists use `max-height`
(a bound, which survives a short surface) rather than a fixed height or
`flex: 1`, and `capRows()` additionally caps the row count so a long agenda
degrades to "+N more events" instead of overflowing.

**3e. Never bind a layout class to a variable.** This was the intermittent
"1 match but no detail" bug, and it is the most important lesson here.
`class="{{ item.rowClass }}"` looks harmless, but when Ink cannot resolve a
template variable it substitutes nothing and only logs
`Template variable 'item.rowClass' is missing from data`. For a `class`
attribute that means the element loses `display: flex`, its width and its
padding — an invisible zero-box. The card's header and count still paint,
because they do not read `item`, so the result reads as "found nothing" when the
data was correct all along.

Whether the variable was present depended on where the rows came from: fresh
from `normalizeEvents` (present), or repainted from device storage by an older
build (absent). Cold run rendered, warm run did not — hence the intermittency.

The fix is structural, not a cache repair. No layout class is bound to a
variable anywhere: `class="row"` is static, and state is a fixed-width accent
rail toggled by `ink:if` on a boolean.

```html
<view class="row">
  <view class="rail on" ink:if="{{ item.isNow || item.clashCount }}"></view>
  <view class="rail" ink:else></view>
```

A missing boolean is merely falsy, so the worst case is an unlit rail — never a
vanished row. Both variants are the same width, so the row cannot reflow either.
`REFRESH.cacheVersion` must still be bumped whenever a row field changes, and
`paintFromCache()` rebuilds computed fields defensively rather than trusting
what was stored.

**3f. `setData` is asynchronous.** A flag written with `setData` is not visible
to code that runs later in the same tick. The timezone-correction path set
`refreshing: false` and immediately re-entered `refresh()`, which read the stale
`true` and returned — one request, no render, stuck on "Checking your calendar"
forever with no error. Re-entrancy guards live on the instance (`this.busy`),
never in `this.data`. Relatedly, `onShow` fires immediately after `onLoad`, so
an utterance turn and an agenda refresh will run concurrently and race to
`setData` unless guarded (`this.answering`).

**3g. All conditional siblings form ONE chain — isolate each chain.** This was
the "correct answer, empty card" bug. Ink resolves `ink:if` / `ink:elif` /
`ink:else` across *every* conditional sibling in a parent, not per adjacent
pair. So this silently renders nothing for the list:

```html
<text  ink:if="{{ somethingElse }}">…</text>   <!-- matches, chain satisfied -->
<text  ink:if="{{ !hasRows }}">Nothing scheduled.</text>
<scroll-view ink:else>…rows…</scroll-view>     <!-- never renders -->
```

An unrelated `ink:if` dropped in beside an `if`/`else` pair consumes the
`else`. There is no warning; the card just paints its header and nothing
below, which reads as "the search found nothing". Every chain in this project
now lives alone in its own container, and the footnote lines sit in a
`.notes` wrapper for exactly this reason.

**3h. A list's height must come from its parent, never a constant.** The
surface is 448 × 352 full-screen but only **448 × 150** in Craft's Interactive
InkView, and both report `layout_mode=bounded`. A `<scroll-view>` with a
constant `height: 236px` is taller than the entire 150px card, and a flex child
that cannot fit is *shrunk toward zero* rather than clipped — so the rows
vanish on the short surface while rendering perfectly at 352. Use
`flex: 1` (resolves correctly in both bounded hosts) plus `min-height` as a
floor for Craft's auto-height chat card, and `flex-shrink: 0` so the floor
itself is not shrunk away. Verify at **both** heights;
`dev/runtime.html` has a surface switch for exactly this.

Also, `Page::set_data: key=… has no bindings` in the log means a `data` key the
template never reads. Harmless, but it is noise that hides real warnings —
delete the key.

**3i. Size lists by content — no flex-grow, no heights, no `<scroll-view>`.**
Everything else collapses. `.card` has no definite height (it is a range), so a
`flex: 1` child has nothing to divide and resolves to zero; `min-height` /
`max-height` do not rescue it; `<scroll-view>` paints nothing without a definite
pixel height; and `style="{{ … }}"` cannot supply one because Ink does not
evaluate a bound `style` (it documents `style` only as a literal). The whole
chain from `.card` to `.row` is therefore pure content sizing, the card clips,
and `capRows()` bounds the row count with a "+N more" line.

The failure mode is silent and misleading: the header and item count still
paint, so a search that found a match reads as "found nothing". If the log shows
`stage rendered {"matches":1}` and the card is empty, it is a container that
collapsed — not the data.

**3j. Large responses hang `fetch`.** `GET /api/v3/tools?toolkit_slug=…` returns
~135 KB and its promise never settles inside the Ink runtime — the turn strands
at `discovering-tools` with no error and no further requests, while the server
log shows the request completing normally. Calendar payloads (~10 KB) are fine.
`ComposioClient.listTools()` therefore answers from `TOOL_ALLOWLIST` locally and
never fetches the catalog; schemas are pulled one tool at a time
(`describeTool`, a few KB each) and only when the on-device model is in use.

**4. `<block>` does not exist** — it warns "Unknown component; falling back to
`<view>`", which inserts a real flex container. Grouping wrappers are now
explicit `.body` flex columns. Relatedly, `text-overflow` is not a supported WXSS
property, so long room names overflowed the card; text is clipped in JS via
`clip()` instead.

### One more Ink rule, learned building this page

`ink:for` goes on a `<view>`; the `{{ item.x }}` interpolation goes on a
`<text>` **child** of that view. Putting the loop and the binding on the same
element renders — and warns `Template variable 'item' is missing from data` on
every pass. That warning is the same one that preceded the agenda list silently
vanishing, so it is not noise to be waved away. The agenda list already had the
right shape; the face card did not, until it was made to match.

The name is also bound to `title` rather than nested under the thumbnail's
`ink:if`. It was nested at first, which meant a card whose canvas paint failed
displayed the notes with nobody's name attached.

## Faces: who am I talking to?

Entirely spoken. There is no screen to manage people in and nothing to enrol
from — the wearer talks, and the glasses answer.

| Say | What happens |
| --- | --- |
| "who is this", "remind me who this is", "do I know them" | photographs whoever is in front of you and says who they are, with your note about them and any meeting you share today |
| "take a photo of them", "look at this", "scan their face" | the same thing, phrased as a capture |
| "remember him as Kevin", "this is Tracy", "her name is Sarah", "call him Dave" | stores the face under that name |
| "note that she runs the security review", "remember that he owes me lunch", "memo that we met at the offsite" | attaches that to the last person recognised |
| "who do I know", "list my people" | says who is remembered |
| "forget Kevin" | deletes them, and their face vectors with them |

If it recognises nobody it says so and listens for a name, so the usual flow is
two sentences: *"who is this"* → *"I do not know them yet"* → *"remember her as
Tracy Lam"*.

That second sentence arrives as a **completely separate dispatch** — the host
model opens the page again, and nothing survives in the page between the two.
Photographing the person a second time would be the obvious answer and a bad
one: by then they have looked away. So the *service* keeps the last capture for
five minutes (`recent_captures`, one row per wearer) and an enrolment that
arrives without a photo uses it. If there is nothing recent, the page falls back
to taking a picture, so "remember her as Tracy" still works on its own.

The vocabulary is declared in **two** places on purpose, and they have to agree:

- `pages/face/face.ink`'s `<script def>` — `description` plus a `schema.data`
  with an `action` enum (`identify`, `remember`, `note`, `forget`, `list`). This
  is what lets the **host model** dispatch straight to the page with structured
  arguments, which is how a Rokid page is meant to be reached.
- `faceCommand()` in `utils/planner.js` — the same phrasings as patterns, for
  when the **agent's own** voice loop heard the utterance and routes it with
  `wx.navigateTo`.

Two entry points, one vocabulary. Verified end to end against the live project:

```
"who is this"                            -> I do not know them yet. Tell me their name.
"remember her as Tracy Lam"              -> I will remember Tracy Lam.
"note that she runs the security review" -> Noted about Tracy Lam.
"remind me who this is"   (other photo)  -> that is Tracy Lam. she runs the
                                            security review.   [score 0.794]
"who do I know"                          -> You know Tracy Lam.
"forget Tracy Lam"                       -> I have forgotten Tracy Lam.
```

### Testing the camera without glasses

The web build of Ink has no camera provider, so the face page could not be
exercised anywhere but on the hardware. `FACE.devCameraUrl` closes that gap:
when it is set **and the host has no real camera**, `takePhoto()` fetches a
photo from that URL instead. It cannot shadow a working camera — the real one is
tried first — and `npm run pack` warns if the setting was left on.

```
npm run dev
open http://localhost:5178/dev/runtime.html
```

Choose a JPEG under **Camera**; it is held in the dev server's memory and served
at `/dev-camera`. Then say "who is this" in the Ask box. The photo travels
through the page's own `takePhoto()` call site, so everything downstream is the
code the glasses will run:

```
dev-camera   4ms      <- the page "takes" the photo
face      5359ms      <- Supabase detects, embeds, searches pgvector
                      -> card: "New face / Say a name to remember them"
```

One caveat: the harness settles a page slowly — 20 s to 2 min before the card
updates, against ~1 s for the same call from Node. Be patient with it, and take
a screenshot only after the network calls have finished.

### `<canvas>` does not render; `<image>` does

The thumbnail was originally painted into a `<canvas>` with `putImageData`, and
it never appeared. Rather than keep guessing, a throwaway probe page drew the
same 64x64 square two ways side by side:

```
image + data URI   ->  renders perfectly
canvas             ->  nothing, and no error
                       fillRect + putImageData both called, flush=function
```

Every canvas call succeeds and the surface stays blank, so on this host a canvas
has no drawing surface behind it — the same class of gap as the missing camera.
Two things genuinely were wrong and are fixed anyway (the backing store is set
by `width`/`height` **attributes**, not CSS, and had been left at the 300x150
default; and the node has to exist before you paint, which `setData` being
asynchronous made false) — but neither was the cause.

So the thumbnail is now a **PNG encoded by the Edge Function** and rendered with
`<image src="data:image/png;base64,…">`. `supabase/functions/_shared/png.ts` is a
~100-line encoder: truecolour, luminance in the green channel because the panel
is single-green, which deflates to about 1.8 KB for 64x64. The database still
stores compact luminance; the PNG is built per response, so the wire format can
change without a migration. `thumbToRgba`, `ImageData` and `fromBase64` are all
gone from the device.

### The interaction gate

`takePhoto()` and `SpeechRecognition.start()` both **require an interactive call
site** and throw otherwise. A page opened by the host model has not necessarily
had a gesture, so the page *attempts* the capture immediately and, if the gate
refuses, arms itself and waits for the temple key or a tap: hands-free where the
host allows it, one press where it does not. Which of the two happens on real
glasses is not yet known, because the camera has never run there.

Recognition itself does **not** run on the glasses — see below.

### How well does it work?

Measured, not asserted. `npm run test:pipeline` runs the real function modules
over twelve photographs of three people, labelled by hand, across changes of
pose, lighting, hair and makeup:

```
detected 12/12 faces, 264 ms per photo end to end

same person      30 pairs, mean 0.733, worst 0.511
different people 36 pairs, mean 0.133, best  0.254

margin 0.257  — separable
at TENTATIVE=0.38  false accepts 0/36, missed 0/30
at CONFIDENT=0.5   strangers named with confidence: 0
```

The number that matters is the **margin**: worst same-person minus best
different-person. Positive means a single threshold separates every pair in the
set. Averages can look excellent while the tails overlap, and only the margin
catches that.

The int8 recogniser is shipped rather than the 38 MB float build: quantisation
cost 0.008 of margin (0.201 against 0.209, measured the same way) for a quarter
of the size, which matters inside a memory-limited Edge Function.

### Where to try it

```bash
npm run dev
```

- **`/dev/faces.html`** — the face bench. Uses your laptop webcam (or a dropped
  photo) in place of the glasses camera, and calls the deployed project through
  the *same* `utils/faceservice.js` the `.aix` ships. Capture, enrol, recall,
  forget, and see the card the glasses would draw, thumbnail included. This is
  the only way to judge recognition on your own face rather than on twelve press
  photographs.
- **`/dev/runtime.html`** — the real Ink WASM runtime. "open face" renders the
  actual page at all three surfaces. Capture there reports *"No camera on this
  host. Run this on the glasses."* — expected, and confirmed by the runtime's own
  log line:

  ```
  createCameraContext: CameraContext is not supported on web media provider
  ```

  The web build of Ink has no camera provider at all, so this is the furthest
  the camera path can be taken off-device. Note the thrown value is a
  `CameraContext`, not an `Error`, and the bridge fails converting it — which is
  why the page has a `messageOf()` helper rather than reading `error.message`.
- **`/dev/aix-check.html`** — reads the built `.aix` with Rokid's own reader.
- **Craft** (`js.rokid.com/craft`) — the reference host for anything UI.
- **The glasses** — install `dist/people-memory-1.0.3.aix`. The only place the
  camera path itself runs.

Command-line, no browser:

```bash
node -e "…"   # see 'Verified end to end' below — utils/faceservice.js runs in
              # plain Node too, since it is only fetch + JSON + base64
```

### Setting it up

Already done for the `rokid Project` (`qnjqghqjdyqrpifrbbdf`); these are the
steps to repeat it elsewhere.

```bash
npx supabase login
npx supabase link --project-ref <ref>     # no database password needed
npm run db:push                           # pgvector, tables, match_face, RLS

SUPABASE_URL=https://<ref>.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=… \
  npm run models                          # ~21 MB into the private bucket

npm run deploy                            # face, face-people
```

Then put the project URL and publishable key into `FACE` in `config.js` and
repack. Both are under Project Settings → API.

`npm run models` uploads three things: the two ONNX models **and the ONNX
Runtime's own `ort-wasm-simd.wasm`**. The last one is not optional — see below.

### Why the anon/publishable key is safe in the bundle

`people` and `face_embeddings` have row-level security enabled and **no
policies**, so the key reads and writes nothing directly, even though it ships
inside the `.aix` and anyone can unzip it. Only the Edge Functions hold the
service role key, and they decide what a caller may touch. `match_face` and
`touch_person` are `security definer` with execute revoked from `anon`.
Verified: publishable key → 200, legacy anon JWT → 200, no key → 401.

Face embeddings are biometric data, which is why this is worth the care.
`ownerId` scopes every query so one project can back several wearers, and
forgetting someone cascades to their vectors rather than orphaning them.

### What the edge runtime forced

Four things about Supabase Edge Functions shaped this design, none of which
reproduce in Deno locally. They are worth reading before changing any of it.

**1. No shared memory.** Every ONNX Runtime build from 1.19 on ships *only*
threaded WebAssembly, whose glue allocates a shared `WebAssembly.Memory`. The
runtime refuses that even though it exposes `SharedArrayBuffer`:

```
no available backend found. ERR: [wasm] TypeError:
Creating a shared memory is not supported
[numThreads=1 simd=undefined proxy=false SAB=true]
```

`numThreads = 1` cannot help there because no single-threaded binary exists to
fall back to. Hence the pin to **1.16.3**, which still publishes real
non-threaded builds, and whose loader selects `ort-wasm-simd.wasm` when
`numThreads = 1`.

**2. A static import of ORT kills the worker.** Every request — even ones that
never touch a model — returned `WORKER_ERROR` in ~270 ms, while a function that
does not import ORT served fine. A module that fails to evaluate leaves no
handler to catch anything, so there is no error to read. The import is therefore
dynamic, inside a `try`, which turned a silent boot crash into a message.

**3. Dynamic imports must use a literal.** `import(SOME_CONST)` is invisible to
the deploy bundler, so the module is never shipped and the call fails at runtime
with `Module not found`. A literal is bundled as a deferred chunk.

**4. The npm package is too big to deploy.** It carries seven `.wasm` binaries
and the bundler inlines all of them — 22 MB, rejected with `request entity too
large`. So the JavaScript comes from a CDN at *bundle* time and the one binary
that is needed is fetched at cold start from the project's own private bucket
through a signed URL. Nothing outside the project is contacted at runtime.

### The resource ceiling, and what it cost

An invocation has a fixed budget, and exceeding it gives only
`WORKER_RESOURCE_LIMIT` (HTTP 546) with no detail. Photos over about 0.7
megapixels failed while smaller ones of the same subject passed — failures
tracked *file size*, not content, which is what identified it.

A decode-only probe (still in the function, `{"decodeOnly": true}`) showed
decoding was never the problem: 276 ms for a 5 MP photo, successful at every
size. It was decode peak *plus* the loaded model together. Three changes fixed
it, and all five sizes from 640 px to 2000 px now pass repeatedly:

- orientation and downscale fused into **one bounded pass** over the output
  pixels, instead of two full-resolution copies
- `enableCpuMemArena: false`, `enableMemPattern: false` so ORT releases
  activations between runs instead of pooling them
- `formatAsRGBA: false` on the decoder — a quarter off the largest allocation
- the base64 string dropped as soon as it is decoded

Cold start is ~3 s (2.6 s of it compiling the wasm), and a warm request is
~4–5 s end to end. Because loading *and* inferring in one request can still
exceed the budget on a fresh instance, the page calls a `warmup` when it opens —
so the models load while the wearer is still aiming — and the client retries
once on 546, which lands on the instance the failed call just warmed.

### Verified end to end, against the live project

```
identify (nobody enrolled) → "New face"
remember  img2 as Tien     → "I will remember Tien."
identify  img10 (different photo)
        → "that is Tien. sits by the window. You have Standup at 09:30."
          score 0.794, confident
identify  a stranger       → correctly not recognised
```

The page itself was confirmed talking to Supabase from the real Ink WASM
runtime: `face-people` 905 ms, `warmup` 4.7 s, no console warnings, and it
renders in both `bounded` and `width-constrained-auto-height`.

### What is still unproven

- **The camera path has never run.** `wx.media.createCameraContext().takePhoto()`
  is called from a tap or the temple key, because it needs an interactive call
  site, but no photo has been taken on real hardware. Everything downstream of
  the JPEG bytes is now tested against the deployed backend; the step that
  produces them is not.
- **There is no camera preview component**, so capture is blind — the wearer
  aims by pointing their head.
- **The fixtures are press photographs**, well lit and mostly frontal. Real
  encounters at conversational distance will score lower than 0.73, which is why
  `CONFIDENT` sits at 0.5 rather than at the measured floor.
- If the glasses camera returns something much larger than 5 MP, the resource
  ceiling may bite again; the fix would be a lower capture quality.

## Notes on the implementation

- **Times are not re-derived.** Google returns `dateTime` already in the
  calendar's timezone, so the UI slices the wall-clock digits. QuickJS timezone
  handling is uneven, and this shows exactly what Google Calendar shows.
  Verified: the card's 12:00→21:00 / 14:00→15:00 / 17:40→18:00 match the raw
  payload for an `Asia/Tokyo` calendar.
- **Planner fallback is a feature, not scaffolding.** `LanguageModel.availability()`
  can report `unavailable`, so `rulePlanner` keeps the agent working; it is also
  what makes the browser preview honest.
- **Speech stays short.** `speakableSummary()` caps narration at a count plus
  the first and last event. Detail belongs on the card.

## Known limits

- The Composio key ships inside the app bundle under the `rest` transport.
  Acceptable for a demo; for production put a proxy in front (as `dev/server.mjs`
  does) or move to `mcp`, where the server URL is the only credential.
- Destructive calendar tools are declared to the model but the confirm-before-write
  step described in `AGENTS.md` is enforced by prompt only, not yet in code.
- `pages/schedule` reads `primary` unless given `calendarId`; it cannot discover
  other calendars under the current OAuth scope.
- **Lookup does no fuzzy matching.** Google's `q` is literal, so a mis-heard word
  finds nothing — "fligh" returns no match where "flight" finds the flight. The
  agent says so plainly rather than guessing.
- Lookup searches **60 days forward only** (`SEARCH_WINDOW_DAYS`). Multi-day
  events already in progress still match and are narrated as "running now,
  through <date>"; genuinely past events are not searched.
- The rule planner's search-term extraction is a stopword heuristic. It handles
  the common phrasings (verified across 11 utterances) but the on-device
  `LanguageModel` planner does this far better when available.
- The `.ink` pages now render on the real Ink WASM runtime, but **not yet on
  physical glasses**. The web host reports "Host capabilities are not configured
  on Web host", so the wake word (`onVoiceWakeup`), `LanguageModel`, TTS and the
  `GlobalHook` temple key are still unverified in practice — only the rule
  planner path has actually executed.
- `TIMEZONE.offsetMinutes` defaults to UTC+09:00 and adopts whatever offset the
  calendar reports. It does not follow daylight-saving transitions on its own.
- **`dev/runtime.html`'s Ask box is unreliable** and Craft is the reference host
  for anything UI-related. The harness's boot path (open a page, agenda renders)
  is sound, but re-opening a bundle with a `query` intermittently stalls the
  turn after tool discovery and before the tool call, with no error in any log.
  Craft creates a fresh Ink instance per run and does not show this; the harness
  now destroys and recreates its view per run too, which did not fully resolve
  it. Treat a green result there as necessary but not sufficient.
- Any `Template variable ... is missing from data` warning is a **defect, not
  noise** — see the note above. Treat the log as empty-or-broken.
