<script def>
{
  "navigationBarTitleText": "People Memory",
  "description": "Live agenda card for a day: event times, titles, locations and links. Answers spoken calendar questions and adds events by voice.",
  "schema": {
    "data": {
      "type": "object",
      "properties": {
        "utterance": {
          "type": "string",
          "description": "The wearer's request in their own words, e.g. 'what do I have today'. When absent the card shows today's schedule."
        },
        "date": {
          "type": "string",
          "description": "Day to display as yyyy-mm-dd. Defaults to today on the device."
        }
      },
      "required": []
    }
  }
}
</script>

<script setup>
import wx from 'wx';

import {
  WAKE_WORD,
  REFRESH,
  WORKDAY,
  TIMEZONE,
  MAX_VISIBLE_ROWS,
  PLANNER,
  FACE,
  DEBUG,
  AUTH,
} from '../../config.js';
import { createConnectionsClient } from '../../utils/connections.js';
import { requireSignin } from '../../utils/gate.js';
import { createLlmPlanner, rulePlanner, faceCommand, signinCommand } from '../../utils/planner.js';
import { runTurn } from '../../utils/agent.js';
import { createStore, wxBackend } from '../../utils/store.js';
import { buildDirectory } from '../../utils/people.js';
import {
  capRows,
  dayListArgs,
  rowClass,
  dayRange,
  extractEvents,
  getOffset,
  learnOffset,
  normalizeEvents,
  relativeTime,
  setOffset,
  speakableSummary,
  todayKey,
} from '../../utils/calendar.js';

export default {
  data: {
    // idle | listening | thinking | ready | failed
    status: 'idle',
    // agenda | people | slots | notice — which body the card renders
    mode: 'agenda',
    wakeWord: WAKE_WORD,
    heard: '',
    dayLabel: '',
    subLabel: '',
    rows: [],
    people: [],
    slots: [],
    moreNote: '',
    hasRows: false,
    eventCount: 0,
    freshness: '',
    refreshing: false,
    errorText: '',
    staleNote: '',
  },

  async onLoad(query) {
    // Sign-in gate (docs/11). Inert unless AUTH.required; when on, a launch with
    // no stored token routes to sign-in before any work happens here.
    if (requireSignin(wx)) return;

    this.store = createStore(wxBackend(wx));

    // Tools (calendar, and later Slack/Gmail/…) run through the Kavi backend,
    // which proxies Composio for this wearer with the device token from sign-in
    // (docs/14). Same interface the app used before, so nothing downstream
    // changes. The Composio key is server-side, never on the glasses.
    const session = this.store.read(AUTH.tokenKey);
    this.deviceToken = (session && session.token) || AUTH.devToken || '';
    this.composio = createConnectionsClient({
      projectUrl: AUTH.projectUrl,
      apiKey: AUTH.apiKey,
      token: this.deviceToken,
      timeoutMs: AUTH.timeoutMs,
    });

    this.date = (query && query.date) || '';
    this.fetchedAt = 0;

    // The runtime cannot report its own UTC offset, so start from config and
    // adopt anything better we cached from the calendar on a previous run.
    const cachedOffset = this.store.read(TIMEZONE.cacheKey);
    setOffset(cachedOffset && typeof cachedOffset.minutes === 'number'
      ? cachedOffset.minutes
      : TIMEZONE.offsetMinutes);

    // Who the wearer shares meetings with, and their own day — the context a
    // turn needs to resolve "Kevin" and to detect overlaps.
    this.directory = [];
    this.myRows = [];

    const utterance = (query && query.utterance) || '';

    /**
     * Was this page opened to answer something?
     *
     * An AIUI agent has no home screen. Pages are MCP UI components the host
     * model opens to answer a request, and `app.json`'s first entry is only a
     * *default landing page* for a bare launch. Fetching and rendering the
     * agenda on that bare launch made the calendar look like the app's resting
     * state — it appeared before the wearer had said anything, and every later
     * answer looked as though it had "gone back" to it.
     *
     * So an uncommanded open stays idle: no cache paint, no network, no
     * polling, just the wake prompt. Nothing happens until asked.
     */
    this.commanded = Boolean(utterance || this.date);

    if (!this.commanded) {
      this.setData({ dayLabel: 'Kavi', status: 'idle' });
      return;
    }

    this.setData({ dayLabel: dayRange(this.date).label });

    // Paint the last known agenda immediately — once a request is in flight, a
    // HUD should never sit empty while the network settles.
    this.paintFromCache();

    // A spoken request answers out loud; a dispatched date refreshes quietly.
    //
    // `onShow` fires immediately after `onLoad`, so without this guard the
    // page runs two overlapping fetches: the utterance turn and a plain
    // agenda refresh. They then race to setData, and the card ends up with
    // the header from one and the rows from the other.
    if (utterance) {
      this.answering = true;
      try {
        await this.handleUtterance(utterance);
      } finally {
        this.answering = false;
      }
    } else {
      await this.refresh({ silent: true });
    }
  },

  onShow() {
    this.visible = true;

    // Never asked for anything, so there is nothing to keep fresh.
    if (!this.commanded) return;

    // A turn opened with an utterance owns the card; do not race it.
    if (this.answering) return;

    // Re-read on return to view: stale data, or the day rolled over while the
    // card was hidden.
    const stale = Date.now() - this.fetchedAt > REFRESH.staleAfterMs;
    const rolled = !this.date && this.loadedDate && this.loadedDate !== todayKey();
    if (stale || rolled) this.refresh({ silent: true });
    else this.setData({ freshness: relativeTime(this.fetchedAt) });

    this.startPolling();
  },

  onHide() {
    this.visible = false;
    this.stopPolling();
  },

  onUnload() {
    this.stopPolling();
    if (this.planner && this.planner.destroy) this.planner.destroy();
    if (this.recognition && this.recognition.abort) this.recognition.abort();
  },

  /**
   * Optional while-visible polling. `setInterval` is not part of the verified
   * AIUI runtime API surface, so it is feature-detected and stays off unless
   * REFRESH.backgroundPollMs is set. onShow refreshing is the primary path.
   */
  startPolling() {
    if (!REFRESH.backgroundPollMs || this.timer) return;
    if (typeof setInterval !== 'function') return;
    this.timer = setInterval(() => {
      if (this.visible && !this.data.refreshing) this.refresh({ silent: true });
    }, REFRESH.backgroundPollMs);
  },

  stopPolling() {
    if (this.timer && typeof clearInterval === 'function') clearInterval(this.timer);
    this.timer = null;
  },

  paintFromCache() {
    const cached = this.store.read(REFRESH.cacheKey);
    if (!cached || !cached.rows) return;
    if (cached.version !== REFRESH.cacheVersion) return;   // older row shape
    if (cached.date !== dayRange(this.date).date) return;

    this.fetchedAt = cached.fetchedAt || 0;
    this.loadedDate = cached.date;
    // Rebuild the computed class: a row persisted by an older build may not
    // carry it, and a missing template variable silently drops the `row` class
    // entirely, leaving an unstyled — invisible — element.
    const restored = cached.rows.map((row) => ({
      ...row,
      rowClass: row.rowClass || rowClass(row.isNow, row.declined, row.clashCount),
      clashCount: row.clashCount || 0,
      clashWith: row.clashWith || '',
      clashLabel: row.clashLabel || '',
      titleShort: row.titleShort || row.title,
      locationShort: row.locationShort || row.location || '',
    }));
    const cappedCache = capRows(restored, MAX_VISIBLE_ROWS);
    this.setData({
      status: 'ready',
      rows: cappedCache.visible,
      moreNote: cappedCache.moreNote,
      hasRows: restored.length > 0,
      eventCount: cached.rows.length,
      dayLabel: cached.dayLabel || this.data.dayLabel,
      freshness: relativeTime(this.fetchedAt),
    });
  },

  /** Read the agenda without involving the model. Silent runs never speak. */
  async refresh(options) {
    const silent = !options || options.silent !== false;

    // Re-entrancy is tracked on the instance, NOT on this.data. setData is
    // asynchronous, so a flag written there is not visible to a call made
    // later in the same tick — the offset-correction retry below would hit a
    // stale `refreshing: true`, return immediately, and strand the card on
    // "Checking your calendar" with no error and no second request.
    if (this.busy) return;
    this.busy = true;

    this.setData({ refreshing: true, errorText: '', staleNote: '' });
    if (!this.data.hasRows && this.data.status !== 'ready') this.setData({ status: 'thinking' });

    try {
      const result = await this.composio.callTool(
        'GOOGLECALENDAR_EVENTS_LIST',
        dayListArgs(this.date, 'primary')
      );

      if (!result.ok) {
        this.busy = false;
        // Service not connected, or the device token is gone → send them to
        // sign-in (which is where connections get authorized).
        if (result.reason === 'not-connected' || result.reason === 'signed-out') {
          wx.navigateTo({ url: '/pages/signin/signin' });
          return;
        }
        this.fail(result.error, silent);
        return;
      }

      // Adopt the calendar's real offset before shaping anything with it. If
      // it disagrees with what we assumed, the window we just asked for was
      // the wrong day — refetch once with the corrected offset.
      if (TIMEZONE.autoLearn) {
        const learned = learnOffset(result.data);
        if (learned !== null && learned !== getOffset()) {
          console.log('[people-memory] offset corrected %d -> %d', getOffset(), learned);
          setOffset(learned);
          this.store.write(TIMEZONE.cacheKey, { minutes: learned });
          this.busy = false;
          return this.refresh(options);
        }
      }

      const range = dayRange(this.date);
      const rows = normalizeEvents(result.data);

      // Refresh the people directory and my-day context off the same payload.
      this.myRows = rows;
      this.directory = buildDirectory(extractEvents(result.data));

      // Hand the directory to the face page, which has no calendar of its own
      // but needs to turn a spoken name into a colleague's address. Versioned
      // so a stale-shaped directory is discarded rather than trusted.
      this.store.write(FACE.directoryKey, { version: REFRESH.cacheVersion, people: this.directory });

      this.fetchedAt = Date.now();
      this.loadedDate = range.date;
      this.store.write(REFRESH.cacheKey, {
        version: REFRESH.cacheVersion,
        date: range.date,
        dayLabel: range.label,
        rows,
        fetchedAt: this.fetchedAt,
      });

      const capped = capRows(rows, MAX_VISIBLE_ROWS);
      this.setData({
        status: 'ready',
        mode: 'agenda',
        rows: capped.visible,
        moreNote: capped.moreNote,
        hasRows: rows.length > 0,
        eventCount: rows.length,
        dayLabel: range.label,
        subLabel: '',
        freshness: relativeTime(this.fetchedAt),
        refreshing: false,
        errorText: '',
        staleNote: '',
      });
      this.busy = false;
      if (!silent) this.speak(speakableSummary(rows, range.label));
    } catch (error) {
      this.busy = false;
      this.fail(String((error && error.message) || error), silent);
    }
  },

  onVoiceWakeup(event) {
    if (event.keyword && event.keyword !== WAKE_WORD) return;
    // From here on the page has been asked for something, so `onShow` may
    // keep it fresh and polling may run.
    this.commanded = true;
    this.startListening();
  },

  onKeyUp(event) {
    if (event.code === 'GlobalHook' || event.code === 'Enter') {
      event.preventDefault();
      this.commanded = true;
      this.startListening();
    }
  },

  startListening() {
    if (this.data.status === 'listening' || this.data.status === 'thinking') return;

    if (typeof SpeechRecognition === 'undefined') {
      this.fail('Speech recognition is unavailable on this device.', false);
      return;
    }

    this.setData({ status: 'listening', heard: '', errorText: '', staleNote: '' });

    const recognition = new SpeechRecognition();
    this.recognition = recognition;

    recognition.onresult = (event) => {
      const best = event.results && event.results[0] && event.results[0][0];
      const transcript = (best && best.transcript) || '';
      this.setData({ heard: transcript });
      this.handleUtterance(transcript);
    };
    recognition.onerror = () => this.fail('I did not catch that.', false);
    recognition.start();
  },

  async ensurePlanner() {
    if (this.planner) return this.planner;

    // Opt-in only: probing the host for model availability can hang forever
    // and there is no timer available to race it with. See config.PLANNER.
    if (PLANNER.useLanguageModel && typeof LanguageModel !== 'undefined') {
      const declarations = await this.composio.toFunctionDeclarations();
      const llm = createLlmPlanner({ LanguageModel, declarations });
      if (await llm.available()) {
        this.planner = llm;
        return this.planner;
      }
    }
    this.planner = rulePlanner;
    return this.planner;
  },

  /** A spoken request: let the model pick the tool, then answer out loud. */
  async handleUtterance(utterance) {
    // Sign-in trigger words route to the sign-in page directly — the platform
    // cannot be relied on to do it on real glasses (docs/12). The gate handles
    // the wordless case (no token on launch).
    if (signinCommand(utterance)) {
      wx.navigateTo({ url: '/pages/signin/signin' });
      return;
    }

    // Face commands are not calendar questions. They are handed straight to the
    // face page, which owns the camera and the people memory — the same route
    // the host model takes when it dispatches on the page's own schema.
    const face = faceCommand(utterance);
    if (face) {
      const params = ['action=' + encodeURIComponent(face.action)];
      if (face.name) params.push('name=' + encodeURIComponent(face.name));
      if (face.note) params.push('note=' + encodeURIComponent(face.note));
      wx.navigateTo({ url: '/pages/face/face?' + params.join('&') });
      return;
    }

    this.setData({ status: 'thinking', refreshing: true, errorText: '', staleNote: '' });

    try {
      const planner = await this.ensurePlanner();
      const turn = await runTurn({
        utterance,
        composio: this.composio,
        planner,
        context: { directory: this.directory, myRows: this.myRows, workday: WORKDAY },
        // Only the stage name. The detail carries plan.args — calendar search
        // terms and attendee/calendar addresses — which do not belong in a log.
        onStage: (stage) => console.log('[people-memory] stage ' + stage),
      });

      if (turn.kind === 'error') {
        // A revoked token or a disconnected calendar surfaces as an error here
        // too. Route to sign-in — where connections are (re)authorized — exactly
        // like the silent refresh path does, rather than only saying so.
        const reason = turn.result && turn.result.reason;
        if (reason === 'not-connected' || reason === 'signed-out') {
          wx.navigateTo({ url: '/pages/signin/signin' });
          return;
        }
        this.fail(turn.error, false);
        return;
      }

      // Every kind below is a transient view over the card. None of them
      // touches the cached agenda or fetchedAt, so the next onShow restores
      // today's schedule on its own.
      if (turn.kind === 'unknown-person') {
        this.setData({
          status: 'ready',
          mode: 'notice',
          dayLabel: turn.dayLabel,
          subLabel: '',
          errorText: turn.spoken,
          rows: [],
          hasRows: false,
          eventCount: 0,
          refreshing: false,
        });
        this.speak(turn.spoken);
        return;
      }

      if (turn.kind === 'attendees') {
        // The list is a plain <view> with no scrolling, so cap it here and
        // report the remainder rather than letting it overflow the card.
        const cappedPeople = capRows(turn.people, MAX_VISIBLE_ROWS + 1, 'person');
        this.setData({
          status: 'ready',
          mode: 'people',
          people: cappedPeople.visible,
          dayLabel: turn.dayLabel,
          subLabel: turn.subLabel,
          eventCount: turn.people.length,
          moreNote: cappedPeople.moreNote,
          rows: [],
          hasRows: false,
          freshness: '',
          errorText: '',
          staleNote: '',
        });
      } else if (turn.kind === 'freeslots') {
        this.setData({
          status: 'ready',
          mode: 'slots',
          slots: turn.slots,
          dayLabel: turn.dayLabel,
          subLabel: turn.subLabel,
          eventCount: turn.slots.length,
          moreNote: '',
          rows: [],
          hasRows: false,
          freshness: '',
          errorText: '',
          staleNote: '',
        });
      } else if (turn.kind === 'person' || turn.kind === 'search') {
        const capped = capRows(turn.rows, MAX_VISIBLE_ROWS);
        this.setData({
          status: 'ready',
          mode: 'agenda',
          rows: capped.visible,
          moreNote: capped.moreNote,
          hasRows: turn.rows.length > 0,
          eventCount: turn.rows.length,
          dayLabel: turn.dayLabel,
          subLabel: turn.subLabel || '',
          freshness: '',
          errorText: '',
          staleNote: '',
        });
      } else if (turn.kind === 'events') {
        const range = dayRange(turn.plan.day);
        this.fetchedAt = Date.now();
        this.loadedDate = range.date;
        this.store.write(REFRESH.cacheKey, {
          version: REFRESH.cacheVersion,
          date: range.date,
          dayLabel: turn.dayLabel,
          rows: turn.rows,
          fetchedAt: this.fetchedAt,
        });
        const cappedTurn = capRows(turn.rows, MAX_VISIBLE_ROWS);
        this.setData({
          status: 'ready',
          mode: 'agenda',
          rows: cappedTurn.visible,
          moreNote: cappedTurn.moreNote,
          hasRows: turn.rows.length > 0,
          eventCount: turn.rows.length,
          dayLabel: turn.dayLabel,
          subLabel: '',
          freshness: relativeTime(this.fetchedAt),
        });
      } else {
        // A non-agenda tool ran; keep the card and refresh it behind the answer.
        await this.refresh({ silent: true });
      }

      this.setData({ refreshing: false });
      this.speak(turn.spoken);
    } catch (error) {
      this.fail(String((error && error.message) || error), false);
    }
  },

  speak(text) {
    if (!text) return;
    // The spoken line can name an event and its attendees, so the content is
    // logged only when DEBUG.logSpeech is on (the dev harness, never a device).
    // Otherwise just its length, which still confirms something was said.
    console.log(DEBUG.logSpeech ? '[people-memory] speak: ' + text : '[people-memory] speak (' + text.length + ' chars)');
    if (typeof speechSynthesis === 'undefined') return;
    speechSynthesis.speak(new SpeechSynthesisUtterance(text), 'immediate');
  },

  /**
   * A silent refresh that fails keeps the last good card on screen — the
   * wearer gets a quiet staleness marker rather than a lost agenda.
   */
  fail(message, silent) {
    const keptCard = this.data.hasRows;
    this.setData({
      status: keptCard ? 'ready' : 'failed',
      errorText: message,
      // Precomputed: Ink evaluates an expression only as a whole attribute,
      // so compound conditions belong in JS, not the template.
      staleNote: keptCard ? 'Last sync failed — showing ' + this.data.freshness : '',
      refreshing: false,
    });
    if (!silent) this.speak('I could not reach your calendar. ' + message);
  },

  retry() {
    this.refresh({ silent: false });
  },
};
</script>

<page>
  <view class="card">

    <view class="head">
      <text class="day">{{ dayLabel }}</text>
      <view class="headmeta">
        <text class="pill" ink:if="{{ refreshing }}">syncing</text>
        <text class="fresh" ink:elif="{{ subLabel }}">{{ subLabel }}</text>
        <text class="fresh" ink:elif="{{ freshness }}">{{ freshness }}</text>
        <text class="count" ink:if="{{ eventCount }}">{{ eventCount }}</text>
      </view>
    </view>

    <view class="rule"></view>

    <!-- Voice capture and first load -->
    <view class="center" ink:if="{{ status === 'listening' || status === 'thinking' }}">
      <text class="mark {{ status === 'listening' ? 'on' : '' }}">◉</text>
      <text class="centertext">{{ status === 'listening' ? 'Listening' : 'Checking your calendar' }}</text>
      <text class="heard" ink:if="{{ heard }}">{{ heard }}</text>
    </view>

    <!-- Hard failure with nothing cached to fall back on -->
    <view class="center" ink:elif="{{ status === 'failed' }}">
      <error-state text="{{ errorText }}"></error-state>
      <button bindtap="retry">Retry</button>
    </view>

    <!-- Results. One card, four bodies.
         `<block>` is not implemented by the Ink runtime — it falls back to
         `<view>`, so every grouping wrapper here is an explicit flex column
         rather than a phantom element. -->
    <view class="body" ink:elif="{{ status === 'ready' }}">

      <!-- who is in a meeting -->
      <view class="list" ink:if="{{ mode === 'people' }}">
        <view class="prow" ink:for="{{ people }}" ink:key="email">
          <text class="pname">{{ item.name }}</text>
          <text class="tag dim" ink:if="{{ item.self }}">you</text>
          <text class="tag" ink:if="{{ item.organizer }}">host</text>
          <text class="tag" ink:if="{{ item.status }}">{{ item.status }}</text>
          <text class="tag dim" ink:if="{{ item.optional }}">optional</text>
        </view>
      </view>

      <!-- free openings -->
      <view class="body" ink:elif="{{ mode === 'slots' }}">
        <view class="list" ink:if="{{ slots.length }}">
          <view class="row" ink:for="{{ slots }}" ink:key="start">
            <text class="rowtime">{{ item.start }}</text>
            <text class="rowtitle">{{ item.duration }} free</text>
          </view>
        </view>
        <text class="empty" ink:else>Fully booked.</text>
      </view>

      <!-- a person we do not know -->
      <view class="center" ink:elif="{{ mode === 'notice' }}">
        <error-state text="{{ errorText }}"></error-state>
      </view>

      <!-- agenda, lookup matches, or someone else's day -->
      <view class="body" ink:else>
        <!-- This if/else pair is alone in its parent on purpose: Ink resolves
             every conditional sibling as ONE chain, so an unrelated ink:if
             placed alongside them consumes the ink:else and the list silently
             never renders. Each chain gets its own container. -->
        <view class="list" ink:if="{{ hasRows }}">
          <!-- Deliberately flat: one <view> holding two <text> children, which
               is the structure the scaffolded template uses. Nested flex
               columns, transparent borders and overflow:hidden inside the row
               did not lay out reliably across hosts — the row measured zero and
               nothing painted, while the card header still rendered. Anything
               richer belongs in the second line, not in more nesting. -->
          <view class="row" ink:for="{{ rows }}" ink:key="id">
            <text class="rowtime">{{ item.start }}</text>
            <text class="rowtitle">{{ item.titleShort }}</text>
          </view>
        </view>
        <text class="empty" ink:else>Nothing scheduled.</text>
      </view>

      <!-- Footnotes live in their own wrapper so their ink:if cannot interfere
           with the mode chain above. -->
      <view class="notes">
        <text class="stale" ink:if="{{ moreNote }}">{{ moreNote }}</text>

        <!-- A background refresh failed, but the cached agenda still stands -->
        <text class="stale" ink:if="{{ staleNote }}">{{ staleNote }}</text>
      </view>
    </view>

    <view class="center" ink:else>
      <text class="mark">◉</text>
      <text class="centertext">Say “{{ wakeWord }}” to ask</text>
    </view>

  </view>
</page>

<style>
/* Single-green monochrome HUD: one hue, four opacity steps, on pure black.
   Host theme tokens first, spec values as fallbacks. */

.card {
  display: flex;
  flex-direction: column;
  /* Content-box dimensions: the 448 x 352 canvas minus 12px padding and the
     2px border per side. `box-sizing: border-box` is not honoured by the Ink
     CSS engine, so declaring 448 here renders a 476px-wide card and the right
     edge is clipped.

     Height is a range, not a fixed value: Craft renders pages as auto-height
     cards in a conversation flow, where a hard height gets clipped. The spec's
     120-352px envelope becomes 96-324px once padding and border are removed. */
  width: 420px;
  /* Floor from the spec's 120px minimum, less padding and border. Without it
     the card measures ~0 in `width-constrained-auto-height`, the runtime
     reports ~0 content height, and the host gives the surface no room. */
  min-height: 92px;
  /* No height at all. In `width-constrained-auto-height` — Craft's chat card —
     the runtime derives the surface height FROM the content, so a fixed height
     here is circular and the card collapses. The host clips instead. */
  background: var(--color-surface, #000000);
  border: var(--border-width-default, 2px) solid var(--border-color-default, rgba(64, 255, 94, 0.6));
  border-radius: var(--radius-md, 12px);
  padding: var(--spacing-md, 12px);
  overflow: hidden;
}

/* ── header ── */
.head {
  display: flex;
  flex-direction: row;
  align-items: baseline;
  justify-content: space-between;
  overflow: hidden;
}

.day {
  font-family: monospace;
  font-size: 18px;
  font-weight: 700;
  line-height: 1.3;
  color: var(--color-primary, #40ff5e);
}

.headmeta {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: var(--spacing-sm, 8px);
}

.fresh,
.pill {
  font-size: 11px;
  line-height: 1.4;
  color: var(--color-text-secondary, rgba(64, 255, 94, 0.6));
}

.pill {
  border: var(--border-width-thin, 1px) solid var(--border-color-muted, rgba(64, 255, 94, 0.4));
  border-radius: 9999px;
  padding: 0 var(--spacing-sm, 8px);
}

.count {
  font-family: monospace;
  font-size: 13px;
  color: var(--color-primary, #40ff5e);
}

.rule {
  height: var(--border-width-thin, 1px);
  background: var(--border-color-muted, rgba(64, 255, 94, 0.4));
  margin: var(--spacing-sm, 8px) 0;
}

/* Grouping wrapper. `<block>` is unimplemented in the Ink runtime and falls
   back to `<view>`, so these must be real flex columns to keep the layout.

   Deliberately NOT `flex: 1`: Craft renders pages in auto-height mode, where
   the parent's height comes from its content. A flex child asking to fill that
   height is circular and resolves to zero, which silently blanks the list. */
/* Pure content sizing — no flex-grow, no min/max height anywhere in the
   chain from .card down to .row. Every flex-based attempt resolved to zero
   height in at least one host, because .card itself has no definite height
   for a `flex: 1` child to divide. The card clips; capRows bounds the rows. */
.body {
  display: flex;
  flex-direction: column;
}

/* ── centered states ── */
.center {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  /* Definite height rather than flex:1 — see the note on .body. Kept small
     enough for the 448 x 150 Interactive InkView surface. */
  min-height: 84px;
  gap: var(--spacing-md, 12px);
}

.mark {
  font-size: 32px;
  line-height: 1.2;
  color: var(--color-primary-40, rgba(64, 255, 94, 0.4));
}

.mark.on {
  color: var(--color-primary, #40ff5e);
}

.centertext {
  font-size: 15px;
  line-height: 1.5;
  color: var(--color-text-secondary, rgba(64, 255, 94, 0.6));
}

.heard {
  font-size: 15px;
  line-height: 1.5;
  text-align: center;
  color: var(--color-primary, #40ff5e);
}

.empty {
  flex: 1;
  font-size: 15px;
  line-height: 1.5;
  text-align: center;
  padding-top: var(--spacing-xl, 24px);
  color: var(--color-text-secondary, rgba(64, 255, 94, 0.6));
}

/* ── agenda list ── */
/* Height has to come from the parent, not a constant.
   The surface is 448x352 full-screen but only 448x150 in Interactive InkView,
   and both report layout_mode=bounded — so `flex: 1` resolves correctly in
   each. A constant like 236px is taller than the whole 150px card, and a flex
   child that cannot fit is shrunk toward zero rather than clipped, which is
   why the rows vanished there but not at 352.
   `min-height` is the floor for Craft's auto-height chat card, where the
   parent has no height to divide and `flex: 1` alone would collapse.
   `flex-shrink: 0` stops the floor itself being shrunk away. */
/* A plain <view> that sizes to its content — NOT a <scroll-view>.
   scroll-view only paints children when it has a definite pixel height, and
   there is no way to give it one that works everywhere: `flex: 1`,
   `min-height` and `max-height` all leave it zero-height in at least one host,
   and a bound `style="{{ … }}"` is ignored (Ink documents `style` only as a
   literal). Overflow is bounded by capRows instead, which caps the row count
   and reports the remainder as "+N more". */
.list {
  display: flex;
  flex-direction: column;
}

/* Flat row: a plain flex line with two text children and nothing else. */
.row {
  display: flex;
  flex-direction: row;
  padding: var(--spacing-sm, 8px) 0;
}

.rowtime {
  width: 62px;
  font-family: monospace;
  font-size: 13px;
  line-height: 1.4;
  color: var(--color-primary, #40ff5e);
}

.rowtitle {
  width: 330px;
  font-size: 15px;
  line-height: 1.4;
  color: var(--color-primary, #40ff5e);
}


/* State rail. Both variants are the same width, so toggling one for the other
   never reflows the row (spec elevation level 3 — an accent for active rows). */



.start {
  font-family: monospace;
  font-size: 13px;
  line-height: 1.4;
  color: var(--color-primary, #40ff5e);
}

.stop {
  font-family: monospace;
  font-size: 11px;
  line-height: 1.4;
  color: var(--color-primary-40, rgba(64, 255, 94, 0.4));
}

/* A lookup can return any day, so matched rows show their own date. */
.date {
  font-size: 11px;
  line-height: 1.4;
  color: var(--color-text-secondary, rgba(64, 255, 94, 0.6));
}

/* min-width:0 is required: a flex item defaults to min-width:auto, so a long
   title would otherwise widen the row past the 448px canvas. Titles are also
   clipped in JS, since text-overflow is not supported. */
/* Fills whatever the row leaves. Titles are clipped in JS, so this never has
   to shrink below its content. */

.title {
  font-size: 15px;
  line-height: 1.5;
  color: var(--color-primary, #40ff5e);
}

.tags {
  display: flex;
  flex-direction: row;
  overflow: hidden;
  gap: var(--spacing-xs, 4px);
  margin-top: var(--spacing-xs, 4px);
}

.tag {
  font-size: 11px;
  line-height: 1.4;
  color: var(--color-text-secondary, rgba(64, 255, 94, 0.6));
  border: var(--border-width-thin, 1px) solid var(--border-color-muted, rgba(64, 255, 94, 0.4));
  border-radius: 9999px;
  padding: 0 var(--spacing-sm, 8px);
  max-width: 180px;
  overflow: hidden;
  white-space: nowrap;
}

.notes {
  display: flex;
  flex-direction: column;
}

.stale {
  font-size: 11px;
  line-height: 1.4;
  text-align: center;
  padding-top: var(--spacing-xs, 4px);
  color: var(--color-text-secondary, rgba(64, 255, 94, 0.6));
}

.tag.strong {
  color: var(--color-primary, #40ff5e);
  border-color: var(--border-color-accent, #40ff5e);
}

.tag.dim {
  color: var(--color-primary-40, rgba(64, 255, 94, 0.4));
}

/* ── attendee rows ── */
.prow {
  /* 420 card content - 16 (own padding) - 4 (own border) = 400.
     Pinned because flex children in this engine grow past the parent's
     content box rather than being constrained by it. */
  width: 400px;
  display: flex;
  flex-direction: row;
  overflow: hidden;
  align-items: center;
  gap: var(--spacing-sm, 8px);
  padding: var(--spacing-sm, 8px) 0;
  border-bottom: var(--border-width-thin, 1px) solid var(--border-color-muted, rgba(64, 255, 94, 0.4));
}

.pname {
  flex: 1;
  font-size: 15px;
  line-height: 1.5;
  color: var(--color-primary, #40ff5e);
}



button {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.3;
  color: var(--color-primary, #40ff5e);
  background: var(--color-surface, #000000);
  border: var(--border-width-default, 2px) solid var(--border-color-accent, #40ff5e);
  border-radius: var(--radius-sm, 12px);
  padding: var(--spacing-sm, 8px) var(--spacing-md, 12px);
  text-align: center;
}
</style>
