/**
 * Request plumbing shared by the three functions.
 *
 * The glasses post JSON with a base64 photo, because that is the one request
 * shape proven to survive the Ink `fetch` bridge. curl and the dev harness may
 * post raw image bytes instead, which is far nicer to debug with, so both are
 * accepted.
 */

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

/** base64 → bytes, without a std/jsr dependency (atob is a Deno/Edge global). */
function decodeBase64(b64: string): Uint8Array {
  const bin = atob(String(b64).replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type, x-owner-id, x-owner-token, x-device-token, x-app-key',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
};

/**
 * The largest upload we will decode.
 *
 * The models fail an invocation's resource budget on photos over ~0.7 MP
 * (HTTP 546), and the ingress side has the same ceiling: an oversized base64
 * body is decoded — and doubled in memory — before any model runs. Reject it up
 * front instead. 8 MB of base64 is ~6 MB of JPEG, well above any real capture
 * and well below what the worker can hold.
 */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/** Thrown when a caller may not act as the wearer it named. → 403. */
export class OwnerError extends Error {}

/** Thrown when the request body is larger than we will decode. → 413. */
export class PayloadError extends Error {}

/**
 * Thrown when a caller has exceeded a rate limit or usage cap. → 429.
 *
 * Defined here rather than in limits.ts so `failure()` can recognise it without
 * importing limits.ts (which imports this file — a cycle). limits.ts re-exports it.
 */
export class LimitError extends Error {
  retryAfter: number;
  constructor(message: string, retryAfter = 60) {
    super(message);
    this.retryAfter = retryAfter;
  }
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'content-type': 'application/json; charset=utf-8' },
  });
}

export function preflight(req: Request): Response | null {
  return req.method === 'OPTIONS' ? new Response('ok', { headers: CORS }) : null;
}

/** App-key values currently accepted (comma-separated env); empty ⇒ gate off. */
function appKeys(): string[] {
  return (Deno.env.get('APP_KEY_VALUES') || '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** Browser origins allowed (comma-separated env); empty ⇒ gate off. */
function allowedOrigins(): string[] {
  return (Deno.env.get('ALLOWED_ORIGINS') || '').split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * A thin, env-gated front gate: an app-identity key and a browser-origin check.
 *
 * This sits IN FRONT of the real controls (the per-wearer device token, RLS with
 * no policies, the per-IP rate limits) and is defense-in-depth — never a
 * replacement. Neither signal is a secret: the app key ships inside the .aix and
 * the console JS, and Origin is browser-populated and forgeable off-browser. What
 * they buy is narrow but real — dropping unkeyed scanner noise, a rotation kill-
 * switch to cut off a leaked build, and 403ing casual cross-site browser abuse.
 *
 * Both checks default OFF when their env var is unset, matching the codebase's
 * OWNER_SIGNING_SECRET / ALLOW_DEFAULT_OWNER idiom, so the server ships INERT and
 * enforcement is flipped on only after the whole fleet sends the header.
 *
 *   x-app-key   Required iff APP_KEY_VALUES is set. Accepts a SET of values, so a
 *               rotation adds the new value, soaks, then drops the old one — no
 *               in-flight build is ever cut off mid-rollout.
 *   Origin      Rejected only when PRESENT and not on ALLOWED_ORIGINS. A MISSING
 *               Origin ALWAYS passes: the glasses (Ink) and curl send none, and
 *               treating absent-as-failure would 403 the entire fleet at once.
 *
 * `opts` lets a route skip a check it structurally cannot satisfy — pair's GET
 * routes (?go navigation, ?done OAuth redirect) cannot carry a custom header, so
 * they run with `{ appKey: false }`.
 *
 * Returns a Response to short-circuit, or null to proceed.
 */
export function guard(req: Request, opts: { appKey?: boolean; origin?: boolean } = {}): Response | null {
  if (opts.appKey !== false) {
    const keys = appKeys();
    if (keys.length) {
      const sent = req.headers.get('x-app-key') || '';
      // Constant-time membership: safeEqual already length-checks, so a wrong key
      // cannot be guessed byte by byte from response timing.
      if (!keys.some((k) => safeEqual(k, sent))) {
        return json({ ok: false, error: 'unrecognized client' }, 401);
      }
    }
  }
  if (opts.origin !== false) {
    const allow = allowedOrigins();
    if (allow.length) {
      const origin = req.headers.get('origin');
      if (origin && !allow.includes(origin)) {
        return json({ ok: false, error: 'origin not allowed' }, 403);
      }
    }
  }
  return null;
}

/**
 * The service-role client.
 *
 * Every table is behind RLS with no policies, so this key is the only way in —
 * which is deliberate. It never leaves the function: the glasses authenticate
 * with the anon key, and the function decides what they may touch.
 */
export function serviceClient(): SupabaseClient {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );
}

/** sha256 as lowercase hex — used to store codes and tokens as hashes, never raw. */
export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time string compare, so a bad token cannot be guessed byte by byte. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Which wearer is asking — verified, not merely claimed.
 *
 * The wearer id used to be taken straight from the `x-owner-id` header. But the
 * anon key ships inside the `.aix` and anyone can unzip it, so a plain header
 * let any holder of that key read or delete another wearer's face memory just by
 * naming their id. That is biometric data belonging to third parties, so the
 * header alone is not enough.
 *
 * The primary path is the wearer's **device token** from sign-in: when present
 * (`x-device-token`), it is resolved to that wearer's account, so each signed-in
 * wearer's faces and people are their own. This is what makes the app safe for
 * many users — biometric memory is scoped per person, not shared.
 *
 * When there is no device token, two fallbacks apply, chosen by whether
 * `OWNER_SIGNING_SECRET` is configured:
 *
 *   unset  — single-wearer deployment. Only the `default` bucket is reachable;
 *            any other id is refused. Nothing to configure, nothing to leak.
 *   set    — the caller must present `x-owner-token`, an HMAC of the owner id
 *            under the secret. The secret never ships to a device.
 */
export async function resolveOwner(req: Request, body: Record<string, unknown> = {}): Promise<string> {
  // Signed-in wearer: their device token maps to their own account.
  const deviceToken = req.headers.get('x-device-token') || String(body.device_token || '');
  if (deviceToken) {
    const { data } = await serviceClient().rpc('owner_from_device_token', {
      p_token_hash: await sha256Hex(deviceToken),
    });
    if (data) return data as string;

    // A token that resolves to nothing has been revoked or has expired, and that
    // is an answer, not an absence. Falling through used to hand these callers
    // the shared `default` bucket — so revoking a lost pair of glasses stopped
    // them reading the wearer's memories but still let them read and write the
    // unsigned one. Presenting a credential we reject is a 401.
    throw new OwnerError('this device is signed out — sign in again');
  }

  const requested = String(req.headers.get('x-owner-id') || body.owner_id || 'default').slice(0, 64);
  const secret = Deno.env.get('OWNER_SIGNING_SECRET') || '';

  if (!secret) {
    if (requested !== 'default') {
      throw new OwnerError('multi-wearer access requires OWNER_SIGNING_SECRET to be configured');
    }

    // The `default` bucket is now opt-in, and this is a security fix, not a
    // tidy-up.
    //
    // These functions run with `verify_jwt = false` — they have to, because the
    // glasses present an anon key rather than a user JWT. That means the gateway
    // performs no authentication at all, and every credential check is the one
    // below. Returning `default` to a caller who presented nothing therefore
    // handed the entire unsigned-in tenant to the open internet: a bare
    // `curl https://<project>.functions.supabase.co/face-people` answered 200
    // with names, notes, e-mail addresses and base64 face crops, and the same
    // path reached POST (rewrite any record) and DELETE (remove a person).
    //
    // The people in that table are third parties. They did not consent to being
    // in it, and they cannot be asked to accept the risk of it being public.
    //
    // A genuine single-wearer deployment that really does want an unauthenticated
    // shared bucket can set ALLOW_DEFAULT_OWNER=1. It is deliberately an explicit
    // choice rather than the default, because the failure mode is silent: nothing
    // errors, nothing logs, and the data is simply readable by anyone who knows
    // the project URL.
    if (Deno.env.get('ALLOW_DEFAULT_OWNER') !== '1') {
      throw new OwnerError('sign in on the glasses first — say “Kavi start”');
    }
    return 'default';
  }

  const token = String(req.headers.get('x-owner-token') || body.owner_token || '');
  const expected = await hmacHex(secret, requested);
  if (!token || !safeEqual(token, expected)) {
    throw new OwnerError('a valid owner token is required for this wearer');
  }

  // Every memory table is keyed to `owners` by a foreign key now, and this is the
  // one path that can name a tenant nobody created: the device-token path gets
  // its row from `pair.start`, and `default` is seeded by the migration, but an
  // HMAC deployment mints ids out of thin air. Open the tenant on first sight
  // rather than letting the wearer's first enrolment fail on the constraint.
  await serviceClient()
    .from('owners')
    .upsert({ id: requested, label: 'hmac' }, { onConflict: 'id', ignoreDuplicates: true });

  return requested;
}

export interface ParsedRequest {
  body: Record<string, unknown>;
  image: Uint8Array | null;
}

export async function parseRequest(req: Request): Promise<ParsedRequest> {
  const type = req.headers.get('content-type') || '';

  // Cheap first line of defence: refuse before reading the body when the
  // declared length is already over the ceiling.
  const declared = Number(req.headers.get('content-length') || 0);
  if (declared && declared > MAX_UPLOAD_BYTES * 2) {
    throw new PayloadError('image is too large');
  }

  if (type.includes('application/json')) {
    const body = (await req.json()) as Record<string, unknown>;
    if (body.image && String(body.image).length > MAX_UPLOAD_BYTES * 2) {
      throw new PayloadError('image is too large');
    }
    const image = body.image ? decodeBase64(String(body.image)) : null;
    // Drop the base64 as soon as it has been decoded. It is a third larger than
    // the photo itself and would otherwise stay reachable through `body` for
    // the whole request, on top of the decoded pixels — and memory is the
    // binding constraint here, not bandwidth.
    delete body.image;
    if (image && image.length > MAX_UPLOAD_BYTES) throw new PayloadError('image is too large');
    return { body, image };
  }

  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.length > MAX_UPLOAD_BYTES) throw new PayloadError('image is too large');
  return { body: {}, image: bytes.length ? bytes : null };
}

/**
 * Turn a thrown value into a response.
 *
 * Authorization and payload problems are the caller's to fix and carry their
 * own safe message. Anything else is logged server-side but returned as a
 * generic sentence: an internal stack trace or Postgres detail must never be
 * read out loud to someone wearing glasses, nor handed to an untrusted client.
 */
export function failure(error: unknown): Response {
  if (error instanceof OwnerError) {
    return json({ ok: false, error: error.message, title: 'Not your memory', lines: [], spoken: 'That is not something I can do for you.' }, 403);
  }
  if (error instanceof PayloadError) {
    return json({ ok: false, error: error.message, title: 'Photo too large', lines: [], spoken: 'That photo was too large to send.' }, 413);
  }
  if (error instanceof LimitError) {
    return new Response(
      JSON.stringify({ ok: false, error: error.message, title: 'Too many tries', lines: [], spoken: 'Give it a moment and try again.' }),
      { status: 429, headers: { ...CORS, 'content-type': 'application/json; charset=utf-8', 'retry-after': String(error.retryAfter) } },
    );
  }
  console.error(String((error as Error)?.message ?? error));
  return json({ ok: false, error: 'internal error', title: 'Something went wrong', lines: [], spoken: 'Sorry, that did not work.' }, 500);
}
