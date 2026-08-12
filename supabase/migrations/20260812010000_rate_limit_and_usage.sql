-- Rate limiting and a per-owner usage ceiling.
--
-- Two holes this closes, both verified this session:
--
--   1. NO RATE LIMITING anywhere. `pair.start` mints a code and `connections`
--      accepts a `user_code` as a bearer credential in a POST body — with the
--      1.6M-code keyspace (128-word list), an unthrottled attacker still sweeps
--      it. A fixed-window counter keyed on the caller's IP prefix bounds that.
--
--   2. NO COST CEILING. `_shared/http.ts` enforces `MAX_UPLOAD_BYTES` and nothing
--      else. Once the backend is shared (hosted), every tool call spends the
--      operator's money and a looping client bills them without limit. A per-owner
--      daily counter gives a cap the function can refuse against.
--
-- Both are plain Postgres — there is nowhere else to keep shared state, because
-- Edge Function isolates are per-request and per-region, so an in-process counter
-- would reset constantly and never coordinate. `security definer`, atomic upsert.

/* -------------------------------------------------------------------------- */
/* 1. fixed-window rate limiter                                               */
/* -------------------------------------------------------------------------- */

create table if not exists public.rate_limits (
  bucket        text primary key,
  window_start  timestamptz not null,
  count         integer not null default 0
);

comment on table public.rate_limits is
  'Fixed-window request counters. One row per bucket (e.g. "pair.start:203.0.113"), reset in place when the window rolls. Swept opportunistically by hit_rate_limit.';

alter table public.rate_limits enable row level security;

-- Count one hit against `p_bucket` and report whether it is still allowed.
--
-- Atomic: the upsert both rolls the window (when `window_start` is stale) and
-- increments (when it is current) in a single statement, so two concurrent
-- callers cannot both read a low count and both be admitted. Returns true while
-- the running count is within `p_max`.
create or replace function public.hit_rate_limit(
  p_bucket text, p_window_seconds integer, p_max integer
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  ws  timestamptz;
  cur integer;
begin
  -- Floor now() to the window boundary, so a bucket's window is shared by every
  -- request that lands in it rather than sliding per-caller.
  ws := to_timestamp(
    floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds
  );

  insert into public.rate_limits (bucket, window_start, count)
  values (p_bucket, ws, 1)
  on conflict (bucket) do update
    set count        = case when public.rate_limits.window_start = ws
                            then public.rate_limits.count + 1
                            else 1 end,
        window_start = ws
  returning count into cur;

  return cur <= p_max;
end;
$$;

revoke all on function public.hit_rate_limit(text, integer, integer) from anon, authenticated;

-- Drop windows nobody has touched in a day. Cheap, and keeps the table from
-- growing one row per distinct attacker IP forever.
create or replace function public.purge_stale_rate_limits()
returns void
language sql
volatile
security definer
set search_path = public
as $$
  delete from public.rate_limits
  where window_start < now() - interval '1 day';
$$;

revoke all on function public.purge_stale_rate_limits() from anon, authenticated;

/* -------------------------------------------------------------------------- */
/* 2. per-owner daily usage ceiling                                           */
/* -------------------------------------------------------------------------- */

create table if not exists public.usage_counters (
  owner_id  text not null references public.owners(id) on delete cascade,
  day       date not null default current_date,
  units     integer not null default 0,
  primary key (owner_id, day)
);

comment on table public.usage_counters is
  'Per-owner, per-day cost units (one unit ≈ one tool execution). The function refuses further paid work once a daily cap is exceeded, so a looping client cannot run up the operator bill.';

alter table public.usage_counters enable row level security;

-- Add `p_units` to today's total for `p_owner` and return the new total. The
-- caller compares it to the cap (an env var, so it is tunable without a
-- migration) and refuses when exceeded. Deliberately post-hoc: the work being
-- counted has usually already happened, and a small overshoot is fine.
create or replace function public.bump_usage(p_owner text, p_units integer)
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  total integer;
begin
  insert into public.usage_counters (owner_id, day, units)
  values (p_owner, current_date, p_units)
  on conflict (owner_id, day) do update
    set units = public.usage_counters.units + p_units
  returning units into total;

  return total;
end;
$$;

revoke all on function public.bump_usage(text, integer) from anon, authenticated;

-- Keep only a short history; the counter is for throttling, not analytics.
create or replace function public.purge_old_usage()
returns void
language sql
volatile
security definer
set search_path = public
as $$
  delete from public.usage_counters where day < current_date - 7;
$$;

revoke all on function public.purge_old_usage() from anon, authenticated;
