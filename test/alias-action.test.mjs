import { connectionCommand, setUserAliases } from '../utils/planner.js';
import { fillArgs } from '../utils/aliasargs.js';
import { dayRange, todayKey } from '../utils/calendar.js';
import { addDays } from '../utils/clock.js';

let fail = 0;
const is = (g, w, l) => {
  const ok = JSON.stringify(g) === JSON.stringify(w);
  console.log((ok ? '  ok   ' : '  FAIL ') + l + (ok ? '' : '  got ' + JSON.stringify(g) + ' want ' + JSON.stringify(w)));
  if (!ok) fail++;
};

const T = todayKey();

console.log('=== fillArgs: placeholders resolve at speak time, not save time ===');
is(fillArgs({ d: '{{day:tomorrow}}' }).args, { d: addDays(T, 1) }, 'day placeholder');
is(fillArgs({ d: '{{day:+2}}' }).args, { d: addDays(T, 2) }, 'offset placeholder');
is(fillArgs({ a: '{{start:tomorrow}}' }).args, { a: dayRange(addDays(T, 1)).timeMin }, 'start = the day boundary dayRange uses');
is(fillArgs({ a: '{{end:tomorrow}}' }).args, { a: dayRange(addDays(T, 1)).timeMax }, 'end = the exclusive next midnight');
is(fillArgs({ calendarId: 'primary', maxResults: 25, on: true }).args,
   { calendarId: 'primary', maxResults: 25, on: true }, 'non-placeholder values pass through untouched');
is(fillArgs({ d: '{{day:blursday}}' }).unresolved, ['blursday'], 'an unreadable day is reported, not guessed');
is(fillArgs({ d: '{{day:blursday}}' }).args, {}, 'and its key is dropped rather than sent literally');
is(fillArgs(null).args, {}, 'null args do not throw');
is(fillArgs({ d: 'the {{day:tomorrow}} one' }).args, { d: 'the {{day:tomorrow}} one' },
   'an EMBEDDED placeholder is never substituted — whole values only');

console.log('=== connectionCommand: structured actions ride alongside the old shape ===');
setUserAliases([
  { phrase: 'google calendar tomorrow', kind: 'action', slug: 'googlecalendar', action: '',
    tool: 'GOOGLECALENDAR_EVENTS_LIST',
    args: { calendarId: 'primary', timeMin: '{{start:tomorrow}}', timeMax: '{{end:tomorrow}}' } },
  { phrase: 'inbox', kind: 'shortcut', slug: 'gmail', action: 'newer_than:2d' },
]);

is(connectionCommand('kavi google calendar tomorrow'), {
  slug: 'googlecalendar', action: '', tool: 'GOOGLECALENDAR_EVENTS_LIST',
  args: { calendarId: 'primary', timeMin: '{{start:tomorrow}}', timeMax: '{{end:tomorrow}}' },
}, 'a structured alias carries its tool and args');

// The whole point of putting slug+action first and omitting the new keys: the
// four assertions in alias-sync.test.mjs compare with JSON.stringify.
is(connectionCommand('kavi inbox'), { slug: 'gmail', action: 'newer_than:2d' },
   'a free-text shortcut in the SAME table keeps the old shape exactly');
is(connectionCommand('kavi mail'), { slug: 'gmail', action: '' },
   'and so does a built-in');

is(connectionCommand('kavi google calendar tomorrow with tracy').action, 'with tracy',
   'a spoken tail is kept, so the page can fall back to the free-text path');

// A user alias must beat the built-in 'google calendar' prefix it extends.
is(connectionCommand('kavi google calendar tomorrow').tool, 'GOOGLECALENDAR_EVENTS_LIST',
   'longest-first puts the 24-char action ahead of the 15-char built-in');

console.log('=== end to end: what the glasses would actually send ===');
const conn = connectionCommand('kavi google calendar tomorrow');
is(fillArgs(conn.args).args, {
  calendarId: 'primary',
  timeMin: dayRange(addDays(T, 1)).timeMin,
  timeMax: dayRange(addDays(T, 1)).timeMax,
}, 'the saved alias becomes the next day window');

setUserAliases([]);
is(connectionCommand('kavi google calendar tomorrow'), { slug: 'googlecalendar', action: 'tomorrow' },
   'cleared: falls back to the built-in alias + the spoken day word');

console.log(fail ? (String.fromCharCode(10) + fail + ' FAILED') : (String.fromCharCode(10) + 'all passed'));
process.exit(fail ? 1 : 0);
