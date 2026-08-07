-- Device-scoped tenancy: one owner per pair of glasses, every memory hanging off it.
--
-- Until now `owner_id` was minted fresh inside `pair.start` for each pairing
-- session and copied into five tables as a bare text column. Two consequences,
-- both bad:
--
--   1. Signing in again on the SAME glasses produced a NEW owner_id, so the
--      wearer's people, faces and notes were orphaned on the spot — still in the
--      table, keyed to an id nothing would ever ask for again. The device was
--      the identity in spirit, but nothing in the schema said so.
--   2. Nothing tied those ids together. No row asserting that a tenant exists,
--      no foreign key, and therefore no way to delete a wearer's data other than
--      five hand-written DELETEs in the right order.
--
-- This migration makes the device the identity for real: `owners` is the tenant,
-- a device carries a stable secret (`device_uid_hash`) that maps it back to its
-- owner across sign-outs, and every memory table references `owners(id)` ON
-- DELETE CASCADE — so forgetting a wearer is one DELETE.
--
-- `owner_id` stays TEXT rather than becoming a uuid. It reads as a uuid in
-- practice, but `_shared/http.ts` also issues the literal `default` bucket for
-- single-wearer deployments, and an HMAC deployment may issue arbitrary ids. A
-- cast would have failed on exactly those rows.

/* -------------------------------------------------------------------------- */
/* 1. the tenant registry                                                     */
/* -------------------------------------------------------------------------- */

create table if not exists public.owners (
  id           text primary key,
  label        text not null default '',
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

comment on table public.owners is
  'One row per wearer identity. Created by pair.start for a device it has not seen before and reused for every later sign-in from that same device. Deleting a row cascades to every memory that wearer holds.';

alter table public.owners enable row level security;

-- Adopt every id already in use, or the foreign keys below cannot be added.
insert into public.owners (id, label)
select distinct s.owner_id, 'backfilled'
from (
  select owner_id from public.devices
  union select owner_id from public.pairing_sessions
  union select owner_id from public.people
  union select owner_id from public.face_embeddings
  union select owner_id from public.recent_captures
) s
where s.owner_id is not null
on conflict (id) do nothing;

-- The bucket `resolveOwner` hands to callers with no device token at all.
insert into public.owners (id, label)
values ('default', 'single-wearer / not signed in')
on conflict (id) do nothing;

/* -------------------------------------------------------------------------- */
/* 2. every memory hangs off the tenant                                       */
/* -------------------------------------------------------------------------- */

alter table public.people
  drop constraint if exists people_owner_fk,
  add constraint people_owner_fk foreign key (owner_id)
    references public.owners(id) on delete cascade;

alter table public.face_embeddings
  drop constraint if exists face_embeddings_owner_fk,
  add constraint face_embeddings_owner_fk foreign key (owner_id)
    references public.owners(id) on delete cascade;

alter table public.recent_captures
  drop constraint if exists recent_captures_owner_fk,
  add constraint recent_captures_owner_fk foreign key (owner_id)
    references public.owners(id) on delete cascade;

alter table public.devices
  drop constraint if exists devices_owner_fk,
  add constraint devices_owner_fk foreign key (owner_id)
    references public.owners(id) on delete cascade;

-- Nullable here: a session holds its owner from `start`, but the column is
-- allowed to be empty for a pairing that never got that far.
alter table public.pairing_sessions
  drop constraint if exists pairing_sessions_owner_fk,
  add constraint pairing_sessions_owner_fk foreign key (owner_id)
    references public.owners(id) on delete cascade;

/* -------------------------------------------------------------------------- */
/* 3. the device's stable identity                                            */
/* -------------------------------------------------------------------------- */

-- sha256 of a secret the glasses keep across sign-outs. The raw value is minted
-- by `pair.start` on a device's first ever pairing, returned once, and stored on
-- the device from then on; only its hash is kept here, exactly like the token.
alter table public.devices
  add column if not exists device_uid_hash text;

alter table public.pairing_sessions
  add column if not exists device_uid_hash text;

comment on column public.devices.device_uid_hash is
  'sha256 of the device secret. Maps a pair of glasses back to its owner on a later sign-in, so the wearer keeps their people memory.';

-- One ACTIVE row per physical device. Partial on `not revoked` on purpose:
-- revoking a lost device leaves its row for audit and lets the same hardware
-- pair again — into a FRESH owner, which is the point of revoking it.
create unique index if not exists devices_uid_active_idx
  on public.devices (device_uid_hash)
  where device_uid_hash is not null and not revoked;

/* -------------------------------------------------------------------------- */
/* 4. lookups                                                                 */
/* -------------------------------------------------------------------------- */

-- Which tenant do these glasses already belong to? Revoked rows are invisible
-- here, so a revoked device cannot walk back into the tenant it was cut from.
create or replace function public.owner_for_device_uid(p_uid_hash text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select owner_id
  from public.devices
  where device_uid_hash = p_uid_hash and not revoked
  order by created_at desc
  limit 1;
$$;

revoke all on function public.owner_for_device_uid(text) from anon, authenticated;

-- Same contract as before — resolve a device token to its owner, or null if the
-- token is unknown or revoked — but the tenant's last_seen_at now moves too, so
-- an idle owner is visible without joining through devices.
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

  if o is not null then
    update public.owners set last_seen_at = now() where id = o;
  end if;

  return o;
end;
$$;

revoke all on function public.owner_from_device_token(text) from anon, authenticated;

-- Forget a wearer entirely: people, embeddings, capture buffer, devices and any
-- half-finished pairing go with the tenant row. This is the whole delete path.
create or replace function public.forget_owner(p_owner text)
returns void
language sql
volatile
security definer
set search_path = public
as $$
  delete from public.owners where id = p_owner;
$$;

revoke all on function public.forget_owner(text) from anon, authenticated;

/* -------------------------------------------------------------------------- */
/* 5. indexes                                                                 */
/* -------------------------------------------------------------------------- */

-- The sweep in purge_expired_pairings scans on exactly this predicate.
create index if not exists pairing_sessions_expiry_idx
  on public.pairing_sessions (expires_at)
  where status <> 'claimed';

-- Every read of a wearer's devices cares only about live ones; the partial index
-- is smaller and matches the query. Replaces the unconditional owner index.
create index if not exists devices_owner_active_idx
  on public.devices (owner_id)
  where not revoked;

drop index if exists devices_owner_idx;

/* -------------------------------------------------------------------------- */
/* 6. the orphan                                                              */
/* -------------------------------------------------------------------------- */

-- `google_accounts` belongs to the direct-Google approach retired in docs/14;
-- no function has read it since. It carries a refresh_token column, so leaving
-- it is a standing liability — but dropping a table that still holds live
-- credentials silently would be worse. Drop it only when it is empty, and say so
-- either way.
do $$
begin
  if to_regclass('public.google_accounts') is not null then
    if not exists (select 1 from public.google_accounts) then
      drop table public.google_accounts;
      raise notice 'dropped orphaned google_accounts (it was empty)';
    else
      raise notice 'google_accounts still holds rows - left in place. Revoke those refresh tokens, then drop it by hand.';
    end if;
  end if;
end;
$$;
