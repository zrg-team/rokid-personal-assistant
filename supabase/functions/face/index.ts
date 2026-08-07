/**
 * POST /functions/v1/face — everything that needs a model.
 *
 *   { mode: 'identify' }            who is this?
 *   { mode: 'remember', name }      enrol them
 *   { warmup: true }                load the models and return, doing no work
 *
 * ## Why one function and not two
 *
 * Each deployed function gets its own instances, and each instance pays its own
 * cold start: ~11 MB of WebAssembly runtime plus ~10 MB of models. Identify and
 * enrol were separate at first, which meant the common flow — ask who someone
 * is, get "I don't know them", say their name — paid that cost *twice*, and the
 * second one reliably came back 546 (worker limit) because loading and
 * inferring inside a single request exceeds what one invocation is allowed.
 *
 * Sharing one function means the enrol step lands on the instance the identify
 * call already warmed.
 *
 * ## Why warmup exists
 *
 * Even merged, the very first capture on a fresh instance can exceed the limit,
 * because loading and inference happen in the same request. The glasses call
 * `warmup` when the page opens, so the models are in memory by the time the
 * wearer has aimed and pressed. The client also retries once on 546, which
 * lands on the instance the failed call just warmed.
 */

import { analyze, loadModels, timings } from '../_shared/pipeline.ts';
import { decodeImage } from '../_shared/image.ts';
import { CONFIDENT, TENTATIVE } from '../_shared/sface.ts';
import { makeThumb, THUMB_SIZE } from '../_shared/thumb.ts';
import { greenPngDataUri } from '../_shared/png.ts';
/** base64 → bytes, without a jsr dependency (atob is a Deno/Edge global). */
function decodeBase64(b64: string): Uint8Array {
  const bin = atob(String(b64));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
import {
  enrolledCard, matchCard, noFaceCard, unknownCard,
  type AgendaRow, type PersonRow,
} from '../_shared/card.ts';
import { failure, json, parseRequest, preflight, resolveOwner, serviceClient } from '../_shared/http.ts';

/** Enrolment samples kept per person; past this the oldest is dropped. */
const MAX_EMBEDDINGS = 6;

/** Ceilings on stored free text, so a bad caller cannot bloat a row. */
const MAX_NAME = 120;
const MAX_NOTE = 500;
const MAX_EMAIL = 200;
const cap = (value: unknown, max: number) => String(value ?? '').slice(0, max);

/**
 * The card shows the thumbnail at 64px, and the canvas is not an option — the
 * Ink web host renders nothing into one — so it ships as a PNG the page can
 * point an `<image>` at. Stored as luminance, encoded per response, so the
 * database stays small and the wire format can change without a migration.
 */
const THUMB_SCALE = 2;

/**
 * How long a capture stays usable for a follow-up enrolment.
 *
 * Long enough to say a name after hearing "I do not know them yet", short
 * enough that "remember her as Tracy" an hour later cannot silently attach a
 * name to whoever you were looking at before lunch.
 */
const RECENT_CAPTURE_MS = 5 * 60 * 1000;

function thumbPng(luminance: string): Promise<string> {
  return greenPngDataUri(decodeBase64(luminance), THUMB_SIZE, THUMB_SCALE);
}

Deno.serve(async (req) => {
  const early = preflight(req);
  if (early) return early;

  try {
    const { body, image } = await parseRequest(req);

    /* ── warm the instance ─────────────────────────────────────────────── */
    if (body.warmup) {
      const started = Date.now();
      // Always answer, even if loading is still running: a wall-clock timeout
      // would otherwise swallow the evidence of where cold start went.
      const outcome = await Promise.race([
        loadModels().then(() => 'ready').catch((e) => 'failed: ' + (e?.message ?? e)),
        new Promise((resolve) => setTimeout(() => resolve('still loading'), 100_000)),
      ]);
      return json({ ok: true, outcome, elapsed: Date.now() - started, timings });
    }

    // A photo is required to identify someone, but not to enrol: "remember her
    // as Tracy" may arrive on its own, right after "who is this".
    if ((!image || image.length < 128) && body.mode !== 'remember') {
      return json({ ok: false, error: 'no photo in the request' }, 400);
    }

    const enrolling = body.mode === 'remember';
    const owner = await resolveOwner(req, body);
    const supabase = serviceClient();

    // Decode and stop. Used to tell apart "the decoder is too expensive" from
    // "decode plus inference together is too expensive" — the two have
    // completely different fixes and the runtime just says RESOURCE_LIMIT.
    //
    // Behind resolveOwner deliberately. It used to run first, which made a full
    // image decode reachable by anyone holding the anon key — and that key ships
    // inside the .aix for anyone to unzip. It also read `image` on a path where
    // the guard above allows null (`mode: 'remember'` with no photo), so a
    // request that mixed the two crashed the function outright.
    if (body.decodeOnly) {
      if (!image) return json({ ok: false, error: 'no photo in the request' }, 400);
      const t0 = Date.now();
      const decoded = decodeImage(image);
      return json({
        ok: true, width: decoded.width, height: decoded.height,
        bytes: image.length, decodeMs: Date.now() - t0,
      });
    }

    let face: { embedding: number[]; crop: Parameters<typeof makeThumb>[0] } | null = null;
    let thumbLuma = '';

    if (image) {
      const { faces } = await analyze(image, { maxFaces: enrolling ? 1 : 4 });
      if (faces.length) {
        face = faces[0];
        thumbLuma = makeThumb(faces[0].crop);
      }
      if (!face && !enrolling) {
        return json({ ok: false, reason: 'no-face', ...noFaceCard() });
      }
    }

    // No usable photo and we are enrolling: use the face the wearer was just
    // looking at, which is the whole point of remembering it.
    let recentFaces = 1;
    if (!face && enrolling) {
      const { data: recent } = await supabase
        .from('recent_captures')
        .select('embedding, thumb, created_at')
        .eq('owner_id', owner)
        .maybeSingle();

      const fresh = recent &&
        Date.now() - new Date(recent.created_at).getTime() < RECENT_CAPTURE_MS;

      if (!fresh) {
        return json({
          ok: false, reason: 'no-face',
          title: 'Nobody to remember', subtitle: '', lines: [],
          spoken: 'I have not looked at anyone recently. Ask me who this is first.',
        });
      }

      // pgvector hands embeddings back as a string; the RPC wants an array.
      const stored = typeof recent.embedding === 'string'
        ? JSON.parse(recent.embedding)
        : recent.embedding;
      face = { embedding: stored, crop: null as never };
      thumbLuma = recent.thumb;
      recentFaces = 0;
    }

    if (!face) {
      return json({ ok: false, reason: 'no-face', ...noFaceCard() });
    }
    const faces = { length: recentFaces };

    /* ── who is this? ──────────────────────────────────────────────────── */
    if (!enrolling) {
      const { data, error } = await supabase.rpc('match_face', {
        query_embedding: face.embedding,
        owner,
        match_threshold: TENTATIVE,
        match_count: 1,
      });
      if (error) throw error;

      const hit = (data as Array<PersonRow & { person_id: string; score: number }>)?.[0];

      // Keep this face around so a spoken name can follow without a second
      // photograph. One row per wearer; the previous one is worthless now.
      await supabase.from('recent_captures').upsert({
        owner_id: owner,
        embedding: face.embedding,
        thumb: makeThumb(face.crop),
        created_at: new Date().toISOString(),
      });

      // A capture is usable for a few minutes and then it is just a biometric
      // vector sitting in a table. Sweep the expired ones on the way past so the
      // retention window is enforced in fact, not only honoured on read.
      await supabase
        .from('recent_captures')
        .delete()
        .lt('created_at', new Date(Date.now() - RECENT_CAPTURE_MS).toISOString());

      if (!hit) {
        // Send this capture's own thumbnail back: showing the wearer what the
        // camera actually saw is the fastest way to understand a miss — lens
        // covered, back of a head, someone else in shot.
        return json({
          ok: true, faces: faces.length, person: null, score: null, confident: false,
          thumb: await thumbPng(thumbLuma), ...unknownCard(),
        });
      }

      // Seeing someone is not enrolling them: counters move, no vector is added.
      await supabase.rpc('touch_person', { person: hit.person_id, owner });

      const person: PersonRow = {
        id: hit.person_id, name: hit.name, note: hit.note,
        email: hit.email, thumb: hit.thumb, seen_count: hit.seen_count,
      };
      const rows = ((body.context as { rows?: AgendaRow[] })?.rows ?? []) as AgendaRow[];
      const confident = hit.score >= CONFIDENT;

      return json({
        ok: true,
        faces: faces.length,
        person: { ...person, seenCount: hit.seen_count + 1 },
        score: Number(hit.score.toFixed(3)),
        confident,
        thumb: await thumbPng(hit.thumb || thumbLuma),
        ...matchCard(person, hit.score, confident, rows, faces.length - 1),
      });
    }

    /* ── remember them ─────────────────────────────────────────────────── */
    const name = cap(body.name, MAX_NAME).trim();
    if (!name) return json({ ok: false, error: 'a name is required to remember someone' }, 400);

    // Which record does this belong to? An explicit id wins; then a face
    // already recognised confidently in this very photo — which is what stops
    // "remember him as Kev" creating a twin of last week's Kevin; then an exact
    // name match for this owner.
    let personId = body.id ? String(body.id) : null;

    if (!personId) {
      const { data } = await supabase.rpc('match_face', {
        query_embedding: face.embedding, owner,
        match_threshold: CONFIDENT, match_count: 1,
      });
      personId = (data as Array<{ person_id: string }>)?.[0]?.person_id ?? null;
    }
    if (!personId) {
      const { data } = await supabase
        .from('people').select('id').eq('owner_id', owner).ilike('name', name).limit(1);
      personId = data?.[0]?.id ?? null;
    }

    const thumb = thumbLuma;
    let person: PersonRow;

    if (personId) {
      // Only overwrite note and email when this call carries them: "remember
      // him as Kevin" must not wipe the note dictated last week.
      const patch: Record<string, unknown> = { name, thumb, last_seen_at: new Date().toISOString() };
      if (body.note) patch.note = cap(body.note, MAX_NOTE);
      if (body.email) patch.email = cap(body.email, MAX_EMAIL);

      const { data, error } = await supabase
        .from('people').update(patch).eq('id', personId).eq('owner_id', owner)
        .select('id, name, note, email, thumb, seen_count').single();
      if (error) throw error;
      person = data as PersonRow;
    } else {
      const { data, error } = await supabase
        .from('people')
        .insert({
          owner_id: owner, name,
          note: cap(body.note, MAX_NOTE), email: cap(body.email, MAX_EMAIL), thumb,
        })
        .select('id, name, note, email, thumb, seen_count').single();
      if (error) throw error;
      person = data as PersonRow;
      personId = person.id;
    }

    const { error: embedError } = await supabase.from('face_embeddings')
      .insert({ person_id: personId, owner_id: owner, embedding: face.embedding });
    if (embedError) throw embedError;

    const { data: samples } = await supabase
      .from('face_embeddings').select('id')
      .eq('person_id', personId).order('created_at', { ascending: true });

    const total = samples?.length ?? 1;
    if (total > MAX_EMBEDDINGS) {
      const stale = samples!.slice(0, total - MAX_EMBEDDINGS).map((s) => s.id);
      await supabase.from('face_embeddings').delete().in('id', stale);
    }

    const kept = Math.min(total, MAX_EMBEDDINGS);
    return json({
      ok: true, enrolled: true,
      person: { ...person, samples: kept },
      thumb: await thumbPng(thumb),
      ...enrolledCard(person, kept),
    });
  } catch (error) {
    return failure(error);
  }
});
