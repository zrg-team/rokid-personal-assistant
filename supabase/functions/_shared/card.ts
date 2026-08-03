/**
 * Turning a match into something worth saying.
 *
 * This lives in the function rather than in the page so the glasses never have
 * to decide anything: they post a photo and render whatever comes back. It is
 * also the only place the wording exists, so fixing a sentence is a function
 * deploy rather than rebuilding and reinstalling the .aix on the hardware.
 *
 * `context.rows` is the wearer's cached agenda, posted along with the photo,
 * which is what lets a recognised face be reported together with the meeting the
 * two of them actually share.
 */

/** Lines are clipped by the page anyway; an unbounded note is not worth sending. */
const MAX_NOTE = 120;

export interface PersonRow {
  id: string;
  name: string;
  note: string;
  email: string;
  thumb?: string;
  seen_count: number;
}

export interface AgendaRow {
  start: string;
  title: string;
  attendees?: Array<{ email?: string; name?: string }>;
}

export interface Card {
  known: boolean;
  confident?: boolean;
  title: string;
  subtitle: string;
  lines: string[];
  spoken: string;
}

function tidy(text: unknown): string {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

/** Free text the wearer dictated rarely ends in a full stop. */
function asSentence(text: unknown): string {
  const trimmed = tidy(text).replace(/[.!?]+$/, '');
  return trimmed ? trimmed + '.' : '';
}

/** The first meeting on the wearer's day that this person is also attending. */
export function sharedMeeting(person: PersonRow, rows: AgendaRow[]): AgendaRow | null {
  if (!person?.email || !Array.isArray(rows)) return null;
  const email = person.email.toLowerCase();
  return (
    rows.find((row) =>
      (row.attendees || []).some((a) => a?.email && a.email.toLowerCase() === email)
    ) || null
  );
}

export function enrolledCard(person: PersonRow, samples: number): Card {
  const lines: string[] = [];
  if (person.note) lines.push(tidy(person.note).slice(0, MAX_NOTE));
  if (person.email) lines.push(person.email);
  lines.push(samples > 1 ? samples + ' views stored' : 'first view stored');

  return {
    known: true,
    title: person.name,
    subtitle: 'Remembered',
    lines,
    spoken: samples > 1
      ? 'Got another look at ' + person.name + '.'
      : 'I will remember ' + person.name + '.',
  };
}

export function unknownCard(): Card {
  return {
    known: false,
    title: 'New face',
    subtitle: '',
    lines: ['Say a name to remember them'],
    spoken: 'I do not know them yet. Tell me their name and I will remember.',
  };
}

export function noFaceCard(): Card {
  return {
    known: false,
    title: 'No face in view',
    subtitle: '',
    lines: [],
    spoken: 'I cannot see anyone. Try facing them straight on.',
  };
}

export function matchCard(
  person: PersonRow,
  score: number,
  confident: boolean,
  rows: AgendaRow[] = [],
  othersInFrame = 0,
): Card {
  const shared = sharedMeeting(person, rows);
  const lines: string[] = [];

  if (person.note) lines.push(tidy(person.note).slice(0, MAX_NOTE));
  if (shared) lines.push(shared.start + ' · ' + shared.title);
  lines.push(
    (person.seen_count > 1 ? 'seen ' + person.seen_count + ' times' : 'seen once') +
    ' · ' + Math.round(score * 100) + '% match'
  );
  // Worth flagging: with several people in shot the answer is about whoever is
  // closest to the camera, who may not be the person the wearer meant.
  if (othersInFrame > 0) {
    lines.push(othersInFrame === 1 ? '1 other face in view' : othersInFrame + ' other faces in view');
  }

  const hedge = confident ? '' : 'I think ';
  const spokenNote = person.note ? ' ' + asSentence(person.note) : '';
  const spokenMeeting = shared ? ' You have ' + shared.title + ' at ' + shared.start + '.' : '';

  return {
    known: true,
    confident,
    title: person.name,
    subtitle: confident ? '' : 'not certain',
    lines,
    spoken: hedge + 'that is ' + person.name + '.' + spokenNote + spokenMeeting,
  };
}
