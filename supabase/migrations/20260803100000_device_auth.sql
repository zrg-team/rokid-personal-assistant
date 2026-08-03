-- Device sign-in for the glasses (the login flow in docs/11).
--
-- A pairing works like a smart-TV login: the glasses start a session and show a
-- short code; the wearer opens a web page on their phone, signs in, and approves;
-- the glasses then exchange the session for a long-lived, revocable device token.
-- No password and no third-party login ever touches the glasses — only the token.
--
-- Same access model as the rest of the project: RLS on, NO policies, so anon and
-- authenticated clients can read/write nothing directly. Only the Edge Function
-- (holding the service-role key) reaches these tables.

/* -------------------------------------------------------------------------- */
/* tables                                                                     */
/* -------------------------------------------------------------------------- */

create table if not exists public.pairing_sessions (
  id           uuid primary key default gen_random_uuid(),

  -- sha256 of the `device_code` the glasses keep and poll with. Only the hash is
  -- stored, so a leaked row cannot be used to claim the session.
  device_hash  text not null unique,

  -- The easy words the wearer types on their phone, e.g. "green-tiger-42".
  user_code    text not null unique,

  -- Shown on BOTH the glasses and the phone after approval, to compare. Matching
  -- it proves the person who signed in is the one wearing the glasses.
  confirm_word text not null,

  -- pending  → started, waiting for the phone
  -- approved → the wearer signed in and approved on the phone (owner_id is set)
  -- claimed  → the glasses exchanged it for a token; terminal
  status       text not null default 'pending'
                 check (status in ('pending', 'approved', 'claimed')),

  -- The signed-in account, filled when the phone approves (Supabase auth uid).
  owner_id     text,

  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null
);

create index if not exists pairing_user_code_idx on public.pairing_sessions (user_code);

create table if not exists public.devices (
  id           uuid primary key default gen_random_uuid(),
  owner_id     text not null,

  -- sha256 of the device token the glasses store. The raw token is returned to
  -- the glasses exactly once, at claim time, and never stored in the clear.
  token_hash   text not null unique,

  label        text not null default 'Rokid Glasses',
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked      boolean not null default false
);

create index if not exists devices_owner_idx on public.devices (owner_id);

alter table public.pairing_sessions enable row level security;
alter table public.devices enable row level security;

/* -------------------------------------------------------------------------- */
/* functions                                                                  */
/* -------------------------------------------------------------------------- */

-- Verify a stored device token and note it was seen. Returns the owner, or null
-- if the token is unknown or has been revoked — which is how the glasses learn a
-- token was turned off from the web and they must sign in again.
create or replace function public.owner_from_device_token(p_token_hash text)
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  o text;
begin
  update public.devices
     set last_seen_at = now()
   where token_hash = p_token_hash and not revoked
  returning owner_id into o;
  return o;
end;
$$;

revoke all on function public.owner_from_device_token(text) from anon, authenticated;

-- Housekeeping: an unclaimed session is worthless once expired, and it holds a
-- code someone could otherwise keep trying. Sweep them.
create or replace function public.purge_expired_pairings()
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  removed integer;
begin
  delete from public.pairing_sessions
   where expires_at < now() and status <> 'claimed';
  get diagnostics removed = row_count;
  return removed;
end;
$$;

revoke all on function public.purge_expired_pairings() from anon, authenticated;

-- Schedule the sweep if pg_cron is available; a project without it still applies
-- cleanly (the Edge Function also treats an expired session as gone on read).
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule(
      'purge-expired-pairings',
      '*/10 * * * *',
      $cron$ select public.purge_expired_pairings(); $cron$
    );
  end if;
exception
  when others then
    raise notice 'pg_cron not scheduled: %', sqlerrm;
end;
$$;
