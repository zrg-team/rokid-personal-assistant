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
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type, x-owner-id, x-owner-token',
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

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'content-type': 'application/json; charset=utf-8' },
  });
}

export function preflight(req: Request): Response | null {
  return req.method === 'OPTIONS' ? new Response('ok', { headers: CORS }) : null;
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
    return 'default';
  }

  const token = String(req.headers.get('x-owner-token') || body.owner_token || '');
  const expected = await hmacHex(secret, requested);
  if (!token || !safeEqual(token, expected)) {
    throw new OwnerError('a valid owner token is required for this wearer');
  }
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
  console.error(String((error as Error)?.message ?? error));
  return json({ ok: false, error: 'internal error', title: 'Something went wrong', lines: [], spoken: 'Sorry, that did not work.' }, 500);
}
