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
