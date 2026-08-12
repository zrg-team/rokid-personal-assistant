/**
 * Turning an arbitrary Composio result into a card the glasses can hold.
 *
 * A 448px single-green display shows ~4 rows. Composio returns wildly different
 * shapes per toolkit, and — verified — the `execute` handler used to return that
 * payload RAW: five HTML newsletters is ~135KB, past the size where the Ink
 * `fetch` promise never settles, so the card hangs. Every adapter projects here
 * instead, and the output is bounded BY CONSTRUCTION (fixed row count, clipped
 * fields), never by truncating a serialized blob.
 *
 * These helpers are the server-side port of the ones proven in utils/connplan.js.
 */

export interface Row {
  id: number;
  title: string;
  subtitle: string;
}

export interface Card {
  title: string;
  lines: Row[];
  hasLines: boolean;
  spoken: string;
}

/** How many rows the card holds. The display shows about this many. */
export const MAX_ROWS = 4;

/** One line, clipped to a column budget. No HTML, no newlines. */
export function oneLine(text: unknown, max = 46): string {
  const s = String(text ?? '')
    .replace(/<[^>]*>/g, ' ')      // strip any HTML a body field carries
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/**
 * The first array of objects found anywhere in the payload.
 *
 * Composio nests the useful list under a different key per toolkit; this finds
 * it without hard-coding a path, checking the common names first.
 */
export function firstList(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  if (!data || typeof data !== 'object') return [];
  const obj = data as Record<string, unknown>;
  const keys = ['messages', 'emails', 'items', 'results', 'data', 'threads', 'conversations', 'events'];
  for (const k of keys) {
    if (Array.isArray(obj[k])) return obj[k] as Record<string, unknown>[];
  }
  for (const v of Object.values(obj)) {
    if (Array.isArray(v) && v.length && typeof v[0] === 'object') return v as Record<string, unknown>[];
  }
  return [];
}

/** First non-empty string among `keys` on `obj`. */
export function pick(obj: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/**
 * The default projection: a list of {title, subtitle} rows and a spoken count.
 *
 * `noun` names the item ("email", "message") for the spoken summary. Adapters
 * with a richer shape override `project` entirely; most reuse this.
 */
export function listCard(
  data: unknown,
  noun: string,
  titleKeys: string[],
  subtitleKeys: string[],
): Card {
  const items = firstList(data);
  const n = items.length;

  const lines: Row[] = items.slice(0, MAX_ROWS).map((it, i) => ({
    id: i,
    title: oneLine(pick(it, titleKeys) || '(no ' + noun + ')', 40),
    subtitle: oneLine(pick(it, subtitleKeys), 40),
  }));

  const many = noun + 's';
  const more = n > MAX_ROWS ? ' (showing ' + MAX_ROWS + ')' : '';
  return {
    title: n ? n + ' ' + (n === 1 ? noun : many) : 'Nothing new',
    lines,
    hasLines: lines.length > 0,
    spoken: n ? 'You have ' + n + ' ' + (n === 1 ? noun : many) + more + '.' : 'Nothing new.',
  };
}

/** A one-line acknowledgement card — for writes and sends. */
export function ackCard(line: string, spoken?: string): Card {
  return {
    title: oneLine(line, 34),
    lines: [],
    hasLines: false,
    spoken: spoken || line,
  };
}
