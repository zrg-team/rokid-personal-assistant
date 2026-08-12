/**
 * Device sign-in for the glasses (the login flow in docs/11).
 *
 *   GET  /functions/v1/pair            → the phone sign-in web page
 *   POST /functions/v1/pair            → the pairing handshake, by `action`:
 *     { action: 'start', device_uid? } (glasses)  begin a pairing, get a code
 *     { action: 'poll', device_code }  (glasses)  has the phone approved yet?
 *     { action: 'claim', device_code } (glasses)  exchange an approved session for a token
 *     { action: 'approve', user_code } (phone)    the signed-in wearer approves; needs their token
 *     { action: 'check' } + Bearer token (glasses) is a stored token still valid?
 *
 * It is a device-authorization flow (the smart-TV pattern): the constrained
 * device shows a code, the login finishes in a browser on a second screen, and
 * the device polls until it can pick up a token. Codes and tokens are stored only
 * as sha256 hashes; the raw token is returned to the glasses exactly once.
 *
 * The device is also the tenant. `start` accepts the `device_uid` these glasses
 * were issued the first time they paired and resolves it to the owner they
 * already have, so a second sign-in keeps the wearer's people memory rather than
 * opening an empty one. Revoking a device breaks that link deliberately: the
 * lookup ignores revoked rows, so lost glasses cannot pair back into the tenant
 * they were cut from. See the migration in 20260807000000_device_tenancy.sql.
 */

import { CORS, failure, json, preflight, serviceClient, sha256Hex } from '../_shared/http.ts';
import { callerPrefix, LimitError, rateLimit } from '../_shared/limits.ts';
import * as composio from '../_shared/composio.ts';

/** How long a pairing code is good for, and how often the glasses should poll. */
const TTL_SECONDS = 10 * 60;
const POLL_INTERVAL_SECONDS = 3;

/**
 * Easy, phonetically distinct words — friendly to read off a HUD, to type, and
 * to say out loud. Kept short and unambiguous on purpose.
 */
/**
 * The pairing-code vocabulary.
 *
 * A code is `<word>-<word>-<NN>`, read off the heads-up display and typed on a
 * phone, so every word is 4–8 lowercase ASCII characters, common, and
 * unambiguous to spell from seeing it. The list is vetted for four failures that
 * a shorter list hid:
 *
 *  - no homophones or near-homophones (a wearer may read the code aloud);
 *  - no collision after `fold()` (lowercase, strip Vietnamese tone marks, đ→d) —
 *    Vietnamese is a first-class input language, and a word that folds onto a
 *    command syllable would misroute (the live `thu` ≈ `thứ`/`thư` bug is exactly
 *    this class);
 *  - no collision with the command grammar (start, sync, status, halo, …);
 *  - no offensive or alarming two-word PAIR — any two entries can appear
 *    together, and that combination can end up in a screenshot.
 *
 * 128 words → 128 × 128 × 100 = 1,638,400 codes (6× the previous 52-word list).
 * 128 divides 256, so the `% length` in `pick()` is unbiased. Grow only by a
 * further vetted round; do NOT reinstate anything that was cut, and if the count
 * ever stops dividing 256, `pick()` must move to rejection sampling.
 *
 * This is one factor of a human confused-deputy check (docs/17 §6), not a secret
 * on its own — but it is also a bearer credential in the connection flow, so it
 * still needs a rate limit alongside the larger keyspace.
 */
const WORDS = [
  'acorn', 'anchor', 'apple', 'apricot', 'arrow', 'barnacle', 'basil', 'bison',
  'breeze', 'bundle', 'burlap', 'canyon', 'cashew', 'cedar', 'ceramic', 'charcoal',
  'circle', 'clarinet', 'clay', 'cloud', 'cobalt', 'coffee', 'comet', 'compass',
  'cosmos', 'crane', 'denim', 'dolphin', 'drizzle', 'drum', 'eagle', 'eclipse',
  'ember', 'emerald', 'eraser', 'fabric', 'falcon', 'fern', 'finch', 'flamingo',
  'flannel', 'foam', 'folder', 'frost', 'garlic', 'garnet', 'glacier', 'glow',
  'guava', 'harbor', 'hazel', 'helix', 'hexagon', 'hillside', 'indigo', 'jade',
  'journal', 'kayak', 'kiwi', 'ladder', 'lamp', 'lantern', 'laurel', 'lemon',
  'lilac', 'lotus', 'marble', 'marigold', 'meadow', 'mint', 'mirror', 'monsoon',
  'nebula', 'nectar', 'ocean', 'octave', 'olive', 'onyx', 'orbit', 'orchid',
  'osprey', 'otter', 'paprika', 'parsley', 'pebble', 'pelican', 'pepper', 'piano',
  'planet', 'platinum', 'primrose', 'pumpkin', 'puzzle', 'quail', 'quartz', 'raven',
  'ribbon', 'ridge', 'saffron', 'sandbar', 'sapling', 'sardine', 'saucer', 'season',
  'silver', 'slate', 'spark', 'spatula', 'spruce', 'square', 'sunbeam', 'sunset',
  'teacup', 'textile', 'thimble', 'tiger', 'topaz', 'toucan', 'tulip', 'valley',
  'violet', 'voyage', 'walnut', 'wheel', 'willow', 'wool', 'zenith', 'zephyr',
];

/** A uniform index into `arr`, unbiased as long as `arr.length` divides 256. */
function pick(arr: string[]): string {
  const a = new Uint8Array(1);
  crypto.getRandomValues(a);
  return arr[a[0] % arr.length];
}

/**
 * Two distinct words. Distinct on purpose: `pepper-pepper-04` reads as a bug the
 * wearer distrusts, and dropping the ~1/128 doubles costs nothing.
 */
function twoWords(): string {
  const first = pick(WORDS);
  let second = pick(WORDS);
  while (second === first) second = pick(WORDS);
  return first + '-' + second;
}

function twoDigits(): string {
  const a = new Uint8Array(1);
  crypto.getRandomValues(a);
  return String(a[0] % 100).padStart(2, '0');
}

function randomToken(bytes = 24): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function bearer(req: Request): string {
  const h = req.headers.get('authorization') || '';
  return h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : '';
}

/**
 * Plain-text response. The functions domain refuses to render `text/html` (it
 * forces `text/plain` + `nosniff` as an anti-abuse measure), so the phone side
 * never tries to be a web page — it is a redirect to Google's real consent screen
 * and, at the end, a one-line message. Both are genuinely plain text.
 */
function text(body: string, status = 200): Response {
  return new Response(body, { status, headers: { ...CORS, 'content-type': 'text/plain; charset=utf-8' } });
}

/** Where the phone-facing links live (overridable if fronted by a domain). */
function pageBase(): string {
  return Deno.env.get('PAIR_VERIFY_URL') || (Deno.env.get('SUPABASE_URL') || '') + '/functions/v1/pair';
}
/** The hosted connections page (docs/16), or '' to fall back to the ?go redirect. */
function connectPage(): string {
  return Deno.env.get('CONNECT_PAGE_URL') || '';
}
function withParam(base: string, kv: string): string {
  return base + (base.indexOf('?') === -1 ? '?' : '&') + kv;
}

Deno.serve(async (req) => {
  const early = preflight(req);
  if (early) return early;

  const url = new URL(req.url);

  // The wearer opens a link on their phone. There is no page to host: the only
  // rich screen is Composio's own Google consent, so these routes just redirect
  // to it and, on the way back, confirm in one plain line.
  if (req.method === 'GET') {
    const supabase = serviceClient();

    // ?go=CODE — begin the Google connection: mint a fresh Composio OAuth URL for
    // this pairing's owner and bounce the phone straight to Google's consent.
    const go = (url.searchParams.get('go') || '').trim().toLowerCase();
    if (go) {
      try {
        const { data: session } = await supabase
          .from('pairing_sessions')
          .select('owner_id, status, expires_at')
          .eq('user_code', go)
          .maybeSingle();
        if (!session || !session.owner_id || session.status === 'claimed' ||
            new Date(session.expires_at).getTime() < Date.now()) {
          return text('That sign-in link has expired. Start again on your glasses.', 410);
        }
        const authConfig = await composio.authConfigId('googlecalendar');
        if (!authConfig) return text('Sign-in is not configured on the server.', 503);
        const back = withParam(pageBase(), 'done=1&code=' + encodeURIComponent(go));
        const linked = await composio.link(authConfig, session.owner_id as string, back);
        if (!linked.ok || !linked.url) return text('Could not start Google sign-in. Try again.', 502);
        return new Response(null, { status: 302, headers: { ...CORS, Location: linked.url } });
      } catch (error) {
        return text('Something went wrong starting sign-in. Try again.', 500);
      }
    }

    // ?done=1&code=CODE — Composio returns the wearer here after Google consent.
    // Confirm the connection really landed, approve the pairing, and send them
    // back to their glasses.
    if (url.searchParams.get('done')) {
      try {
        const code = (url.searchParams.get('code') || '').trim().toLowerCase();
        const { data: session } = await supabase
          .from('pairing_sessions')
          .select('id, owner_id, status, confirm_word, expires_at')
          .eq('user_code', code)
          .maybeSingle();
        if (!session || !session.owner_id) {
          return text('That sign-in could not be matched. Start again on your glasses.', 410);
        }
        if (session.status === 'claimed') {
          return text('Those glasses are already signed in — you can close this.', 200);
        }
        // Composio can lag a beat between the redirect and the connection showing
        // active, so poll briefly rather than trusting the redirect alone.
        let connected = false;
        for (let i = 0; i < 5; i++) {
          const st = await composio.status(session.owner_id as string, 'googlecalendar');
          if (st.connected) { connected = true; break; }
          await new Promise((r) => setTimeout(r, 1200));
        }
        if (!connected) {
          return text('Google is still finishing up. Give it a moment, then reopen the link from your glasses.', 409);
        }
        if (session.status !== 'approved') {
          await supabase.from('pairing_sessions').update({ status: 'approved' }).eq('id', session.id);
        }
        return text('Signed in! Return to your glasses. If they show the word "' +
          session.confirm_word + '", press the temple to finish.', 200);
      } catch (error) {
        return text('Something went wrong finishing sign-in. Try the link again.', 500);
      }
    }

    return text('Open the sign-in link shown on your glasses to continue.', 200);
  }

  if (req.method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405);

  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = String(body.action || '');
    const supabase = serviceClient();

    // Throttle the two actions that mint or probe a code. `approve` is the
    // enumeration oracle (a valid code flips a session to approved), and `start`
    // mints codes; both are keyed on the caller's IP prefix so one address cannot
    // sweep the keyspace. `poll`/`claim`/`check` present a device_code/token the
    // attacker does not have, so they are not the sweep surface.
    if (action === 'start' || action === 'approve') {
      await rateLimit('pair.' + action + ':' + callerPrefix(req), 12, 60);
    }

    /* ── start: the glasses begin a pairing ────────────────────────────── */
    if (action === 'start') {
      const expires_at = new Date(Date.now() + TTL_SECONDS * 1000).toISOString();
      const verification_url = Deno.env.get('PAIR_VERIFY_URL') ||
        (Deno.env.get('SUPABASE_URL') || '') + '/functions/v1/pair';

      // The device IS the identity. Glasses that have paired before send back the
      // secret we issued them the first time; it resolves to the owner they
      // already have, so signing in again keeps their people, faces and notes
      // instead of stranding them under a fresh id. A device we have never seen
      // (or one whose last pairing was revoked) gets a new secret and a new
      // owner, which is exactly what revoking is supposed to achieve.
      const sent_uid = String(body.device_uid || '').trim();
      const device_uid = sent_uid || randomToken(24);
      const device_uid_hash = await sha256Hex(device_uid);

      let owner_id = '';
      if (sent_uid) {
        const { data: known } = await supabase.rpc('owner_for_device_uid', {
          p_uid_hash: device_uid_hash,
        });
        if (known) owner_id = known as string;
      }

      // First sight of these glasses: open a tenant for them. It has to exist
      // before the session references it, and before the phone connects anything
      // to it — the Google grant attaches to this id too.
      if (!owner_id) {
        owner_id = crypto.randomUUID();
        const { error: ownerErr } = await supabase
          .from('owners')
          .insert({ id: owner_id, label: 'Rokid Glasses' });
        if (ownerErr) throw ownerErr;
      }

      // Retry on the tiny chance of a user_code collision.
      for (let attempt = 0; attempt < 5; attempt++) {
        const device_code = randomToken();
        const user_code = twoWords() + '-' + twoDigits();
        const { error } = await supabase.from('pairing_sessions').insert({
          device_hash: await sha256Hex(device_code),
          user_code,
          confirm_word: twoWords(),
          status: 'pending',
          owner_id,
          device_uid_hash,
          expires_at,
        });
        if (!error) {
          return json({
            ok: true,
            device_code,
            // Returned every time; the glasses store it on first sign-in and send
            // it back forever after. Secret, like the token — it names a tenant.
            device_uid,
            user_code,
            verification_url,
            // The one link the wearer taps. When CONNECT_PAGE_URL is set it opens
            // the connections page (docs/16) — a list of services to authorize,
            // which also signs the glasses in. Without it, we fall back to the old
            // single-service behaviour: redirect straight to Google via ?go.
            link: connectPage()
              ? withParam(connectPage(), 'code=' + encodeURIComponent(user_code))
              : withParam(verification_url, 'go=' + encodeURIComponent(user_code)),
            expires_in: TTL_SECONDS,
            interval: POLL_INTERVAL_SECONDS,
          });
        }
      }
      return json({ ok: false, error: 'could not start a pairing, try again' }, 503);
    }

    /* ── poll: the glasses ask whether the phone has approved ───────────── */
    if (action === 'poll') {
      const device_code = String(body.device_code || '');
      if (!device_code) return json({ ok: false, error: 'device_code is required' }, 400);

      const { data: session } = await supabase
        .from('pairing_sessions')
        .select('status, confirm_word, expires_at')
        .eq('device_hash', await sha256Hex(device_code))
        .maybeSingle();

      if (!session) return json({ ok: true, status: 'expired' });
      if (session.status !== 'claimed' && new Date(session.expires_at).getTime() < Date.now()) {
        return json({ ok: true, status: 'expired' });
      }
      // Reveal the confirm word only once approved, so the glasses show it exactly
      // when the wearer needs to compare it with the phone.
      if (session.status === 'approved') {
        return json({ ok: true, status: 'approved', confirm_word: session.confirm_word });
      }
      return json({ ok: true, status: session.status });
    }

    /* ── claim: the glasses exchange an approved session for a token ────── */
    if (action === 'claim') {
      const device_code = String(body.device_code || '');
      if (!device_code) return json({ ok: false, error: 'device_code is required' }, 400);
      const device_hash = await sha256Hex(device_code);

      const { data: session } = await supabase
        .from('pairing_sessions')
        .select('status, owner_id, device_uid_hash, expires_at')
        .eq('device_hash', device_hash)
        .maybeSingle();

      if (!session || (session.status !== 'claimed' &&
          new Date(session.expires_at).getTime() < Date.now())) {
        return json({ ok: false, status: 'expired' });
      }
      if (session.status !== 'approved' || !session.owner_id) {
        return json({ ok: true, status: session.status }); // still pending
      }

      // Issue the token, record the device, and close the session.
      const token = randomToken(32);
      const token_hash = await sha256Hex(token);
      const uid_hash = (session.device_uid_hash as string) || null;

      // One live row per physical device. Glasses that are signing in again
      // rotate the token on the row they already have — inserting a second would
      // collide with devices_uid_active_idx and would leave the old token valid.
      let existing: { id: string } | null = null;
      if (uid_hash) {
        const { data } = await supabase
          .from('devices')
          .select('id')
          .eq('device_uid_hash', uid_hash)
          .eq('revoked', false)
          .maybeSingle();
        existing = data as { id: string } | null;
      }

      if (existing) {
        const { error: rotErr } = await supabase
          .from('devices')
          .update({ token_hash, owner_id: session.owner_id, last_seen_at: new Date().toISOString() })
          .eq('id', existing.id);
        if (rotErr) throw rotErr;
      } else {
        const { error: devErr } = await supabase.from('devices').insert({
          owner_id: session.owner_id,
          token_hash,
          device_uid_hash: uid_hash,
          label: 'Rokid Glasses',
        });
        if (devErr) throw devErr;
      }

      const { error: updErr } = await supabase
        .from('pairing_sessions')
        .update({ status: 'claimed' })
        .eq('device_hash', device_hash);
      if (updErr) throw updErr;

      return json({ ok: true, status: 'claimed', token, owner_id: session.owner_id });
    }

    /* ── approve: the phone finalizes the pairing ──────────────────────────
     * Opening the connections page (docs/16) with the code the glasses show IS
     * the sign-in: it gives the pairing its identity so the glasses can claim a
     * device token. Face/text memory then works immediately; external services
     * (calendar, gmail, …) are authorized on that same page, separately and
     * optionally. The confirm word the glasses display is the human check.
     */
    if (action === 'approve') {
      const user_code = String(body.user_code || '').trim().toLowerCase();
      if (!user_code) return json({ ok: false, error: 'enter the code from your glasses' }, 400);

      const { data: session } = await supabase
        .from('pairing_sessions')
        .select('id, status, confirm_word, owner_id, expires_at')
        .eq('user_code', user_code)
        .maybeSingle();

      if (!session || new Date(session.expires_at).getTime() < Date.now()) {
        return json({ ok: false, error: 'that code has expired — start again on your glasses' }, 410);
      }
      if (session.status === 'claimed') {
        return json({ ok: true, already: true, confirm_word: session.confirm_word });
      }
      if (!session.owner_id) {
        return json({ ok: false, error: 'this pairing lost its identity — start again on your glasses' }, 409);
      }

      if (session.status !== 'approved') {
        const { error: updErr } = await supabase
          .from('pairing_sessions')
          .update({ status: 'approved' })
          .eq('id', session.id);
        if (updErr) throw updErr;
      }

      return json({ ok: true, confirm_word: session.confirm_word });
    }

    /* ── check: is a stored device token still valid? ──────────────────── */
    if (action === 'check') {
      const token = bearer(req);
      if (!token) return json({ ok: false, error: 'no token' }, 401);
      const { data: owner, error } = await supabase.rpc('owner_from_device_token', {
        p_token_hash: await sha256Hex(token),
      });
      if (error) throw error;
      if (!owner) return json({ ok: false, error: 'signed out' }, 401);
      return json({ ok: true, owner_id: owner });
    }

    return json({ ok: false, error: 'unknown action' }, 400);
  } catch (error) {
    return failure(error);
  }
});
