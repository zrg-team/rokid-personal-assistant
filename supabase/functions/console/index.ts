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

import { failure, guard, json, preflight, serviceClient, sha256Hex } from '../_shared/http.ts';
import { callerPrefix, rateLimit } from '../_shared/limits.ts';
import { ADAPTERS, BY_SLUG, registryJson, toolsJson } from '../_shared/services/index.ts';
import type { Field } from '../_shared/services/types.ts';
import * as composio from '../_shared/composio.ts';

function bearer(req: Request): string {
  const h = req.headers.get('authorization') || '';
  return h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : '';
}

/** A random opaque token as lowercase hex — the durable console session secret. */
function randomToken(bytes = 32): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
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
/**
 * Turn whatever a "list the options" tool returned into {value,label} pairs.
 *
 * Every toolkit nests its list under a different key and names its id and title
 * fields differently — Slack has `id`/`name`, Google Tasks `id`/`title`, Linear
 * `id`/`name`. Rather than a lookup table per service that would need editing
 * for every new one, this hunts for the first array of objects and then for the
 * first id-ish and name-ish field on each. Same defensive shape as
 * `_shared/services/shape.ts` `firstList`, and for the same reason.
 */
function flattenOptions(data: unknown): { value: string; label: string }[] {
  const findList = (d: unknown): Record<string, unknown>[] => {
    if (Array.isArray(d)) return d as Record<string, unknown>[];
    if (!d || typeof d !== 'object') return [];
    const obj = d as Record<string, unknown>;
    for (const k of ['items', 'channels', 'results', 'data', 'teams', 'nodes', 'lists']) {
      if (Array.isArray(obj[k])) return obj[k] as Record<string, unknown>[];
    }
    for (const v of Object.values(obj)) {
      if (Array.isArray(v) && v.length && typeof v[0] === 'object') return v as Record<string, unknown>[];
    }
    return [];
  };

  const first = (o: Record<string, unknown>, keys: string[]) => {
    for (const k of keys) {
      const v = o?.[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
  };

  return findList(data)
    .map((o) => ({
      value: first(o, ['id', 'value', 'key', 'gid']),
      label: first(o, ['name', 'title', 'label', 'displayName', 'summary']) || first(o, ['id']),
    }))
    .filter((o) => o.value)
    .slice(0, 100);
}

/** A stored day placeholder: the WHOLE value, never embedded in a sentence. */
const PLACEHOLDER = /^\{\{(day|start|end):([a-z]{1,12}|[+-]\d{1,2})\}\}$/;

/**
 * Check the arguments the console wants to save against the tool's own schema.
 *
 * `action` — the free-text field this replaces — was stored with no validation
 * of any kind. Structured args go to a real tool call, so they get checked:
 * every key must be one the tool declares, values stay scalar, and anything
 * containing `{{` must be a complete placeholder rather than a fragment. That
 * last rule is what keeps device-side substitution free of an injection
 * surface — there is no interpolation, only whole-value replacement.
 *
 * @returns the cleaned args, or a human sentence explaining the refusal.
 */
function validateArgs(fields: Field[], raw: unknown): Record<string, unknown> | string {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) return 'Options must be a set of values.';

  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > 12) return 'Too many options.';

  // Every argument key this tool can legitimately receive: the declared fields,
  // minus the `_`-prefixed controls, plus whatever those controls expand into.
  const allowed = new Set<string>();
  for (const f of fields) {
    if (f.key[0] !== '_') allowed.add(f.key);
    for (const key of Object.keys(f.expands || {})) allowed.add(key);
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    // Rejected, not dropped: a typo should surface on the phone, where there is
    // a screen to explain it, rather than becoming a silently wrong tool call.
    if (!allowed.has(key)) return 'That action has no option called "' + key + '".';

    if (typeof value === 'string') {
      if (value.length > 200) return '"' + key + '" is too long.';
      if (value.indexOf('{{') !== -1 && !PLACEHOLDER.test(value)) {
        return '"' + key + '" must be a whole day placeholder, e.g. {{day:tomorrow}}.';
      }
      out[key] = value;
    } else if (typeof value === 'number') {
      if (!isFinite(value)) return '"' + key + '" must be a number.';
      out[key] = value;
    } else if (typeof value === 'boolean') {
      out[key] = value;
    } else {
      return '"' + key + '" must be text, a number or yes/no.';
    }
  }

  for (const f of fields) {
    if (f.required && f.key[0] !== '_' && !(f.key in out)) return f.label + ' is required.';
  }

  if (JSON.stringify(out).length > 2048) return 'Those options are too large.';
  return out;
}

function aliasProblem(folded: string, builtinAliases: Set<string>): string {
  if (!folded) return 'Type a word.';
  if (!/^[a-z0-9 ]+$/.test(folded)) return 'Use plain letters only.';
  if (folded.length < 2) return 'Too short.';
  // 24 was exactly the length of "google calendar tomorrow" — the very phrase
  // this feature exists to support sat on the ceiling.
  if (folded.length > 48) return 'Too long.';
  if (RESERVED.has(folded)) return '"' + folded + '" is a Kavi command — pick another word.';
  // The router runs statusCommand and syncCommand BEFORE the alias table, and
  // the sync matcher is unanchored — so a phrase containing any of these is
  // swallowed by "Kavi sync" and the alias would never fire, with nothing to
  // explain why. Refuse it here, where there is a screen to say so.
  if (/^(?:status|connections?|accounts?|login|sign|start|begin)/.test(folded) ||
      /(?:sync|resync|refresh|reload|update|cap nhat|dong bo|lam moi)/.test(folded)) {
    return '"' + folded + '" collides with a Kavi command — pick another word.';
  }
  // The whole point of aliases is that they fold cleanly; if the folded form
  // collides with a built-in alias, the router could not tell them apart. (This
  // is the "thư" ≈ "thứ" class, caught here where we can explain it.)
  if (builtinAliases.has(folded)) return '"' + folded + '" is already a built-in name.';
  return '';
}

Deno.serve(async (req) => {
  const early = preflight(req);
  if (early) return early;
  const blocked = guard(req);
  if (blocked) return blocked;
  if (req.method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405);

  const supabase = serviceClient();
  try {
    await rateLimit('console:' + callerPrefix(req), 60, 60);
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = String(body.action || '');

    // Two ways to prove who this is, in order of strength:
    //   1. A Supabase Auth Google JWT → the durable tenant (owner_for_auth_user).
    //   2. The live pairing CODE the glasses showed → its tenant. Short-lived and
    //      now rate-limited; this is the path the phone link uses out of the box,
    //      so the console works without the Google provider being configured.
    const userId = await authUserId(supabase, req);
    const userCode = String(body.user_code || '').trim().toLowerCase();
    // A durable console token the browser kept — behind a passkey, or encrypted in
    // localStorage under a passcode. It re-proves the tenant without a fresh code.
    const consoleToken = String(body.console_token || '');

    /* ── session.revoke: kill a durable token (the browser's "clear this device") ─ */
    if (action === 'session.revoke') {
      if (consoleToken) await supabase.rpc('revoke_console_session', { p_token_hash: await sha256Hex(consoleToken) });
      return json({ ok: true });
    }

    /* ── bind: link the device tenant (from its pairing code) to a Google id ─── */
    if (action === 'bind') {
      if (!userId) return json({ ok: false, error: 'sign in with Google first' }, 401);
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

    // Resolve the tenant from the JWT (if bound) or the pairing code.
    let owner: string | null = null;
    let approvedSignin = false;
    if (userId) owner = await ownerForUser(supabase, userId);
    if (!owner && consoleToken) {
      const { data } = await supabase.rpc('owner_from_console_token', { p_token_hash: await sha256Hex(consoleToken) });
      owner = (data as string) || null;
    }
    if (!owner && userCode) {
      const { data: session } = await supabase.from('pairing_sessions')
        .select('owner_id, status, expires_at, confirm_word').eq('user_code', userCode).maybeSingle();
      if (session?.owner_id && new Date(session.expires_at).getTime() >= Date.now()) {
        owner = session.owner_id as string;
        // Opening the console with a live code APPROVES the glasses' sign-in, so
        // the wearer can press the temple to finish. Without this the glasses
        // poll forever on "Sign in" — the original phone page did this and the
        // new console dropped it. Idempotent: only pending → approved.
        if (session.status === 'pending') {
          await supabase.from('pairing_sessions').update({ status: 'approved' }).eq('user_code', userCode);
          approvedSignin = true;
        }
      }
    }
    if (!owner) {
      // A presented-but-unresolved code is the brute-force signal. Count it in a
      // strict per-IP-prefix bucket so a sweep trips 429 within seconds, while
      // legitimate code-authenticated calls (which DO resolve, and fire several
      // times per page load) never touch this bucket and are never throttled.
      if (userCode) await rateLimit('code.miss:' + callerPrefix(req), 10, 60);
      return json({ ok: false, error: 'open this from your glasses, or sign in with Google', reason: 'no-owner' }, 401);
    }

    /* ── signin-status: tell the page whether it just approved a sign-in ─────── */
    if (action === 'signin-status') {
      return json({ ok: true, approved: approvedSignin });
    }

    /* ── session.issue: mint a durable console token for this proven tenant ────
     * Only from a FRESH proof (a live code or Google JWT) — never from an existing
     * console token, so a leaked token cannot mint itself fresh siblings. The
     * browser keeps the returned token behind a passkey or a passcode; the server
     * stores only its hash and slides its 14-day window forward on each use. */
    if (action === 'session.issue') {
      if (!userCode && !userId) return json({ ok: false, error: 'sign in from your glasses first' }, 401);
      const token = randomToken(32);
      const expires_at = new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString();
      const { error } = await supabase.from('console_sessions').insert({
        token_hash: await sha256Hex(token), owner_id: owner, label: String(body.label || 'this device').slice(0, 60), expires_at,
      });
      if (error) throw error;
      return json({ ok: true, console_token: token, expires_at });
    }

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
      // What the wearer has already chosen, so the console can show the current
      // value on each picker rather than an empty select.
      const { data: chosen } = await supabase.from('owner_bindings')
        .select('slug, key, value, label').eq('owner_id', owner);
      for (const c of connections) {
        c.chosen = (chosen || []).filter((b) => b.slug === c.slug);
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
      // Return to the console with the code preserved, so the page is still
      // authenticated after the OAuth round trip.
      const page = Deno.env.get('CONNECT_PAGE_URL') || '';
      const back = page && userCode
        ? page + (page.indexOf('?') === -1 ? '?' : '&') + 'code=' + encodeURIComponent(userCode)
        : page;
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

    /* ── tools: the action catalog the console's form is built from ────────── */
    if (action === 'tools') return json({ ok: true, services: toolsJson() });

    /* ── aliases: list / add / remove ───────────────────────────────────────── */
    if (action === 'aliases') {
      const { data } = await supabase.from('owner_aliases')
        .select('phrase, kind, slug, action, tool, args').eq('owner_id', owner).order('phrase');
      return json({ ok: true, aliases: data || [] });
    }
    if (action === 'alias.add') {
      const phrase = fold(String(body.phrase || ''));
      const slug = String(body.slug || '');
      const tool = String(body.tool || '');
      // Derived, never supplied — and the DB now holds the same invariant.
      const kind = tool ? 'action' : body.action ? 'shortcut' : 'app';

      const adapter = BY_SLUG.get(slug);
      if (!adapter) return json({ ok: false, error: 'unknown service' }, 400);
      const builtins = new Set(registryJson().flatMap((s) => s.aliases.map(fold)));
      const problem = aliasProblem(phrase, builtins);
      if (problem) return json({ ok: false, error: problem, reason: 'invalid-alias' }, 400);

      let args: Record<string, unknown> = {};
      if (tool) {
        const decl = adapter.tools.find((t) => t.name === tool);
        if (!decl) {
          return json({ ok: false, error: adapter.name + ' cannot do that', reason: 'unknown-tool' }, 400);
        }
        // Belt and braces with toolsJson()'s filter: a shortcut is one spoken
        // word with no confirmation step, so it must never reach a tool that
        // sends something to someone else.
        if (decl.risk === 'outbound') {
          return json({
            ok: false,
            error: 'A shortcut cannot send on your behalf — pick a read-only action.',
            reason: 'outbound-tool',
          }, 400);
        }
        const checked = validateArgs(decl.fields || [], body.args);
        if (typeof checked === 'string') {
          return json({ ok: false, error: checked, reason: 'invalid-args' }, 400);
        }
        args = checked;
      }

      const { error } = await supabase.from('owner_aliases').upsert({
        owner_id: owner, phrase, kind, slug,
        // A structured action has no canned free text; the two are exclusive.
        action: tool ? '' : String(body.action || ''),
        tool, args,
      });
      if (error) throw error;
      return json({ ok: true, phrase, kind, slug, tool });
    }
    if (action === 'alias.remove') {
      const phrase = fold(String(body.phrase || ''));
      await supabase.from('owner_aliases').delete().eq('owner_id', owner).eq('phrase', phrase);
      return json({ ok: true });
    }

    /* ── bindings: set an opaque resource id (Slack channel, …) ─────────────── */
    /* ── binding.list: what can this binding be set to? ──────────────────────
       An adapter declares `listTool` for each binding (a Slack channel, a Tasks
       list, a Linear team) — the tool that enumerates the options. Nothing ever
       called it, so the pickers could not be rendered and every service needing
       one was unusable: Slack has shipped since the start with no way to choose
       a channel. This runs that tool for the wearer and flattens whatever comes
       back into {value,label} pairs the console can render. */
    if (action === 'binding.list') {
      const slug = String(body.slug || '');
      const key = String(body.key || '');
      const adapter = BY_SLUG.get(slug);
      if (!adapter) return json({ ok: false, error: 'unknown service' }, 400);

      const binding = (adapter.bindings || []).find((b) => b.key === key);
      if (!binding) return json({ ok: false, error: 'unknown option' }, 400);
      if (!composio.configured()) {
        return json({ ok: false, error: 'connections are not configured yet' }, 503);
      }

      const run = await composio.execute(binding.listTool, owner, {});
      if (!run.ok) {
        // Almost always "not connected yet" — say so plainly rather than
        // surfacing a Composio error string on a phone screen.
        return json({
          ok: false,
          error: 'Connect ' + adapter.name + ' first, then choose ' + binding.label.toLowerCase() + '.',
          reason: 'not-connected',
        }, 400);
      }

      return json({ ok: true, options: flattenOptions(run.data) });
    }

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
    // failure() maps LimitError → 429 (with retry-after) and OwnerError → 403;
    // anything else is logged server-side and returned as a generic 500.
    return failure(error);
  }
});
