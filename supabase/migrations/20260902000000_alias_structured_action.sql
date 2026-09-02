-- Structured actions for aliases, and the merge bug that was eating them.
--
-- ## 1. An alias can now name a tool, not just a phrase
--
-- `owner_aliases.action` is free text that gets *prepended* to whatever the
-- wearer said after the phrase, and the tool is then guessed server-side by a
-- regex in the adapter's `plan()`. That is fine for "inbox" → gmail
-- "newer_than:2d", and hopeless for "Google Calendar tomorrow", which needs a
-- specific tool with specific arguments and a day that must be recomputed every
-- time it is spoken.
--
-- So an alias may now carry a `tool` and a JSON `args` blob. Existing rows are
-- untouched and keep working: `tool = ''` means the old free-text behaviour,
-- and that is the default.
--
-- Day-dependent args are stored as placeholders, never as dates:
--
--     {"calendar_id":"primary","time_min":"{{start:tomorrow}}","time_max":"{{end:tomorrow}}"}
--
-- resolved on the glasses at the moment the phrase is spoken. Freezing a date
-- at save time would make "tomorrow" mean one specific Thursday forever.
--
-- ## 2. bind_owner was silently deleting aliases and bindings
--
-- The comment on `bind_owner` in 20260812000000_durable_identity.sql warns that
-- a future owner-scoped table must be re-pointed there too — and then
-- `owner_bindings` and `owner_aliases` were both added without doing it. Both
-- reference `owners(id) ON DELETE CASCADE`, and the merge branch ends with
-- `delete from public.owners where id = p_device_owner`.
--
-- So the first time a wearer signed into the console with Google having already
-- bound another device, every shortcut and every Slack channel they had chosen
-- was cascaded away. Silently, and permanently. Fixed below, in the same
-- migration, because a schema change that adds more per-owner data to lose
-- should not ship without it.

alter table public.owner_aliases
  add column if not exists tool text not null default '',
  add column if not exists args jsonb not null default '{}'::jsonb;

-- `kind` gains a third value. It is derived server-side from the request shape
-- (tool → 'action', action → 'shortcut', neither → 'app'); these constraints
-- make that derivation something the database also insists on, so a future call
-- site cannot write an inconsistent row.
alter table public.owner_aliases drop constraint if exists owner_aliases_kind_check;
alter table public.owner_aliases add constraint owner_aliases_kind_check
  check (kind in ('app', 'shortcut', 'action'));

alter table public.owner_aliases drop constraint if exists owner_aliases_action_has_tool;
alter table public.owner_aliases add constraint owner_aliases_action_has_tool
  check ((kind = 'action') = (tool <> ''));

-- Bound the blob. `args` is written from the console, and a per-phrase row has
-- no business being large; this is a backstop, not the real validation (which
-- lives in console/index.ts and checks the keys against the tool's schema).
alter table public.owner_aliases drop constraint if exists owner_aliases_args_small;
alter table public.owner_aliases add constraint owner_aliases_args_small
  check (jsonb_typeof(args) = 'object' and length(args::text) <= 2048);

comment on table public.owner_aliases is
  'Per-owner voice aliases, defined in the console and synced to the glasses. '
  'kind=app: phrase → service. kind=shortcut: phrase → service + canned text. '
  'kind=action: phrase → a specific tool and its arguments, where a {{day:…}} / '
  '{{start:…}} / {{end:…}} placeholder is resolved on the device at speak time. '
  'phrase is stored folded so it matches the router''s folded utterance.';

/* -------------------------------------------------------------------------- */
/* bind_owner: carry the per-owner tables through a tenant merge              */
/* -------------------------------------------------------------------------- */

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

  -- These two cannot use a plain UPDATE: their primary keys include owner_id,
  -- so a phrase (or a binding key) the durable tenant already defines would
  -- collide. The durable tenant's own choice wins — it is the one the wearer
  -- has been using from the account they just signed in with — and the
  -- transient's duplicate is dropped rather than overwriting it.
  insert into public.owner_aliases (owner_id, phrase, kind, slug, action, tool, args, created_at)
  select canonical, phrase, kind, slug, action, tool, args, created_at
    from public.owner_aliases
   where owner_id = p_device_owner
  on conflict (owner_id, phrase) do nothing;
  delete from public.owner_aliases where owner_id = p_device_owner;

  insert into public.owner_bindings (owner_id, slug, key, value, label)
  select canonical, slug, key, value, label
    from public.owner_bindings
   where owner_id = p_device_owner
  on conflict (owner_id, slug, key) do nothing;
  delete from public.owner_bindings where owner_id = p_device_owner;

  -- The transient tenant now owns nothing. Deleting it cascades over empty sets.
  delete from public.owners where id = p_device_owner;

  update public.owners set last_seen_at = now() where id = canonical;
  return canonical;
end;
$$;

revoke all on function public.bind_owner(text, uuid) from anon, authenticated;

comment on function public.bind_owner(text, uuid) is
  'Bind the current device tenant to a Supabase Auth (Google) identity, merging into the durable tenant if that identity already has one. Returns the id to use from now on. NOTE: when a future migration adds another owner-scoped table it must be re-pointed here too, or a merge will orphan its rows — or, for a table whose primary key includes owner_id, silently cascade them away.';
