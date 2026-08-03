# Agent notes

Extended documentation that used to live in `AGENTS.md`. The upload platform
parses `AGENTS.md` as a strict manifest (`# Agent Manifest` → `## Identity` →
`## Capabilities`, see `.agents/skills/aiui-dev/SKILL.md` §1.1) and derives the
智能体描述 from it, so anything beyond that format risks being swallowed into
the description and tripping the 512-character limit. This file is not in
`dev/pack.mjs`'s CONTENTS allowlist and never ships.

## System Prompts

You are a calendar assistant running on Rokid AR glasses. The wearer is walking around and glancing at a small transparent display, so brevity is the whole job.

- Always prefer calling a declared Composio tool over answering from memory. You have no calendar knowledge of your own.
- For schedule questions call `GOOGLECALENDAR_EVENTS_LIST` with `calendarId: "primary"`, `singleEvents: true`, `orderBy: "startTime"`, and an explicit RFC3339 `timeMin`/`timeMax` bounding the requested day.
- To find one named thing ("when does my flight start"), call `GOOGLECALENDAR_EVENTS_LIST` with the subject as free-text `q` and a window from now to about 60 days ahead. Pass the plain subject word, not the whole sentence — Google matches `q` against title, description, location and attendees.
- To read another person's day, call `GOOGLECALENDAR_EVENTS_LIST` with `calendarId` set to their email address. Do not use the free/busy tools; they are not available on this connection.
- For availability, read the day's events and let the app derive the gaps. Do not call `GOOGLECALENDAR_FIND_FREE_SLOTS` or `FREE_BUSY_QUERY` — both are scope-blocked.
- For new events prefer `GOOGLECALENDAR_QUICK_ADD` when the user spoke a natural phrase, and `GOOGLECALENDAR_CREATE_EVENT` when they gave explicit fields.
- Never invent event titles, times, attendees, or email addresses. If you cannot resolve a person's name, say so — never answer about the wearer's own calendar instead.
- If a tool returns nothing, say the calendar is clear.
- Spoken replies are at most two short sentences. Detail belongs on the card, not in the audio.
- Resolve relative dates ("today", "tomorrow", "Friday") against the device's current date before calling a tool.
- Before any tool call that deletes or modifies an existing event, state what will change and wait for the wearer to confirm.

## Capabilities

- `network.http`: Reach the Composio API (MCP endpoint or `backend.composio.dev`) to discover and execute tools.
- `speech.recognition`: Transcribe the wearer's request after wake-word activation.
- `speech.synthesis`: Speak the summary of a result.
- `model.languagemodel`: On-device tool-call planning over the discovered Composio tool set.
- `storage.local`: Cache the last turn so the card survives a page hide.
- `camera.photo`: Take a single still when the wearer asks who someone is. Only ever from an interactive call site — a tap or the temple key — never on page open, and never continuously.

Not requested: filesystem access, location, video capture, or background camera access.

## Configuration

Set in `config.js`:

- `COMPOSIO_TRANSPORT`: `mcp` or `rest`. `rest` is the default because the current API key cannot provision an MCP server.
- `COMPOSIO_MCP_URL`: Composio MCP server URL. Required when transport is `mcp`.
- `COMPOSIO_API_KEY`: Composio API key. Required when transport is `rest`.
- `COMPOSIO_USER_ID`: Composio end-user whose connected accounts the agent acts on.
- `COMPOSIO_TOOLKITS`: Toolkit slugs exposed to the model. Defaults to `googlecalendar`.
- `WAKE_WORD`: Wake keyword reported by `onVoiceWakeup`. Defaults to `kavi` (also the agent name and the prefix on the sign-in command).
- `FACE.projectUrl` / `FACE.apiKey`: the Supabase project backing face memory (`qnjqghqjdyqrpifrbbdf`). The publishable key is safe in the bundle — every table is behind RLS with no policies, so only the Edge Functions (which hold the service role key) can reach the data.
- `FACE.ownerId`: which wearer the memories belong to, so one project can back several pairs of glasses without anyone matching against someone else's people.

## Dependencies

- Model: the runtime's default `LanguageModel`, with a keyword-routing fallback when `availability()` is not `available`
- Services: Composio (`googlecalendar` toolkit) with an `ACTIVE` OAuth2 connected account, narrowed to `EVENTS_LIST`, `QUICK_ADD` and `CREATE_EVENT`
- Device: Rokid Glasses — temple touch reported as key code `GlobalHook`; camera via `wx.media.createCameraContext()`
- Services: a Supabase project for face memory — Postgres with pgvector, plus two Edge Functions: `face` (identify, remember, warmup; YuNet detection and SFace int8 128-d embeddings) and `face-people` (list, correct, forget). Photos are sent there for matching and are not stored; only the embedding, a 32x32 greyscale thumbnail, and what the wearer dictated are kept.

## Pages

- `pages/index/index` — the voice loop: wake word → speech recognition → tool planning → card + speech. Also accepts `utterance` and `date` when the platform model dispatches to it.
- `pages/schedule/schedule` — a single-day schedule card, invocable directly by the platform model with `date` and `calendarId`.
- `pages/face/face` — the people memory, driven entirely by voice. Accepts `action` (`identify`, `remember`, `note`, `forget`, `list`) with optional `name` and `note`. `identify` photographs whoever is in front of the wearer and reports their name, the wearer's note about them, and any meeting the two of them share today; `remember` enrols that face under a spoken name; `note` attaches something worth recalling to the last person recognised; `forget` deletes a person and their face vectors; `list` says who is remembered. Recognition happens in the Supabase functions, not on the glasses.
