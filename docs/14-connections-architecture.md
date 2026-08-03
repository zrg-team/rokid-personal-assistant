# Kavi architecture: default functions + connections

*The shape of the agent: a small set of **built-in functions** that always work, plus **connections** — external services the wearer authorizes once, through Composio — that plug in without new auth code. Google Calendar is the first connection; the structure is built so Slack, Gmail, Notion, … are a registry entry, not a rewrite.*

## Two kinds of capability

```
  KAVI
  ├─ Default functions        (built in, no authorization)
  │    • Face memory           "who is this" / "remember her as Tracy"
  │    • Text memory           notes attached to a person
  │
  └─ Connections              (authorized per wearer, via Composio)
       • Google Calendar       "what's on my calendar today"     ← implemented
       • Slack, Gmail, …       future — add a registry entry
```

- **Default functions** need no sign-in to a third party. Face and text memory work out of the box (they use Kavi's own Supabase backend). They are the baseline of what Kavi is.
- **Connections** are external services. Each one is a **Composio toolkit**. The wearer authorizes it once on their phone; after that Kavi can use that service's tools. Adding a new connection is a registry entry plus a Composio auth config — the sign-in, authorize, and tool-execution paths are already service-agnostic.

## Why Composio (not direct OAuth per service)

One integration layer instead of N. Composio holds the OAuth for every connected service and injects the right token when a tool runs. So "support more connections" means listing a toolkit, not writing a new OAuth client, callback, token store, and refresh loop for each service. Kavi stays a thin client; the breadth lives in the connection registry.

## Security model

Learned from the earlier review (`docs/08`) and kept here:

- **The Composio key never touches the glasses.** It lives as a backend secret (`COMPOSIO_API_KEY`). The glasses call the **Kavi backend**, which proxies Composio.
- **Per wearer.** The Composio `user_id` is the wearer's `owner_id` (their Supabase account). Composio stores each wearer's connections against their own id, so one wearer can never act as another.
- **The glasses hold one credential: the device token** from sign-in. The backend maps `device token → owner → Composio user_id`.

```
  glasses ──(device token)──► Kavi backend ──(server Composio key, user_id=owner)──► Composio ──► service
```

## The flow

```
  glasses: "Kavi sign in"        → pairing code on the HUD
        │
        ▼  phone opens the address, signs in (Supabase)
  phone:  Connections
          ┌─────────────────────────────┐
          │  Google Calendar   [Connect] │ → Composio OAuth → Google consent
          │  Slack             (soon)    │
          └─────────────────────────────┘
        │  connected ✓
        ▼  approve the glasses
  glasses: signed in
        │
        ▼  "what's on my calendar today"
  glasses ─► backend `connections/execute` ─► Composio GOOGLECALENDAR_EVENTS_LIST (user_id=owner) ─► events
```

Face/text memory work the whole time, connected or not — they're defaults, not connections.

## Folder structure

**Backend (Supabase Edge Functions)**

```
supabase/functions/
  _shared/
    http.ts             request plumbing, owner/device-token resolution
    composio.ts         server-side Composio client — auth configs, initiate a
                        connection, check status, execute a tool (key from env)
  pair/                 device sign-in: identity + device token (default)
  connections/         Composio connections for the wearer:
                          list      → available connections + this wearer's status
                          authorize → start a connection (returns an OAuth URL)
                          status    → is a connection active for this wearer?
                          execute   → run a tool for the wearer (proxy)
  face/                 default function: recognise / enrol faces
  face-people/          default function: list / note / forget people
```

**Glasses (`utils/`)**

```
utils/
  authservice.js        device pairing (sign-in)
  connections.js        client for the connections function: list / status /
                        authorizeUrl / execute(tool, args) — carries the device token
  calendarservice.js    thin wrapper: events(args) = connections.execute(
                        'GOOGLECALENDAR_EVENTS_LIST', args)
  faceservice.js        default function client (faces)
  …                     agent / planner / calendar shaping unchanged
```

**Config — the registry**

```js
// Built-in, always available.
export const DEFAULT_FUNCTIONS = ['faces', 'text-memory'];

// External services, authorized via Composio. Add one to grow Kavi's reach.
export const CONNECTIONS = [
  {
    slug: 'googlecalendar',          // Composio toolkit slug
    name: 'Google Calendar',
    summary: "Read your day and answer calendar questions",
    tools: ['GOOGLECALENDAR_EVENTS_LIST'],
    // e.g. add later: { slug: 'slack', name: 'Slack', tools: ['SLACK_SEND_MESSAGE', …] }
  },
];
```

The Composio key moves **out** of the glasses config (it was `composioConfig.apiKey`) and becomes the backend secret `COMPOSIO_API_KEY`. The glasses config keeps only the backend URL + the connection registry.

## Adding a connection later (the point of this design)

1. In the Composio dashboard, add the service's **auth config** (its OAuth integration) to the project.
2. Add one entry to `CONNECTIONS` (slug, name, the tool slugs to expose).
3. Nothing else: the phone Connections screen lists it, `authorize` starts its OAuth, and `execute` runs its tools — all already generic over the toolkit slug.

## Status and what this needs

- **Implemented now:** the structure above, with **Google Calendar** as the one connection. Face/text memory remain the built-in defaults.
- **Requires a valid Composio API key.** The demo key that shipped in `config.js` is dead (401 on every call), and Composio must have a **Google Calendar auth config** in the project with the connection redirect pointing back to the phone page. With those in place the flow runs end to end; without them, `authorize`/`execute` return clean "not configured / not connected" states.
- This supersedes the short-lived direct-Google approach (`docs/13`): same goal (the wearer authorizes their own Google, glasses hold no Google token), but routed through Composio so every future service reuses the path.
