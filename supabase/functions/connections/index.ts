/**
 * Connections for the wearer — external services authorized through Composio
 * (docs/14). Face and text memory are default functions and do not live here.
 *
 *   POST { action: 'list' }        + Bearer (device token OR user JWT)
 *        → the connection registry with this wearer's status for each
 *   POST { action: 'authorize', slug, user_code } + Bearer user JWT
 *        → a URL the wearer opens to authorize the service (Composio OAuth)
 *   POST { action: 'status', slug } + Bearer (device token OR user JWT)
 *        → is that service connected for this wearer?
 *   POST { action: 'execute', tool, arguments } + Bearer device token
 *        → run one tool for this wearer (proxied to Composio, user_id = owner)
 *
 * The Composio key stays server-side (COMPOSIO_API_KEY); the glasses only ever
 * send their device token. The Composio user_id is the wearer's owner_id, so
 * connections and tool calls are isolated per wearer.
 */

import { json, preflight, serviceClient, sha256Hex } from '../_shared/http.ts';
import * as composio from '../_shared/composio.ts';

/**
 * The supported connections. Adding a service is one entry here plus its auth
 * config in the Composio dashboard — nothing else in this function changes.
 */
const CONNECTIONS = [
  {
    slug: 'googlecalendar',
    name: 'Google Calendar',
    summary: 'Read your day, answer calendar questions, and add events',
    tools: ['GOOGLECALENDAR_EVENTS_LIST', 'GOOGLECALENDAR_QUICK_ADD'],
  },
];
const BY_SLUG = new Map(CONNECTIONS.map((c) => [c.slug, c]));
const TOOL_TO_SLUG = new Map(CONNECTIONS.flatMap((c) => c.tools.map((t) => [t, c.slug])));

function bearer(req: Request): string {
  const h = req.headers.get('authorization') || '';
  return h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : '';
}

/** The wearer behind either a device token (glasses) or a user JWT (phone). */
async function resolveOwner(supabase: ReturnType<typeof serviceClient>, req: Request): Promise<string | null> {
  const token = bearer(req);
  if (!token) return null;
  const { data: owner } = await supabase.rpc('owner_from_device_token', { p_token_hash: await sha256Hex(token) });
  if (owner) return owner as string;
  const { data: auth } = await supabase.auth.getUser(token);
  return auth?.user?.id || null;
}
async function ownerFromJwt(supabase: ReturnType<typeof serviceClient>, req: Request): Promise<string | null> {
  const { data: auth } = await supabase.auth.getUser(bearer(req));
  return auth?.user?.id || null;
}

Deno.serve(async (req) => {
  const early = preflight(req);
  if (early) return early;
  if (req.method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405);

  const supabase = serviceClient();
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = String(body.action || '');

    if (!composio.configured()) {
      return json({ ok: false, error: 'Connections are not configured on the server (COMPOSIO_API_KEY)' }, 503);
    }

    /* ── list / status: the wearer's connections ───────────────────────────── */
    if (action === 'list' || action === 'status') {
      const owner = await resolveOwner(supabase, req);
      if (!owner) return json({ ok: false, error: 'not authorized' }, 401);

      const wanted = action === 'status' && body.slug
        ? CONNECTIONS.filter((c) => c.slug === body.slug)
        : CONNECTIONS;

      const connections = [];
      for (const c of wanted) {
        const st = await composio.status(owner, c.slug);
        connections.push({ slug: c.slug, name: c.name, summary: c.summary, connected: st.connected, status: st.status });
      }
      return json({ ok: true, connections });
    }

    /* ── authorize: start a connection, hand back an OAuth URL ──────────────── */
    if (action === 'authorize') {
      const slug = String(body.slug || '');
      if (!BY_SLUG.has(slug)) return json({ ok: false, error: 'unknown connection' }, 400);

      // Who is authorizing? In the device-pairing flow the phone has no account —
      // it identifies the wearer by the code shown on the glasses, which maps to
      // the owner_id minted when the pairing started. A signed-in JWT is still
      // accepted as a fallback for any non-pairing caller.
      const userCode = String(body.user_code || '').trim().toLowerCase();
      let owner: string | null = null;
      if (userCode) {
        const { data: session } = await supabase
          .from('pairing_sessions')
          .select('owner_id, status, expires_at')
          .eq('user_code', userCode)
          .maybeSingle();
        if (session && session.owner_id && session.status !== 'claimed' &&
            new Date(session.expires_at).getTime() >= Date.now()) {
          owner = session.owner_id as string;
        }
      }
      if (!owner) owner = await ownerFromJwt(supabase, req);
      if (!owner) return json({ ok: false, error: 'sign in first' }, 401);

      const authConfig = await composio.authConfigId(slug);
      if (!authConfig) return json({ ok: false, error: 'no Composio auth config for ' + slug }, 503);

      // After authorizing, Composio returns the wearer to the phone sign-in page,
      // carrying the code so it can finalize the pairing.
      const back = (Deno.env.get('SUPABASE_URL') || '') + '/functions/v1/pair?connected=' + encodeURIComponent(slug) +
        (userCode ? '&code=' + encodeURIComponent(userCode) : '');

      const linked = await composio.link(authConfig, owner, back);
      if (!linked.ok) return json({ ok: false, error: linked.error || 'could not start authorization' }, 502);
      return json({ ok: true, url: linked.url });
    }

    /* ── execute: run a tool for the wearer (glasses) ──────────────────────── */
    if (action === 'execute') {
      const owner = await resolveOwner(supabase, req);
      if (!owner) return json({ ok: false, error: 'signed out' }, 401);

      const tool = String(body.tool || '');
      const slug = TOOL_TO_SLUG.get(tool);
      if (!slug) return json({ ok: false, error: 'tool not available' }, 400);

      const st = await composio.status(owner, slug);
      if (!st.connected) return json({ ok: false, error: 'not connected', reason: 'not-connected', slug }, 409);

      const result = await composio.execute(tool, owner, (body.arguments || {}) as Record<string, unknown>);
      if (!result.ok) return json({ ok: false, error: result.error || 'tool failed' }, 502);
      return json({ ok: true, data: result.data });
    }

    return json({ ok: false, error: 'unknown action' }, 400);
  } catch (error) {
    console.error(String((error as Error)?.message ?? error));
    return json({ ok: false, error: 'internal error' }, 500);
  }
});
