-- Google Calendar authorization, per wearer.
--
-- The Composio path (a shared demo key) is retired — the key died and it put a
-- third-party in the middle of every calendar read. Instead each wearer
-- authorizes their OWN Google once, on their phone, during sign-in (docs/11,
-- docs/13). We keep only the refresh token, server-side; the glasses never see a
-- Google token — they call the `google` Edge Function with their device token,
-- and the function reads Calendar on their behalf.
--
-- Same access model as the rest: RLS on, NO policies. Only the Edge Functions
-- (service role) reach this. A refresh token is a long-lived credential, so it
-- lives nowhere a client can read it.

create table if not exists public.google_accounts (
  owner_id      text primary key,     -- the signed-in wearer (Supabase auth uid)
  email         text,                 -- which Google account, for display
  refresh_token text not null,        -- long-lived; exchanged for access tokens
  scope         text not null default '',
  connected_at  timestamptz not null default now(),
  last_used_at  timestamptz
);

alter table public.google_accounts enable row level security;

-- Disconnecting Google should take the token with it; forgetting a device does
-- not (the account can outlive one pair of glasses), so this is a separate,
-- explicit action handled in the function.
