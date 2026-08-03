-- The face you just looked at.
--
-- Every command is a fresh page open — that is how the host model dispatches on
-- the glasses, and how the dev harness works too — so nothing survives in the
-- page between "who is this" and "remember her as Tracy". Without somewhere to
-- put it, the second command has to photograph the person again, by which time
-- they may have turned away or the moment has passed.
--
-- So the *service* remembers the last capture instead, for a few minutes, and an
-- enrolment that arrives without a photo uses it. One row per wearer: the
-- previous capture is worth nothing once a new one replaces it.

create table if not exists public.recent_captures (
  owner_id   text primary key,
  embedding  vector(128) not null,
  thumb      text not null default '',
  created_at timestamptz not null default now()
);

-- Biometric data, same as the rest: reachable only through the Edge Functions
-- on the service role key.
alter table public.recent_captures enable row level security;

comment on table public.recent_captures is
  'Last face seen per wearer, so "remember her as X" can follow "who is this" without a second photo. Overwritten on every capture; ignored by the function once older than a few minutes.';
