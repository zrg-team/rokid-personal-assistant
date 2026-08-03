/**
 * One voice turn: utterance -> Composio tool call -> renderable rows + speech.
 *
 * Page code stays declarative — it feeds an utterance in and binds whatever
 * comes back. Shared verbatim by the glasses pages and the dev harness.
 */

import {
  normalizeEvents,
  extractEvents,
  speakableSummary,
  speakableMatch,
  summarizeToolResult,
  dayRange,
  getOffset,
} from './calendar.js';
import { friendlyError } from './composio.js';
import { attendeesOf, markOverlaps } from './people.js';
import { freeSlots, speakableSlots } from './freeslots.js';

/**
 * A per-row date only makes sense when the card mixes days (a lookup). On a
 * single-day card the header already names the day, so repeating it on every
 * row is noise — and it costs the narrow time column its width.
 */
function withoutRowDates(rows) {
  return rows.map((row) => (row.ongoing ? row : { ...row, dateLabel: '' }));
}

/**
 * @param {object} options
 * @param {string} options.utterance
 * @param {import('./composio.js').ComposioClient} options.composio
 * @param {{plan: Function, name: string}} options.planner
 * @param {object} [options.context]  { directory, myRows, workday }
 * @param {(stage: string, detail?: any) => void} [options.onStage]
 */
export async function runTurn({ utterance, composio, planner, context, onStage }) {
  const ctx = context || {};
  const stage = onStage || function () {};
  const startedAt = Date.now();
  const trace = [];
  const mark = (name, detail) => {
    trace.push({ stage: name, at: Date.now() - startedAt, detail: detail || null });
    stage(name, detail);
  };

  mark('discovering-tools');
  const tools = await composio.listTools();
  mark('tools-ready', { count: tools.length, transport: composio.label });

  mark('planning', { planner: planner.name });
  const plan = await planner.plan(utterance, tools, ctx);

  // Asked about a person the directory does not know. The directory is built
  // from attendees of the wearer's own events, so it only covers people they
  // actually share meetings with.
  if (plan.intent === 'unknown-person') {
    mark('unknown-person', { name: plan.name });
    return {
      kind: 'unknown-person',
      utterance,
      name: plan.name,
      rows: [],
      dayLabel: 'Unknown person',
      spoken:
        'I do not know who ' + plan.name + ' is. I only know people you share meetings with.',
      plan,
      trace,
    };
  }

  // The model answered conversationally instead of reaching for a tool.
  if (!plan.toolName) {
    mark('answered-directly');
    return {
      kind: 'text',
      utterance,
      spoken: plan.reply || 'I did not catch a calendar request.',
      rows: [],
      plan,
      trace,
    };
  }

  mark('calling-tool', { tool: plan.toolName, args: plan.args });
  const result = await composio.callTool(plan.toolName, plan.args);

  if (!result.ok) {
    const reason = friendlyError(result.error);
    mark('tool-failed', { error: reason });
    return {
      kind: 'error',
      utterance,
      spoken: 'I could not reach your calendar. ' + reason,
      error: reason,
      errorDetail: result.error,
      rows: [],
      plan,
      result,
      trace,
    };
  }

  const args = plan.args || {};
  const raw = extractEvents(result.data);
  const isCalendarPayload = raw.length > 0 || /EVENTS_LIST|FIND_EVENT/.test(plan.toolName);

  if (!isCalendarPayload) {
    mark('rendered', { generic: true });
    return {
      kind: 'result',
      utterance,
      rows: [],
      data: result.data,
      spoken: summarizeToolResult(plan.toolName, result),
      plan,
      result,
      trace,
    };
  }

  const rows = normalizeEvents(result.data);

  // The rule planner states its intent; infer it when the model chose the tool.
  const query = plan.query || args.q || args.query || '';
  const intent = plan.intent || (query ? 'search' : 'agenda');

  /* ── who is in a meeting ─────────────────────────────────────────────────── */
  if (intent === 'attendees') {
    // Prefer the matched meeting; fall back to the next one with people in it.
    const event = raw.find((e) => (e.attendees || []).length > 0) || raw[0];
    const people = event ? attendeesOf(event) : [];
    const row = event ? normalizeEvents({ items: [event] })[0] : null;

    mark('rendered', { attendees: people.length });
    return {
      kind: 'attendees',
      utterance,
      query,
      event: row,
      people,
      rows,
      dayLabel: row ? row.title : 'No matching meeting',
      subLabel: row ? (row.dateLabel ? row.dateLabel + ' · ' + row.start : row.start) : '',
      spoken: speakableAttendees(row, people, query),
      plan,
      result,
      trace,
    };
  }

  /* ── free time, computed locally ─────────────────────────────────────────── */
  if (intent === 'freeslots') {
    const range = dayRange(plan.day);
    const workday = ctx.workday || {};
    const availability = freeSlots(rows, {
      dateKey: range.date,
      offsetMinutes: getOffset(),
      startHour: workday.startHour,
      endHour: workday.endHour,
      minMinutes: workday.minSlotMinutes,
      isToday: range.date === dayRange('').date,
    });

    mark('rendered', { slots: availability.slots.length });
    return {
      kind: 'freeslots',
      utterance,
      dayLabel: 'Free · ' + range.label,
      subLabel: availability.windowLabel,
      slots: availability.slots,
      busyMinutes: availability.busyMinutes,
      freeMinutes: availability.freeMinutes,
      rows,
      spoken: speakableSlots(availability, range.label),
      plan,
      result,
      trace,
    };
  }

  /* ── someone else's day, with clashes against mine ───────────────────────── */
  if (intent === 'person') {
    const range = dayRange(plan.day);
    const person = plan.person || { name: args.calendarId, email: args.calendarId };
    const marked = withoutRowDates(markOverlaps(rows, ctx.myRows || []));
    const clashing = marked.filter((r) => r.clashCount > 0);

    mark('rendered', { events: marked.length, clashes: clashing.length });
    return {
      kind: 'person',
      utterance,
      person,
      rows: marked,
      clashCount: clashing.length,
      dayLabel: person.name,
      subLabel: range.label,
      spoken: speakablePerson(person, marked, clashing, range.label),
      plan,
      result,
      trace,
    };
  }

  /* ── lookup one named thing ──────────────────────────────────────────────── */
  if (intent === 'search') {
    let matched = rows;
    let label = query;

    // Google ANDs the words in `q`, so a multi-word subject only matches an
    // event containing every one of them — "flight nearless" finds nothing
    // even though "flight" does. Fall back to searching each word on its own
    // and merging, which turns the AND into an OR.
    const words = String(query).split(/\s+/).filter((w) => w.length > 2);
    if (!matched.length && words.length > 1) {
      mark('widening-search', { words });

      const seen = {};
      const merged = [];
      const hits = [];

      for (const word of words) {
        const attempt = await composio.callTool(plan.toolName, { ...args, q: word });
        if (!attempt.ok) continue;

        const found = normalizeEvents(attempt.data);
        if (found.length) hits.push(word);
        for (const row of found) {
          if (seen[row.id]) continue;
          seen[row.id] = true;
          merged.push({ ...row, matchedWord: word });
        }
      }

      // Soonest first, all-day events last so a timed answer leads.
      merged.sort((a, b) => {
        if (a.allDay !== b.allDay) return a.allDay ? 1 : -1;
        return String(a.startsAt).localeCompare(String(b.startsAt));
      });

      matched = merged;
      if (hits.length) label = hits.join(' or ');
      mark('widened', { matches: merged.length, matchedWords: hits });
    }

    mark('rendered', { matches: matched.length, query: label });
    return {
      kind: 'search',
      utterance,
      query: label,
      requested: query,
      widened: label !== query,
      rows: matched,
      dayLabel: matched.length ? 'Matches for “' + label + '”' : 'No match for “' + query + '”',
      spoken: speakableMatch(matched, label),
      plan,
      result,
      trace,
    };
  }

  /* ── the day's agenda ────────────────────────────────────────────────────── */
  const label = dayRange(plan.day).label;
  mark('rendered', { events: rows.length });
  return {
    kind: 'events',
    utterance,
    dayLabel: label,
    rows: withoutRowDates(rows),
    spoken: speakableSummary(rows, label),
    timeZone: (result.data && result.data.timeZone) || '',
    calendarName: (result.data && result.data.summary) || 'primary',
    plan,
    result,
    trace,
  };
}

/* -------------------------------------------------------------------------- */
/* narration                                                                  */
/* -------------------------------------------------------------------------- */

function speakableAttendees(row, people, query) {
  if (!row) return 'I could not find a meeting matching ' + (query || 'that') + '.';
  if (!people.length) return row.title + ' has no other attendees.';

  const names = people.filter((p) => !p.self).map((p) => p.name);
  const head = names.slice(0, 3).join(', ');
  const rest = names.length - 3;

  let text = row.title + ' has ' + people.length + ' ' + (people.length === 1 ? 'person' : 'people') + '.';
  if (head) text += ' ' + head + (rest > 0 ? ' and ' + rest + ' more' : '') + '.';

  const unanswered = people.filter((p) => !p.status).length;
  if (unanswered) text += ' ' + unanswered + ' have not replied.';
  return text;
}

function speakablePerson(person, rows, clashing, dayLabel) {
  const who = person.name || 'They';

  if (!rows.length) return who + ' has nothing on ' + dayLabel + '.';

  const timed = rows.filter((r) => !r.allDay);
  let text = who + ' has ' + rows.length + ' ' + (rows.length === 1 ? 'event' : 'events') + ' on ' + dayLabel + '.';
  if (timed.length) text += ' First at ' + timed[0].start + '.';

  if (clashing.length) {
    const first = clashing[0];
    text += ' ' + clashing.length + ' overlap' + (clashing.length === 1 ? 's' : '') + ' with yours';
    if (first.clashWith) text += ', including ' + first.clashWith + ' at ' + first.start;
    text += '.';
  } else {
    text += ' No overlap with yours.';
  }
  return text;
}
