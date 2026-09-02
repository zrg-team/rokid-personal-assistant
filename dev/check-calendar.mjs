#!/usr/bin/env node
/**
 * Ask the deployed backend to list calendar events, and print what actually
 * comes back.
 *
 * ## Why this exists
 *
 * On the glasses a failed calendar read is one line — *"Failed to list events,
 * Status 404"* — and that sentence is not ours. It is relayed from Composio,
 * through the `connections` Edge Function, through `utils/connections.js`, and
 * onto the card with every useful detail already discarded. A 404 could be any
 * of at least four different faults, and the HUD cannot tell you which:
 *
 *   1. the `connections` function is not deployed (Supabase's own 404);
 *   2. the tool slug is wrong, so Composio 404s the execute endpoint;
 *   3. Composio has no connected Google account for this wearer;
 *   4. Google returns 404 for the calendar id we asked for.
 *
 * This walks the same path the page does and prints the raw JSON at each hop, so
 * the four become distinguishable.
 *
 *   node dev/check-calendar.mjs                    # today
 *   node dev/check-calendar.mjs --date 2026-09-03  # a specific day
 *   node dev/check-calendar.mjs --raw              # dump full payloads
 *
 * Needs a device token — the one the glasses got at sign-in:
 *
 *   KAVI_DEV_TOKEN=<token> node dev/check-calendar.mjs
 *
 * Read it off a signed-in device from `localStorage['people-memory:device-token']`,
 * or complete a pairing with `dev/runtime.html`. Without it the backend answers
 * `signed-out` and that is all you will learn.
 */

import { AUTH, FACE, CONNECTIONS } from '../config.js';
import { dayListArgs, dayRange, todayKey } from '../utils/calendar.js';

const argv = process.argv.slice(2);
const RAW = argv.includes('--raw');
const date = argv[argv.indexOf('--date') + 1];
const DAY = argv.includes('--date') && date ? date : todayKey();

const TOKEN = process.env.KAVI_DEV_TOKEN || AUTH.devToken || '';
const PROJECT = String(AUTH.projectUrl || FACE.projectUrl || '').replace(/\/+$/, '');
const API_KEY = AUTH.apiKey || FACE.apiKey || '';

const line = (k, v) => console.log('  ' + (k + '                    ').slice(0, 20) + v);

function show(label, status, body) {
  console.log('\n── ' + label + '  →  HTTP ' + status + ' ─────────────────────');
  const text = JSON.stringify(body, null, RAW ? 2 : 0);
  console.log(RAW ? text : text.slice(0, 1200) + (text.length > 1200 ? ' …(--raw for all)' : ''));
}

async function post(body) {
  const endpoint = PROJECT + '/functions/v1/connections';
  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: API_KEY,
        authorization: 'Bearer ' + (TOKEN || API_KEY),
        ...(FACE.appKey ? { 'x-app-key': FACE.appKey } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    return { status: 0, body: { error: String((error && error.message) || error) } };
  }
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON is itself the answer: Supabase's gateway 404 for a function that
    // was never deployed comes back as plain text, not as a Composio error.
    parsed = { nonJson: text.slice(0, 400) };
  }
  return { status: res.status, body: parsed };
}

console.log('\n  Kavi — calendar path check');
console.log('  ─────────────────────────────────────────');
line('project', PROJECT || '(unset)');
line('api key', API_KEY ? API_KEY.slice(0, 12) + '…' : '(unset)');
line('device token', TOKEN ? TOKEN.slice(0, 8) + '…' : '(none — expect signed-out)');
line('day', DAY);

if (!PROJECT || PROJECT.includes('YOUR-PROJECT-REF')) {
  console.error('\n  config.js has no real projectUrl. Fill it in first.');
  process.exit(1);
}

const registry = (CONNECTIONS || []).find((c) => c.slug === 'googlecalendar');
const tool = (registry?.tools || []).find((t) => /EVENTS_LIST/.test(t.name))?.name
  || 'GOOGLECALENDAR_EVENTS_LIST';
line('tool', tool);

// 1. Is the function there at all, and is this token good?
const status = await post({ action: 'status' });
show('action=status', status.status, status.body);

if (status.status === 404) {
  console.log('\n  → A 404 HERE means the `connections` function is not deployed.');
  console.log('    Fix: npm run deploy');
}
if (status.status === 401 || status.body?.reason === 'signed-out') {
  console.log('\n  → Signed out. Set KAVI_DEV_TOKEN to a live device token.');
}

// 2. The actual call the schedule page makes, with the args it builds.
const args = dayListArgs(DAY, 'primary');
console.log('\n── arguments the page sends ──────────────────────────');
console.log(JSON.stringify(args, null, 2));

const exec = await post({ action: 'execute', tool, arguments: args });
show('action=execute ' + tool, exec.status, exec.body);

// 3. Same tool, no arguments at all. If this succeeds where the one above
//    fails, the fault is in the arguments — not the connection, the token, the
//    deployment or the tool slug. That is the single most useful comparison
//    here, because Composio's published schema for this tool is inconsistent
//    about camelCase vs snake_case and the error text names neither.
const bare = await post({ action: 'execute', tool, arguments: {} });
show('action=execute ' + tool + ' (no arguments)', bare.status, bare.body);

// 4. The casing probe. Composio's own docs disagree with themselves — the
//    toolkit page lists camelCase for this tool (calendarId/timeMin/timeMax)
//    while other pages list snake_case — and our own adapter is mixed, sending
//    snake_case for QUICK_ADD and camelCase for the list. Rather than pick by
//    coin flip, send BOTH and see which one comes back with events.
const range = dayRange(DAY);
const snake = {
  calendar_id: 'primary',
  time_min: range.timeMin,
  time_max: range.timeMax,
  single_events: true,
  order_by: 'startTime',
  max_results: 25,
};
const probe = await post({ action: 'execute', tool, arguments: snake });
show('action=execute ' + tool + ' (snake_case arguments)', probe.status, probe.body);

const okSnake = probe.body?.ok === true;
const countOf = (r) => {
  const d = r.body?.data;
  const items = d?.items || d?.data?.items || (Array.isArray(d) ? d : null);
  return Array.isArray(items) ? items.length : null;
};
console.log('');
console.log('── argument casing ─────────────────────────────────');
console.log('  camelCase (what we send today) : ' +
  (exec.body?.ok === true ? 'ok, ' + countOf(exec) + ' events' : 'FAILED'));
console.log('  snake_case                     : ' +
  (okSnake ? 'ok, ' + countOf(probe) + ' events' : 'FAILED'));
if (exec.body?.ok !== true && okSnake) {
  console.log('  → switch utils/calendar.js dayListArgs() and the adapter to snake_case.');
} else if (exec.body?.ok === true && countOf(exec) === 0 && countOf(probe) > 0) {
  console.log('  → camelCase is ACCEPTED BUT IGNORED (0 events vs ' + countOf(probe) + ').');
  console.log('    That is the worst case: no error, wrong answer. Switch to snake_case.');
}

console.log('\n── reading the result ────────────────────────────────');
const okExec = exec.body?.ok === true;
const okBare = bare.body?.ok === true;
if (okExec) {
  console.log('  Both fine — the calendar path works for this wearer and day.');
} else if (okBare && !okExec) {
  console.log('  The bare call works and the argued one does not:');
  console.log('  → the ARGUMENTS are the problem (utils/calendar.js dayListArgs).');
  console.log('    Compare the names above against the tool schema in the');
  console.log('    Composio dashboard for this auth config — that dashboard is');
  console.log('    authoritative; the public docs disagree with themselves.');
} else if (!okBare && !okExec) {
  console.log('  Neither works — so it is not the arguments. Look at the status');
  console.log('  block above: no connected account, wrong tool slug, or the');
  console.log('  function/toolkit is not set up for this wearer.');
}
console.log('');
