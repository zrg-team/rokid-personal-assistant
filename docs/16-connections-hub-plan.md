# 16 — Connections Hub: deep plan

*How Kavi grows from "calendar + faces" into a **connections hub**: authorize many
services once on a phone, then speak `Kavi <thing> <action>`. Face/text memory
stays the built-in default. This is the plan; nothing here is built yet.*

---

## The shape of it

```
   GLASSES                         PHONE (one page, opened from a link)
   "Kavi status"  ───────────────► ┌───────────────────────────────┐
   shows link + code               │  Connect your services         │
                                   │  ✓ Google Calendar   Connected │
                                   │  ○ Google Contacts   Connect → │
                                   │  ○ Gmail             Connect → │
                                   │  ○ Google Tasks      Connect → │
                                   │  ○ Slack             Connect → │
                                   └───────────────────────────────┘
                                        each Connect → Composio OAuth
   "Kavi sync"  ◄──────────────────  wearer returns; glasses re-read status
        │
        ▼   now the wearer can speak, namespaced by connection:
   "Kavi Calendar what's today"      "Kavi Lịch hôm nay có gì"
   "Kavi Gmail any new mail"         "Kavi Thư có gì mới"
   "Kavi Tasks add: call the vet"    "Kavi who is this"  (face — default)
```

## Requirement → change (nothing dropped)

| Your requirement | What it becomes |
| --- | --- |
| Say "Kavi status / login / trạng thái" | A **status command** → the status page (§2) |
| Show link and code | Status page shows the pairing link + word-code (as sign-in does today) |
| Open link → list of supported authorizations | The **connections page** on the phone (§4), driven by the registry (§5) |
| Click to authorize with Composio | Each row's Connect button → `connections.authorize` → Composio OAuth (§4) |
| Recommend other useful connections | Curated recommendations (§6) |
| Back to glasses → "Kavi sync / cập nhật" | A **sync command** re-reads connection status (§7) |
| "Kavi Calendar/Lịch [action]" | **Connection-namespaced grammar** (§1, §8) |
| "Kavi who is this / remember" | Face verbs, now under the same `Kavi …` router (§1) |

---

## 1. The command grammar — one router, `Kavi <X> <action>`

Today three separate matchers exist (`signinCommand`, `faceCommand`, calendar
default). They become **one classifier** in `utils/planner.js`, run on folded
(lowercase, diacritic-stripped — `fold()` already does this) text:

1. **Strip an optional leading `Kavi`** (ASR-tolerant: `c/k`, `i/y`, optional
   space). Present or not, we continue — so "Kavi calendar today" and a
   host-dispatched "calendar today" both work.
2. **Classify the remainder, in order:**
   - **status** — `status | connections | login | sign in | trạng thái | đăng nhập | kết nối` → status page (§2)
   - **sync** — `sync | refresh | update | cập nhật | đồng bộ | làm mới` → sync (§7)
   - **connection** — starts with a known **alias** (table below) → that connection's handler (§8), the rest is the action
   - **face** — `who is this | remember | note | forget | who do I know | …` (+ VN) → face page (default function)
   - **fallback** — anything else → calendar agenda (keeps today's natural "what's on my calendar")

**Alias table** (registry-driven, English + Vietnamese):

| slug | spoken aliases |
| --- | --- |
| googlecalendar | calendar, lịch, schedule, agenda |
| googlecontacts | contacts, danh bạ, people, contact |
| gmail | gmail, mail, email, thư, hộp thư |
| googletasks | tasks, task, việc, nhiệm vụ, to-do |
| slack | slack, tin nhắn |

`namedPerson` / `searchTerm` stay as-is for parsing the action tail.

**Why optional prefix, not required:** on real glasses the host already routes an
utterance to Kavi; forcing "Kavi" on every sentence is tiring. The prefix is for
*explicit* invocation and disambiguation, so we recognize-and-strip it rather than
demand it. The unique word still guards the one ambiguous case (sign-in/status).

---

## 2. Status page on the glasses (`Kavi status`)

Evolve `pages/signin/signin.ink` → `pages/status/status.ink` (the sign-in card is
a subset of status):

- Top: sign-in state + the **link + word-code** (unchanged mechanics — `pair start`).
- Below: the **connection list with status** — `✓ Google Calendar`,
  `○ Gmail (open the link to connect)` — from `connections.list` (device token).
- Speaks a one-breath summary: *"You're signed in. Calendar is connected; open the
  link on your phone to add more."*
- Temple key / "Kavi sync" refreshes it.

---

## 3–4. The connections page on the phone — and where it lives

The page the wearer opens: **reads the code from the URL → `connections.list`
(with the code) → renders each service with its status and a Connect button →
Connect calls `connections.authorize` → redirect to Composio → on return
(`?connected=<slug>`) re-reads the list and shows the new ✓.** It's a thin static
page; the registry the function returns drives the rows, so adding a service needs
**no page change**.

**The hosting problem (must solve first).** Supabase's functions domain forces
`text/plain` on HTML (that's why sign-in currently redirects straight to Google),
so a *list* page can't be served from a function. Options:

| Option | Free? | Renders HTML? | Cost/caveat |
| --- | --- | --- | --- |
| **A. Supabase Storage public bucket** | ✅ | **Unconfirmed** — `nosniff` is added, but that does *not* block a correctly-declared `text/html`; a real object may render. **Validate first.** | Most self-contained (stays in the one project). Upload `connect.html` to a public bucket. |
| **B. Dedicated public GitHub repo + Pages** | ✅ | ✅ definitely | Main repo is **private** (Pages not free there), so use a *small separate public repo* holding only `index.html` (no secrets — it uses the publishable key). `gh` is available to create it. |
| **C. Cloudflare Pages / Vercel / Netlify** | ✅ | ✅ | A new host/account to manage. |
| **D. Supabase custom domain** | 💲 | ✅ | Serve HTML from functions directly; needs Pro. |

**Recommendation:** validate **A (Storage)** first — if a public `text/html`
object renders, everything stays in one project. If it doesn't, fall back to **B**
(a public `kavi-connect` repo + Pages). Either way the page only needs the
Supabase **publishable** key + project URL (both safe to ship) and talks to the
`connections` function via `fetch` (CORS already enabled).

**One backend tweak:** `connections.authorize` builds the post-OAuth `back` URL as
the functions `pair` page today. It must point back to **this** page instead — add
a `CONNECT_PAGE_URL` env (or reuse `PAIR_VERIFY_URL`) so the wearer returns to the
list with `?connected=<slug>` and sees the update.

---

## 5. The registry — one extensible source of truth

Both `config.js` (glasses) and `connections/index.ts` (backend) already hold a
`CONNECTIONS` array. Enrich each entry so the list page, the status card, and the
command router all read the same thing:

```js
{
  slug: 'gmail',
  name: 'Gmail',
  aliases: ['gmail','mail','email','thư','hộp thư'],   // §1 router
  summary: 'Read your inbox and search mail by voice',
  category: 'Communication',
  icon: '✉️',                                          // list-page glyph
  tools: [
    { name: 'GMAIL_FETCH_EMAILS', kind: 'read' },
    { name: 'GMAIL_SEND_EMAIL',   kind: 'send' },      // kind gates confirmation
  ],
}
```

Adding a service = **one registry entry + one Composio auth config** (ideally
`is_composio_managed` so there's no Google Cloud client, like calendar). `kind`
(`read` | `write` | `send`) lets the app auto-confirm before anything outbound.

---

## 6. Recommended connections (you asked me to think about this)

Curated for a **voice-first, face-aware** device. Guiding principle: **read and
capture win on glasses; send/destructive actions must confirm first.**

**Tier 1 — build these, highest synergy**

1. **Google Calendar** — *(have it)* the anchor.
2. **Google Contacts** — the standout, and the reason to do this at all. It pairs
   with face memory: recognize a face → pull their **contact card** (title,
   company, phone, email, your notes), and resolve spoken names ("what does Kevin
   have") to a real person **without** needing a shared calendar event. "Who is
   this" goes from *"someone you share a meeting with"* to *"your actual
   contact, with everything you know about them."* This is a genuinely novel
   glasses capability — I'd lead the product story with it.

**Tier 2 — high everyday voice value**

3. **Gmail (read-first)** — "any new mail from Tracy", "read my latest", "what did
   Kevin send". Sending is possible but gated behind confirmation (`kind:'send'`).
4. **Google Tasks** (or Todoist) — hands-free capture is where glasses shine:
   "add a task: email the vendor", "what's on my list".

**Tier 3 — situational**

5. **Slack** — "any Slack mentions?", "tell #eng I'm running late" (send → confirm).
6. **Weather** — glanceable and perfect for a HUD: "will it rain today?" (a simple
   weather API or a Composio weather toolkit if one exists).
7. **Notion** — voice note capture into a knowledge base.

**Deliberately *not* recommended for glasses:** Drive/Docs/Sheets editing,
spreadsheets, anything that wants a keyboard or a big screen — poor voice/HUD fit.

*(Exact Composio toolkit slugs and whether each is managed OAuth are confirmed in
the Composio dashboard when we add them; calendar's managed config is the model.)*

---

## 7. `Kavi sync` — apply new connections

After connecting on the phone, the glasses don't know yet. `Kavi sync` (`cập nhật`
/ `đồng bộ`):
- calls `connections.list` + re-checks the device token (`pair check`),
- updates the on-device cache of active connections,
- speaks the delta: *"Gmail and Contacts are now connected."*

The status page also refreshes on `onShow`, so sync is the explicit nudge when the
wearer just finished authorizing.

---

## 8. Per-connection actions

`Kavi <connection> <action>` routes to a handler that turns the action into that
connection's Composio tools via the existing `connections.execute`:

- **Calendar** — the current planner (agenda / lookup / attendees / free / add).
- **Contacts** — lookup by name or by a recognized face; "who is this" enriched.
- **Gmail** — list/search/read; send behind confirmation.
- **Tasks** — add / list / complete.
- **Slack** — read mentions; send behind confirmation.

Each is a thin module (`utils/connections/<slug>.js`) exposing
`plan(action) → {tool, args}` + a render shape, so a new connection is a new small
module, not a rewrite. **Face** stays separate (a default function, not a Composio
tool): its verbs route to `pages/face` as today, now under the same `Kavi …`
router.

---

## Backend changes (summary)

- `connections/index.ts`: expand the registry (aliases/category/icon/tool.kind);
  `list` returns it; `authorize` already accepts a `user_code`; `back` URL →
  `CONNECT_PAGE_URL`.
- New per-connection tool handlers (Contacts, Gmail, Tasks…) — mostly prompt/route
  logic, since `execute` is generic.
- Composio: add an auth config per new toolkit (managed where possible).
- No new secret ever reaches the glasses; the device token still scopes everything,
  Composio `user_id` = owner. Send/write tools are gated on-device by `kind`.

## Phased build order

- **Phase 0 — hosting spike:** validate Storage renders `text/html`; else stand up
  the public `kavi-connect` repo + Pages. *(Gate for everything visual.)*
- **Phase 1 — hub skeleton:** `Kavi status` + `Kavi sync` commands; status page
  with link/code + live status; connections list page (Calendar only end-to-end).
- **Phase 2 — grammar + Contacts:** the `Kavi <connection> <action>` router; add
  Google Contacts and wire the face×contacts synergy.
- **Phase 3 — Gmail + Tasks:** read/capture handlers; send-confirmation gating.
- **Phase 4 — Slack / Weather / polish:** situational connections; recommendations
  surfaced in the status card ("Try connecting Gmail").

## Decisions (made) and what's built

**Decided:** first cut = **Calendar + Gmail + Slack**; hosting = a **public
`kavi-connect` repo on GitHub Pages** (`https://zrg-team.github.io/kavi-connect/`).
Contacts + Tasks are strong future adds (note: connecting Gmail already exposes
`GMAIL_GET_CONTACTS`/`GMAIL_GET_PEOPLE`, a partial face×contacts synergy).

**Built and verified (build 20):**

- **Composio:** managed auth configs created for `gmail` (`ac_p49phxgelxpZ`) and
  `slack` (`ac_WkSQhGuaMRta`) — no Google/Slack app of your own needed. Resolution
  is by toolkit slug, so no IDs are hardcoded.
- **Registry** (`config.js` + `connections/index.ts`): Calendar/Gmail/Slack with
  aliases (en/vi), category, icon, and `tools:{name,kind}` (`kind` gates outbound
  actions).
- **Backend:** `list`/`status`/`authorize` all resolve the wearer from the glasses
  **pairing code** (no login) or a device token; `authorize` returns to
  `CONNECT_PAGE_URL`; `approve` no longer requires a specific connection (faces
  need identity too). Deployed.
- **Connections page:** the public `kavi-connect` page renders the service list
  with status + Connect buttons, and signs the glasses in on load. Verified live
  (GitHub Pages serves real `text/html`; the list + sign-in render).
- **Command grammar** (`utils/planner.js`): `statusCommand`, `syncCommand`,
  `connectionCommand` — one `Kavi <thing> <action>` router (optional prefix, en/vi).
- **Glasses:** `index.ink` routes status→sign-in, sync→`syncConnections()`,
  `<connection> <action>`→ the new **`pages/connection/connection`** card (Gmail/
  Slack read via `utils/connplan.js`). Verified in the real Ink engine: "kavi gmail
  any new mail" routes to and renders the connection card.

**Not yet built (next):** a live connection-status list *on the glasses* status
card (today "Kavi status" shows the link+code and "Kavi sync" speaks what's
connected); Contacts/Tasks connections; send/write actions (the `kind:'send'` gate
exists but no send UI yet); and result-field tuning once a real Gmail/Slack account
is connected and tested.
