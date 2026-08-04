/**
 * Connections client for the glasses (docs/14).
 *
 * Talks to the Kavi `connections` Edge Function, which proxies Composio with the
 * server-side key. The glasses send only their device token. It exposes the same
 * small `listTools()` / `callTool(name, args)` interface the app already uses, so
 * utils/agent.js, the planner and the pages are unchanged — a tool call just runs
 * through Composio for the wearer instead of a hardcoded account.
 *
 * It also lists and reports connection status, for the sign-in UI.
 */
import { CONNECTIONS } from '../config.js';

const DEFAULT_TIMEOUT_MS = 15000;

export function createConnectionsClient(config) {
  const projectUrl = String((config && config.projectUrl) || '').replace(/\/+$/, '');
  const apiKey = (config && config.apiKey) || '';
  const token = (config && config.token) || '';
  const timeoutMs = (config && config.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const endpoint = projectUrl + '/functions/v1/connections';
  const configured = Boolean(projectUrl && apiKey);

  // Every tool the registry exposes, flattened — this is the "tool catalog" the
  // rule planner narrows against, replacing Composio's on-device discovery. Tools
  // are {name, kind} (docs/16); kind lets a caller gate outbound actions.
  const tools = (CONNECTIONS || []).flatMap((c) =>
    (c.tools || []).map((t) => ({
      name: t.name,
      kind: t.kind || 'read',
      slug: c.slug,
      description: c.name + ' — ' + c.summary,
      inputSchema: { type: 'object', properties: {} },
    })));

  function withDeadline(promise) {
    if (typeof setTimeout !== 'function') return promise;
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), timeoutMs)),
    ]);
  }

  async function post(body) {
    let response;
    try {
      response = await withDeadline(fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', apikey: apiKey, authorization: 'Bearer ' + (token || apiKey) },
        body: JSON.stringify(body),
      }));
    } catch (error) {
      return { status: 0, ok: false, body: { error: 'Cannot reach the connections service.' } };
    }
    let parsed = null;
    try { parsed = JSON.parse(await response.text()); } catch { /* fall through */ }
    return { status: response.status, ok: response.ok, body: parsed || {} };
  }

  return {
    label: 'Kavi connections (Composio)',
    configured,
    hasToken: Boolean(token),

    async listTools() { return tools; },
    async describeTool(name) { return tools.find((t) => t.name === name) || null; },
    async toFunctionDeclarations() { return []; },

    // Run a Composio tool for the wearer — same result shape ComposioClient gave.
    async callTool(name, args) {
      if (!configured) return { ok: false, data: null, error: 'Sign-in is not configured (AUTH in config.js).' };
      if (!token) return { ok: false, data: null, error: 'Not signed in yet.', reason: 'signed-out' };
      const r = await post({ action: 'execute', tool: name, arguments: args || {} });
      if (r.ok && r.body.ok) return { ok: true, data: r.body.data, error: null, raw: r.body };
      if (r.body.reason === 'not-connected') {
        return { ok: false, data: null, error: 'Connect ' + (r.body.slug || 'that service') + ' — say “Kavi sign in”.', reason: 'not-connected' };
      }
      if (r.status === 401) return { ok: false, data: null, error: 'Signed out — say “Kavi sign in”.', reason: 'signed-out' };
      return { ok: false, data: null, error: r.body.error || ('HTTP ' + r.status), raw: r.body };
    },

    // For the sign-in / connections UI.
    async list() { return (await post({ action: 'list' })).body; },
    async status(slug) { return (await post({ action: 'status', slug })).body; },
  };
}
