# Deploying and testing on a real Rokid device

*How to get this agent — and its sign-in backend — onto physical Rokid Glasses, how it is invoked there, and what to watch for. Device-specific facts here are drawn from the Rokid developer forum (August 2026); they are developer reports and current-beta behavior, not permanent guarantees. Sources at the end.*

## Two things get deployed, not one

This agent has a client and a backend, and they ship through completely different channels:

1. **The agent** (`.aix`) → uploaded to **AIUI Studio** and synced to the glasses.
2. **The Supabase backend** (face recognition + the sign-in `pair` function) → deployed to Supabase with the CLI.

Sign-in needs **both**: the glasses run `pages/signin`, but it talks to the `pair` Edge Function, which must be live first.

## 1. Deploy the Supabase backend

```bash
npm run db:push     # applies migrations: face tables, pairing_sessions, devices
npm run deploy      # deploys the functions: face, face-people, pair
```

Then, in the Supabase dashboard:

- **Authentication → Providers**: enable **Email** (the phone sign-in page uses an emailed one-time code) or **Google**. Without a sign-in method enabled, the phone page cannot sign anyone in.
- Optional env for the `pair` / face functions (Project → Edge Functions → Secrets): `PAIR_VERIFY_URL` (a short domain to show on the HUD instead of the long Supabase URL), and `OWNER_SIGNING_SECRET` (turns on real multi-wearer isolation for the face functions — see `docs/08`).

Verify the function answers before touching the glasses:

```bash
curl -s -X POST "https://qnjqghqjdyqrpifrbbdf.supabase.co/functions/v1/pair" \
  -H "apikey: <supabase-publishable-key>" \
  -H "content-type: application/json" \
  -d '{"action":"start"}'
# → { "ok": true, "user_code": "green-tiger-42",
#     "verification_url": "https://qnjqghqjdyqrpifrbbdf.supabase.co/functions/v1/pair", … }
```

That `verification_url` is what the glasses show and the wearer types. It is long,
so set a `PAIR_VERIFY_URL` secret (or a Supabase custom domain) to a short link if
you want it easier to enter — there is no built-in short domain.

## 2. Package and upload the agent

```bash
npm run pack        # → dist/people-memory-<version>.aix
```

Upload that `.aix` through **AIUI Studio** (global platform: `aiui-global.rokid.com/space`) or from the **Craft IDE**. Craft's own **Pack** button produces the same artifact through the hosted toolchain. A build is considered ready when Rokid's reader parses it (title, pages, and one tool per page) — locally you can pre-check with `dev/aix-check.html`.

Then push it to the hardware: in the **Hi Rokid companion app**, run **"更新眼镜资源" (Update glasses resources)** to sync the agent to the paired glasses, and bind the device. Developers report the agent can be in **draft** status for personal debugging; declare only the permissions you use (this agent: camera, microphone, network, audio, storage).

## 3. How it is invoked on the glasses

This is the part that changes the design, and it is the reason this agent recognizes its **own** trigger words rather than trusting the platform to route them. A custom AIUI agent is **not** the main assistant. On the current platform it is reached two ways:

- **By name** — the wearer says the agent's name, **"Kavi"** (a developer on the forum invokes theirs with *"show Jarvis"*). It is the Name in `AGENTS.md`, coined so it is unique — not an everyday English or Vietnamese word that another agent or the assistant could also claim — and clean for both languages' ASR.
- **By the AI-shortcut gesture** — a **double two-finger tap on the touchpad** invokes whichever agent is selected as the **"call target"** in the companion app's AI-shortcut list.

Routing **all** voice commands to a custom agent (making it the default assistant) is **not supported today** — a frequently requested feature. So once your agent is foregrounded, *it* must interpret what it hears.

### Which is why sign-in has explicit triggers

Because the platform will not reliably catch a bare "sign in" and open your page, this agent reaches sign-in two ways of its own (both in code):

- **A unique trigger phrase** — `signinCommand()` in `utils/planner.js` requires the coined word **"Kavi"** *plus* a sign-in verb: **"Kavi sign in"**, **"Kavi log in"**, or **"Kavi đăng nhập"** (accent-insensitive, with tolerance for common ASR spellings of Kavi). Requiring the unique word — not a bare "sign in", which the assistant or another agent could also claim — is the whole point. `pages/index` routes it straight to `pages/signin`.
- **The gate** — `requireSignin()` in `utils/gate.js` redirects any page to sign-in on a launch with no stored token (active only when `AUTH.required = true`).

The page's `<script def>` description is kept too, so the host model *can* dispatch it where that path works — but nothing depends on it.

## 4. On-device test checklist

The desktop harness proves layout and logic; only the glasses prove the rest (forum post 3481: *"real device confirms whether the text is legible, whether voice can trigger it, and whether the photo path is smooth"*). Verify on hardware:

- **Invocation** — the agent opens by name and/or the touchpad gesture.
- **Sign-in** — say a trigger word (or launch gated): the code and address are legible; the phone flow completes; the confirm word matches; the temple press finishes and stores a token; a relaunch skips sign-in.
- **Legibility** — code, URL, and confirm word are readable at a glance; nothing overflows the card.
- **Voice** — the wake word (`kavi`) and ASR actually trigger, and "Kavi sign in" / "Kavi đăng nhập" route to sign-in (unverified off-device).
- **Camera + TTS** — `takePhoto()` fires from a tap/temple press; spoken lines play.
- **Temple key** — `GlobalHook` reaches `onKeyUp`.
- **Failure paths** — expired code, denied camera, no network: each shows a clear state, not a blank card.

## 5. Known beta gotchas (from the forum)

Budget time for these — they are current-platform realities, not your bugs:

- **Deleting an agent may not fully remove it.** Developers report deleted agents linger as selectable "zombie" entries in the companion app, re-uploading the same name creates duplicates, and even a **factory reset did not clear them**. The partial fix reported: remove the link in Craft, then delete again. Prefer **updating** a build over delete-and-recreate, and avoid churning agent names.
- **Custom agent as call target can fail.** Selecting a custom agent for the AI-shortcut and triggering it has returned *"AI assistant service error"* for multiple developers; the exact requirements to be invocable are not yet documented. Test invocation-by-name as well.
- **No display/power API.** There is no documented way to sleep the panel or exit to a dark screen; `wx.exitMiniProgram()` hands back to the (lit) assistant home, and `this.finish()` only pops the page. Don't design a flow that depends on the glasses going dark.
- **ADB is for logs/debug, not for installing the agent.** The `.aix` goes through AIUI Studio + the companion app, not `adb install`. ADB over the 5-pin dev cable is available for logs but is reported flaky (can fail to enumerate on Windows 11); use a data/debug cable, not a charge-only one.

## Sources

- Rokid developer forum post **3481** — an agent's build-and-on-device-test writeup (`forum.rokid.com/post/detail/3481`).
- Post **3493** — agent lifecycle, the AI-shortcut "call target" list, invocation by name, and the "main assistant → custom agent" limitation (`/post/detail/3493`).
- Post **3564** — exit behavior, the absence of a display/power API, and ADB over the dev cable (`/post/detail/3564`).
- Platform/runtime background: `docs/02`, `docs/03`; the build loop: `docs/09`.
