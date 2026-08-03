-- Retention for the last-seen capture buffer.
--
-- `recent_captures` holds one biometric vector per wearer so "remember her as
-- Tracy" can follow "who is this" without a second photo. It is useful for a
-- few minutes and then it is just a face vector sitting in a table. The Edge
-- Function already sweeps expired rows as it writes new ones, and clears a
-- wearer's row when they forget someone — but a device that goes quiet writes
-- nothing, so nothing gets swept. This adds a database-side purge that does not
-- depend on any request arriving.

create or replace function public.purge_stale_captures(max_age interval default interval '10 minutes')
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  removed integer;
begin
  delete from public.recent_captures
  where created_at < now() - max_age;
  get diagnostics removed = row_count;
  return removed;
end;
$$;

-- Callable only through the service role, like everything else that touches
-- biometric data.
revoke all on function public.purge_stale_captures(interval) from anon, authenticated;

-- Schedule it if pg_cron is available. Wrapped so a project without the
-- extension still applies the migration cleanly — the Edge Function's
-- sweep-on-write remains the guaranteed path, and this is the belt to its
-- braces where the platform allows it.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule(
      'purge-stale-captures',
      '*/5 * * * *',
      $cron$ select public.purge_stale_captures(); $cron$
    );
  end if;
exception
  when others then
    raise notice 'pg_cron not scheduled: %', sqlerrm;
end;
$$;
