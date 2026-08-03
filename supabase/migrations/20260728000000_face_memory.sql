-- People Memory: faces, and the vectors that identify them.
--
-- Two tables rather than one because a person is not a single photograph. Each
-- enrolment adds another embedding — a different angle, different light — and a
-- lookup scores against whichever of them is closest. Averaging them into one
-- row would blur a profile view into a frontal one and match neither well.
--
-- Similarity search is pgvector's, not ours: embeddings arrive L2-normalised
-- from the Edge Function, so cosine distance `<=>` is a dot product and
-- `1 - distance` is the similarity the app talks in.

create extension if not exists vector;

/* -------------------------------------------------------------------------- */
/* tables                                                                     */
/* -------------------------------------------------------------------------- */

create table if not exists public.people (
  id           uuid primary key default gen_random_uuid(),

  -- Which wearer these memories belong to. One project can back several pairs
  -- of glasses, and nobody should ever match against someone else's people.
  owner_id     text not null,

  name         text not null,
  note         text not null default '',

  -- Calendar address, when the name resolves to someone in the attendee
  -- directory. This is the join that lets a recognised face be reported
  -- alongside the meeting you are both in.
  email        text not null default '',

  -- 32x32 luminance, base64. Not a photograph: the glasses have no image
  -- decoder, so the only thing they can draw is raw greyscale bytes.
  thumb        text not null default '',

  seen_count   integer not null default 1,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table if not exists public.face_embeddings (
  id         uuid primary key default gen_random_uuid(),
  person_id  uuid not null references public.people(id) on delete cascade,
  owner_id   text not null,

  -- 128 dimensions, from SFace. Changing the model invalidates every stored
  -- vector, so treat this width as part of the schema.
  embedding  vector(128) not null,

  created_at timestamptz not null default now()
);

create index if not exists people_owner_idx
  on public.people (owner_id, last_seen_at desc);

create index if not exists face_embeddings_owner_idx
  on public.face_embeddings (owner_id);

-- HNSW over cosine distance. At personal scale a sequential scan would do, but
-- the index costs nothing to carry and means the query plan does not change
-- character as the table grows.
create index if not exists face_embeddings_vector_idx
  on public.face_embeddings using hnsw (embedding vector_cosine_ops);

/* -------------------------------------------------------------------------- */
/* matching                                                                   */
/* -------------------------------------------------------------------------- */

-- Best match for a freshly captured face.
--
-- Ordering by distance and taking one row per person via DISTINCT ON gives each
-- person their *closest* enrolment, which is exactly the max-over-samples rule
-- the thresholds were calibrated against.
create or replace function public.match_face(
  query_embedding vector(128),
  owner           text,
  match_threshold double precision default 0.38,
  match_count     integer default 3
)
returns table (
  person_id  uuid,
  name       text,
  note       text,
  email      text,
  thumb      text,
  seen_count integer,
  score      double precision
)
language sql
stable
security definer
set search_path = public
as $$
  select *
  from (
    select distinct on (p.id)
      p.id,
      p.name,
      p.note,
      p.email,
      p.thumb,
      p.seen_count,
      1 - (e.embedding <=> query_embedding) as score
    from public.face_embeddings e
    join public.people p on p.id = e.person_id
    where e.owner_id = owner
    order by p.id, e.embedding <=> query_embedding
  ) ranked
  where ranked.score >= match_threshold
  order by ranked.score desc
  limit match_count;
$$;

-- Seeing someone again is not the same as enrolling them: it updates the
-- counters without adding another vector.
create or replace function public.touch_person(person uuid, owner text)
returns void
language sql
volatile
security definer
set search_path = public
as $$
  update public.people
  set seen_count = seen_count + 1,
      last_seen_at = now()
  where id = person and owner_id = owner;
$$;

/* -------------------------------------------------------------------------- */
/* access                                                                     */
/* -------------------------------------------------------------------------- */

-- Face embeddings are biometric data. Everything goes through the Edge
-- Functions on the service role key; RLS with no policies means anon and
-- authenticated clients — including anyone who reads the anon key out of the
-- .aix bundle — can read and write nothing directly.
alter table public.people enable row level security;
alter table public.face_embeddings enable row level security;

revoke all on function public.match_face(vector, text, double precision, integer) from anon, authenticated;
revoke all on function public.touch_person(uuid, text) from anon, authenticated;

-- Private bucket for the ONNX models the Edge Functions load at cold start.
insert into storage.buckets (id, name, public)
values ('models', 'models', false)
on conflict (id) do nothing;
