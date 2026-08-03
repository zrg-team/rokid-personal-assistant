# Connecting the wearer's Google Calendar

*How Kavi reads the wearer's own calendar: direct Google OAuth through the Supabase backend, no Composio. This replaces the old shared Composio key (which died — 401 on every call).*

## Why this changed

The calendar used to go through Composio with one shared demo key. That key is now invalid, and it also put a third party in the middle of every read. Kavi now uses **direct Google OAuth**: each wearer authorizes their **own** Google once, on their phone, during sign-in. The glasses never hold a Google token — the backend keeps only a refresh token (server-side, RLS-locked) and exchanges it for a short-lived access token each time the glasses ask for events, keyed by the device token.

## The full flow

```
  glasses: "Kavi sign in"  ──►  show pairing code + web address
        │
        ▼  wearer opens the address on their phone
  phone:  sign in (email code)  ──►  Connect Google Calendar  ──►  Google consent
        │                                                              │
        │   Google redirects back ──► google/callback stores the      │
        │   refresh token for this wearer ──► back to the phone page ◄─┘
        ▼
  phone:  "Google connected" ──►  approve ──►  confirm word
        │
        ▼  wearer presses the temple
  glasses: signed in ──►  reads THEIR calendar via the google function
                          (device token → owner → refresh → Calendar API)
```

## What's implemented and deployed

- **`google` Edge Function** (deployed, public): `connect` (→ Google consent URL), `/callback` (code → refresh token), `status`, `events` (device token → the wearer's events), `disconnect`.
- **`google_accounts` table** (migrated): `owner_id → refresh_token, email` behind RLS with no policies.
- **Phone page** (`pair`): sign in → **Connect Google Calendar** → approve.
- **Glasses** (`utils/calendarservice.js`): the pages read events through the backend with the device token, using the same interface the app had for Composio — the agenda, lookups, attendees, free slots and other people's days all work (they're all `EVENTS_LIST`). Creating events is not wired to Google yet.

Verified live (against the deployed functions): the phone page serves the Google step, `google/callback` is reachable, and every auth guard returns correctly (`events` without a token → 401, `connect` without sign-in → 401, `status` → 401, bad callback state → 400).

## The one thing you must do: a Google OAuth client

Google OAuth requires an OAuth client that **you** own (there's no way around this — the tokens are your users' Google data). ~5 minutes in the Google Cloud Console:

1. **Enable the API** — APIs & Services → Library → **Google Calendar API** → Enable.
2. **OAuth consent screen** — External. Add scopes `.../auth/calendar.readonly` and `openid`, `email`. While in "Testing", add each wearer's email under **Test users** (no Google verification needed for testing).
3. **Credentials → Create OAuth client ID → Web application.** Set the **Authorized redirect URI** to exactly:
   ```
   https://qnjqghqjdyqrpifrbbdf.supabase.co/functions/v1/google/callback
   ```
   Copy the **Client ID** and **Client secret**.
4. **Give them to the backend** as Supabase secrets:
   ```bash
   npx supabase secrets set \
     GOOGLE_CLIENT_ID=<your-client-id> \
     GOOGLE_CLIENT_SECRET=<your-client-secret> \
     --project-ref qnjqghqjdyqrpifrbbdf
   ```
   (No redeploy needed — Edge Functions pick up secrets on the next cold start.)

That's it. Until those secrets are set, `connect` returns `503 "Google is not configured"` and `events` returns `409 no-google` — both handled gracefully (the glasses route the wearer to sign-in).

## Test it end to end

1. Set the two secrets above.
2. On the glasses (or `dev/runtime.html` → open sign-in): start sign-in, get a code.
3. Open the address on your phone, sign in with the emailed code, click **Connect Google Calendar**, approve on Google's screen.
4. Back on the phone: "Google connected" → the confirm word appears.
5. Press the temple on the glasses → signed in → ask for your day. It reads your real calendar.

Quick backend check once the secrets are set (needs a real device token from a completed sign-in):
```bash
curl -s -X POST https://qnjqghqjdyqrpifrbbdf.supabase.co/functions/v1/google \
  -H "authorization: Bearer <device-token>" -H "content-type: application/json" \
  -d '{"action":"events","timeMin":"2026-08-03T00:00:00Z","timeMax":"2026-08-04T00:00:00Z"}'
# → { "ok": true, "data": { "items": [ … your events … ] } }
```

## Notes / limits

- **Refresh token:** Google only returns one with `access_type=offline` + `prompt=consent` (both set). If a wearer previously consented, they may need to remove the app at `myaccount.google.com/permissions` and reconnect — the callback says so.
- **Read-only:** the scope is `calendar.readonly`. "Add lunch at noon" (create) is not wired to Google yet; reading is.
- **`config.js` `composioConfig` is retired** — kept only so old references don't break; nothing uses it now.
