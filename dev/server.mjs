/**
 * Local dev harness for the People Memory agent.
 *
 *   node dev/server.mjs   ->  http://localhost:5178/dev/preview.html
 *
 * Two jobs:
 *   1. Serve the project as ES modules so dev/preview.html imports the very
 *      same utils/*.js the glasses run — the preview exercises real app code,
 *      not a reimplementation.
 *   2. Proxy /composio/* to Composio and attach the API key server-side. The
 *      key never reaches browser JS, and it sidesteps CORS on the Composio API.
 */

import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { extname, join, normalize, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = normalize(join(fileURLToPath(new URL('.', import.meta.url)), '..'));
const PORT = Number(process.env.PORT || 5178);
// Dev-only: what the mock pair endpoint reports on poll. 'approved' drives the
// whole flow; set PAIR_MOCK_STATUS=pending to hold the sign-in card on its
// "waiting for your phone" state (handy for screenshots).
const PAIR_MOCK_STATUS = process.env.PAIR_MOCK_STATUS || 'approved';
const DIST_DIR = join(ROOT, 'dist');
/**
 * Demo mode (`KAVI_DEMO=1`), used by `npm run shots`.
 *
 * The store's preview media has to show populated cards, and the pages only
 * populate from the backend — which needs a deployed Supabase project and a
 * completed phone sign-in. In demo mode this server answers the four Edge
 * Function routes itself with the fixed sample cast below, so the *real* pages,
 * running on the *real* Ink runtime, render a full agenda and a full roster
 * offline and identically on every run.
 *
 * It is opt-in, lives in dev/ (excluded from the .aix), and rewrites only the
 * copy of config.js served to the harness — never the file on disk.
 */
const DEMO = process.env.KAVI_DEMO === '1';
// The old /composio proxy is retired (the glasses read calendar through the
// `connections` Edge Function now, docs/14). Kept only so an old harness that
// still points here does not 500; no key is injected.
const UPSTREAM = 'https://backend.composio.dev';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  // Required for WebAssembly.instantiateStreaming; without it the Ink SDK
  // falls back to the slower non-streaming compile path.
  '.wasm': 'application/wasm',
  '.ink': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Forward to Composio with the key injected, and log the call for the console. */
async function proxyComposio(req, res, url) {
  const target = UPSTREAM + url.pathname.replace(/^\/composio/, '') + (url.search || '');
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);

  const started = Date.now();
  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.COMPOSIO_API_KEY || '',
      },
      body,
    });

    const text = await upstream.text();
    console.log(
      '  → %s %s  %d  %dms  %db',
      req.method,
      target.replace(UPSTREAM, ''),
      upstream.status,
      Date.now() - started,
      text.length
    );

    // Surface what the runtime actually sent, and why Composio refused it.
    if (body && body.length) {
      try {
        console.log('    args %s', JSON.stringify(JSON.parse(body.toString()).arguments));
      } catch (e) {
        /* not JSON */
      }
    }
    if (text.indexOf('"successful":false') !== -1 || text.indexOf('"error"') !== -1) {
      try {
        const parsed = JSON.parse(text);
        if (parsed.error || parsed.successful === false) {
          console.log('    ✗ %s', String(parsed.error || JSON.stringify(parsed.data)).slice(0, 400));
        }
      } catch (e) {
        /* ignore */
      }
    }

    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') || 'application/json',
      'cache-control': 'no-store',
    });
    res.end(text);
  } catch (error) {
    console.error('  ✗ proxy error', error.message);
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'proxy failed: ' + error.message } }));
  }
}

/**
 * Collect the agent's own source as an in-memory Ink bundle.
 *
 * This is what `view.openBundle()` consumes, so the real WASM runtime parses
 * the actual .ink files — templates, WXSS and `script def` included. Only the
 * agent's files go in; dev/, node_modules/ and .claude/ stay out of the bundle.
 */
const BUNDLE_ROOTS = ['app.js', 'app.json', 'config.js', 'AGENTS.md', 'utils', 'pages'];

async function collectFiles(dir, out) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await collectFiles(full, out);
    else out.push(full);
  }
}

async function serveBundle(res) {
  const paths = [];
  for (const root of BUNDLE_ROOTS) {
    const full = join(ROOT, root);
    try {
      const stat = await readdir(full).then(() => true).catch(() => false);
      if (stat) await collectFiles(full, paths);
      else paths.push(full);
    } catch (e) {
      /* optional file */
    }
  }

  const files = {};
  for (const path of paths) {
    let text;
    try {
      text = await readFile(path, 'utf8');
    } catch (e) {
      continue;
    }

    // Dev-only rewrite: point the bundle at the local proxy so the API key
    // stays server-side and the runtime is not subject to Composio CORS.
    if (relative(ROOT, path) === 'config.js') {
      text = text
        .replace(/restBaseUrl:\s*'[^']*'/, "restBaseUrl: 'http://localhost:" + PORT + "/composio'")
        .replace(/apiKey:\s*'[^']*'/, "apiKey: ''")
        // The harness reads the SPOKEN panel from the console, so keep full
        // speech logging on for the local bundle only. Device builds stay
        // redacted (see config.DEBUG.logSpeech).
        .replace(/logSpeech:\s*false/, 'logSpeech: true')
        // Dev-only: inject a device token so the harness can render real
        // connection data without a full phone sign-in. Empty unless set.
        .replace(/devToken:\s*'[^']*'/, "devToken: '" + (process.env.KAVI_DEV_TOKEN || '') + "'")
        // Dev-only: point the face page at the harness camera stand-in, so the
        // shipped config can keep devCameraUrl empty (there is no web camera).
        .replace(/devCameraUrl:\s*'[^']*'/, "devCameraUrl: 'http://localhost:" + PORT + "/dev-camera'");

      // KAVI_DEMO=1 only: aim the whole backend at this server's demo
      // endpoints, so `npm run shots` can photograph populated cards with no
      // Supabase project and no phone sign-in. Off by default, and dev/ is
      // excluded from the .aix either way — nothing here can reach a build.
      if (DEMO) {
        text = text
          .replace(/projectUrl:\s*'https:\/\/[^']*'/g, "projectUrl: 'http://localhost:" + PORT + "'")
          .replace(/apiKey:\s*'[^']*'/g, "apiKey: 'demo-key'")
          .replace(/required:\s*true/, 'required: false')
          .replace(/devToken:\s*'[^']*'/, "devToken: 'demo-token'");
      }
    }

    files[relative(ROOT, path).split(sep).join('/')] = text;
  }

  console.log('  ⬡ bundle served — %d files', Object.keys(files).length);
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ appId: 'people-memory', files }));
}

async function serveStatic(res, url) {
  const rel = decodeURIComponent(url.pathname === '/' ? '/dev/preview.html' : url.pathname);
  const target = normalize(join(ROOT, rel));

  // Never serve outside the project root.
  if (!target.startsWith(ROOT + sep) && target !== ROOT) {
    res.writeHead(403).end('forbidden');
    return;
  }

  // @yodaos-pkg/aix imports './pkg/aix_web' with no extension, which a browser
  // will not resolve. Fall back to the .js file so the module graph loads.
  const candidates = extname(target) ? [target] : [target, target + '.js', join(target, 'index.js')];

  for (const candidate of candidates) {
    try {
      let file = await readFile(candidate);

      // Demo mode: point the phone console at THIS server instead of the live
      // Supabase project, so web/kavi-connect can be opened and photographed
      // offline. Only the served copy is rewritten; the file on disk (and the
      // submodule it belongs to) is untouched.
      if (DEMO && relative(ROOT, candidate).split(sep).join('/') === 'web/kavi-connect/index.html') {
        file = Buffer.from(String(file)
          .replace(/const FN = '[^']*'/, "const FN = 'http://localhost:" + PORT + "'")
          .replace(/const APP_KEY = '[^']*'/, "const APP_KEY = ''"));
      }
      res.writeHead(200, {
        'content-type': MIME[extname(candidate)] || 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(file);
      return;
    } catch (error) {
      /* try the next candidate */
    }
  }
  res.writeHead(404, { 'content-type': 'text/plain' }).end('not found: ' + rel);
}

/**
 * The stand-in camera roll.
 *
 * The web build of Ink has no camera provider, so `createCameraContext()`
 * refuses and the face page can never be exercised in the harness. This holds
 * one uploaded photo in memory: the harness PUTs it here, and the page fetches
 * it through the same `takePhoto()` call site it uses on the glasses. Nothing is
 * written to disk — it is a test fixture, not a feature.
 */
let devPhoto = null;

async function handleDevCamera(req, res) {
  if (req.method === 'PUT' || req.method === 'POST') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    devPhoto = Buffer.concat(chunks);
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify({ ok: true, bytes: devPhoto.length }));
    return;
  }

  if (req.method === 'DELETE') {
    devPhoto = null;
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (!devPhoto && DEMO) {
    // Demo mode has no harness to choose a photo in, and the demo `face`
    // endpoint never looks at the pixels — it only needs the capture path to
    // hand it some bytes. A 1x1 JPEG is enough to carry it through.
    devPhoto = Buffer.from(
      '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
      'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
      'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
      'base64'
    );
  }

  if (!devPhoto) {
    // 404 rather than an empty body: the page reports "no photo loaded" instead
    // of sending zero bytes to the recogniser and getting a confusing answer.
    res.writeHead(404, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
    res.end('no photo loaded — choose one in the harness');
    return;
  }

  res.writeHead(200, {
    'content-type': 'image/jpeg',
    'content-length': devPhoto.length,
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(devPhoto);
}

/* ── Demo backend (KAVI_DEMO=1) ──────────────────────────────────────────────
 *
 * Stands in for the four Edge Functions with a fixed cast, so the capture run
 * is deterministic: the same agenda and the same roster every time, which is
 * what makes a re-shot screenshot comparable to the one before it.
 *
 * The people are invented. Times are built relative to *now* so the agenda
 * always looks like a live day rather than a stale fixture. */

const DEMO_PEOPLE = [
  { id: 'p1', name: 'Tracy Lam', note: 'runs the security review', email: '' },
  { id: 'p2', name: 'Kevin Ortiz', note: 'prefers email over calls', email: '' },
  { id: 'p3', name: 'Mai Nguyen', note: 'met at the Hanoi offsite', email: '' },
  { id: 'p4', name: 'David Park', note: 'design partner on the HUD', email: '' },
  { id: 'p5', name: 'Sarah Weiss', note: '', email: '' },
];

/** An ISO timestamp `hour:minute` local time today, with the offset kept. */
function todayAt(hour, minute) {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  const pad = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:00` +
    `${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

function demoEvents() {
  const ev = (id, summary, from, to, extra) => ({
    id, status: 'confirmed', summary,
    start: { dateTime: todayAt(from[0], from[1]) },
    end: { dateTime: todayAt(to[0], to[1]) },
    ...extra,
  });
  return {
    items: [
      ev('e1', 'Standup', [9, 30], [9, 45], {
        location: 'Meet',
        hangoutLink: 'https://meet.google.com/demo-stand-up',
        attendees: [
          { email: 'you@example.com', self: true },
          { email: 'kevin@example.com', displayName: 'Kevin Ortiz' },
          { email: 'mai@example.com', displayName: 'Mai Nguyen' },
        ],
      }),
      ev('e2', 'Security review with Tracy', [11, 0], [12, 0], {
        location: 'Room 4B',
        attendees: [
          { email: 'you@example.com', self: true },
          { email: 'tracy@example.com', displayName: 'Tracy Lam' },
        ],
      }),
      ev('e3', 'Lunch with Mai', [12, 30], [13, 30], { location: 'Cafe Lam' }),
      ev('e4', 'HUD design sync', [15, 0], [16, 0], {
        location: 'Meet',
        hangoutLink: 'https://meet.google.com/demo-hud-sync',
        attendees: [
          { email: 'you@example.com', self: true },
          { email: 'david@example.com', displayName: 'David Park' },
        ],
      }),
    ],
  };
}

/* The console's own routes, for previewing web/kavi-connect offline. Demo mode
   only; the real ones live in supabase/functions/console. */
const DEMO_SERVICES = [
  { slug: 'googlecalendar', name: 'Google Calendar', icon: '\u{1F4C5}', tools: [
    { name: 'GOOGLECALENDAR_EVENTS_LIST', label: 'List events for a day', risk: 'read', fields: [
      { key: 'calendarId', label: 'Calendar', type: 'text', default: 'primary' },
      { key: '_day', label: 'Which day', type: 'day', default: 'today',
        expands: { timeMin: 'start', timeMax: 'end' },
        choices: [
          { value: 'today', label: 'Today' }, { value: 'tomorrow', label: 'Tomorrow' },
          { value: 'friday', label: 'Friday' }, { value: '+7', label: 'In a week' },
        ] },
      { key: 'maxResults', label: 'How many at most', type: 'number', default: 25 },
    ] },
    { name: 'GOOGLECALENDAR_QUICK_ADD', label: 'Add an event', risk: 'self', fields: [
      { key: 'text', label: 'What to add', type: 'text', required: true },
    ] },
  ] },
  { slug: 'gmail', name: 'Gmail', icon: '\u2709\uFE0F', tools: [
    { name: 'GMAIL_FETCH_EMAILS', label: 'Fetch emails', risk: 'read', fields: [
      { key: 'query', label: 'Gmail search', type: 'text', default: 'newer_than:2d' },
      { key: 'max_results', label: 'How many at most', type: 'number', default: 4 },
    ] },
  ] },
  { slug: 'googletasks', name: 'Google Tasks', icon: '\u2705', tools: [
    { name: 'GOOGLETASKS_LIST_TASKS', label: 'List my tasks', risk: 'read', fields: [
      { key: 'maxResults', label: 'How many at most', type: 'number', default: 10 },
      { key: 'showCompleted', label: 'Include finished ones', type: 'boolean', default: false },
    ] },
  ] },
  { slug: 'notion', name: 'Notion', icon: '\u{1F4D3}', tools: [
    { name: 'NOTION_SEARCH_NOTION_PAGE', label: 'Search my pages', risk: 'read', fields: [
      { key: 'query', label: 'Search for', type: 'text' },
    ] },
  ] },
  { slug: 'linear', name: 'Linear', icon: '\u{1F4D0}', tools: [
    { name: 'LINEAR_LIST_LINEAR_ISSUES', label: 'List issues', risk: 'read', fields: [
      { key: 'first', label: 'How many at most', type: 'number', default: 5 },
    ] },
  ] },
];

const DEMO_CONNECTIONS = [
  { slug: 'googlecalendar', name: 'Google Calendar', summary: 'Read your day, answer calendar questions, and add events', category: 'Productivity', icon: '\u{1F4C5}', connected: true, status: 'ACTIVE', bindings: [], chosen: [] },
  { slug: 'gmail', name: 'Gmail', summary: 'Read and search your inbox, and send by voice', category: 'Communication', icon: '\u2709\uFE0F', connected: true, status: 'ACTIVE', bindings: [], chosen: [] },
  { slug: 'slack', name: 'Slack', summary: 'Catch up on a channel and post to it', category: 'Communication', icon: '\u{1F4AC}', connected: true, status: 'ACTIVE',
    bindings: [{ key: 'channel', label: 'Default channel', listTool: 'SLACK_LIST_ALL_CHANNELS' }], chosen: [] },
  { slug: 'googletasks', name: 'Google Tasks', summary: 'Read what is on your list, and add to it by voice', category: 'Productivity', icon: '\u2705', connected: true, status: 'ACTIVE',
    bindings: [{ key: 'tasklist', label: 'Which list', listTool: 'GOOGLETASKS_LIST_TASK_LISTS' }],
    chosen: [{ key: 'tasklist', value: 'MTIz', label: 'My Tasks' }] },
  { slug: 'notion', name: 'Notion', summary: 'Find a page, or capture a line into your inbox page', category: 'Productivity', icon: '\u{1F4D3}', connected: false, status: 'none',
    bindings: [{ key: 'page', label: 'Capture into', listTool: 'NOTION_FETCH_DATA' }], chosen: [] },
  { slug: 'linear', name: 'Linear', summary: 'See what is assigned to you, and file a new issue', category: 'Engineering', icon: '\u{1F4D0}', connected: false, status: 'none',
    bindings: [{ key: 'team', label: 'Which team', listTool: 'LINEAR_LIST_LINEAR_TEAMS' }], chosen: [] },
];

const DEMO_ALIASES = [
  { phrase: 'google calendar tomorrow', kind: 'action', slug: 'googlecalendar',
    action: '', tool: 'GOOGLECALENDAR_EVENTS_LIST',
    args: { calendarId: 'primary', timeMin: '{{start:tomorrow}}', timeMax: '{{end:tomorrow}}' } },
  { phrase: 'inbox', kind: 'shortcut', slug: 'gmail', action: 'newer_than:2d', tool: '', args: {} },
  { phrase: 'my list', kind: 'app', slug: 'googletasks', action: '', tool: '', args: {} },
];

async function handleDemoConsole(req, res) {
  const body = JSON.parse((await readBody(req)).toString() || '{}');
  const send = (o) => {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify(o));
  };
  switch (body.action) {
    case 'tools':
      // KAVI_OLD_BACKEND=1 simulates a project that has not been redeployed
      // yet, so the console's fallback can be exercised: `tools` is newer than
      // the routes beside it, and the Shortcuts tab has to survive its absence
      // rather than showing an error to everyone mid-deploy.
      if (process.env.KAVI_OLD_BACKEND) return send({ ok: false, error: 'unknown action' });
      return send({ ok: true, services: DEMO_SERVICES });
    case 'connections': return send({ ok: true, connections: DEMO_CONNECTIONS });
    case 'aliases': return send({ ok: true, aliases: DEMO_ALIASES });
    case 'people': return send({ ok: true, people: DEMO_PEOPLE.map((p) => ({ ...p, seen_count: 3, last_seen_at: new Date().toISOString() })) });
    case 'binding.list': return send({ ok: true, options: [
      { value: 'C123', label: '#engineering' }, { value: 'C456', label: '#design' },
      { value: 'C789', label: '#general' },
    ] });
    case 'binding.set': return send({ ok: true });
    case 'alias.add': return send({ ok: true, phrase: body.phrase, kind: body.tool ? 'action' : 'app', slug: body.slug });
    case 'alias.remove': return send({ ok: true });
    case 'signin-status': return send({ ok: true, approved: true });
    default: return send({ ok: true });
  }
}

async function handleDemoBackend(req, res, url) {
  const send = (o, status) => {
    res.writeHead(status || 200, {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
    });
    res.end(JSON.stringify(o));
  };
  const body = req.method === 'POST'
    ? JSON.parse((await readBody(req)).toString() || '{}')
    : {};
  const fn = url.pathname.replace('/functions/v1/', '').split('?')[0];

  if (fn === 'pair') {
    if (body.action === 'start') {
      return send({
        ok: true, device_code: 'demo-code', user_code: 'coral-ivory-24',
        verification_url: 'https://kavi.link/go', expires_in: 600, interval: 3,
      });
    }
    if (body.action === 'poll') return send({ ok: true, status: PAIR_MOCK_STATUS, confirm_word: 'brave-otter' });
    if (body.action === 'claim') return send({ ok: true, status: 'claimed', token: 'demo-token', owner_id: 'demo' });
    return send({ ok: true, status: 'ok' });
  }

  if (fn === 'face-people') {
    if (req.method === 'DELETE') return send({ ok: true, removed: 1 });
    if (req.method === 'POST') return send({ ok: true, person: DEMO_PEOPLE[0] });
    return send({ ok: true, people: DEMO_PEOPLE, count: DEMO_PEOPLE.length });
  }

  if (fn === 'face') {
    if (body.warmup) return send({ ok: true, warm: true });
    if (body.mode === 'remember') {
      return send({ ok: true, known: true, person: { id: 'p1', name: body.name || 'Tracy Lam', note: body.note || '' } });
    }
    // identify
    return send({
      ok: true, known: true, score: 0.91,
      person: DEMO_PEOPLE[0],
      lines: ['runs the security review', 'Security review · 11:00'],
    });
  }

  if (fn === 'connections') {
    if (body.action === 'status') {
      return send({ ok: true, connections: [{ slug: 'googlecalendar', status: 'connected' }] });
    }
    if (body.action === 'execute') {
      return send({ ok: true, data: demoEvents() });
    }
    return send({ ok: true });
  }

  return send({ ok: false, error: 'unknown demo route: ' + fn }, 404);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:' + PORT);

  if (DEMO && url.pathname === '/console') {
    await handleDemoConsole(req, res);
    return;
  }
  if (DEMO && url.pathname.startsWith('/functions/v1/')) {
    await handleDemoBackend(req, res, url);
    return;
  }

  if (url.pathname === '/composio' || url.pathname.startsWith('/composio/')) {
    await proxyComposio(req, res, url);
    return;
  }
  // Lets dev/aix-check.html find the current build instead of guessing a name.
  if (url.pathname === '/dist-list') {
    let names = [];
    try {
      names = (await readdir(DIST_DIR)).filter((n) => n.endsWith('.aix'));
    } catch (e) {
      /* nothing built yet */
    }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(names));
    return;
  }
  if (url.pathname === '/dev-camera') {
    await handleDevCamera(req, res);
    return;
  }
  // Dev-only stand-in for the `pair` Edge Function, so dev/runtime.html can
  // render the real sign-in page's states (waiting → approved → signed in)
  // without the Supabase backend deployed. runtime.html rewrites the pair URL
  // here. Never ships — dev/ is excluded from the .aix.
  if (url.pathname === '/mock-pair') {
    const body = req.method === 'POST' ? JSON.parse((await readBody(req)).toString() || '{}') : {};
    const reply = (o) => {
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify(o));
    };
    if (body.action === 'start') return reply({ ok: true, device_code: 'dev-code',
      user_code: 'green-tiger-42',
      verification_url: 'https://qnjqghqjdyqrpifrbbdf.supabase.co/functions/v1/pair',
      expires_in: 600, interval: 3 });
    if (body.action === 'poll') return reply({ ok: true, status: PAIR_MOCK_STATUS, confirm_word: 'brave-otter' });
    if (body.action === 'claim') return reply({ ok: true, status: 'claimed', token: 'dev-token', owner_id: 'default' });
    return reply({ ok: false, error: 'signed out' });
  }
  if (url.pathname === '/bundle') {
    await serveBundle(res);
    return;
  }
  await serveStatic(res, url);
});

server.listen(PORT, () => {
  console.log('');
  console.log('  People Memory — dev preview');
  console.log('  ──────────────────────────────────────────────');
  console.log('  runtime   http://localhost:' + PORT + '/dev/runtime.html   ← real Ink WASM');
  console.log('  preview   http://localhost:' + PORT + '/dev/preview.html');
  console.log('  calendar & connections read through the Kavi backend (docs/14)');
  console.log('');
});
