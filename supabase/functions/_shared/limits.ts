/**
 * Rate limiting and the per-owner cost ceiling.
 *
 * Both back onto Postgres (migration `20260812010000_rate_limit_and_usage.sql`),
 * because an Edge Function isolate is per-request and per-region — there is no
 * in-process place to keep a counter that would survive to the next call or
 * coordinate across regions.
 */

import { LimitError, serviceClient } from './http.ts';

// Re-exported so callers can `import { LimitError } from './limits.ts'` — but the
// class lives in http.ts so `failure()` there recognises it without a cycle.
export { LimitError };

/**
 * The caller's IP prefix, for rate-limit bucketing.
 *
 * Taken from the RIGHTMOST `x-forwarded-for` hop — the trusted edge proxy — not
 * the leftmost, which is client-supplied and would let a sweep mint unlimited
 * distinct buckets and never trip a limit. Widened to a /24 (v4) or /64 (v6) so
 * a single actor on a rotating address inside one prefix is still bounded.
 */
export function callerPrefix(req: Request): string {
  const xff = req.headers.get('x-forwarded-for') || '';
  const hops = xff.split(',').map((h) => h.trim()).filter(Boolean);
  const ip = hops.length ? hops[hops.length - 1] : (req.headers.get('x-real-ip') || 'unknown');

  if (ip.includes(':')) {
    // IPv6 → first four hextets (/64).
    return ip.split(':').slice(0, 4).join(':') + '::/64';
  }
  // IPv4 → first three octets (/24).
  const parts = ip.split('.');
  return parts.length === 4 ? parts.slice(0, 3).join('.') + '.0/24' : ip;
}

/**
 * Count one hit against `bucket` and throw `LimitError` if it is over `max`
 * within `windowSeconds`. Fails OPEN on a database error — a limiter that hard-
 * fails would take the whole endpoint down, which is a worse outcome than a
 * missed count.
 */
export async function rateLimit(
  bucket: string, max: number, windowSeconds: number,
): Promise<void> {
  try {
    const { data, error } = await serviceClient().rpc('hit_rate_limit', {
      p_bucket: bucket,
      p_window_seconds: windowSeconds,
      p_max: max,
    });
    if (error) return; // fail open
    if (data === false) {
      throw new LimitError('too many attempts — wait a moment and try again', windowSeconds);
    }
  } catch (e) {
    if (e instanceof LimitError) throw e;
    // fail open on anything else
  }
}

/**
 * Add `units` to the owner's daily total and throw if the (post-hoc) total is
 * over `cap`. `cap` comes from `OWNER_DAILY_UNIT_CAP` (default 500) so it is
 * tunable without a migration; a non-positive cap disables the ceiling.
 */
export async function chargeUsage(ownerId: string, units = 1): Promise<void> {
  const cap = Number(Deno.env.get('OWNER_DAILY_UNIT_CAP') || '500');
  if (!(cap > 0)) return;
  try {
    const { data, error } = await serviceClient().rpc('bump_usage', {
      p_owner: ownerId,
      p_units: units,
    });
    if (error) return; // fail open
    if (typeof data === 'number' && data > cap) {
      throw new LimitError('daily limit reached for this account', 3600);
    }
  } catch (e) {
    if (e instanceof LimitError) throw e;
  }
}
