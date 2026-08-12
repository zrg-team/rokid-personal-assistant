-- Durable console sessions (docs/16).
--
-- The phone console signs in with a short-lived pairing code (10-min) or a Google
-- JWT; neither persists, so reopening the console otherwise needs a fresh glasses
-- code. A console session is the durable, revocable credential that fixes that:
-- once the wearer has proven themselves (a live code that resolves to their
-- tenant), the console mints one, and the browser re-presents it to skip the code.
--
-- How the browser KEEPS it never touches the server: behind a passkey (WebAuthn),
-- or encrypted in localStorage under a short passcode. Either way this table only
-- ever sees the token's sha256 hash; the raw token is returned to the browser
-- exactly once — the same contract the device token already uses.

create table if not exists public.console_sessions (
  token_hash   text primary key,
  owner_id     text not null references public.owners(id) on delete cascade,
  label        text,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  expires_at   timestamptz not null,
  revoked      boolean not null default false
);

create index if not exists console_sessions_owner_idx on public.console_sessions(owner_id);

-- RLS on, no policies: reachable only through the service role inside the function.
alter table public.console_sessions enable row level security;

-- Resolve a live console token to its owner, or null if it is unknown, revoked or
-- expired. Mirrors owner_from_device_token, and additionally SLIDES the window:
-- every use pushes expiry out, so an active console stays signed in while an
-- abandoned token still lapses on its own. Idempotent and safe to call per request.
create or replace function public.owner_from_console_token(p_token_hash text)
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  o text;
begin
  update public.console_sessions
     set last_used_at = now(),
         expires_at   = now() + interval '14 days'
   where token_hash = p_token_hash and not revoked and expires_at > now()
  returning owner_id into o;
  return o;
end;
$$;

revoke all on function public.owner_from_console_token(text) from anon, authenticated;

-- The browser's "clear / sign this device out": kill one console token so a leaked
-- localStorage blob is dead even before it would have expired.
create or replace function public.revoke_console_session(p_token_hash text)
returns void
language sql
volatile
security definer
set search_path = public
as $$
  update public.console_sessions set revoked = true where token_hash = p_token_hash;
$$;

revoke all on function public.revoke_console_session(text) from anon, authenticated;

-- NOTE (future, when Google binding goes live): bind_owner() re-points a device
-- tenant's rows onto the durable Google tenant and then deletes the transient
-- owner. console_sessions has ON DELETE CASCADE, so an un-repointed token would be
-- dropped by a merge (the console simply re-authenticates — acceptable). When
-- bind_owner is put on the live path, add console_sessions to its re-point list,
-- as flagged in 20260812000000_durable_identity.sql.
