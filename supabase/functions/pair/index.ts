/**
 * Device sign-in for the glasses (the login flow in docs/11).
 *
 *   GET  /functions/v1/pair            → the phone sign-in web page
 *   POST /functions/v1/pair            → the pairing handshake, by `action`:
 *     { action: 'start' }              (glasses)  begin a pairing, get a code
 *     { action: 'poll', device_code }  (glasses)  has the phone approved yet?
 *     { action: 'claim', device_code } (glasses)  exchange an approved session for a token
 *     { action: 'approve', user_code } (phone)    the signed-in wearer approves; needs their token
 *     { action: 'check' } + Bearer token (glasses) is a stored token still valid?
 *
 * It is a device-authorization flow (the smart-TV pattern): the constrained
 * device shows a code, the login finishes in a browser on a second screen, and
 * the device polls until it can pick up a token. Codes and tokens are stored only
 * as sha256 hashes; the raw token is returned to the glasses exactly once.
 */

import { CORS, failure, json, preflight, serviceClient, sha256Hex } from '../_shared/http.ts';
import { verifyPage } from './page.ts';

/** How long a pairing code is good for, and how often the glasses should poll. */
const TTL_SECONDS = 10 * 60;
const POLL_INTERVAL_SECONDS = 3;

/**
 * Easy, phonetically distinct words — friendly to read off a HUD, to type, and
 * to say out loud. Kept short and unambiguous on purpose.
 */
const WORDS = [
  'amber', 'anchor', 'apple', 'arrow', 'basil', 'bison', 'brave', 'cedar',
  'cobalt', 'comet', 'coral', 'cosmos', 'delta', 'ember', 'falcon', 'fern',
  'garnet', 'ginger', 'harbor', 'hazel', 'indigo', 'ivory', 'jade', 'kiwi',
  'lemon', 'lilac', 'lotus', 'maple', 'meadow', 'mint', 'nectar', 'ocean',
  'olive', 'onyx', 'opal', 'otter', 'pepper', 'pine', 'quartz', 'raven',
  'river', 'saffron', 'sage', 'slate', 'tiger', 'topaz', 'umber', 'violet',
  'walnut', 'willow', 'yarrow', 'zephyr',
];

function pick(arr: string[]): string {
  const a = new Uint8Array(1);
  crypto.getRandomValues(a);
  return arr[a[0] % arr.length];
}

function twoWords(): string {
  return pick(WORDS) + '-' + pick(WORDS);
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

Deno.serve(async (req) => {
  const early = preflight(req);
  if (early) return early;

  const url = new URL(req.url);

  // The phone opens this page in a browser.
  if (req.method === 'GET') {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
    const anon = Deno.env.get('SUPABASE_ANON_KEY') || Deno.env.get('ANON_KEY') || '';
    const html = verifyPage(supabaseUrl, anon, url.searchParams.get('code') || '');
    return new Response(html, { headers: { ...CORS, 'content-type': 'text/html; charset=utf-8' } });
  }

  if (req.method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405);

  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = String(body.action || '');
    const supabase = serviceClient();

    /* ── start: the glasses begin a pairing ────────────────────────────── */
    if (action === 'start') {
      const expires_at = new Date(Date.now() + TTL_SECONDS * 1000).toISOString();
      const verification_url = Deno.env.get('PAIR_VERIFY_URL') ||
        (Deno.env.get('SUPABASE_URL') || '') + '/functions/v1/pair';

      // Retry on the tiny chance of a user_code collision.
      for (let attempt = 0; attempt < 5; attempt++) {
        const device_code = randomToken();
        const user_code = twoWords() + '-' + twoDigits();
        const { error } = await supabase.from('pairing_sessions').insert({
          device_hash: await sha256Hex(device_code),
          user_code,
          confirm_word: twoWords(),
          status: 'pending',
          expires_at,
        });
        if (!error) {
          return json({
            ok: true,
            device_code,
            user_code,
            verification_url,
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
        .select('status, owner_id, expires_at')
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
      const { error: devErr } = await supabase.from('devices').insert({
        owner_id: session.owner_id,
        token_hash: await sha256Hex(token),
        label: 'Rokid Glasses',
      });
      if (devErr) throw devErr;

      const { error: updErr } = await supabase
        .from('pairing_sessions')
        .update({ status: 'claimed' })
        .eq('device_hash', device_hash);
      if (updErr) throw updErr;

      return json({ ok: true, status: 'claimed', token, owner_id: session.owner_id });
    }

    /* ── approve: the signed-in wearer approves, from the phone ─────────── */
    if (action === 'approve') {
      const jwt = bearer(req);
      if (!jwt) return json({ ok: false, error: 'sign in first' }, 401);
      const { data: auth, error: authErr } = await supabase.auth.getUser(jwt);
      if (authErr || !auth?.user) return json({ ok: false, error: 'sign in first' }, 401);

      const user_code = String(body.user_code || '').trim().toLowerCase();
      if (!user_code) return json({ ok: false, error: 'enter the code from your glasses' }, 400);

      const { data: session } = await supabase
        .from('pairing_sessions')
        .select('id, status, confirm_word, expires_at')
        .eq('user_code', user_code)
        .maybeSingle();

      if (!session || new Date(session.expires_at).getTime() < Date.now()) {
        return json({ ok: false, error: 'that code has expired — start again on your glasses' }, 410);
      }
      if (session.status === 'claimed') {
        return json({ ok: false, error: 'those glasses are already signed in' }, 409);
      }

      const { error: updErr } = await supabase
        .from('pairing_sessions')
        .update({ status: 'approved', owner_id: auth.user.id })
        .eq('id', session.id);
      if (updErr) throw updErr;

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
