/**
 * Server-side Composio client (docs/14).
 *
 * The Composio key lives here, in the Edge Function env — never on the glasses.
 * Everything is per-wearer: the Composio `user_id` is the wearer's `owner_id`, so
 * one wearer's connections and tool calls can never touch another's.
 *
 * Only four calls are needed to make "authorize a service, then use its tools"
 * work for any Composio toolkit:
 *   authConfigId  — the OAuth integration for a toolkit (googlecalendar, slack…)
 *   link          — start a connection; returns a URL the wearer opens to authorize
 *   status        — is this toolkit connected (ACTIVE) for this wearer?
 *   execute       — run one tool for this wearer
 */

const BASE = 'https://backend.composio.dev';

function key(): string {
  return Deno.env.get('COMPOSIO_API_KEY') || '';
}

async function cx(path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; data: any }> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { 'x-api-key': key(), 'content-type': 'application/json', ...(init?.headers || {}) },
  });
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { ok: res.ok, status: res.status, data };
}

export function configured(): boolean {
  return Boolean(key());
}

/** The OAuth auth config (integration) id for a toolkit, or '' if none exists. */
export async function authConfigId(toolkit: string): Promise<string> {
  const r = await cx('/api/v3/auth_configs?toolkit_slug=' + encodeURIComponent(toolkit));
  return r.data?.items?.[0]?.id || '';
}

/** Start a connection. Returns a URL the wearer opens to authorize the service. */
export async function link(authConfig: string, userId: string, callbackUrl: string): Promise<{ ok: boolean; url: string; connectedAccountId: string; error?: string }> {
  const r = await cx('/api/v3/connected_accounts/link', {
    method: 'POST',
    body: JSON.stringify({ auth_config_id: authConfig, user_id: userId, callback_url: callbackUrl }),
  });
  if (!r.ok || !r.data?.redirect_url) {
    return { ok: false, url: '', connectedAccountId: '', error: r.data?.error?.message || ('HTTP ' + r.status) };
  }
  return { ok: true, url: r.data.redirect_url, connectedAccountId: r.data.connected_account_id || '' };
}

/** Is `toolkit` connected for this wearer? */
export async function status(userId: string, toolkit: string): Promise<{ connected: boolean; status: string }> {
  const r = await cx(
    '/api/v3/connected_accounts?user_ids=' + encodeURIComponent(userId) +
    '&toolkit_slugs=' + encodeURIComponent(toolkit),
  );
  const acct = r.data?.items?.find((a: any) => a?.status === 'ACTIVE') || r.data?.items?.[0];
  return { connected: acct?.status === 'ACTIVE', status: acct?.status || 'none' };
}

/** Run one tool for this wearer. Returns Composio's unwrapped result. */
export async function execute(slug: string, userId: string, args: Record<string, unknown>): Promise<{ ok: boolean; data: any; error: string | null }> {
  const r = await cx('/api/v3/tools/execute/' + encodeURIComponent(slug), {
    method: 'POST',
    body: JSON.stringify({ user_id: userId, arguments: args || {} }),
  });
  if (!r.ok) {
    return { ok: false, data: null, error: r.data?.error?.message || r.data?.error || ('HTTP ' + r.status) };
  }
  // Composio wraps as { data, successful, error }.
  return { ok: r.data.successful !== false, data: r.data.data, error: r.data.error || null };
}
