/**
 * Copy this file to `config.js` and fill in your own keys.
 * `config.js` is gitignored so credentials never land in the repository.
 */

/**
 * Composio connection settings.
 *
 * transport: 'mcp'  -> talk MCP JSON-RPC to `mcpUrl` (preferred; no key on device)
 *            'rest' -> talk Composio v3 REST to `restBaseUrl` with `apiKey`
 *
 * The supplied key (<composio-api-key>) is a *scoped* key: it can read
 * toolkits/tools/connected_accounts and execute tools, but it cannot provision
 * an MCP server (POST /api/v3/mcp/servers -> 403, needs "sessions" write).
 * So 'rest' is the working default. Create an MCP server with a full-access
 * project key, paste the URL into `mcpUrl`, flip transport to 'mcp', and the
 * rest of the app is unchanged.
 */
export const composioConfig = {
  transport: 'rest',

  // --- MCP transport -------------------------------------------------------
  mcpUrl: '',

  // --- REST transport ------------------------------------------------------
  restBaseUrl: 'https://backend.composio.dev',
  apiKey: '<composio-api-key>',

  // Composio end-user whose connected accounts we act on. Composio holds the
  // Google OAuth tokens for this user, so the glasses never run an auth flow —
  // they send a user id and Composio attaches the credentials server-side.
  userId: '<composio-user-id>',

  // Optional: pin the exact already-authorized connection instead of letting
  // Composio infer it from the toolkit. Set this and a second Google account
  // connected later cannot silently change which calendar is read.
  // Composio requires user_id alongside it, which the client already sends.
  connectedAccountId: '<connected-account-id>',

  // Toolkits exposed to the on-device model. Add 'gmail', 'slack', ... to grow
  // the agent's reach — nothing else in the app needs to change.
  toolkits: ['googlecalendar'],

  // Cap how many tool definitions we hand the model in one session.
  maxTools: 12,

  // Best-effort deadline on every Composio request. The Ink runtime has no
  // AbortController, so a hung `fetch` cannot be cancelled — but racing a timer
  // lets the turn fail with a message instead of stranding the card forever.
  // Feature-detected against setTimeout, so it is a no-op where timers are
  // absent (see utils/composio.js).
  timeoutMs: 15000,
};

/**
 * The only tools the agent may use. Composio's googlecalendar toolkit exposes
 * 28; handing all of them to a small on-device model makes it pick badly, so
 * this narrows the surface to what is both needed and actually reachable.
 *
 * Deliberately excluded:
 *   FIND_FREE_SLOTS, FREE_BUSY_QUERY  — 403, need a broader OAuth scope than
 *                                       this connection has. Free time is
 *                                       computed locally in utils/freeslots.js.
 *   LIST_CALENDARS                    — 403, same scope limit.
 *   FIND_EVENT                        — EVENTS_LIST with `q` does the same job
 *                                       and returns a saner response shape.
 *   GET_CURRENT_DATE_TIME             — the device already knows the date.
 *   UPDATE_EVENT, DELETE_EVENT, and
 *   the CALENDARS and ACL families    — destructive or out of scope for now.
 */
export const TOOL_ALLOWLIST = [
  'GOOGLECALENDAR_EVENTS_LIST',
  'GOOGLECALENDAR_QUICK_ADD',
  'GOOGLECALENDAR_CREATE_EVENT',
];

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
export const BUILD = 18;

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
  projectUrl: 'https://qnjqghqjdyqrpifrbbdf.supabase.co',

  // The project's publishable key. A legacy anon JWT works here too — both are
  // accepted by the functions gateway, and both were verified against this
  // project. An unauthenticated call is rejected with 401.
  apiKey: '<supabase-publishable-key>',

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
   * only reached if it is absent. Leave it empty for a device build; `npm run
   * pack` warns if it is not.
   */
  devCameraUrl: '',
  directoryKey: 'people-memory:directory',
  contextKey: 'people-memory:last-schedule',
};

/**
 * Device sign-in, backed by Supabase (the login flow in docs/11).
 *
 * The glasses pair with an account through a short code the wearer opens on a
 * phone browser — no app to install, no password on the glasses. On success the
 * glasses hold a single revocable device token, stored under `tokenKey`. It
 * reuses the same Supabase project as FACE; the `pair` Edge Function runs the
 * handshake and serves the phone page.
 *
 * `required` gates the app behind sign-in. It is OFF by default so the existing
 * demo is unchanged; turn it on once `pair` is deployed (`npm run deploy`) and
 * the migration is pushed (`npm run db:push`).
 */
export const AUTH = {
  projectUrl: FACE.projectUrl,
  apiKey: FACE.apiKey,
  tokenKey: 'people-memory:device-token',
  timeoutMs: 15000,
  required: false,
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

/** Order the allowed tools are offered to the model in. */
export const PREFERRED_TOOLS = TOOL_ALLOWLIST;
