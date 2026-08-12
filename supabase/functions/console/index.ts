/**
 * The phone console backend (web/console).
 *
 * Everything the wearer manages from their phone: their connected services,
 * the people Kavi remembers and the notes about them, and their voice aliases.
 *
 * ## Auth — a Google sign-in, not the pairing code
 *
 * The pairing `user_code` is a bearer credential with a bounded keyspace, and it
 * must never unlock a face roster of third parties. So the console authenticates
 * with a real **Supabase Auth Google sign-in** (the page runs it): the wearer
 * proves the Google account, and we map that to their tenant through
 * `owners.auth_user_id`. The one place the code is still used is `bind` — the
 * first sign-in links the device tenant (identified by the code the glasses
 * showed) to the Google identity, after which the identity alone is enough.
 *
 * Every handler resolves `owner` from the verified JWT, never from a header or a
 * body field, so a caller can only ever touch their own tenant.
 */

import { CORS, json, preflight, serviceClient } from '../_shared/http.ts';
import { callerPrefix, rateLimit } from '../_shared/limits.ts';
import { ADAPTERS, BY_SLUG, registryJson } from '../_shared/services/index.ts';
import * as composio from '../_shared/composio.ts';

function bearer(req: Request): string {
  const h = req.headers.get('authorization') || '';
  return h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : '';
}

/** The Supabase Auth user id (Google-backed) behind the request's JWT, or null. */
async function authUserId(supabase: ReturnType<typeof serviceClient>, req: Request): Promise<string | null> {
  const token = bearer(req);
  if (!token) return null;
  const { data } = await supabase.auth.getUser(token);
  return data?.user?.id || null;
}

/**
 * The tenant for the signed-in wearer. Null until their glasses have been bound
 * to this Google account at least once (the console then offers to bind).
 */
async function ownerForUser(supabase: ReturnType<typeof serviceClient>, userId: string): Promise<string | null> {
  const { data } = await supabase.rpc('owner_for_auth_user', { p_auth_user: userId });
  return (data as string) || null;
}

/**
 * Fold to match the router: lowercase, đ→d, strip diacritics. A phrase is stored
 * folded so it lines up with utils/planner.js `fold()` on the glasses.
 */
function fold(text: string): string {
  return String(text || '').toLowerCase().replace(/đ/g, 'd')
    .normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

// Words the wearer must not shadow — they already drive the command grammar.
const RESERVED = new Set([
  'kavi', 'start', 'begin', 'sync', 'status', 'update', 'connection', 'connections',
  'account', 'accounts', 'login', 'sign', 'halo', 'hello', 'chao', 'remember', 'note',
  'forget', 'list', 'yes', 'no', 'cancel', 'undo', 'who',
  'bat', 'dau', 'cap', 'nhat', 'trang', 'thai', 'dang', 'nhap', 'ket', 'noi', 'nho', 'quen',
]);

/** Reject a proposed alias phrase, or '' if it is allowed. */
function aliasProblem(folded: string, builtinAliases: Set<string>): string {
  if (!folded) return 'Type a word.';
  if (!/^[a-z0-9 ]+$/.test(folded)) return 'Use plain letters only.';
  if (folded.length < 2) return 'Too short.';
  if (folded.length > 24) return 'Too long.';
  if (RESERVED.has(folded)) return '"' + folded + '" is a Kavi command — pick another word.';
  // The whole point of aliases is that they fold cleanly; if the folded form
  // collides with a built-in alias, the router could not tell them apart. (This
  // is the "thư" ≈ "thứ" class, caught here where we can explain it.)
  if (builtinAliases.has(folded)) return '"' + folded + '" is already a built-in name.';
  return '';
}

Deno.serve(async (req) => {
  const early = preflight(req);
  if (early) return early;
  if (req.method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405);

  const supabase = serviceClient();
  try {
    await rateLimit('console:' + callerPrefix(req), 60, 60);
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = String(body.action || '');

    const userId = await authUserId(supabase, req);
    if (!userId) return json({ ok: false, error: 'sign in with Google first' }, 401);

    /* ── bind: link the device tenant (from its pairing code) to this Google id ─ */
    if (action === 'bind') {
      const userCode = String(body.user_code || '').trim().toLowerCase();
      if (!userCode) return json({ ok: false, error: 'no pairing code' }, 400);
      const { data: session } = await supabase.from('pairing_sessions')
        .select('owner_id, status, expires_at').eq('user_code', userCode).maybeSingle();
      if (!session?.owner_id || new Date(session.expires_at).getTime() < Date.now()) {
        return json({ ok: false, error: 'that code has expired — reopen from your glasses' }, 410);
      }
      const { data: owner } = await supabase.rpc('bind_owner', {
        p_device_owner: session.owner_id, p_auth_user: userId,
      });
      return json({ ok: true, owner_id: owner });
    }

    // Everything past here needs an already-bound tenant.
    const owner = await ownerForUser(supabase, userId);
    if (!owner) return json({ ok: false, error: 'no glasses linked yet', reason: 'unbound' }, 409);

    /* ── connections: each service with this wearer's connected status ──────── */
    if (action === 'connections') {
      const connections = [];
      for (const a of ADAPTERS) {
        const st = composio.configured()
          ? await composio.status(owner, a.slug)
          : { connected: false, status: 'unconfigured' };
        connections.push({
          slug: a.slug, name: a.name, summary: a.summary, category: a.category,
          icon: a.icon, connected: st.connected, status: st.status,
          bindings: a.bindings || [],
        });
      }
      return json({ ok: true, connections });
    }

    /* ── connect: start a Composio OAuth for this service, hand back a URL ───── */
    if (action === 'connect') {
      const slug = String(body.slug || '');
      if (!BY_SLUG.has(slug)) return json({ ok: false, error: 'unknown service' }, 400);
      if (!composio.configured()) return json({ ok: false, error: 'connections not configured' }, 503);
      const authConfig = await composio.authConfigId(slug);
      if (!authConfig) return json({ ok: false, error: 'no auth config for ' + slug }, 503);
      const back = Deno.env.get('CONNECT_PAGE_URL') || '';
      const linked = await composio.link(authConfig, owner, back);
      if (!linked.ok) return json({ ok: false, error: linked.error || 'could not start' }, 502);
      return json({ ok: true, url: linked.url });
    }

    /* ── people: the memory roster (names + notes; NO thumbnails) ───────────── */
    if (action === 'people') {
      const { data } = await supabase.from('people')
        .select('id, name, note, email, seen_count, last_seen_at')
        .eq('owner_id', owner).order('last_seen_at', { ascending: false });
      return json({ ok: true, people: data || [] });
    }

    /* ── person: correct a name / note / email ──────────────────────────────── */
    if (action === 'person') {
      const id = String(body.id || '');
      const patch: Record<string, unknown> = {};
      for (const f of ['name', 'note', 'email']) {
        if (body[f] !== undefined) patch[f] = String(body[f]).slice(0, f === 'note' ? 500 : 200);
      }
      if (!id || !Object.keys(patch).length) return json({ ok: false, error: 'nothing to change' }, 400);
      const { data, error } = await supabase.from('people')
        .update(patch).eq('id', id).eq('owner_id', owner).select('id, name, note, email').single();
      if (error) return json({ ok: false, error: 'no such person' }, 404);
      return json({ ok: true, person: data });
    }

    /* ── forget: delete a person and their embeddings ───────────────────────── */
    if (action === 'forget') {
      const id = String(body.id || '');
      if (!id) return json({ ok: false, error: 'no person id' }, 400);
      const { count } = await supabase.from('people')
        .delete({ count: 'exact' }).eq('id', id).eq('owner_id', owner);
      return json({ ok: true, removed: count || 0 });
    }

    /* ── aliases: list / add / remove ───────────────────────────────────────── */
    if (action === 'aliases') {
      const { data } = await supabase.from('owner_aliases')
        .select('phrase, kind, slug, action').eq('owner_id', owner).order('phrase');
      return json({ ok: true, aliases: data || [] });
    }
    if (action === 'alias.add') {
      const phrase = fold(String(body.phrase || ''));
      const slug = String(body.slug || '');
      const kind = body.action ? 'shortcut' : 'app';
      if (!BY_SLUG.has(slug)) return json({ ok: false, error: 'unknown service' }, 400);
      const builtins = new Set(registryJson().flatMap((s) => s.aliases.map(fold)));
      const problem = aliasProblem(phrase, builtins);
      if (problem) return json({ ok: false, error: problem, reason: 'invalid-alias' }, 400);
      const { error } = await supabase.from('owner_aliases').upsert({
        owner_id: owner, phrase, kind, slug, action: String(body.action || ''),
      });
      if (error) throw error;
      return json({ ok: true, phrase, kind, slug });
    }
    if (action === 'alias.remove') {
      const phrase = fold(String(body.phrase || ''));
      await supabase.from('owner_aliases').delete().eq('owner_id', owner).eq('phrase', phrase);
      return json({ ok: true });
    }

    /* ── bindings: set an opaque resource id (Slack channel, …) ─────────────── */
    if (action === 'binding.set') {
      const slug = String(body.slug || '');
      const key = String(body.key || '');
      const value = String(body.value || '');
      const label = String(body.label || '');
      if (!BY_SLUG.has(slug) || !key || !value) return json({ ok: false, error: 'bad binding' }, 400);
      const { error } = await supabase.from('owner_bindings')
        .upsert({ owner_id: owner, slug, key, value, label });
      if (error) throw error;
      return json({ ok: true });
    }

    /* ── forget-owner: the hard delete (everything this wearer holds) ────────── */
    if (action === 'forget.owner') {
      await supabase.rpc('forget_owner', { p_owner: owner });
      return json({ ok: true });
    }

    return json({ ok: false, error: 'unknown action' }, 400);
  } catch (error) {
    console.error(String((error as Error)?.message ?? error));
    return new Response(JSON.stringify({ ok: false, error: 'internal error' }), {
      status: 500, headers: { ...CORS, 'content-type': 'application/json; charset=utf-8' },
    });
  }
});
