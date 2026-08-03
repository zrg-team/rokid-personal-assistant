/**
 * People: who is in a meeting, and whose calendar to read.
 *
 * There is no directory API in scope, so the agent builds one from the
 * attendees of the wearer's own events. That is enough to turn "Kevin" into
 * kevin.nguyen@jitera.com, which is all that is needed to read a colleague's
 * calendar with GOOGLECALENDAR_EVENTS_LIST.
 */

import { clip, rowClass } from './calendar.js';

/** RSVP codes reduced to something readable on a small monochrome display. */
const RSVP = {
  accepted: 'yes',
  declined: 'no',
  tentative: 'maybe',
  needsAction: '',
};

function localPart(email) {
  return String(email || '').split('@')[0];
}

/** "kevin.nguyen" -> "Kevin Nguyen"; used when Google gives no displayName. */
function nameFromEmail(email) {
  return localPart(email)
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/** Normalize one event's attendee list for display. */
export function attendeesOf(event) {
  const list = (event && event.attendees) || [];
  return list
    .filter((a) => a && a.email && !a.resource)
    .map((a) => ({
      email: a.email,
      name: a.displayName || nameFromEmail(a.email),
      status: RSVP[a.responseStatus] !== undefined ? RSVP[a.responseStatus] : '',
      organizer: !!a.organizer,
      optional: !!a.optional,
      self: !!a.self,
      // Resolved here: Ink does not evaluate expressions in mixed attributes.
      nameClass: a.self ? 'pname self' : 'pname',
    }))
    // Organizer first, then anyone who accepted, then the rest.
    .sort((a, b) => {
      if (a.organizer !== b.organizer) return a.organizer ? -1 : 1;
      const rank = (s) => (s.status === 'yes' ? 0 : s.status === 'maybe' ? 1 : 2);
      return rank(a) - rank(b);
    });
}

/**
 * Build a name -> email directory from every attendee seen across events.
 * `events` are raw Google event objects.
 */
export function buildDirectory(events) {
  const byEmail = {};

  for (const event of events || []) {
    for (const attendee of attendeesOf(event)) {
      if (attendee.self) continue;               // the wearer is not "someone else"
      const key = attendee.email.toLowerCase();
      if (!byEmail[key]) {
        byEmail[key] = { email: attendee.email, name: attendee.name, seen: 0 };
      }
      byEmail[key].seen += 1;
      // Prefer a real displayName over one derived from the address.
      if (attendee.name && attendee.name.indexOf('@') === -1) byEmail[key].name = attendee.name;
    }
  }

  return Object.keys(byEmail)
    .map((key) => byEmail[key])
    .sort((a, b) => b.seen - a.seen);
}

/**
 * Resolve a spoken fragment ("kevin", "tracy le") to a directory entry.
 * Returns null when nothing matches confidently.
 */
export function resolvePerson(term, directory) {
  const needle = String(term || '').trim().toLowerCase();
  if (!needle || !directory || !directory.length) return null;

  const candidates = directory.map((person) => ({
    person,
    name: person.name.toLowerCase(),
    local: localPart(person.email).toLowerCase(),
  }));

  // Exact address, then exact display name.
  const exact =
    candidates.find((c) => c.person.email.toLowerCase() === needle) ||
    candidates.find((c) => c.name === needle);
  if (exact) return exact.person;

  // Any name token or address token starting with the fragment — "kevin"
  // matches both "Kevin Nguyen" and kevin.nguyen@…
  const prefixed = candidates.filter((c) => {
    const tokens = c.name.split(/\s+/).concat(c.local.split(/[._-]+/));
    return tokens.some((token) => token.indexOf(needle) === 0);
  });
  if (prefixed.length) return prefixed[0].person;

  const loose = candidates.filter((c) => c.name.indexOf(needle) !== -1 || c.local.indexOf(needle) !== -1);
  return loose.length ? loose[0].person : null;
}

/**
 * Flag which of `theirRows` collide with the wearer's own events, so the card
 * can mark "this clashes with your standup".
 *
 * Both lists are normalized rows carrying RFC3339 `startsAt` / `endsAt`.
 */
export function markOverlaps(theirRows, myRows) {
  const mine = (myRows || [])
    .filter((row) => !row.allDay && row.startsAt)
    .map((row) => ({
      title: row.title,
      start: Date.parse(row.startsAt),
      end: row.endsAt ? Date.parse(row.endsAt) : Date.parse(row.startsAt) + 30 * 60 * 1000,
      label: row.start,
    }));

  return (theirRows || []).map((row) => {
    if (row.allDay || !row.startsAt) {
      return {
        ...row, clashes: [], clashCount: 0, clashWith: '', clashLabel: '',
        rowClass: rowClass(row.isNow, row.declined, 0),
      };
    }

    const start = Date.parse(row.startsAt);
    const end = row.endsAt ? Date.parse(row.endsAt) : start + 30 * 60 * 1000;

    // Half-open intervals: touching end-to-start is not a clash.
    const clashes = mine.filter((m) => start < m.end && m.start < end);

    return {
      ...row,
      clashes,
      clashCount: clashes.length,
      clashWith: clashes.length ? clashes[0].title : '',
      clashLabel: clashes.length ? 'clashes: ' + clip(clashes[0].title, 16) : '',
      rowClass: rowClass(row.isNow, row.declined, clashes.length),
    };
  });
}
