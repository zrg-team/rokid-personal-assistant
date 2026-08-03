/**
 * Turning an utterance into a Composio tool call.
 *
 * Two planners with the same shape:
 *
 *   plan(utterance, tools) -> { toolName, args, via } | { reply, via }
 *
 * `llmPlanner` uses the on-device LanguageModel with the discovered Composio
 * tools declared as functions, and reads the resulting `toolcall` event.
 * `rulePlanner` is a keyword router used when LanguageModel.availability()
 * reports unavailable, and in the browser dev harness where there is no
 * on-device model.
 */

import { dayListArgs, searchArgs, todayKey } from './calendar.js';
import { addDays } from './clock.js';
import { resolvePerson } from './people.js';

/* Words that describe *when*, so they never become a search term. */
const DATE_WORDS = [
  'today', 'tonight', 'tomorrow', 'yesterday', 'week', 'weekend', 'month',
  'day', 'days', 'morning', 'afternoon', 'evening', 'next', 'this', 'last',
  'later', 'now', 'upcoming', 'monday', 'tuesday', 'wednesday', 'thursday',
  'friday', 'saturday', 'sunday',
];

/* Question scaffolding and calendar nouns that carry no search signal. */
const STOPWORDS = DATE_WORDS.concat([
  'when', 'what', 'whats', 'where', 'wheres', 'which', 'who', 'why', 'how',
  'is', 'are', 'am', 'was', 'were', 'be', 'do', 'does', 'did', 'will', 'would',
  'my', 'mine', 'me', 'i', 'the', 'a', 'an', 'of', 'for', 'on', 'at', 'in',
  'to', 'any', 'there', 'have', 'has', 'had', 'get', 'got', 'about', 'tell',
  'show', 'find', 'search', 'look', 'lookup', 'up', 'start', 'starts',
  'started', 'starting', 'begin', 'begins', 'end', 'ends', 'time', 'times',
  'schedule', 'scheduled', 'calendar', 'event', 'events', 'appointment',
  'appointments', 'meeting', 'meetings', 's', 't',
]);

/**
 * Reduce an utterance to the thing being asked about.
 * "When my flight start?" -> "flight";  "what's on my calendar today" -> ""
 * An empty result means there was no subject, so it is an agenda question.
 */
export function searchTerm(utterance) {
  return String(utterance || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, ' ')
    .replace(/'s\b/g, ' ')
    .split(/\s+/)
    .filter((word) => word && STOPWORDS.indexOf(word) === -1)
    .join(' ')
    .trim();
}

const SYSTEM_PROMPT = [
  'You are a calendar assistant on Rokid AR glasses.',
  'Always prefer calling one of the declared tools over answering from memory.',
  'For "what is on my calendar" style questions call GOOGLECALENDAR_EVENTS_LIST',
  'with calendarId "primary", singleEvents true, orderBy "startTime", and an',
  'explicit RFC3339 timeMin/timeMax covering the requested day.',
  'When the wearer asks about one specific named thing instead of a whole day',
  '("when does my flight start", "where is the standup", "when is lunch with',
  'Tracy"), call GOOGLECALENDAR_EVENTS_LIST with the subject as the free-text',
  '`q` parameter and a timeMin of now with a timeMax about 60 days ahead.',
  'Google matches `q` against title, description, location and attendees, so',
  'pass the plain subject word rather than the whole sentence.',
  'Keep any spoken text under two short sentences.',
].join(' ');

/* -------------------------------------------------------------------------- */
/* rule planner                                                               */
/* -------------------------------------------------------------------------- */

/** Day key `days` away from today. Pure integer math — see utils/clock.js. */
function shiftDate(days) {
  return addDays(todayKey(), days);
}

/* -------------------------------------------------------------------------- */
/* face commands                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Spoken commands that belong to the face memory rather than the calendar.
 *
 * These never reach Composio. They are recognised here so the agent can route
 * them itself, and they are declared again in pages/face/face.ink's `schema` so
 * the host model can dispatch straight to the page — the same vocabulary in
 * both places, which is what makes it feel like one feature rather than two.
 *
 * Order matters. "remember that she runs security" is a note; "remember her as
 * Sarah" is a name. The name patterns are tested first because "as" is the
 * narrower signal.
 */
const FACE_COMMANDS = [
  // ── give this face a name ────────────────────────────────────────────────
  { action: 'remember', capture: 'name', patterns: [
    /\bremember\s+(?:this|that|him|her|them|this\s+person)?\s*as\s+(.+)$/i,
    /\bcall\s+(?:him|her|them|this\s+person)\s+(.+)$/i,
    /\b(?:his|her|their)\s+name\s+is\s+(.+)$/i,
    /\bthis\s+is\s+(.+)$/i,
    /\bsave\s+(?:him|her|them)\s+as\s+(.+)$/i,
  ] },

  // ── attach something worth recalling ─────────────────────────────────────
  { action: 'note', capture: 'note', patterns: [
    /\b(?:note|memo|remind\s+me)\s+that\s+(.+)$/i,
    /\badd\s+a?\s*(?:note|memo)\s+(?:that\s+)?(.+)$/i,
    /\bremember\s+that\s+(.+)$/i,
    /\bmake\s+a\s+note\s+(?:that\s+)?(.+)$/i,
  ] },

  // ── who is in front of me ────────────────────────────────────────────────
  // The pronoun list has to include he/she/him/her, not just this/that/they.
  // "who is she" is the most natural way to ask, and without it the utterance
  // fell through to the calendar planner and rendered the agenda instead.
  { action: 'identify', patterns: [
    /\bwho(?:'s|\s+is|\s+are)\s+(?:this|that|they|these|them|he|she|him|her)\b/i,
    /\bwho(?:'s| is)\s+in\s+front\b/i,
    /\bwho\s+am\s+i\s+(?:talking|speaking|looking)\b/i,
    /\bdo\s+(?:i|we)\s+know\s+(?:this|that|them|him|her|he|she)\b/i,
    /\bremind\s+me\s+who\s+(?:this|that|they|he|she|it)\b/i,
    /\bhave\s+i\s+met\s+(?:them|him|her|this|he|she)\b/i,
    /\bwhat(?:'s| is)\s+(?:his|her|their)\s+name\b/i,
    /\bname\s+of\s+(?:this|that)\s+(?:person|guy|girl|man|woman)\b/i,
  ] },

  // ── just take the picture ────────────────────────────────────────────────
  { action: 'identify', patterns: [
    /\b(?:capture|take)\s+(?:a\s+)?(?:photo|picture|shot)\b/i,
    /\blook\s+at\s+(?:this|them|him|her)\b/i,
    /\bscan\s+(?:this|their|his|her)\s*face\b/i,
  ] },

  // ── housekeeping ─────────────────────────────────────────────────────────
  { action: 'forget', capture: 'name', patterns: [
    /\bforget\s+(?:about\s+)?(.+)$/i,
    /\bdelete\s+(.+?)\s+from\s+(?:my\s+)?(?:faces|people|memory)$/i,
  ] },

  { action: 'list', patterns: [
    /\bwho\s+do\s+i\s+know\b/i,
    /\b(?:list|show)\s+(?:my\s+)?(?:people|faces)\b/i,
    /\bhow\s+many\s+people\s+do\s+i\s+know\b/i,
  ] },
];

/**
 * Parse a face command out of an utterance.
 * @returns {{action: string, name?: string, note?: string} | null}
 */
export function faceCommand(utterance) {
  const text = String(utterance || '').trim();
  if (!text) return null;

  for (const command of FACE_COMMANDS) {
    for (const pattern of command.patterns) {
      const match = text.match(pattern);
      if (!match) continue;

      const result = { action: command.action };
      if (command.capture && match[1]) {
        // Keep the wearer's own casing: it is a name or their own words.
        result[command.capture] = match[1].replace(/[.?!]+$/, '').trim();
      }
      return result;
    }
  }
  return null;
}

/** Kept for callers that only need to know whether to route to the face page. */
export function isFaceRequest(utterance) {
  return faceCommand(utterance) !== null;
}

/* -------------------------------------------------------------------------- */
/* sign-in trigger words                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Fold text for matching: lowercase, and strip Vietnamese tone marks (and đ→d)
 * so "đăng nhập" and a diacritic-less ASR result "dang nhap" both reduce to the
 * same ASCII. `normalize` is feature-detected because the Ink runtime's coverage
 * is uneven; đ is replaced explicitly because NFD does not decompose it.
 */
function fold(text) {
  let t = String(text || '').toLowerCase().replace(/đ/g, 'd');
  if (typeof t.normalize === 'function') {
    t = t.normalize('NFD').replace(/[̀-ͯ]/g, '');
  }
  return t.trim();
}

/**
 * The sign-in trigger: the UNIQUE agent word "Kavi" followed by a sign-in verb,
 * in English or Vietnamese — "Kavi sign in", "Kavi log in", "Kavi đăng nhập".
 *
 * A bare "sign in" is too common: on real Rokid Glasses the built-in assistant
 * and other agents are listening too, and everyday words collide (forum post
 * 3493). Requiring the coined word "Kavi" — which is also the agent's name and
 * wake word — makes the command unmistakably this agent's, so nothing else can
 * claim it. The gate (utils/gate.js) is the wordless fallback when there is no
 * stored token. Keep the word in step with config.WAKE_WORD and the Name in
 * AGENTS.md.
 *
 * The name pattern tolerates the common ASR spellings of "Kavi" (c/k, i/y, an
 * optional internal space) so a slightly mis-heard invocation still routes.
 * Everything runs against folded (accent-free, lowercase, trimmed) text.
 */
const KAVI = /^(?:k|c)a\s?v(?:i|y)\b/;
const SIGNIN_VERB = /\b(?:sign\s?in|log\s?in|dang\s?nhap)\b/;

/** @returns {boolean} whether the utterance is "Kavi, sign in" (en/vi). */
export function signinCommand(utterance) {
  const text = fold(utterance);
  if (!text) return false;
  return KAVI.test(text) && SIGNIN_VERB.test(text);
}

/** How far forward a lookup searches. */
export const SEARCH_WINDOW_DAYS = 60;

/** How long to wait for the model host to answer before giving up on it. */
export const AVAILABILITY_TIMEOUT_MS = 2500;

/**
 * Resolve `fallback` if `promise` has not settled in time.
 *
 * `setTimeout` is not in the verified AIUI API surface, so this degrades to a
 * plain await when timers are missing — the guard is best-effort, never a
 * hard dependency.
 */
export function withTimeout(promise, ms, fallback) {
  if (typeof setTimeout !== 'function') return promise;
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

export const rulePlanner = {
  name: 'rules',

  /**
   * @param {string} utterance
   * @param {Array}  tools     discovered Composio tools
   * @param {object} [context] { directory } — people known from my own events
   */
  async plan(utterance, tools, context) {
    const text = String(utterance || '').toLowerCase();
    const has = (name) => tools.some((t) => t.name === name);
    const directory = (context && context.directory) || [];

    let day = null;
    if (/\btomorrow\b/.test(text)) day = shiftDate(1);
    else if (/\byesterday\b/.test(text)) day = shiftDate(-1);

    // ── who is in a meeting ────────────────────────────────────────────────
    // "who is in the engineering catch up", "who's coming to standup"
    if (/^\s*who\b|\battendees?\b|\bparticipants?\b|\bwho else\b/.test(text)) {
      const subject = searchTerm(text.replace(/\bwho\b|\belse\b|\bcoming\b|\bjoining\b|\battending\b/g, ' '));
      return {
        via: 'rules',
        intent: 'attendees',
        toolName: 'GOOGLECALENDAR_EVENTS_LIST',
        args: subject
          ? searchArgs(subject, SEARCH_WINDOW_DAYS, 'primary')
          : dayListArgs(day, 'primary'),
        query: subject,
        day: subject ? null : day,
      };
    }

    // ── free time ──────────────────────────────────────────────────────────
    // Computed locally from the day's events; the Google freeBusy tools are
    // scope-blocked on this connection.
    if (/\bfree\b|\bavailab|\bopen slot|\bopening|\bgap\b|\bbusy\b/.test(text)) {
      const person = findPersonMention(text, directory);
      if (person) {
        return {
          via: 'rules',
          intent: 'person',
          toolName: 'GOOGLECALENDAR_EVENTS_LIST',
          args: dayListArgs(day, person.email),
          person,
          day,
        };
      }

      // Named a third party we cannot resolve — say so rather than silently
      // answering about the wearer's own day.
      const named = namedPerson(text);
      if (named) return { via: 'rules', intent: 'unknown-person', name: named };

      return {
        via: 'rules',
        intent: 'freeslots',
        toolName: 'GOOGLECALENDAR_EVENTS_LIST',
        args: dayListArgs(day, 'primary'),
        day,
      };
    }

    // ── someone else's schedule ────────────────────────────────────────────
    // Reading a colleague's calendar directly works where freeBusy does not.
    // "meeting with Kevin" is about my own event, so `with` stays out of this.
    const person = findPersonMention(text, directory);
    if (person && !/\bwith\b/.test(text)) {
      return {
        via: 'rules',
        intent: 'person',
        toolName: 'GOOGLECALENDAR_EVENTS_LIST',
        args: dayListArgs(day, person.email),
        person,
        day,
      };
    }

    const namedUnknown = namedPerson(text);
    if (namedUnknown && !person) {
      return { via: 'rules', intent: 'unknown-person', name: namedUnknown };
    }

    // ── create ─────────────────────────────────────────────────────────────
    if (/\b(add|create|book|schedule|set up|put)\b/.test(text) && has('GOOGLECALENDAR_QUICK_ADD')) {
      return {
        via: 'rules',
        intent: 'create',
        toolName: 'GOOGLECALENDAR_QUICK_ADD',
        args: { calendar_id: 'primary', text: String(utterance) },
      };
    }

    // ── lookup one named thing ─────────────────────────────────────────────
    // "when does my flight start?" — anything left after stripping question
    // scaffolding and date words is the subject. Nothing left means agenda.
    const term = searchTerm(text);
    if (term && !day) {
      return {
        via: 'rules',
        intent: 'search',
        toolName: 'GOOGLECALENDAR_EVENTS_LIST',
        args: searchArgs(term, SEARCH_WINDOW_DAYS, 'primary'),
        query: term,
      };
    }

    // ── default: the agenda for the requested day ──────────────────────────
    return {
      via: 'rules',
      intent: 'agenda',
      toolName: 'GOOGLECALENDAR_EVENTS_LIST',
      args: dayListArgs(day, 'primary'),
      day,
    };
  },
};

/** Any directory person named anywhere in the utterance. */
function findPersonMention(text, directory) {
  if (!directory || !directory.length) return null;

  for (const word of searchTerm(text).split(/\s+/)) {
    if (word.length < 3) continue;
    const hit = resolvePerson(word, directory);
    if (hit) return hit;
  }
  return null;
}

/**
 * Grammatical patterns that clearly name a third party. Used to tell "is Tracy
 * busy?" (a person question about someone unknown) apart from "am I busy?" —
 * without this, an unresolvable name silently returns the wearer's own day.
 */
const PERSON_PATTERNS = [
  /\bis\s+([a-z][a-z.'-]+)\s+(?:busy|free|available|around|in)\b/,
  /\b(?:what|when)\s+(?:does|is|has)\s+([a-z][a-z.'-]+)\s+(?:have|doing|got|free|busy|on)\b/,
  /\b([a-z][a-z.'-]+)(?:'s)?\s+(?:calendar|schedule|day|meetings?|availability)\b/,
  /\b(?:show|check)\s+(?:me\s+)?([a-z][a-z.'-]+)(?:'s)?\s+(?:calendar|schedule|day)\b/,
];

/** The third-party name an utterance mentions, resolved or not. */
export function namedPerson(text) {
  const lowered = String(text || '').toLowerCase();
  for (const pattern of PERSON_PATTERNS) {
    const match = lowered.match(pattern);
    if (!match) continue;
    const candidate = match[1];

    // "is my meeting free" / "is the room busy" are not people.
    if (STOPWORDS.indexOf(candidate) !== -1) continue;

    // Nor is "my offsite meeting" — a determiner in front means the wearer is
    // describing their own event, not naming someone else.
    if (new RegExp('\\b(?:my|the|a|an|our|this|that)\\s+' + candidate + '\\b').test(lowered)) continue;

    return candidate;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* LanguageModel planner                                                      */
/* -------------------------------------------------------------------------- */

/**
 * @param {object} deps
 * @param {object} deps.LanguageModel - the AIUI global (injected for testability)
 * @param {Array}  deps.declarations   - function declarations from ComposioClient
 */
export function createLlmPlanner({ LanguageModel, declarations }) {
  let session = null;

  return {
    name: 'language-model',

    /**
     * Whether the on-device model can be used.
     *
     * Wrapped in a timeout because `availability()` does not always settle:
     * on a host without speech/model capabilities it can hang instead of
     * rejecting ("Host capabilities are not configured on Web host"), which
     * would strand the whole turn on "Checking your calendar" with no error.
     * A non-answer is treated as unavailable and the rule planner takes over.
     */
    async available() {
      if (!LanguageModel || typeof LanguageModel.availability !== 'function') return false;
      try {
        const status = await withTimeout(LanguageModel.availability(), AVAILABILITY_TIMEOUT_MS, 'timeout');
        return status === 'available';
      } catch (e) {
        return false;
      }
    },

    async plan(utterance) {
      if (!session) {
        session = await LanguageModel.create({
          initialPrompts: [{ role: 'system', content: SYSTEM_PROMPT }],
          tools: declarations,
        });
      }

      // The toolcall event fires before prompt() resolves, so capture it and
      // then await the text so the session settles either way.
      let captured = null;
      const onToolCall = (event) => {
        if (captured) return;
        captured = { toolName: event.functionName, args: event.arguments || {} };
      };
      session.addEventListener('toolcall', onToolCall);

      let text = '';
      try {
        text = await session.prompt(String(utterance || ''));
      } finally {
        if (typeof session.removeEventListener === 'function') {
          session.removeEventListener('toolcall', onToolCall);
        }
      }

      if (captured) return { via: 'language-model', toolName: captured.toolName, args: captured.args };
      return { via: 'language-model', reply: text };
    },

    destroy() {
      if (session && typeof session.destroy === 'function') session.destroy();
      session = null;
    },
  };
}

export { SYSTEM_PROMPT };
