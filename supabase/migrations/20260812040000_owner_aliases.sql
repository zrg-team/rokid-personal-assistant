-- User-defined aliases and shortcuts, set from the console.
--
-- The primary grammar stays "Kavi <app> <action>". These are OPT-IN sugar the
-- wearer defines for themselves — words they will actually remember — validated
-- at definition time on the phone (a keyboard and a screen to explain), then
-- synced to the glasses and merged into the router's alias table.
--
--   kind='app'      phrase → slug             "mail" → gmail   (say "Kavi mail")
--   kind='shortcut' phrase → slug + action    "inbox" → gmail "newer_than:2d"

create table if not exists public.owner_aliases (
  owner_id    text not null references public.owners(id) on delete cascade,
  phrase      text not null,               -- folded, lowercase (matches utils/planner.js fold())
  kind        text not null check (kind in ('app', 'shortcut')),
  slug        text not null,
  action      text not null default '',
  created_at  timestamptz not null default now(),
  primary key (owner_id, phrase)
);

comment on table public.owner_aliases is
  'Per-owner voice aliases and shortcuts, defined in the console and synced to the glasses. phrase is stored folded so it matches the router''s folded utterance.';

alter table public.owner_aliases enable row level security;
