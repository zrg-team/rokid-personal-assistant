-- Per-owner opaque resource ids — the reason Slack never worked.
--
-- Some tools need an id the wearer chooses once and that no utterance can
-- supply: a Slack channel, a Google Tasks list, a Linear team. The old code
-- shipped Slack with no channel and it silently failed. An adapter now declares
-- what it needs (`bindings` in _shared/services), the console renders a picker,
-- and the choice is stored here. A missing required binding becomes a
-- `needs-setup` card, never a wrong call.

create table if not exists public.owner_bindings (
  owner_id  text not null references public.owners(id) on delete cascade,
  slug      text not null,               -- service slug (Composio toolkit)
  key       text not null,               -- binding key, e.g. 'channel'
  value     text not null,               -- the resolved id
  label     text not null default '',    -- human label for the console
  primary key (owner_id, slug, key)
);

comment on table public.owner_bindings is
  'Per-owner opaque resource ids (Slack channel, Tasks list, …) chosen once via the console. Read by the connections `run` action to fill tool args.';

alter table public.owner_bindings enable row level security;
