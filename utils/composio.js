/**
 * Composio client for AIUI agents.
 *
 * Two transports behind one interface, so page code never changes:
 *
 *   listTools()            -> [{ name, description, inputSchema }]
 *   callTool(name, args)   -> { ok, data, error, raw }
 *
 *   'mcp'  — MCP JSON-RPC 2.0 over Streamable HTTP against a Composio MCP
 *            server URL. Handles both plain-JSON and SSE-framed responses and
 *            carries the Mcp-Session-Id across calls.
 *   'rest' — Composio v3 REST: GET /api/v3/tools for discovery,
 *            POST /api/v3/tools/execute/{slug} for invocation.
 *
 * Deliberately uses only fetch / JSON / Promise so the same file runs on the
 * QuickJS (Ink) runtime on the glasses and in a browser dev harness.
 */

const MCP_PROTOCOL_VERSION = '2025-06-18';
const DEFAULT_TIMEOUT_MS = 15000;

/* -------------------------------------------------------------------------- */
/* helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Best-effort deadline on a request.
 *
 * `AbortController` is not in the verified AIUI surface and `setTimeout` is not
 * on every build, so this races a timer when there is one and otherwise just
 * waits. It does not cancel the underlying request — it stops the turn hanging
 * on it. Without this, the documented ~135 KB catalog hang and any dead-link
 * stall strand the card on "Checking your calendar" with no error at all.
 */
function withDeadline(promise, timeoutMs) {
  if (typeof setTimeout !== 'function' || !timeoutMs) return promise;
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Composio request timed out')), timeoutMs)),
  ]);
}

/**
 * Parse an MCP response body that may be either a JSON object or an SSE
 * stream of `data:` frames. Returns the first frame carrying a JSON-RPC
 * `result` or `error`.
 */
function parseRpcBody(body) {
  const text = (body || '').trim();
  if (!text) return null;

  if (text[0] === '{' || text[0] === '[') {
    try {
      return JSON.parse(text);
    } catch (e) {
      /* fall through to SSE parsing */
    }
  }

  // SSE framing: lines of `event: ...` / `data: ...`, frames split by blank line.
  const payloads = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const chunk = trimmed.slice(5).trim();
    if (!chunk || chunk === '[DONE]') continue;
    try {
      payloads.push(JSON.parse(chunk));
    } catch (e) {
      /* ignore non-JSON keepalive frames */
    }
  }
  if (!payloads.length) return null;
  return payloads.find((p) => p && (p.result !== undefined || p.error !== undefined)) || payloads[payloads.length - 1];
}

/**
 * Composio surfaces upstream failures as a string containing the provider's
 * JSON error. Dig out the human sentence — a glasses wearer must not hear a
 * serialized Google API payload read aloud.
 */
export function friendlyError(error) {
  if (!error) return 'Unknown error';
  if (typeof error === 'object') {
    return String(error.message || error.error || JSON.stringify(error)).slice(0, 200);
  }

  const text = String(error);
  const start = text.indexOf('{');
  if (start !== -1) {
    try {
      const parsed = JSON.parse(text.slice(start));
      const inner = parsed.error || parsed;
      if (inner.message) return String(inner.message);
      if (Array.isArray(inner.errors) && inner.errors[0] && inner.errors[0].message) {
        return String(inner.errors[0].message);
      }
    } catch (e) {
      /* not JSON after all — fall through */
    }
  }
  return text.length > 200 ? text.slice(0, 200) + '…' : text;
}

/** Strip schema noise the on-device model does not need. */
function slimSchema(schema, maxProps) {
  if (!schema || typeof schema !== 'object') {
    return { type: 'object', properties: {} };
  }
  const required = Array.isArray(schema.required) ? schema.required : [];
  const source = schema.properties || {};

  // Required properties first, then the rest, capped.
  const ordered = Object.keys(source).sort((a, b) => {
    const ra = required.indexOf(a) === -1 ? 1 : 0;
    const rb = required.indexOf(b) === -1 ? 1 : 0;
    return ra - rb;
  });

  const properties = {};
  for (const key of ordered.slice(0, maxProps || 12)) {
    const prop = source[key] || {};
    const cleaned = { type: prop.type || 'string' };
    if (prop.description) cleaned.description = String(prop.description).slice(0, 220);
    if (prop.enum) cleaned.enum = prop.enum;
    if (prop.items) cleaned.items = { type: (prop.items && prop.items.type) || 'string' };
    properties[key] = cleaned;
  }

  return {
    type: 'object',
    properties,
    required: required.filter((r) => properties[r]),
  };
}

/* -------------------------------------------------------------------------- */
/* MCP transport                                                              */
/* -------------------------------------------------------------------------- */

class McpTransport {
  constructor(config) {
    this.url = config.mcpUrl;
    this.sessionId = null;
    this.initialized = false;
    this.nextId = 1;
    this.timeoutMs = config.timeoutMs || DEFAULT_TIMEOUT_MS;
  }

  get label() {
    return 'Composio MCP';
  }

  async rpc(method, params, isNotification) {
    const id = this.nextId++;
    const payload = isNotification
      ? { jsonrpc: '2.0', method, params: params || {} }
      : { jsonrpc: '2.0', id, method, params: params || {} };

    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': MCP_PROTOCOL_VERSION,
    };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;

    const response = await withDeadline(fetch(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    }), this.timeoutMs);

    // The server assigns the session on `initialize`; reuse it from then on.
    const assigned = response.headers && response.headers.get && response.headers.get('mcp-session-id');
    if (assigned) this.sessionId = assigned;

    if (isNotification) return null;

    const body = await response.text();
    if (!response.ok) {
      throw new Error('MCP ' + method + ' failed: HTTP ' + response.status + ' ' + body.slice(0, 300));
    }

    const message = parseRpcBody(body);
    if (!message) throw new Error('MCP ' + method + ': empty or unparseable response');
    if (message.error) {
      throw new Error('MCP ' + method + ': ' + (message.error.message || JSON.stringify(message.error)));
    }
    return message.result;
  }

  async ensureInitialized() {
    if (this.initialized) return;
    await this.rpc('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'rokid-aiui-people-memory', version: '1.0.0' },
    });
    await this.rpc('notifications/initialized', {}, true);
    this.initialized = true;
  }

  async listTools() {
    await this.ensureInitialized();
    const tools = [];
    let cursor;
    do {
      const result = await this.rpc('tools/list', cursor ? { cursor } : {});
      for (const tool of result.tools || []) {
        tools.push({
          name: tool.name,
          description: tool.description || '',
          inputSchema: tool.inputSchema || { type: 'object', properties: {} },
        });
      }
      cursor = result.nextCursor;
    } while (cursor);
    return tools;
  }

  async callTool(name, args) {
    await this.ensureInitialized();
    const result = await this.rpc('tools/call', { name, arguments: args || {} });

    // MCP returns content blocks; Composio puts its JSON payload in a text block.
    let data = result.structuredContent || null;
    if (!data) {
      const textBlock = (result.content || []).find((c) => c && c.type === 'text');
      if (textBlock) {
        try {
          data = JSON.parse(textBlock.text);
        } catch (e) {
          data = { text: textBlock.text };
        }
      }
    }
    // Composio nests its own {data, successful, error} envelope inside.
    if (data && data.successful !== undefined) {
      return { ok: !!data.successful && !result.isError, data: data.data, error: data.error, raw: result };
    }
    return { ok: !result.isError, data, error: result.isError ? 'tool reported an error' : null, raw: result };
  }
}

/* -------------------------------------------------------------------------- */
/* REST transport                                                             */
/* -------------------------------------------------------------------------- */

class RestTransport {
  constructor(config) {
    this.base = String(config.restBaseUrl || '').replace(/\/+$/, '');
    this.apiKey = config.apiKey || '';
    this.userId = config.userId;
    this.connectedAccountId = config.connectedAccountId || '';
    this.toolkits = config.toolkits || [];
    this.preferred = config.preferredTools || [];
    this.allowlist = config.toolAllowlist || null;
    this.maxTools = config.maxTools || 12;
    this.timeoutMs = config.timeoutMs || DEFAULT_TIMEOUT_MS;
  }

  get label() {
    return 'Composio REST (v3)';
  }

  headers() {
    const h = { 'content-type': 'application/json' };
    // Omitted in dev, where a local proxy injects the key server-side.
    if (this.apiKey) h['x-api-key'] = this.apiKey;
    return h;
  }

  async listTools() {
    const collected = [];

    for (const toolkit of this.toolkits) {
      const url = this.base + '/api/v3/tools?toolkit_slug=' + encodeURIComponent(toolkit) + '&limit=100';
      const response = await withDeadline(fetch(url, { headers: this.headers() }), this.timeoutMs);
      const body = await response.text();
      if (!response.ok) {
        throw new Error('Composio tools list failed: HTTP ' + response.status + ' ' + body.slice(0, 300));
      }
      const parsed = JSON.parse(body);
      for (const tool of parsed.items || []) {
        collected.push({
          name: tool.slug,
          description: tool.description || tool.human_description || tool.name || '',
          inputSchema: tool.input_parameters || { type: 'object', properties: {} },
        });
      }
    }

    return collected;
  }

  /** GET one tool definition — a few KB, versus ~135 KB for the catalog. */
  async describeTool(name) {
    const url = this.base + '/api/v3/tools/' + encodeURIComponent(name);
    const response = await withDeadline(fetch(url, { headers: this.headers() }), this.timeoutMs);
    if (!response.ok) return null;
    const tool = JSON.parse(await response.text());
    return {
      name: tool.slug || name,
      description: tool.description || tool.name || '',
      inputSchema: tool.input_parameters || { type: 'object', properties: {} },
    };
  }

  async callTool(name, args) {
    const url = this.base + '/api/v3/tools/execute/' + encodeURIComponent(name);

    // Composio resolves the stored OAuth credentials from user_id — no token
    // ever reaches the device. connected_account_id only narrows the choice,
    // and Composio rejects it without a user_id, so both go together.
    const payload = { user_id: this.userId, arguments: args || {} };
    if (this.connectedAccountId) payload.connected_account_id = this.connectedAccountId;

    const response = await withDeadline(fetch(url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(payload),
    }), this.timeoutMs);
    const body = await response.text();

    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (e) {
      throw new Error('Composio execute returned non-JSON: HTTP ' + response.status + ' ' + body.slice(0, 200));
    }

    if (!response.ok) {
      const message = (parsed.error && (parsed.error.message || parsed.error)) || 'HTTP ' + response.status;
      return { ok: false, data: null, error: String(message), raw: parsed };
    }
    return {
      ok: parsed.successful !== false,
      data: parsed.data,
      error: parsed.error || null,
      raw: parsed,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* public client                                                              */
/* -------------------------------------------------------------------------- */

export class ComposioClient {
  constructor(config) {
    this.config = config;
    this.transport =
      config.transport === 'mcp' && config.mcpUrl ? new McpTransport(config) : new RestTransport(config);
    this.tools = null;
  }

  get label() {
    return this.transport.label;
  }

  /**
   * The tools available this session.
   *
   * When an allowlist is configured this is answered locally and NO catalog
   * request is made. That is not just an optimization: the catalog response for
   * one toolkit is ~135 KB, and the Ink runtime's `fetch` does not resolve for
   * a body that large — the promise simply never settles and the whole turn
   * strands on "Checking your calendar" with no error and no further requests.
   * Calendar payloads (~10 KB) are fine, which is why only the paths that
   * discover tools were affected.
   *
   * The rule planner only needs tool names, so names are enough. Schemas are
   * fetched one tool at a time (small responses) by `toFunctionDeclarations()`,
   * and only when the on-device model is actually in use.
   */
  async listTools(force) {
    if (this.tools && !force) return this.tools;

    const allowlist = this.config.toolAllowlist;
    if (allowlist && allowlist.length) {
      this.tools = allowlist.map((name) => ({
        name,
        description: '',
        inputSchema: { type: 'object', properties: {} },
      }));
      return this.tools;
    }

    this.tools = this.narrow(await this.transport.listTools());
    return this.tools;
  }

  /** Fetch one tool's schema. Small response, unlike the full catalog. */
  async describeTool(name) {
    if (this.transport.describeTool) return this.transport.describeTool(name);
    const all = await this.transport.listTools();
    return all.find((t) => t.name === name) || null;
  }

  /**
   * Keep only allowed tools, in the configured order. A small on-device model
   * picks far better from three relevant tools than from twenty-eight. Applied
   * here rather than per-transport so MCP and REST behave identically.
   */
  narrow(discovered) {
    const allowlist = this.config.toolAllowlist;
    const preferred = this.config.preferredTools || [];

    let tools = discovered || [];
    if (allowlist && allowlist.length) {
      tools = tools.filter((tool) => allowlist.indexOf(tool.name) !== -1);
    }

    tools.sort((a, b) => {
      const ia = preferred.indexOf(a.name);
      const ib = preferred.indexOf(b.name);
      return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
    });

    return tools.slice(0, this.config.maxTools || 12);
  }

  /**
   * Shape discovered tools into AIUI LanguageModel function declarations.
   * Pulls each schema individually so the oversized catalog is never fetched.
   */
  async toFunctionDeclarations() {
    const names = (await this.listTools()).map((t) => t.name);
    const tools = [];
    for (const name of names) {
      const described = await this.describeTool(name);
      if (described) tools.push(described);
    }
    return tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: String(tool.description || '').slice(0, 300),
        parameters: slimSchema(tool.inputSchema, 12),
      },
    }));
  }

  callTool(name, args) {
    return this.transport.callTool(name, args);
  }
}

export { parseRpcBody, slimSchema };
