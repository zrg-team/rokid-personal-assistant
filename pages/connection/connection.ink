<script def>
{
  "navigationBarTitleText": "Kavi",
  "description": "Runs an action on a connected service and shows the result: read Gmail ('any new mail', 'mail from Tracy') or catch up on Slack. Calendar and face memory have their own cards.",
  "schema": {
    "data": {
      "type": "object",
      "properties": {
        "slug": { "type": "string", "description": "the connection to use: 'gmail' or 'slack'" },
        "action": { "type": "string", "description": "the request in the wearer's own words, e.g. 'from Tracy' or 'newer than 2 days'; may be empty for a default view" }
      }
    }
  }
}
</script>

<script setup>
/**
 * The `Kavi <connection> <action>` result card (docs/16).
 *
 * A generic page: the router (utils/planner.connectionCommand) sends it a `slug`
 * and the spoken `action`; utils/connplan turns that into one Composio tool call
 * and the result into a small card. So Gmail and Slack — and any future
 * connection — share this one page. Calendar and faces keep their own richer
 * pages; this is for read-style catch-ups.
 *
 * Same runtime lessons as the rest of the app: setData is async (guards on the
 * instance), no word-break in the CSS engine (lines are pre-clipped in connplan),
 * and no work runs without a device token (the gate redirects to sign-in).
 */
import wx from 'wx';

import { AUTH, DEBUG, CONNECTIONS } from '../../config.js';
import { createStore, wxBackend } from '../../utils/store.js';
import { createConnectionsClient } from '../../utils/connections.js';
import { plan, render } from '../../utils/connplan.js';
import { clip } from '../../utils/calendar.js';
import { requireSignin } from '../../utils/gate.js';
import { MOOD, INITIAL, createFace, moodFor } from '../../utils/mood.js';

function messageOf(error) {
  if (!error) return 'Something went wrong';
  if (typeof error === 'string') return error;
  if (error.message) return String(error.message);
  try { return JSON.stringify(error).slice(0, 120); } catch { return 'Something went wrong'; }
}

function nameOf(slug) {
  const c = (CONNECTIONS || []).find((x) => x.slug === slug);
  return (c && c.name) || slug || 'Kavi';
}

export default {
  data: {
    // The agent face (utils/mood.js). Spread so this page cannot fall behind
    // the vocabulary — an undeclared key binds to empty and the dot vanishes.
    ...INITIAL,
    // working | ready | not-connected | error
    status: 'working',
    title: 'Kavi',
    subtitle: 'Working…',
    lines: [],
    hasLines: false,
    errorText: '',
    hint: '',
  },

  async onLoad(query) {
    if (requireSignin(wx)) return;   // no token → sign-in first

    this.face = createFace((d) => this.setData(d));
    this.store = createStore(wxBackend(wx));
    const session = this.store.read(AUTH.tokenKey);
    const token = (session && session.token) || AUTH.devToken || '';
    this.client = createConnectionsClient({
      projectUrl: AUTH.projectUrl,
      apiKey: AUTH.apiKey,
      token,
      timeoutMs: AUTH.timeoutMs,
    });

    const slug = (query && query.slug) || '';
    const action = (query && query.action) || '';
    this.slug = slug;
    const name = nameOf(slug);
    this.show({ status: 'working', title: name, subtitle: 'Checking…', lines: [], hasLines: false, errorText: '', hint: '' });

    const p = plan(slug, action);
    if (!p) { this.fail(name, 'I cannot do that on ' + name + ' yet.'); return; }

    let res;
    try {
      res = await this.client.callTool(p.tool, p.args);
    } catch (error) {
      this.fail(name, messageOf(error));
      return;
    }

    if (!res || !res.ok) {
      const reason = res && res.reason;
      if (reason === 'not-connected') {
        this.show({
          status: 'not-connected', title: name, subtitle: 'Not connected', lines: [], hasLines: false,
          errorText: 'Connect ' + name + ' first — say “Kavi status”.', hint: 'Press to open sign-in.',
        });
        this.speak('Connect ' + name + ' first. Say Kavi status.');
        return;
      }
      if (reason === 'signed-out') { this.toSignin(); return; }
      this.fail(name, (res && res.error) || 'That did not work.');
      return;
    }

    const card = render(slug, res.data);
    this.setData({
      status: 'ready', title: name, subtitle: card.title,
      lines: card.lines, hasLines: card.hasLines, errorText: '', hint: '',
    });
    this.speak(card.spoken);
    // Not `show`: the result rows are the answer, so the face reads out the
    // summary and then steps back to idle rather than sitting there pleased
    // with itself on top of the content.
    this.face.say(card.spoken, MOOD.IDLE);
  },

  /* ── lifecycle: nothing animates off-screen ─────────────────────────────── */

  onShow() {
    if (this.face) this.face.resume();
  },

  onHide() {
    if (this.face) this.face.pause();
  },

  onUnload() {
    if (this.face) this.face.pause();
  },

  /* ── input: one press goes back (or to sign-in when not connected) ──────── */

  onKeyUp(event) {
    if (event.code === 'GlobalHook' || event.code === 'Enter') {
      event.preventDefault();
      this.onCardTap();
    }
  },

  onCardTap() {
    if (this.data.status === 'not-connected') { this.toSignin(); return; }
    try { wx.redirectTo({ url: '/pages/index/index' }); } catch (error) { /* harness may not navigate */ }
  },

  toSignin() {
    try { wx.navigateTo({ url: '/pages/signin/signin' }); } catch (error) { /* harness */ }
  },

  /** Paint the card and move the face with it — the status alone decides here. */
  show(patch) {
    this.setData(patch);
    if (patch.status && this.face) this.face.set(moodFor('connection', patch.status));
  },

  fail(name, message) {
    this.show({
      status: 'error', title: name || 'Kavi', subtitle: '', lines: [], hasLines: false,
      errorText: clip(message, 90), hint: 'Press to go back.',
    });
    this.speak(message);
  },

  speak(text) {
    if (!text) return;
    console.log(DEBUG.logSpeech ? '[people-memory] speak: ' + text : '[people-memory] speak (' + text.length + ' chars)');
    try {
      if (wx.speech && wx.speech.playTTS) { wx.speech.playTTS(text); return; }
    } catch (error) {
      console.log('[people-memory] playTTS failed: ' + messageOf(error));
    }
    if (typeof speechSynthesis === 'undefined') return;
    speechSynthesis.speak(new SpeechSynthesisUtterance(text), 'immediate');
  },
};
</script>

<page>
  <view class="card" bindtap="onCardTap">

    <view class="head">
      <text class="title">{{ title }}</text>
      <text class="dots" ink:if="{{ status === 'working' }}">•••</text>
    </view>

    <view class="rule"></view>

    <view class="body">

      <!-- The agent face, in its own wrapper so its conditional cannot join the
           chain below it. Hidden once the rows arrive: the answer is the point,
           and this card has no room to show both. -->
      <view class="stage">
        <view class="face" ink:if="{{ status !== 'ready' }}">
          <view class="eyes">
            <view class="{{ eyeL }}"></view>
            <view class="{{ eyeR }}"></view>
          </view>
          <view class="mouth">
            <view class="{{ mouth }}"></view>
          </view>
        </view>
      </view>

      <text class="sub" ink:if="{{ subtitle }}">{{ subtitle }}</text>

      <view class="rows" ink:if="{{ hasLines }}">
        <view class="row" ink:for="{{ lines }}" ink:key="id">
          <text class="rtitle">{{ item.title }}</text>
          <text class="rsub" ink:if="{{ item.subtitle }}">{{ item.subtitle }}</text>
        </view>
      </view>

      <view class="notes">
        <text class="err" ink:if="{{ errorText }}">{{ errorText }}</text>
        <text class="hint" ink:if="{{ hint }}">{{ hint }}</text>
      </view>
    </view>

  </view>
</page>

<style>
.card {
  display: flex;
  flex-direction: column;
  width: 420px;
  min-height: 92px;
  background: var(--color-surface, #000000);
  border: var(--border-width-default, 2px) solid var(--border-color-default, rgba(64, 255, 94, 0.6));
  border-radius: var(--radius-md, 12px);
  padding: var(--spacing-md, 12px);
  overflow: hidden;
}

.head {
  display: flex;
  flex-direction: row;
  align-items: baseline;
  justify-content: space-between;
}

.title {
  font-family: monospace;
  font-size: 18px;
  font-weight: 700;
  line-height: 1.3;
  color: var(--color-primary, #40ff5e);
}

.dots {
  font-size: 13px;
  color: var(--color-text-secondary, rgba(64, 255, 94, 0.6));
}

.rule {
  height: var(--border-width-thin, 1px);
  background: var(--border-color-muted, rgba(64, 255, 94, 0.4));
  margin: var(--spacing-sm, 8px) 0;
}

.body {
  display: flex;
  flex-direction: column;
}

.stage {
  display: flex;
  flex-direction: column;
  align-items: center;
}

.sub {
  font-size: 13px;
  line-height: 1.5;
  color: var(--color-primary, #40ff5e);
}

/* ==== agentface:begin ================================================
   The agent face. THIS COPY IS CANONICAL — dev/check-face.mjs fails the
   build if any other page's block has drifted from it. The moods that
   choose between these tokens live in utils/mood.js.

   Only properties this app already exercises on-device are load-bearing:
   brightness is background-color with an alpha, not `opacity`; position is
   `margin`, not `transform`. Both of those are listed as supported but are
   used nowhere else in this repo, so nothing here depends on them.

   `transition` is pure enhancement. If the engine ignores it the frames
   become hard cuts, which is still correct — just less alive. */

.face {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  /* Definite heights all the way down. `flex: 1` resolves to zero in Craft's
     auto-height card, which would silently blank the whole face. */
  height: 48px;
  gap: var(--spacing-xs, 6px);
}

/* flex-start, so each token's margin-top places it deterministically inside
   the row rather than being re-centred by the engine. */
/* 14px, not 20. At 20 the eyes read as two unrelated dots rather than a pair —
   about two-thirds of an eye width is where they start belonging to one face. */
.eyes {
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  justify-content: center;
  height: 34px;
  gap: 14px;
}

.mouth {
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  justify-content: center;
  height: 8px;
}

.ea, .eb, .ed, .edl, .edr, .ee, .ef, .eg, .eh, .ei, .ej,
.m0, .m1, .m2, .m3, .m4 {
  display: block;
  transition-property: width, height, margin-top, margin-left, margin-right,
                       border-radius, background-color;
  transition-duration: 190ms;
  transition-timing-function: ease-out;
}

/* ── eyes ── */

/* neutral */
.ea { width: 24px; height: 24px; border-radius: 12px; margin-top: 5px;
      background-color: var(--color-primary, #40ff5e); }
/* alert — wide open, for a live microphone or an unrecognised face */
.eb { width: 26px; height: 32px; border-radius: 13px; margin-top: 1px;
      background-color: var(--color-primary, #40ff5e); }
/* lowered lid, level. `.edl`/`.edr` are the same lid with the pair nudged one
   way or the other — the margin sits on the OUTER edge of the pair only, so
   `justify-content: center` slides both eyes together and the gap between them
   is untouched. Putting it on both eyes pushes them apart instead. */
.ed  { width: 24px; height: 12px; border-radius: 6px; margin-top: 19px;
       background-color: var(--color-primary, #40ff5e); }
.edl { width: 24px; height: 12px; border-radius: 6px; margin-top: 19px;
       margin-left: 16px; background-color: var(--color-primary, #40ff5e); }
.edr { width: 24px; height: 12px; border-radius: 6px; margin-top: 19px;
       margin-right: 16px; background-color: var(--color-primary, #40ff5e); }
/* content squint */
.ee { width: 28px; height: 12px; border-radius: 6px; margin-top: 11px;
      background-color: var(--color-primary, #40ff5e); }
/* shut. Faster than the rest so a blink snaps closed and eases back open. */
.ef { width: 26px; height: 5px; border-radius: 3px; margin-top: 15px;
      background-color: var(--color-primary, #40ff5e);
      transition-duration: 90ms; }
/* asleep — shut and dimmed */
.eg { width: 26px; height: 5px; border-radius: 3px; margin-top: 15px;
      background-color: var(--color-primary-40, rgba(64, 255, 94, 0.4)); }
/* raised: looking up at the wearer, waiting on them */
.ej { width: 24px; height: 24px; border-radius: 12px; margin-top: 0;
      background-color: var(--color-primary, #40ff5e);
      transition-duration: 260ms; }
/* apertures. Content-box, so 18 + 2*3 border = 24, matching .ea.
   The fill is alpha 0 rather than `transparent`, whose keyword support here
   is unverified — if the fill ever paints, LOOK collapses into IDLE. */
.eh { width: 18px; height: 18px; border-radius: 12px; margin-top: 5px;
      background-color: rgba(64, 255, 94, 0);
      border: 3px solid var(--color-primary, #40ff5e); }
.ei { width: 10px; height: 10px; border-radius: 8px; margin-top: 9px;
      background-color: rgba(64, 255, 94, 0);
      border: 3px solid var(--border-color-default, rgba(64, 255, 94, 0.6)); }

/* ── mouth ──
   Hidden is alpha 0, never `width: 0`: the box has to keep its space or the
   row reflows and the face jumps sideways every time the mouth appears. */

.m0 { width: 24px; height: 4px; border-radius: 2px; margin-top: 2px;
      background-color: rgba(64, 255, 94, 0); }
.m1 { width: 8px; height: 4px; border-radius: 2px; margin-top: 2px;
      background-color: var(--color-primary-40, rgba(64, 255, 94, 0.4)); }
.m2 { width: 16px; height: 4px; border-radius: 2px; margin-top: 2px;
      background-color: var(--color-primary, #40ff5e); }
.m3 { width: 30px; height: 4px; border-radius: 2px; margin-top: 2px;
      background-color: var(--color-primary, #40ff5e); }
.m4 { width: 10px; height: 6px; border-radius: 5px; margin-top: 1px;
      background-color: var(--color-primary, #40ff5e); }
/* ==== agentface:end ================================================== */

.rows {
  display: flex;
  flex-direction: column;
  padding-top: var(--spacing-xs, 4px);
}

.row {
  display: flex;
  flex-direction: column;
  padding: var(--spacing-xs, 4px) 0;
}

.rtitle {
  font-size: 14px;
  line-height: 1.35;
  color: var(--color-primary, #40ff5e);
}

.rsub {
  font-size: 11px;
  line-height: 1.35;
  color: var(--color-text-secondary, rgba(64, 255, 94, 0.6));
}

.notes {
  display: flex;
  flex-direction: column;
}

.err {
  font-size: 13px;
  line-height: 1.4;
  color: var(--color-primary, #40ff5e);
}

.hint {
  font-size: 11px;
  line-height: 1.4;
  padding-top: var(--spacing-xs, 4px);
  color: var(--color-text-secondary, rgba(64, 255, 94, 0.6));
}
</style>
