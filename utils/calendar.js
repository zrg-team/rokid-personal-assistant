/**
 * Google Calendar shaping helpers.
 *
 * All date handling goes through utils/clock.js. The Ink runtime's Date
 * component getters and formatters are broken, so nothing here may call
 * getFullYear/getMonth/getDate/getHours/getTimezoneOffset/toISOString — see
 * clock.js for the measured details.
 */

import { friendlyError } from './composio.js';
import {
  addDays,
  dateKeyFromMs,
  longDate,
  offsetFromRfc3339,
  shortDate,
  startOfDay,
} from './clock.js';

/* -------------------------------------------------------------------------- */
/* device offset                                                              */
/* -------------------------------------------------------------------------- */

let deviceOffset = 0;

/** Set the UTC offset (minutes east) all day-boundary math uses. */
export function setOffset(minutes) {
  deviceOffset = Number(minutes) || 0;
}

export function getOffset() {
  return deviceOffset;
}

/**
 * Read the calendar's real UTC offset off its own event timestamps.
 * Google returns `dateTime` in the calendar's timezone, so the offset is
 * carried in the string itself — the one source the runtime cannot get wrong.
 */
export function learnOffset(payload) {
  for (const event of extractEvents(payload)) {
    const stamp = (event.start && event.start.dateTime) || (event.end && event.end.dateTime);
    const offset = offsetFromRfc3339(stamp);
    if (offset !== null) return offset;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* day windows                                                                */
/* -------------------------------------------------------------------------- */

/** Today's "YYYY-MM-DD" at the configured offset. */
export function todayKey() {
  return dateKeyFromMs(Date.now(), deviceOffset);
}

/**
 * Resolve a day into the pieces the UI and the API both need.
 * @param {string} [isoDate] "YYYY-MM-DD"; defaults to today on the device.
 */
export function dayRange(isoDate) {
  const date = isoDate && /^\d{4}-\d{2}-\d{2}$/.test(isoDate) ? isoDate : todayKey();
  return {
    date,
    label: longDate(date),
    timeMin: startOfDay(date, deviceOffset),
    timeMax: startOfDay(addDays(date, 1), deviceOffset),
  };
}

/** Arguments for GOOGLECALENDAR_EVENTS_LIST covering one day. */
export function dayListArgs(isoDate, calendarId) {
  const range = dayRange(isoDate);
  return {
    calendarId: calendarId || 'primary',
    timeMin: range.timeMin,
    timeMax: range.timeMax,
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 25,
  };
}

/**
 * Arguments for a forward free-text search. Google's `q` matches title,
 * description, location and attendees, which is why "flight" finds an event
 * titled "Tokyo - Ho Chi Minh City (VJ 823)".
 */
export function searchArgs(query, windowDays, calendarId) {
  const today = todayKey();
  return {
    calendarId: calendarId || 'primary',
    q: String(query || '').trim(),
    timeMin: startOfDay(today, deviceOffset),
    timeMax: startOfDay(addDays(today, windowDays || 60), deviceOffset),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 10,
  };
}

/* -------------------------------------------------------------------------- */
/* events                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Locate the event array in a Composio calendar payload.
 *
 * The shape differs per tool: EVENTS_LIST returns `items`, while FIND_EVENT
 * nests them at `event_data.event_data`.
 */
export function extractEvents(payload) {
  if (!payload) return [];
  if (Array.isArray(payload.items)) return payload.items;

  const inner = payload.event_data;
  if (inner) {
    if (Array.isArray(inner)) return inner;
    if (Array.isArray(inner.event_data)) return inner.event_data;
    if (Array.isArray(inner.items)) return inner.items;
  }
  return [];
}

/**
 * Google returns `dateTime` already expressed in the calendar's timezone, so
 * slicing the wall-clock digits shows exactly what the user sees in Calendar.
 */
function wallClock(stamp) {
  if (!stamp || typeof stamp !== 'string' || stamp.length < 16) return '';
  return stamp.slice(11, 16);
}

/**
 * Clip text to a column budget. `text-overflow` is not a supported WXSS
 * property and the canvas is a fixed 448px, so ellipsis has to happen in JS.
 *
 * CJK and full-width characters occupy roughly two columns, so a plain
 * character count badly under-estimates a Japanese meeting title and the row
 * overflows the card. Width is measured in columns instead.
 */
export function displayWidth(text) {
  let width = 0;
  for (const ch of String(text || '')) {
    const code = ch.codePointAt(0);
    // CJK, kana, full-width forms and CJK punctuation.
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6);
    width += wide ? 2 : 1;
  }
  return width;
}

export function clip(text, maxColumns) {
  const value = String(text || '').trim();
  const limit = maxColumns || 18;
  if (displayWidth(value) <= limit) return value;

  let width = 0;
  let out = '';
  for (const ch of value) {
    const next = width + displayWidth(ch);
    if (next > limit - 1) break;
    out += ch;
    width = next;
  }
  return out + '…';
}

/**
 * Trim a list to what fits the card, with a note about the remainder.
 *
 * The list is a plain fixed-height <view>, not a <scroll-view>: scroll-view
 * children fail to paint in some hosts (Craft's Interactive InkView shows an
 * empty body while the header and count still render). Overflow is therefore
 * handled here rather than by scrolling.
 */
export function capRows(rows, max, noun) {
  const limit = max || 4;
  const list = rows || [];
  if (list.length <= limit) return { visible: list, moreNote: '' };
  const hidden = list.length - limit;
  // Irregular plural, so the caller passes both forms when they differ.
  const one = noun || 'event';
  const many = one === 'person' ? 'people' : one + 's';
  return {
    visible: list.slice(0, limit),
    moreNote: '+' + hidden + ' more ' + (hidden === 1 ? one : many),
  };
}

/**
 * A definite pixel height for a list, as a whole `style` attribute value.
 *
 * `<scroll-view>` only paints its children when it has a definite height —
 * `flex: 1`, `min-height` and `max-height` all leave it effectively zero in at
 * least one host. The row count is known here, so the height is computed
 * rather than declared in CSS, and it is bound as an entire attribute because
 * Ink does not evaluate expressions inside mixed attributes.
 */
export function listStyleFor(count, rowHeight, maxHeight) {
  const per = rowHeight || 46;
  const cap = maxHeight || 236;
  const height = Math.max(per, Math.min(cap, (count || 0) * per));
  return 'height: ' + height + 'px;';
}

/** Row modifier classes, resolved in JS rather than in the template. */
export function rowClass(isNow, declined, clashCount) {
  let cls = 'row';
  if (isNow) cls += ' now';
  if (declined) cls += ' off';
  if (clashCount) cls += ' clash';
  return cls;
}

function meetingLink(event) {
  if (event.hangoutLink) return event.hangoutLink;
  const entries = (event.conferenceData && event.conferenceData.entryPoints) || [];
  const video = entries.find((e) => e && e.entryPointType === 'video');
  return video ? video.uri : '';
}

/**
 * Flatten a Composio calendar payload into rows the UI can bind directly.
 * `nowMs` marks the event currently in progress so the card can highlight it.
 */
export function normalizeEvents(payload, nowMs) {
  const items = extractEvents(payload);
  const now = nowMs || Date.now();
  const today = todayKey();
  const rows = [];

  for (const event of items) {
    if (event.status === 'cancelled') continue;

    const allDay = !!(event.start && event.start.date && !event.start.dateTime);
    const startsAt = event.start ? event.start.dateTime || event.start.date : '';
    const endsAt = event.end ? event.end.dateTime || event.end.date : '';
    const attendees = event.attendees || [];
    const link = meetingLink(event);
    const me = attendees.find((a) => a && a.self);

    // Date.parse honours the embedded offset correctly on this runtime.
    const startMs = allDay ? 0 : Date.parse(startsAt);
    const endMs = allDay ? 0 : (endsAt ? Date.parse(endsAt) : startMs + 30 * 60 * 1000);

    const dayKey = (startsAt || '').slice(0, 10);
    const endKey = (endsAt || '').slice(0, 10);
    const isToday = dayKey === today;

    // An all-day event's `end.date` is exclusive, so a block ending 2026-08-01
    // actually runs through 2026-07-31. String compare is safe on ISO dates.
    const ongoing = allDay && !!dayKey && !!endKey && dayKey <= today && today < endKey;

    let dateLabel = '';
    if (ongoing) dateLabel = 'Now';
    else if (dayKey && !isToday) dateLabel = shortDate(dayKey);

    const isNow = !allDay && !!startMs && now >= startMs && now < endMs;
    const declined = !!me && me.responseStatus === 'declined';

    rows.push({
      id: event.id,
      title: event.summary || 'Busy',
      // Precomputed because Ink only evaluates an expression when it is the
      // entire attribute value; `class="row {{ a ? 'x' : '' }}"` is read as a
      // variable literally named "a ? 'x' : ''" and silently resolves to empty.
      rowClass: rowClass(isNow, declined, 0),
      allDay,
      startsAt,
      endsAt,
      isToday,
      dateLabel,
      ongoing,
      lastDay: allDay && endKey ? shortDate(addDays(endKey, -1)) : '',
      isNow,
      start: allDay ? 'All day' : wallClock(startsAt),
      end: allDay ? '' : wallClock(endsAt),
      location: event.location || '',
      // Column budgets sized to the 448px canvas: the title column is ~356px
      // wide at 15px, the chips sit under it at 11px.
      locationShort: clip(event.location, 20),
      titleShort: clip(event.summary || 'Busy', 34),
      meetUrl: link,
      hasMeet: !!link,
      organizer: (event.organizer && (event.organizer.displayName || event.organizer.email)) || '',
      attendeeCount: attendees.length,
      // Light attendee list — email is what links a remembered face to the
      // meeting you are both in. Names/RSVP stay in people.js attendeesOf().
      attendees: attendees
        .filter((a) => a && a.email && !a.resource)
        .map((a) => ({ email: a.email, name: a.displayName || '' })),
      myResponse: (me && me.responseStatus) || '',
      declined,

      // Overlap fields are filled in by people.js markOverlaps() for another
      // person's day. They are declared here regardless because Ink warns on
      // any template variable that is missing from the bound data.
      clashes: [],
      clashCount: 0,
      clashWith: '',
      clashLabel: '',
    });
  }

  return rows;
}

/* -------------------------------------------------------------------------- */
/* narration                                                                  */
/* -------------------------------------------------------------------------- */

/** "just now" / "4m ago" — the freshness caption on an ambient card. */
export function relativeTime(fromMs, nowMs) {
  if (!fromMs) return '';
  const seconds = Math.floor(((nowMs || Date.now()) - fromMs) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes + 'm ago';
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours + 'h ago';
  return Math.round(hours / 24) + 'd ago';
}

/** One-breath spoken summary — glasses TTS should not read a whole agenda. */
export function speakableSummary(rows, dayLabel) {
  const when = dayLabel ? 'on ' + dayLabel : 'today';

  if (!rows.length) return 'Your calendar is clear ' + when + '.';

  const timed = rows.filter((r) => !r.allDay);
  const head = timed[0] || rows[0];
  const count = rows.length;
  const noun = count === 1 ? 'event' : 'events';

  let text = 'You have ' + count + ' ' + noun + ' ' + when + '.';
  if (head) {
    text += head.allDay
      ? ' First up, ' + head.title + ', all day.'
      : ' First up, ' + head.title + ' at ' + head.start + '.';
  }
  if (count > 1) {
    const last = rows[rows.length - 1];
    if (!last.allDay) text += ' Your last one, ' + last.title + ', starts at ' + last.start + '.';
  }
  return text;
}

/**
 * Answer for a specific-event lookup ("when does my flight start?").
 * Leads with the soonest match and says the day out loud, because a lookup
 * result is usually not today.
 */
export function speakableMatch(rows, query) {
  const term = String(query || 'that').trim();

  if (!rows.length) return 'I could not find anything matching ' + term + ' on your calendar.';

  const first = rows[0];

  let text;
  if (first.ongoing) {
    text = first.title + ' is running now' + (first.lastDay ? ', through ' + first.lastDay : '') + '.';
  } else {
    const when = first.dateLabel ? ' on ' + first.dateLabel : ' today';
    text = first.allDay
      ? first.title + ' is all day' + when + '.'
      : first.title + ' starts at ' + first.start + when + '.';
  }

  // Room names arrive as full street addresses; speak only the leading part.
  if (first.location) {
    const place = String(first.location).split(/[,·/]/)[0].trim();
    if (place && place.length <= 42) text += ' At ' + place + '.';
  }
  if (rows.length > 1) {
    text += ' ' + (rows.length - 1) + ' other match' + (rows.length === 2 ? '' : 'es') + '.';
  }
  return text;
}

/** Fallback narration for any non-calendar tool result. */
export function summarizeToolResult(toolName, result) {
  if (!result || !result.ok) {
    return 'That did not work: ' + friendlyError(result && result.error) + '.';
  }
  const data = result.data;
  if (data && data.items && Array.isArray(data.items)) {
    return 'Got ' + data.items.length + ' results from ' + toolName + '.';
  }
  if (data && (data.summary || data.htmlLink)) {
    return 'Done: ' + (data.summary || 'calendar updated') + '.';
  }
  return 'Done.';
}
