/**
 * Free/busy computed locally from the wearer's own events.
 *
 * Composio's GOOGLECALENDAR_FIND_FREE_SLOTS and FREE_BUSY_QUERY both hit
 * Google's freeBusy endpoint, which needs a broader OAuth scope than this
 * connection was granted (403 insufficient scope, verified). The day's events
 * are already in hand, so the gaps can be derived directly — no extra scope, no
 * extra round trip, and the same answer.
 */

import { clockFromMs, msAtDayTime, pad } from './clock.js';
import { getOffset } from './calendar.js';

/** "1h 30m" / "45m" / "2h" */
export function humanDuration(minutes) {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours && mins) return hours + 'h ' + mins + 'm';
  if (hours) return hours + 'h';
  return mins + 'm';
}

/**
 * @param {Array}  rows      normalized rows for ONE day (see calendar.js)
 * @param {object} [options] { startHour, endHour, minMinutes, isToday, nowMs }
 * @returns {{slots: Array, busyMinutes: number, freeMinutes: number}}
 */
export function freeSlots(rows, options) {
  const opts = options || {};
  const startHour = opts.startHour === undefined ? 9 : opts.startHour;
  const endHour = opts.endHour === undefined ? 18 : opts.endHour;
  const minMinutes = opts.minMinutes === undefined ? 30 : opts.minMinutes;

  // Anchor the window on the requested day. Never infer it from rows[0] — a
  // multi-day all-day event sorts first and would drag the window to its own
  // start date, leaving the real day's meetings outside the window entirely.
  const offset = opts.offsetMinutes === undefined ? getOffset() : opts.offsetMinutes;
  const dateKey =
    opts.dateKey && /^\d{4}-\d{2}-\d{2}$/.test(opts.dateKey)
      ? opts.dateKey
      : ((rows || []).find((r) => r.startsAt && !r.allDay) || {}).startsAt?.slice(0, 10) || '';
  if (!dateKey) return { slots: [], busyMinutes: 0, freeMinutes: 0, windowLabel: '' };

  const dayStart = msAtDayTime(dateKey, startHour, 0, offset);
  const dayEnd = msAtDayTime(dateKey, endHour, 0, offset);

  // Today's already-elapsed time is not free.
  let windowStart = dayStart;
  if (opts.isToday) {
    const now = opts.nowMs || Date.now();
    if (now > windowStart) windowStart = Math.min(now, dayEnd);
  }

  // All-day events do not block a working day; declined ones do not either.
  const busy = (rows || [])
    .filter((r) => !r.allDay && !r.declined && r.startsAt)
    .map((r) => {
      const start = Date.parse(r.startsAt);
      return {
        start,
        end: r.endsAt ? Date.parse(r.endsAt) : start + 30 * 60 * 1000,
      };
    })
    .filter((b) => b.end > windowStart && b.start < dayEnd)
    .sort((a, b) => a.start - b.start);

  // Merge overlaps so back-to-back and nested meetings count once.
  const merged = [];
  for (const block of busy) {
    const last = merged[merged.length - 1];
    if (last && block.start <= last.end) last.end = Math.max(last.end, block.end);
    else merged.push({ start: block.start, end: block.end });
  }

  const slots = [];
  let cursor = windowStart;
  for (const block of merged) {
    if (block.start > cursor) addSlot(slots, cursor, Math.min(block.start, dayEnd), minMinutes, offset);
    cursor = Math.max(cursor, block.end);
    if (cursor >= dayEnd) break;
  }
  if (cursor < dayEnd) addSlot(slots, cursor, dayEnd, minMinutes, offset);

  const busyMinutes = merged.reduce(
    (sum, b) => sum + Math.max(0, Math.min(b.end, dayEnd) - Math.max(b.start, windowStart)) / 60000,
    0
  );

  return {
    slots,
    busyMinutes: Math.round(busyMinutes),
    freeMinutes: slots.reduce((sum, s) => sum + s.minutes, 0),
    windowLabel: pad(startHour) + ':00–' + pad(endHour) + ':00',
  };
}

function addSlot(slots, start, end, minMinutes, offset) {
  const minutes = Math.round((end - start) / 60000);
  if (minutes < minMinutes) return;
  slots.push({
    start: clockFromMs(start, offset),
    end: clockFromMs(end, offset),
    minutes,
    duration: humanDuration(minutes),
    startsAtMs: start,
  });
}

/** "You have 3 openings today, the longest 2h from 15:00." */
export function speakableSlots(result, dayLabel) {
  const when = dayLabel ? 'on ' + dayLabel : 'today';
  const slots = (result && result.slots) || [];

  if (!slots.length) {
    return 'You have no free time ' + when + ' between ' + (result.windowLabel || 'working hours') + '.';
  }

  const longest = slots.reduce((best, s) => (s.minutes > best.minutes ? s : best), slots[0]);
  const noun = slots.length === 1 ? 'opening' : 'openings';

  let text = 'You have ' + slots.length + ' ' + noun + ' ' + when + '.';
  text += ' The longest is ' + longest.duration + ' from ' + longest.start + '.';
  if (slots.length > 1 && slots[0] !== longest) {
    text += ' The next one starts at ' + slots[0].start + '.';
  }
  return text;
}
