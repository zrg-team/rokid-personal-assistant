-- The send gate: outbound actions are staged, never fired on the first turn.
--
-- `outbound`-risk tools (GMAIL_SEND_EMAIL, SLACK_SEND_MESSAGE) send something to
-- someone else, and this device has no undo. The connections function refuses to
-- execute them directly; it stages a row here and returns a token. The wearer
-- confirms (a press, or a spoken "yes"), the token is redeemed, and only THEN
-- does the send run — against the args that were staged, never re-inferred.
--
-- The invariants that make a confirm safe live in the schema, not in a comment:
--   * one live pending action per owner (partial unique index) — "yes" is never
--     ambiguous about which action it confirms;
--   * atomic claim (pending → claimed in one UPDATE) — a double "yes" or a retry
--     cannot send twice;
--   * the executed result is stored, so a replayed confirm returns it rather than
--     re-running the send.

create table if not exists public.pending_actions (
  token       text primary key,
  owner_id    text not null references public.owners(id) on delete cascade,
  tool        text not null,
  args        jsonb not null default '{}'::jsonb,
  line        text not null default '',           -- the human confirm line shown on the HUD
  status      text not null default 'pending' check (status in ('pending', 'claimed')),
  result      jsonb,                               -- provider result, set on execute (idempotent replay)
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);

comment on table public.pending_actions is
  'Staged outbound actions awaiting the wearer''s confirmation. Redeemed atomically by claim_pending_action; one live pending per owner.';

alter table public.pending_actions enable row level security;

-- At most one action awaiting confirmation per owner. Staging a new one deletes
-- the old (done in the function), so "yes" always refers to the last card shown.
create unique index if not exists pending_actions_one_live_idx
  on public.pending_actions (owner_id)
  where status = 'pending';

-- The sweep predicate for expiry.
create index if not exists pending_actions_expiry_idx
  on public.pending_actions (expires_at)
  where status = 'pending';

-- Atomic redeem: flip pending → claimed for exactly this owner's token, only
-- while it is still live. Returns the row on success, nothing if the token is
-- unknown, already claimed, or expired. The single UPDATE is the whole
-- concurrency guarantee — two confirms race to it and only one wins.
create or replace function public.claim_pending_action(p_token text, p_owner text)
returns public.pending_actions
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  row public.pending_actions;
begin
  update public.pending_actions
     set status = 'claimed'
   where token = p_token
     and owner_id = p_owner
     and status = 'pending'
     and expires_at > now()
  returning * into row;

  return row;  -- null when nothing matched
end;
$$;

revoke all on function public.claim_pending_action(text, text) from anon, authenticated;

-- Drop expired, never-confirmed stagings.
create or replace function public.purge_expired_pending()
returns void
language sql
volatile
security definer
set search_path = public
as $$
  delete from public.pending_actions
  where status = 'pending' and expires_at < now();
$$;

revoke all on function public.purge_expired_pending() from anon, authenticated;
