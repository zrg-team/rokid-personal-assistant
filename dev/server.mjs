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

import { composioConfig } from '../config.js';

const ROOT = normalize(join(fileURLToPath(new URL('.', import.meta.url)), '..'));
const PORT = Number(process.env.PORT || 5178);
// Dev-only: what the mock pair endpoint reports on poll. 'approved' drives the
// whole flow; set PAIR_MOCK_STATUS=pending to hold the sign-in card on its
// "waiting for your phone" state (handy for screenshots).
const PAIR_MOCK_STATUS = process.env.PAIR_MOCK_STATUS || 'approved';
const DIST_DIR = join(ROOT, 'dist');
const UPSTREAM = composioConfig.restBaseUrl;

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
        'x-api-key': composioConfig.apiKey,
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
        .replace(/logSpeech:\s*false/, 'logSpeech: true');
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
      const file = await readFile(candidate);
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

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:' + PORT);

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
  console.log('  proxy     /composio/*  →  ' + UPSTREAM);
  console.log('  key       ' + composioConfig.apiKey.slice(0, 8) + '… (server-side only)');
  console.log('  user      ' + composioConfig.userId);
  console.log('  toolkits  ' + composioConfig.toolkits.join(', '));
  console.log('');
});
