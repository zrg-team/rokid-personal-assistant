/**
 * Fill the day placeholders in a console-defined action's arguments.
 *
 * An alias saved on the phone stores what the wearer *meant*, not what it
 * resolved to on the day they saved it:
 *
 *   { calendarId: 'primary',
 *     timeMin: '{{start:tomorrow}}',
 *     timeMax: '{{end:tomorrow}}' }
 *
 * Freezing a date at save time would make "Kavi google calendar tomorrow" mean
 * one specific Thursday forever, which is worse than not having the feature.
 * So substitution happens here, on the glasses, at the moment the phrase is
 * spoken — and against the *learned* device offset (utils/calendar.js), which
 * the server does not have and cannot guess.
 *
 * A placeholder is always the WHOLE value, never embedded in a longer string.
 * That is enforced when it is saved (`validateArgs` in the console function)
 * and again on the way out here, so there is no interpolation surface: a value
 * either is a placeholder and gets replaced, or is data and is passed through
 * untouched.
 */

import { dayRange } from './calendar.js';
import { resolveDay } from './clock.js';
import { todayKey } from './calendar.js';

/** `{{day:tomorrow}}` / `{{start:friday}}` / `{{end:+2}}` — the whole value. */
const PLACEHOLDER = /^\{\{(day|start|end):([a-z]{1,12}|[+-]\d{1,2})\}\}$/;

/**
 * @param   {object} args  the saved arguments, flat by construction
 * @returns {{args: object, unresolved: string[]}} `unresolved` names the day
 *          words that could not be read. It is not a warning to log and carry
 *          on from: a caller that runs the tool anyway would ask Google for
 *          events on a day called "{{day:blursday}}", so the card should say it
 *          did not understand instead.
 */
export function fillArgs(args) {
  const out = {};
  const unresolved = [];
  if (!args || typeof args !== 'object') return { args: out, unresolved };

  const today = todayKey();

  for (const key of Object.keys(args)) {
    const value = args[key];
    if (typeof value !== 'string') {
      out[key] = value;
      continue;
    }

    const match = value.match(PLACEHOLDER);
    if (!match) {
      // Includes a partial or embedded `{{`, which validation should already
      // have refused — pass it through rather than half-substituting, and let
      // the server's own placeholder check reject it loudly.
      out[key] = value;
      continue;
    }

    const [, mode, word] = match;
    const day = resolveDay(word, today);
    if (!day.matched) {
      unresolved.push(word);
      continue;
    }

    if (mode === 'day') {
      out[key] = day.date;
    } else {
      // `start`/`end` need the day's boundaries as RFC3339 at the device
      // offset, which is exactly what dayRange already computes for the cards.
      const range = dayRange(day.date);
      out[key] = mode === 'start' ? range.timeMin : range.timeMax;
    }
  }

  return { args: out, unresolved };
}
