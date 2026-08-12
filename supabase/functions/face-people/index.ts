/**
 * The management endpoint — everything that is not a capture.
 *
 *   GET    /functions/v1/face-people             who do I know?
 *   POST   /functions/v1/face-people             correct a name, note or email
 *   DELETE /functions/v1/face-people?id=…        forget someone
 *
 * Forgetting deletes the row; the embeddings go with it through the foreign
 * key's ON DELETE CASCADE. That matters more than usual here — someone asking to
 * be forgotten should leave nothing behind, including the vectors.
 */

import { failure, json, preflight, resolveOwner, serviceClient } from '../_shared/http.ts';

/** Ceilings on stored free text, matching the face function. */
const MAX_LEN: Record<string, number> = { name: 120, note: 500, email: 200 };

/** How accumulated notes read back on the card, and how they are split again. */
const NOTE_SEP = ' · ';

/**
 * Add a note to what is already known, keeping the newest when the column fills.
 *
 * `people.note` is a single 500-character column, so accumulation has a hard
 * ceiling. Whole segments are dropped from the oldest end rather than the string
 * being cut mid-word — a fragment reads as a bug, and the wearer cannot tell it
 * from something the recogniser got wrong.
 */
function mergeNotes(existing: string, addition: string): string {
  const had = String(existing || '').trim();
  const add = String(addition || '').trim();
  if (!add) return had.slice(0, MAX_LEN.note);

  const parts = had ? had.split(NOTE_SEP).filter(Boolean) : [];
  // Saying the same thing twice is a repeat, not a second fact.
  if (parts.length && parts[parts.length - 1] === add) return had.slice(0, MAX_LEN.note);

  parts.push(add);
  while (parts.length > 1 && parts.join(NOTE_SEP).length > MAX_LEN.note) parts.shift();
  return parts.join(NOTE_SEP).slice(0, MAX_LEN.note);
}

/**
 * Postgres rejects a malformed uuid with a 500 that reads like a server fault.
 *
 * A client that stringifies a missing value sends the literal "undefined",
 * which is truthy and sails past an `if (!id)` guard — that is exactly how a
 * caller bug arrived here dressed as `invalid input syntax for type uuid`.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  const early = preflight(req);
  if (early) return early;

  try {
    const url = new URL(req.url);
    const supabase = serviceClient();

    if (req.method === 'GET') {
      const owner = await resolveOwner(req);
      const { data, error } = await supabase
        .from('people')
        .select('id, name, note, email, thumb, seen_count, created_at, last_seen_at, face_embeddings(count)')
        .eq('owner_id', owner)
        .order('last_seen_at', { ascending: false });
      if (error) throw error;

      const people = (data ?? []).map((p) => ({
        id: p.id,
        name: p.name,
        note: p.note,
        email: p.email,
        thumb: p.thumb,
        seenCount: p.seen_count,
        createdAt: p.created_at,
        lastSeenAt: p.last_seen_at,
        samples: (p.face_embeddings as Array<{ count: number }>)?.[0]?.count ?? 0,
      }));

      return json({ ok: true, count: people.length, people });
    }

    if (req.method === 'DELETE') {
      const owner = await resolveOwner(req);
      const id = url.searchParams.get('id');
      if (!id || !UUID.test(id)) {
        return json({ ok: false, error: 'a valid person id is required' }, 400);
      }

      const { error, count } = await supabase
        .from('people')
        .delete({ count: 'exact' })
        .eq('id', id)
        .eq('owner_id', owner);
      if (error) throw error;

      // Forgetting must leave nothing behind. The person's enrolments cascade
      // with the row, but the last-seen scratch capture is keyed by wearer, not
      // person — so clear it too, rather than let a forgotten face's vector sit
      // there until the next capture happens to overwrite it.
      await supabase.from('recent_captures').delete().eq('owner_id', owner);

      return json({ ok: true, removed: count ?? 0 });
    }

    if (req.method === 'POST') {
      const body = await req.json() as Record<string, unknown>;
      const owner = await resolveOwner(req, body);
      const id = String(body.id || '');
      if (!UUID.test(id)) {
        return json({ ok: false, error: 'a valid person id is required' }, 400);
      }

      const patch: Record<string, unknown> = {};

      // A name or an address is a correction: the new value replaces the old.
      for (const field of ['name', 'email']) {
        if (body[field] !== undefined) patch[field] = String(body[field]).slice(0, MAX_LEN[field]);
      }

      // A note is not a correction — it is another thing the wearer learned.
      //
      // This used to replace, like the two above, so "note that we met at the
      // offsite" silently erased "note that she runs the security review":
      // data loss inside the feature the product is named for, with no warning
      // and no way to get the sentence back.
      //
      // Real history belongs in an append-only `memories` table with its own
      // retention (docs/19, Phase 4.2). Until that exists, accumulate in the
      // column we have.
      if (body.note !== undefined) {
        const addition = String(body.note).trim();
        const { data: current } = await supabase
          .from('people')
          .select('note')
          .eq('id', id)
          .eq('owner_id', owner)
          .single();
        patch.note = mergeNotes(String((current && current.note) || ''), addition);
      }
      if (!Object.keys(patch).length) {
        return json({ ok: false, error: 'nothing to change' }, 400);
      }

      const { data, error } = await supabase
        .from('people')
        .update(patch)
        .eq('id', id)
        .eq('owner_id', owner)
        .select('id, name, note, email, seen_count')
        .single();
      if (error) throw error;

      return json({ ok: true, person: data });
    }

    return json({ ok: false, error: 'method not allowed' }, 405);
  } catch (error) {
    return failure(error);
  }
});
