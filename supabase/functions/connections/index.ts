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

import { failure, json, preflight, serviceClient, sha256Hex } from '../_shared/http.ts';
import { callerPrefix, chargeUsage, rateLimit } from '../_shared/limits.ts';
import * as composio from '../_shared/composio.ts';

// The registry is now the single source of truth in _shared/services/. Adding a
// service is one adapter file there — no edit here, and no device-side duplicate
// to keep in sync (the glasses fetch it via the `registry` action).
import { ADAPTERS, BY_SLUG, registryJson, TOOL_RISK, TOOL_TO_SLUG } from '../_shared/services/index.ts';

/** A URL-safe random token, for staged-action confirmation. */
function randomToken(bytes = 24): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

// The shape `list`/`status` return per connection — unchanged for the client.
const CONNECTIONS = ADAPTERS;

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

/**
 * The wearer, resolved from the glasses' pairing code (the hosted connections
 * page, which has no account) OR a device token / user JWT (glasses, or a
 * signed-in caller). The code path is what lets the phone list and authorize
 * connections for the wearer without ever logging in.
 */
async function ownerFromCodeOrToken(
  supabase: ReturnType<typeof serviceClient>,
  req: Request,
  body: Record<string, unknown>,
): Promise<string | null> {
  const userCode = String(body?.user_code || '').trim().toLowerCase();
  if (userCode) {
    const { data: session } = await supabase
      .from('pairing_sessions')
      .select('owner_id, status, expires_at')
      .eq('user_code', userCode)
      .maybeSingle();
    if (session && session.owner_id && session.status !== 'claimed' &&
        new Date(session.expires_at).getTime() >= Date.now()) {
      return session.owner_id as string;
    }
  }
  return await resolveOwner(supabase, req);
}

/**
 * Run one tool for the wearer: the send gate, the execute, and the shaping, in
 * one place so `execute` (given a tool) and `run` (plans one) share it.
 *
 * Outbound tools never fire here — they are staged into pending_actions and only
 * a redeemed `confirm` runs them (server-enforced, so a repacked .aix cannot
 * skip it). Reads and self-writes execute directly and return a ≤4-row card.
 */
async function runTool(
  supabase: ReturnType<typeof serviceClient>,
  owner: string,
  tool: string,
  args: Record<string, unknown>,
  confirmLine: string,
): Promise<Response> {
  const slug = TOOL_TO_SLUG.get(tool);
  if (!slug) return json({ ok: false, error: 'tool not available' }, 400);
  const risk = TOOL_RISK.get(tool) || 'read';
  const adapter = BY_SLUG.get(slug);

  if (risk === 'outbound') {
    const line = (confirmLine || ('Send via ' + (adapter?.name || slug) + '?')).slice(0, 90);
    const token = randomToken(24);
    const expires_at = new Date(Date.now() + 90 * 1000).toISOString();
    // One live pending per owner: staging supersedes the old, so a later "yes"
    // can only confirm the most recent card.
    await supabase.from('pending_actions').delete().eq('owner_id', owner).eq('status', 'pending');
    const { error: stageErr } = await supabase.from('pending_actions')
      .insert({ token, owner_id: owner, tool, args, line, expires_at });
    if (stageErr) throw stageErr;
    return json({
      ok: true, pending: true, confirm: token,
      card: { title: line, lines: [], hasLines: false, spoken: line + ' Say yes to send.' },
    });
  }

  const st = await composio.status(owner, slug);
  if (!st.connected) return json({ ok: false, error: 'not connected', reason: 'not-connected', slug }, 409);

  const result = await composio.execute(tool, owner, args);
  if (!result.ok) return json({ ok: false, error: result.error || 'tool failed' }, 502);
  await chargeUsage(owner, 1);
  const card = adapter ? adapter.project(tool, result.data) : undefined;
  return json({ ok: true, data: result.data, card });
}

Deno.serve(async (req) => {
  const early = preflight(req);
  if (early) return early;
  if (req.method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405);

  const supabase = serviceClient();
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = String(body.action || '');

    // `list` and `authorize` accept a `user_code` as identity, so they are a
    // brute-force surface; throttle every POST on the caller's IP prefix. The
    // glasses' own `execute` calls come from few addresses and stay well under.
    await rateLimit('connections:' + callerPrefix(req), 30, 60);

    /* ── registry: the compact service list the glasses cache ──────────────── */
    // Public — it is not owner data, just which services exist and their aliases.
    // The device fetches it on sync so there is no registry copy inside the .aix.
    if (action === 'registry') {
      return json({ ok: true, registry: registryJson() });
    }

    /* ── aliases: the wearer's own aliases, for the glasses to cache ────────────
       The console WRITES these behind a Google sign-in; the glasses READ them
       here with their device token, so "Kavi sync" can pull them into the router. */
    if (action === 'aliases') {
      const owner = await resolveOwner(supabase, req);
      if (!owner) return json({ ok: false, error: 'signed out' }, 401);
      const { data } = await supabase.from('owner_aliases')
        .select('phrase, kind, slug, action').eq('owner_id', owner);
      return json({ ok: true, aliases: data || [] });
    }

    if (!composio.configured()) {
      return json({ ok: false, error: 'Connections are not configured on the server (COMPOSIO_API_KEY)' }, 503);
    }

    /* ── list / status: the wearer's connections ───────────────────────────── */
    if (action === 'list' || action === 'status') {
      const owner = await ownerFromCodeOrToken(supabase, req, body);
      if (!owner) return json({ ok: false, error: 'not authorized' }, 401);

      const wanted = action === 'status' && body.slug
        ? CONNECTIONS.filter((c) => c.slug === body.slug)
        : CONNECTIONS;

      const connections = [];
      for (const c of wanted) {
        const st = await composio.status(owner, c.slug);
        connections.push({
          slug: c.slug,
          name: c.name,
          summary: c.summary,
          category: c.category,
          icon: c.icon,
          aliases: c.aliases,
          // Map the adapter's risk back to the client's historical {name, kind}
          // shape so the connections page renders unchanged.
          tools: c.tools.map((t) => ({
            name: t.name,
            kind: t.risk === 'outbound' ? 'send' : t.risk === 'self' ? 'write' : 'read',
          })),
          connected: st.connected,
          status: st.status,
        });
      }
      return json({ ok: true, connections });
    }

    /* ── authorize: start a connection, hand back an OAuth URL ──────────────── */
    if (action === 'authorize') {
      const slug = String(body.slug || '');
      if (!BY_SLUG.has(slug)) return json({ ok: false, error: 'unknown connection' }, 400);

      // Who is authorizing? The phone identifies the wearer by the code shown on
      // the glasses (no account); a device token / JWT also works.
      const userCode = String(body.user_code || '').trim().toLowerCase();
      const owner = await ownerFromCodeOrToken(supabase, req, body);
      if (!owner) return json({ ok: false, error: 'sign in first' }, 401);

      const authConfig = await composio.authConfigId(slug);
      if (!authConfig) return json({ ok: false, error: 'no Composio auth config for ' + slug }, 503);

      // After authorizing, Composio returns the wearer to the connections list
      // page (CONNECT_PAGE_URL, the hosted HTML), carrying the slug + code so the
      // page shows the new ✓ and can finalize. Falls back to the pair function's
      // plain-text confirmation when the page URL is not configured.
      const pageBase = Deno.env.get('CONNECT_PAGE_URL') ||
        ((Deno.env.get('SUPABASE_URL') || '') + '/functions/v1/pair');
      const back = pageBase + (pageBase.indexOf('?') === -1 ? '?' : '&') +
        'connected=' + encodeURIComponent(slug) +
        (userCode ? '&code=' + encodeURIComponent(userCode) : '');

      const linked = await composio.link(authConfig, owner, back);
      if (!linked.ok) return json({ ok: false, error: linked.error || 'could not start authorization' }, 502);
      return json({ ok: true, url: linked.url });
    }

    /* ── execute: run one named tool for the wearer (the glasses' current path) */
    if (action === 'execute') {
      const owner = await resolveOwner(supabase, req);
      if (!owner) return json({ ok: false, error: 'signed out' }, 401);

      const tool = String(body.tool || '');
      const slug = TOOL_TO_SLUG.get(tool);
      if (!slug) return json({ ok: false, error: 'tool not available' }, 400);
      return await runTool(
        supabase, owner, tool, (body.arguments || {}) as Record<string, unknown>,
        String(body.confirm_line || ''),
      );
    }

    /* ── run: plan {slug, action} server-side, resolve bindings, then run ──────
       The all-in-one path: the glasses send the service and the spoken action;
       the server picks the tool, fills opaque bindings from owner_bindings, and
       returns a shaped card. Adding a service reaches the glasses with no repack. */
    if (action === 'run') {
      const owner = await resolveOwner(supabase, req);
      if (!owner) return json({ ok: false, error: 'signed out' }, 401);

      const slug = String(body.slug || '');
      const adapter = BY_SLUG.get(slug);
      if (!adapter) return json({ ok: false, error: 'unknown service', slug }, 400);

      const { data: binds } = await supabase.from('owner_bindings')
        .select('key, value').eq('owner_id', owner).eq('slug', slug);
      const bindings: Record<string, string> = {};
      for (const b of (binds || []) as { key: string; value: string }[]) bindings[b.key] = b.value;

      const planned = adapter.plan(String(body.action || ''), bindings);
      if (!planned) {
        return json({ ok: true, card: { title: 'I cannot do that on ' + adapter.name + ' yet', lines: [], hasLines: false, spoken: 'I cannot do that yet.' } });
      }
      if (planned.missingBinding) {
        const need = adapter.bindings?.find((x) => x.key === planned.missingBinding);
        const line = 'Choose a ' + (need?.label || planned.missingBinding) + ' for ' + adapter.name + ' in the app';
        return json({ ok: true, needsSetup: planned.missingBinding, card: { title: line, lines: [], hasLines: false, spoken: line + '.' } });
      }
      return await runTool(supabase, owner, planned.tool, planned.args, String(body.confirm_line || ''));
    }

    /* ── confirm: redeem a staged outbound action and run it ───────────────── */
    if (action === 'confirm') {
      const owner = await resolveOwner(supabase, req);
      if (!owner) return json({ ok: false, error: 'signed out' }, 401);
      const token = String(body.token || '');

      // Atomic claim: pending → claimed, this owner's token, still live. Wins at
      // most once, so a double "yes" cannot send twice.
      const { data: claimed } = await supabase.rpc('claim_pending_action', { p_token: token, p_owner: owner });

      if (!claimed) {
        // Not claimable now — either already claimed (replay) or gone. If it was
        // claimed and carries a stored result, return that instead of re-sending.
        const { data: prior } = await supabase.from('pending_actions')
          .select('tool, result').eq('token', token).eq('owner_id', owner).maybeSingle();
        if (prior && prior.result) {
          const a = BY_SLUG.get(TOOL_TO_SLUG.get(prior.tool as string) || '');
          return json({ ok: true, card: a ? a.project(prior.tool as string, prior.result) : undefined, replayed: true });
        }
        return json({ ok: false, error: 'nothing to confirm', reason: 'expired' }, 410);
      }

      const tool = claimed.tool as string;
      const slug = TOOL_TO_SLUG.get(tool) || '';
      const st = await composio.status(owner, slug);
      if (!st.connected) return json({ ok: false, error: 'not connected', reason: 'not-connected', slug }, 409);

      const result = await composio.execute(tool, owner, (claimed.args || {}) as Record<string, unknown>);
      if (!result.ok) return json({ ok: false, error: result.error || 'send failed' }, 502);
      // Store the result so a replayed confirm returns it rather than re-sending.
      await supabase.from('pending_actions').update({ result: result.data }).eq('token', token);
      await chargeUsage(owner, 1);
      const adapter = BY_SLUG.get(slug);
      return json({ ok: true, data: result.data, card: adapter ? adapter.project(tool, result.data) : undefined });
    }

    return json({ ok: false, error: 'unknown action' }, 400);
  } catch (error) {
    // Routes LimitError → 429 (with retry-after), OwnerError → 403, else 500.
    return failure(error);
  }
});
