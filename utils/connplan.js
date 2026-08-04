/**
 * Per-connection action logic for the `Kavi <connection> <action>` page (docs/16).
 *
 * Two pure functions keep the connection page generic:
 *   plan(slug, action)   -> { tool, args } | null   how to call the service
 *   render(slug, data)   -> { title, lines, spoken } how to show the result
 *
 * The result shapes Composio returns vary by tool and can change, so `render`
 * reads defensively: it hunts for the first array of items and pulls a title and
 * a subtitle from whichever common fields are present, rather than assuming one
 * schema. That keeps a new connection to a small entry here plus a registry line.
 */

/** Cap on how many rows a fixed-height card shows before "+N more". */
const MAX_ROWS = 5;

/* -------------------------------------------------------------------------- */
/* plan: action -> tool call                                                  */
/* -------------------------------------------------------------------------- */

export function plan(slug, action) {
  const a = String(action || '').trim();
  if (slug === 'gmail') {
    // GMAIL_FETCH_EMAILS takes a Gmail search `query`. A bare "Kavi gmail" shows
    // the last two days; a spoken phrase becomes the query ("from Tracy" works as
    // Gmail search, and "from:tracy" if the wearer says it that way).
    return { tool: 'GMAIL_FETCH_EMAILS', args: { query: a || 'newer_than:2d', max_results: MAX_ROWS } };
  }
  if (slug === 'slack') {
    // Reading Slack needs a channel; without one we can still fetch the wearer's
    // own recent activity. This is best-effort until a channel picker exists.
    return { tool: 'SLACK_FETCH_CONVERSATION_HISTORY', args: { limit: MAX_ROWS } };
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* render: result -> card                                                     */
/* -------------------------------------------------------------------------- */

/** First array of objects found anywhere in the result, so we don't hard-code a path. */
function firstList(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  const keys = ['messages', 'emails', 'items', 'results', 'data', 'threads', 'conversations'];
  for (const k of keys) {
    if (Array.isArray(data[k])) return data[k];
  }
  for (const v of Object.values(data)) {
    if (Array.isArray(v) && v.length && typeof v[0] === 'object') return v;
  }
  return [];
}

function pick(obj, keys) {
  for (const k of keys) {
    const v = obj && obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

function oneLine(s, max) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

export function render(slug, data) {
  const items = firstList(data);
  const label = slug === 'gmail' ? 'email' : slug === 'slack' ? 'message' : 'item';

  const lines = items.slice(0, MAX_ROWS).map((it, i) => {
    const title = oneLine(
      pick(it, ['subject', 'text', 'title', 'snippet', 'message', 'name', 'body']) || '(no subject)', 46);
    const subtitle = oneLine(
      pick(it, ['sender', 'from', 'user', 'author', 'fromName', 'from_email', 'date', 'timestamp']), 40);
    return { id: i, title, subtitle };
  });

  const n = items.length;
  const more = n > MAX_ROWS ? ' (showing ' + MAX_ROWS + ')' : '';
  const spoken = n
    ? 'You have ' + n + ' ' + label + (n === 1 ? '' : 's') + more + '.'
    : 'Nothing new.';

  return {
    title: n ? n + ' ' + label + (n === 1 ? '' : 's') : 'Nothing new',
    lines,
    hasLines: lines.length > 0,
    spoken,
  };
}
