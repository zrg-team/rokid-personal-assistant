/**
 * Date math that survives the Ink runtime.
 *
 * Ink's QuickJS build implements only part of `Date`. Verified on
 * @yodaos-pkg/ink 0.14.0 via pages/probe/probe.ink:
 *
 *   WORKS    Date.now()                 -> correct epoch ms
 *            Date.parse('…+09:00')      -> correct epoch ms, honours the offset
 *            date.valueOf()             -> correct epoch ms
 *
 *   BROKEN   getFullYear() -> 2060, getMonth(), getDate(), getHours()
 *            getTimezoneOffset()        -> -17917542
 *            toISOString()              -> "1044688-1044672-00T1044576:00:00.000Z"
 *            toLocaleDateString(), and `Intl` is not defined at all
 *
 * So everything here goes through epoch milliseconds plus integer civil-calendar
 * arithmetic, and never calls a component getter or any formatter. The offset is
 * always passed in explicitly, because the runtime cannot report it.
 */

const MS_PER_DAY = 86400000;
const MS_PER_MIN = 60000;

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function pad(n) {
  return (n < 10 ? '0' : '') + n;
}

/* Howard Hinnant's civil-calendar algorithms — pure integer math, proleptic
   Gregorian, valid far beyond any range a calendar app will see. */

export function daysFromCivil(y, m, d) {
  const yy = y - (m <= 2 ? 1 : 0);
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

export function civilFromDays(z) {
  const zz = z + 719468;
  const era = Math.floor(zz / 146097);
  const doe = zz - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365
  );
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return { y: y + (m <= 2 ? 1 : 0), m, d };
}

/** Epoch ms -> civil fields as observed at `offsetMinutes` east of UTC. */
export function civilFromMs(ms, offsetMinutes) {
  const shifted = ms + (offsetMinutes || 0) * MS_PER_MIN;
  const days = Math.floor(shifted / MS_PER_DAY);
  const rem = shifted - days * MS_PER_DAY;

  const { y, m, d } = civilFromDays(days);
  return {
    y,
    m,
    d,
    hh: Math.floor(rem / 3600000),
    mi: Math.floor(rem / 60000) % 60,
    weekday: ((days % 7) + 11) % 7, // 1970-01-01 was a Thursday
  };
}

/** Civil fields at `offsetMinutes` -> epoch ms. */
export function msFromCivil(y, m, d, hh, mi, offsetMinutes) {
  return (
    daysFromCivil(y, m, d) * MS_PER_DAY +
    (hh || 0) * 3600000 +
    (mi || 0) * 60000 -
    (offsetMinutes || 0) * MS_PER_MIN
  );
}

/** "+09:00" / "-05:30" / "Z" */
export function formatOffset(offsetMinutes) {
  const off = offsetMinutes || 0;
  if (off === 0) return 'Z';
  const sign = off > 0 ? '+' : '-';
  const abs = Math.abs(off);
  return sign + pad(Math.floor(abs / 60)) + ':' + pad(abs % 60);
}

/** RFC3339 timestamp for civil fields at a given offset. */
export function rfc3339(y, m, d, hh, mi, offsetMinutes) {
  return (
    y + '-' + pad(m) + '-' + pad(d) +
    'T' + pad(hh || 0) + ':' + pad(mi || 0) + ':00' +
    formatOffset(offsetMinutes)
  );
}

/** "YYYY-MM-DD" for an instant, at a given offset. */
export function dateKeyFromMs(ms, offsetMinutes) {
  const c = civilFromMs(ms, offsetMinutes);
  return c.y + '-' + pad(c.m) + '-' + pad(c.d);
}

/** Shift a "YYYY-MM-DD" key by whole days, without touching Date. */
export function addDays(dateKey, days) {
  const [y, m, d] = String(dateKey).split('-').map(Number);
  const c = civilFromDays(daysFromCivil(y, m, d) + (days || 0));
  return c.y + '-' + pad(c.m) + '-' + pad(c.d);
}

/** Start-of-day RFC3339 for a "YYYY-MM-DD" key at a given offset. */
export function startOfDay(dateKey, offsetMinutes) {
  const [y, m, d] = String(dateKey).split('-').map(Number);
  return rfc3339(y, m, d, 0, 0, offsetMinutes);
}

/** Epoch ms for a wall-clock time on a given day at a given offset. */
export function msAtDayTime(dateKey, hour, minute, offsetMinutes) {
  const [y, m, d] = String(dateKey).split('-').map(Number);
  return msFromCivil(y, m, d, hour, minute, offsetMinutes);
}

/** Day of week for a "YYYY-MM-DD" key. 0 = Sunday. */
export function weekdayOf(dateKey) {
  const [y, m, d] = String(dateKey).split('-').map(Number);
  return ((daysFromCivil(y, m, d) % 7) + 11) % 7;
}

/* The day vocabulary, folded (lowercase, no tone marks) — the same shape
   utils/planner.js `fold()` produces, so a Vietnamese utterance matches whether
   or not the ASR returned diacritics. */
const FIXED_DAYS = {
  today: 0, tonight: 0, now: 0, 'hom nay': 0, 'toi nay': 0,
  tomorrow: 1, tmr: 1, 'ngay mai': 1, mai: 1,
  yesterday: -1, 'hom qua': -1,
  'day after tomorrow': 2, 'ngay kia': 2,
  'day before yesterday': -2,
};

const WEEKDAY_INDEX = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3, thursday: 4, thu: 4, thurs: 4,
  friday: 5, fri: 5, saturday: 6, sat: 6,
};

/**
 * Turn a spoken day word into a date key.
 *
 * The one place that knows what "tomorrow" means. Before this existed there
 * were two half-answers: `rulePlanner` handled exactly `tomorrow` and
 * `yesterday` and nothing else, while `dayRange()` accepted only a `yyyy-mm-dd`
 * string and **silently returned today** for anything else — so a card could
 * render the wrong day and confidently label it. Weekday names were never
 * parsed anywhere, despite docs claiming otherwise.
 *
 * Vocabulary: an already-ISO key (passed through), today/tonight/now,
 * tomorrow, yesterday, the day after tomorrow, a weekday name, and a signed
 * day offset (`+2`, `-1`). Vietnamese equivalents fold to the same keys.
 *
 * A bare weekday means **the next occurrence, counting today** — "Friday" said
 * on a Friday is that same day, which is what a wearer means. "next friday"
 * always skips ahead, so it is never ambiguous with today.
 *
 * @param   {string} word      the spoken day, in any case, tone marks optional
 * @param   {string} todayKey  "YYYY-MM-DD" for the wearer's today
 * @returns {{date: string|null, matched: boolean}} `matched: false` when the
 *          input is not a day word at all — the distinction callers need in
 *          order to tell "not a date" apart from "today", which is exactly
 *          what the old silent fallback threw away.
 */
export function resolveDay(word, todayKey) {
  const today = String(todayKey || '');
  let t = String(word == null ? '' : word).toLowerCase().replace(/đ/g, 'd').trim();
  if (typeof t.normalize === 'function') t = t.normalize('NFD').replace(/[̀-ͯ]/g, '');
  t = t.replace(/[.,!?]+$/, '').replace(/\s+/g, ' ').trim();

  if (!t) return { date: null, matched: false };

  // An ISO key is already an answer. Checked first so a stored date always wins.
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return { date: t, matched: true };

  if (Object.prototype.hasOwnProperty.call(FIXED_DAYS, t)) {
    return { date: addDays(today, FIXED_DAYS[t]), matched: true };
  }

  // A signed offset: "+2", "-1", and the spoken "in 3 days".
  const offset = t.match(/^([+-]\d{1,3})$/) || t.match(/^in (\d{1,3}) days?$/);
  if (offset) return { date: addDays(today, Number(offset[1])), matched: true };

  // Weekdays. "this friday" reads the same as a bare "friday"; only "next" and
  // "last" move the answer, so saying a weekday on that weekday means today —
  // which is what a wearer means on a Friday morning asking about Friday.
  const weekday = t.match(/^(next|this|coming|last|past)?\s*([a-z]+)$/);
  if (weekday && Object.prototype.hasOwnProperty.call(WEEKDAY_INDEX, weekday[2])) {
    const ahead = (WEEKDAY_INDEX[weekday[2]] - weekdayOf(today) + 7) % 7;
    const modifier = weekday[1];
    if (modifier === 'next') return { date: addDays(today, ahead === 0 ? 7 : ahead + 7), matched: true };
    // The most recent past occurrence; on the day itself, a week ago.
    if (modifier === 'last' || modifier === 'past') {
      return { date: addDays(today, ahead === 0 ? -7 : ahead - 7), matched: true };
    }
    return { date: addDays(today, ahead), matched: true };
  }

  return { date: null, matched: false };
}

/* Day phrases that are safe to spot *inside* a sentence, longest first so
   "day after tomorrow" is tested before "tomorrow". Deliberately excludes the
   short weekday forms (sat, sun, mon, thu): they collide with ordinary English
   and, in `thu`'s case, with Vietnamese — an unanchored match would recreate
   the very class of bug `test/planner-routing.test.mjs` already guards. */
const SCANNABLE = [
  'day after tomorrow', 'day before yesterday', 'hom nay', 'ngay mai', 'hom qua',
  'ngay kia', 'toi nay', 'tomorrow', 'yesterday', 'tonight', 'today',
  'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
];

/**
 * Find the day named anywhere in an utterance.
 *
 * `resolveDay` answers "is this string a day?"; this answers "does this
 * sentence mention one?" — which is what the spoken path needs, because the
 * wearer says "what do I have on Friday", not "friday".
 *
 * Kept separate rather than folded into `resolveDay` so the strict, whole-input
 * form stays strict: a stored `{{day:…}}` placeholder or a dispatched `date`
 * param must never match loosely.
 *
 * @returns {string|null} "YYYY-MM-DD", or null when no day is named — null is
 *          *not* today; callers decide what "unspecified" means.
 */
export function findDayIn(text, todayKey) {
  let t = String(text == null ? '' : text).toLowerCase().replace(/đ/g, 'd');
  if (typeof t.normalize === 'function') t = t.normalize('NFD').replace(/[̀-ͯ]/g, '');

  // "next friday" / "last friday" must beat a bare "friday", so try the
  // modified forms first — otherwise the bare scan below claims the weekday and
  // the modifier is silently dropped.
  const modified = t.match(/\b(next|this|coming|last|past)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (modified) return resolveDay(modified[1] + ' ' + modified[2], todayKey).date;

  const relative = t.match(/\bin\s+(\d{1,3})\s+days?\b/);
  if (relative) return addDays(todayKey, Number(relative[1]));

  for (const phrase of SCANNABLE) {
    // \b would not fire around a multi-word phrase's inner spaces, so bound it
    // explicitly on both ends.
    if (new RegExp('(^|[^a-z])' + phrase.replace(/ /g, '\\s+') + '([^a-z]|$)').test(t)) {
      return resolveDay(phrase, todayKey).date;
    }
  }
  return null;
}

/** "Tuesday, Jul 28" */
export function longDate(dateKey) {
  const [y, m, d] = String(dateKey).split('-').map(Number);
  const weekday = ((daysFromCivil(y, m, d) % 7) + 11) % 7;
  return WEEKDAYS[weekday] + ', ' + MONTHS[m - 1] + ' ' + d;
}

/** "Aug 1" — deliberately without the weekday, which does not fit the
    56px time column and collides with the event title. */
export function shortDate(dateKey) {
  const [, m, d] = String(dateKey).split('-').map(Number);
  return MONTHS[m - 1] + ' ' + d;
}

/** "HH:MM" wall clock for an instant at a given offset. */
export function clockFromMs(ms, offsetMinutes) {
  const c = civilFromMs(ms, offsetMinutes);
  return pad(c.hh) + ':' + pad(c.mi);
}

/**
 * The UTC offset encoded in an RFC3339 string, in minutes east of UTC.
 * Returns null for date-only values or a missing offset.
 */
export function offsetFromRfc3339(stamp) {
  const text = String(stamp || '');
  if (text.length < 20) return null;              // date-only, or no offset
  if (text.charAt(text.length - 1) === 'Z') return 0;

  const match = text.match(/([+-])(\d{2}):(\d{2})$/);
  if (!match) return null;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === '-' ? -minutes : minutes;
}

export { pad };
