-- Durable owner identity: a tenant that survives a wiped pair of glasses.
--
-- `20260807000000_device_tenancy.sql` made the DEVICE the identity: a device
-- carries `device_uid_hash`, and re-signing in on the same glasses returns to
-- the same owner. That holds right up until the device's storage is wiped — a
-- reinstall, a resource update that clears `wx.getStorageSync`, or a warranty
-- replacement. The `device_uid` lives only on the glasses, so once it is gone
-- the tenant is orphaned: the people, embeddings and notes are still in the
-- tables, keyed to an id nothing will ask for again. The tenancy migration's own
-- header calls this out; this migration is the fix it deferred.
--
-- The anchor cannot live on the device, because the device is exactly what got
-- wiped. It has to be something the wearer can re-present from outside: their
-- Google account. When they sign in on the phone console (Supabase Auth, Google
-- provider), we get a stable Supabase Auth user id for that Google account, and
-- bind it to their tenant. A later wipe re-pairs into a fresh transient owner;
-- the first console sign-in merges it back into the durable one.
--
-- We anchor on the Supabase Auth user id rather than the raw Google `sub`
-- because Supabase already dedupes provider+provider_id into one stable
-- `auth.users` row, it is a real uuid we can foreign-key intent against, and —
-- verified against the Composio API this session — the connected-account object
-- does NOT reliably expose the Google `sub` (sensitive fields are masked and the
-- available identity depends on which toolkit was connected). The glasses never
-- do Google OAuth themselves; the console does, which is where the keyboard is.

/* -------------------------------------------------------------------------- */
/* 1. the durable anchor                                                      */
/* -------------------------------------------------------------------------- */

-- The Supabase Auth user id (Google-backed) for this tenant, or null until the
-- wearer has signed in on the console at least once. Unique: one Google account
-- anchors at most one tenant.
alter table public.owners
  add column if not exists auth_user_id uuid;

create unique index if not exists owners_auth_user_idx
  on public.owners (auth_user_id)
  where auth_user_id is not null;

comment on column public.owners.auth_user_id is
  'Supabase Auth user id (Google provider), set when the wearer first signs in on the console. The durable anchor that reunites a wiped pair of glasses with its tenant. Null for a tenant that has only ever paired, never signed in on the console.';

/* -------------------------------------------------------------------------- */
/* 2. bind a device-minted tenant to a Google identity, merging if needed     */
/* -------------------------------------------------------------------------- */

-- Called when the console authenticates a wearer. `p_device_owner` is the tenant
-- the glasses are currently on (possibly a fresh one minted after a wipe);
-- `p_auth_user` is the Supabase Auth user id we just verified.
--
-- Three cases:
--   a. This Google account already anchors another tenant → MERGE: re-point every
--      memory from the transient tenant onto the durable one, drop the transient
--      row, return the durable id. This is the recovery path.
--   b. This Google account anchors nothing yet, and the current tenant is
--      unanchored → CLAIM: stamp the anchor onto the current tenant, return it.
--   c. The current tenant is already anchored to this same account → no-op.
--
-- Returns the id of the tenant the caller should use from now on.
--
-- Re-pointing order matters: the memory tables reference owners(id) ON DELETE
-- CASCADE, so the transient owner row must be deleted AFTER its rows have moved,
-- never before, or the cascade would take the memories with it.
create or replace function public.bind_owner(p_device_owner text, p_auth_user uuid)
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  canonical text;
begin
  if p_auth_user is null then
    raise exception 'bind_owner requires an auth user id';
  end if;

  select id into canonical
  from public.owners
  where auth_user_id = p_auth_user
  limit 1;

  -- (b) / (c): nobody else holds this identity.
  if canonical is null then
    update public.owners
       set auth_user_id = p_auth_user,
           last_seen_at = now()
     where id = p_device_owner;
    return p_device_owner;
  end if;

  -- (c): already the same tenant.
  if canonical = p_device_owner then
    update public.owners set last_seen_at = now() where id = canonical;
    return canonical;
  end if;

  -- (a): merge the transient tenant into the durable one.
  --
  -- recent_captures keys on owner_id (primary key, one row per owner) and is a
  -- throwaway few-minute buffer, so the transient's row is dropped rather than
  -- moved — moving it could collide with the durable owner's own row.
  delete from public.recent_captures where owner_id = p_device_owner;

  update public.people          set owner_id = canonical where owner_id = p_device_owner;
  update public.face_embeddings set owner_id = canonical where owner_id = p_device_owner;
  update public.devices         set owner_id = canonical where owner_id = p_device_owner;
  update public.pairing_sessions set owner_id = canonical where owner_id = p_device_owner;

  -- The transient tenant now owns nothing. Deleting it cascades over empty sets.
  delete from public.owners where id = p_device_owner;

  update public.owners set last_seen_at = now() where id = canonical;
  return canonical;
end;
$$;

revoke all on function public.bind_owner(text, uuid) from anon, authenticated;

comment on function public.bind_owner(text, uuid) is
  'Bind the current device tenant to a Supabase Auth (Google) identity, merging into the durable tenant if that identity already has one. Returns the id to use from now on. NOTE: when a future migration adds another owner-scoped table (owner_bindings, owner_aliases, memories, …) it must be re-pointed here too, or a merge will orphan its rows.';

/* -------------------------------------------------------------------------- */
/* 3. resolve a tenant by its durable anchor                                  */
/* -------------------------------------------------------------------------- */

-- The console's read path: given the signed-in Google identity, which tenant is
-- theirs? Null if they have paired glasses but never bound them (the console can
-- then offer to bind the device the code came from).
create or replace function public.owner_for_auth_user(p_auth_user uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select id
  from public.owners
  where auth_user_id = p_auth_user
  limit 1;
$$;

revoke all on function public.owner_for_auth_user(uuid) from anon, authenticated;
