/**
 * Kavi configuration.
 *
 * No third-party credentials or account ids live here. Calendar and other
 * services are "connections" authorized through Composio, but the Composio key
 * stays on the BACKEND (COMPOSIO_API_KEY); the glasses only ever talk to the
 * Kavi backend with their device token (docs/14). The list of connections is in
 * CONNECTIONS below.
 */

/**
 * Rows the fixed-height list can show. The list is a plain <view>, not a
 * <scroll-view> (see utils/calendar.js capRows), so anything beyond this is
 * summarised as "+N more" rather than scrolled to.
 */
export const MAX_VISIBLE_ROWS = 4;

/**
 * Whether to route utterances through the on-device LanguageModel.
 *
 * OFF by default, and this is deliberate. `LanguageModel.availability()` does
 * not always settle — on a host without model capabilities it can hang rather
 * than reject, and there is no `setTimeout` in the verified AIUI API surface to
 * race it with. A hung probe strands the turn on "Checking your calendar" with
 * no error and no network call. Probing is therefore replaced by an explicit
 * switch: turn this on once you have confirmed the model answers on your
 * device. The rule planner handles every intent this agent supports.
 */
export const PLANNER = {
  useLanguageModel: false,
};

/** Working window used when computing free slots locally. */
export const WORKDAY = {
  startHour: 9,
  endHour: 18,
  minSlotMinutes: 30,
};

/**
 * The device's UTC offset, in minutes east of UTC.
 *
 * This has to be configured because the Ink runtime cannot report it:
 * `getTimezoneOffset()` returns garbage and `Intl` is not defined (see
 * utils/clock.js for the full list of what the runtime's Date does and does not
 * implement). 540 = UTC+09:00, Asia/Tokyo.
 *
 * With `autoLearn` on, the real offset is read from the calendar's own event
 * timestamps on the first successful fetch and cached, so a wrong default
 * self-corrects after one request. It does not track daylight saving on its
 * own — it adopts whatever offset the calendar is currently reporting.
 */
export const TIMEZONE = {
  offsetMinutes: 540,
  autoLearn: true,
  cacheKey: 'people-memory:tz-offset',
};

/**
 * Bumped by hand whenever the rendering or layout changes. `app.js` logs it on
 * launch, so a screenshot of the runtime log says exactly which build is
 * running — otherwise a stale bundle and a real bug look identical.
 */
export const BUILD = 20;

/**
 * Diagnostics that must stay off on a device.
 *
 * `logSpeech` echoes the full spoken sentence to the console. On a glasses log
 * that sentence can be a recognised person's name plus the private note about
 * them, or a meeting title and attendees — content that should not sit in a log
 * anyone can screenshot. Off by default; the dev harness turns it on for its own
 * bundle (see dev/server.mjs) so the SPOKEN panel still works. When off, only
 * the length is logged, which is enough to confirm something was said.
 */
export const DEBUG = {
  logSpeech: false,
};

/**
 * Face memory, backed by Supabase.
 *
 * Recognition happens in a Supabase Edge Function, not on the glasses. The Ink
 * runtime has no image decoder and no face model, so anything on-device could
 * only ever compare pixels — which is not face recognition and does not survive
 * a change of light or head pose. The function runs YuNet for detection and
 * SFace for the embedding, pgvector does the similarity search, and the finished
 * card comes back as JSON. This app takes the photo and draws the answer.
 *
 * `projectUrl` and `apiKey` come from Project Settings > API. The key is safe
 * to ship inside the .aix even though anyone can unzip it: `people` and
 * `face_embeddings` have row-level security enabled with no policies, so it
 * reads and writes nothing directly. Only the Edge Functions hold the service
 * role key, and they decide what a caller may touch.
 *
 * `ownerId` separates wearers when one project backs several pairs of glasses.
 *
 * `directoryKey` is written by the agenda page so a spoken name resolves to a
 * colleague's email without refetching the calendar, and `contextKey` carries
 * today's events so a recognised face can be reported alongside the meeting the
 * two of you share.
 */
export const FACE = {
  projectUrl: 'https://YOUR-PROJECT-REF.supabase.co',

  // The project's publishable key. A legacy anon JWT works here too — both are
  // accepted by the functions gateway, and both were verified against this
  // project. An unauthenticated call is rejected with 401.
  apiKey: 'YOUR_SUPABASE_PUBLISHABLE_KEY',

  /**
   * A low-privilege app-identity key, checked by the functions' `guard()` only
   * when the server sets `APP_KEY_VALUES`. NOT the admin/service key and NOT a
   * secret — it ships in the .aix like `apiKey`. It drops unkeyed scanner noise
   * and gives a rotation kill-switch. Empty ⇒ no `x-app-key` header is sent
   * (correct while the server gate is unset). Match one of `APP_KEY_VALUES`.
   */
  appKey: '',

  ownerId: 'default',

  /**
   * Per-wearer authorization token, when the backend runs multi-wearer.
   *
   * Empty for a single-wearer deployment: the functions only serve the
   * `default` bucket unless `OWNER_SIGNING_SECRET` is set on the project, so a
   * stray or forged `ownerId` cannot reach anyone else's face memory. To back
   * several pairs of glasses from one project, set that secret and put each
   * pair's HMAC token here — `openssl dgst -sha256 -hmac "<secret>" <<<"<ownerId>"`.
   * The secret itself never ships to a device.
   */
  ownerToken: '',

  // Generous on purpose: a request that lands on a cold instance pays for the
  // model load as well as the inference.
  timeoutMs: 30000,

  /**
   * A stand-in for the camera, for the dev harness only.
   *
   * The web build of Ink has no camera provider — `createCameraContext()`
   * answers "CameraContext is not supported on web media provider" — so the
   * face page could not be exercised anywhere but on the glasses. When this is
   * set, and only when the host has no real camera, `takePhoto()` fetches this
   * URL instead. `dev/server.mjs` serves whatever photo you chose in the
   * harness at http://localhost:5178/dev-camera.
   *
   * It cannot shadow a working camera: the real one is tried first and this is
   * only reached if it is absent. Empty for device builds — `dev/server.mjs`
   * injects the local camera URL for the harness, the same way it injects
   * `AUTH.devToken`; `npm run pack` warns if it was left set.
   */
  devCameraUrl: '',
  directoryKey: 'people-memory:directory',
  contextKey: 'people-memory:last-schedule',
};

/**
 * Connections — external services the wearer authorizes through Composio
 * (docs/14). Face and text memory are built-in defaults and are NOT listed here.
 *
 * This is only the registry the glasses show and route by; the Composio key
 * lives server-side (COMPOSIO_API_KEY on the backend), never on the device. To
 * add a service: add its Composio auth config in the dashboard, then add an entry
 * here (slug = Composio toolkit slug, tools = the tool slugs to expose). Nothing
 * else in the app changes.
 */
export const CONNECTIONS = [
  {
    slug: 'googlecalendar',
    name: 'Google Calendar',
    // Spoken names the router matches "Kavi <alias> <action>" against (docs/16).
    // English + Vietnamese; matched against folded (accent-free) text.
    // 'schedule' is deliberately NOT an alias: it is also the create verb
    // ("schedule a meeting"), and routing it here would strip that intent.
    aliases: ['calendar', 'lich', 'agenda'],
    summary: 'Read your day, answer calendar questions, and add events',
    category: 'Productivity',
    icon: '📅',
    // `kind` gates outbound actions: the app confirms before any 'write'/'send'.
    tools: [
      { name: 'GOOGLECALENDAR_EVENTS_LIST', kind: 'read' },
      { name: 'GOOGLECALENDAR_QUICK_ADD', kind: 'write' },
    ],
  },
  {
    slug: 'gmail',
    name: 'Gmail',
    aliases: ['gmail', 'mail', 'email', 'thu', 'hop thu'],
    summary: 'Read and search your inbox by voice',
    category: 'Communication',
    icon: '✉️',
    tools: [
      { name: 'GMAIL_FETCH_EMAILS', kind: 'read' },
      { name: 'GMAIL_SEND_EMAIL', kind: 'send' },
    ],
  },
  {
    slug: 'slack',
    name: 'Slack',
    aliases: ['slack', 'tin nhan'],
    summary: 'Catch up on messages and post to a channel',
    category: 'Communication',
    icon: '💬',
    tools: [
      { name: 'SLACK_FETCH_CONVERSATION_HISTORY', kind: 'read' },
      { name: 'SLACK_SEND_MESSAGE', kind: 'send' },
    ],
  },
];

/**
 * Device sign-in, backed by Supabase (the login flow in docs/11).
 *
 * The glasses pair with an account through a short code the wearer opens on a
 * phone browser — no app to install, no password on the glasses. On success the
 * glasses hold a single revocable device token, stored under `tokenKey`. It
 * reuses the same Supabase project as FACE; the `pair` Edge Function runs the
 * handshake and serves the phone page.
 *
 * `required` gates the app behind sign-in. It is ON for the store build: this is
 * what identifies each wearer, and that identity is what scopes BOTH the calendar
 * (their connection) and face memory (their own people) to one person — so no two
 * wearers of the same install ever see each other's data. Turn it OFF for local
 * dev if you want to skip the phone handshake; `pair` must be deployed
 * (`npm run deploy`) and the migration pushed (`npm run db:push`) for ON to work.
 */
export const AUTH = {
  projectUrl: FACE.projectUrl,
  apiKey: FACE.apiKey,
  // Same low-privilege app key as FACE — see FACE.appKey. Mirrored so the sign-in
  // client sends it on the pair handshake too.
  appKey: FACE.appKey,
  tokenKey: 'people-memory:device-token',

  /**
   * A pairing that has been started but not yet claimed — `{ deviceCode,
   * userCode, link }`. Written the moment the glasses get a code, cleared as
   * soon as a token is issued, so the sign-in card can resume an interrupted
   * pairing and "Kavi sync" can pick the token up after the phone step.
   */
  pendingKey: 'people-memory:pending-pairing',

  /**
   * The secret that makes these glasses one tenant for as long as they live.
   * Issued by the backend on the first pairing and sent back on every later one,
   * so signing out and in again lands on the wearer's existing people memory
   * rather than an empty account. Never cleared on sign-out; dropped by the
   * backend when the device is revoked.
   */
  deviceUidKey: 'people-memory:device-uid',

  timeoutMs: 15000,
  required: true,

  /**
   * Dev harness only: a device token used when nothing is stored yet, so the
   * runtime harness can render real connection data without a full phone
   * sign-in. Empty for device builds — `dev/server.mjs` injects it from
   * KAVI_DEV_TOKEN, and `npm run pack` warns if it was left set. Same shape as
   * FACE.devCameraUrl: it can only ever fill in for a missing real session.
   */
  devToken: '',
};

/**
 * The agent's unique trigger word — its name, its wake word, and the prefix on
 * its spoken commands. Coined on purpose: it is not an everyday word in English
 * or Vietnamese, so nothing else (the built-in assistant, another agent, a
 * common phrase) can claim it, and both languages' ASR catch it cleanly.
 * Keep this in step with the Name in AGENTS.md and the matcher in
 * utils/planner.js (signinCommand).
 */
export const WAKE_WORD = 'kavi';

/**
 * Ambient freshness. The agent is a personal always-on card, so it refreshes
 * itself rather than waiting to be asked.
 *
 * Refresh happens when the page appears (`onLoad`) and whenever it returns to
 * the foreground (`onShow`) with data older than `staleAfterMs`. That is the
 * documented AIUI lifecycle and the right model for glasses: no work happens
 * while the card is out of view.
 *
 * `backgroundPollMs` would additionally re-poll while the card stays visible,
 * but `setInterval` is NOT part of the verified AIUI runtime API surface, so it
 * is feature-detected and disabled by default. Set it to e.g. 120000 only after
 * confirming timers work on your device.
 */
export const REFRESH = {
  cacheKey: 'people-memory:last-schedule',
  staleAfterMs: 5 * 60 * 1000,
  backgroundPollMs: 0,

  // Bump when the shape of a cached row changes. Rows are bound straight into
  // the template, and Ink warns on any variable missing from the data, so a
  // stale-shaped cache must be discarded rather than rendered.
  cacheVersion: 4,
};
