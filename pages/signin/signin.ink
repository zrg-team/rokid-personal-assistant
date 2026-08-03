<script def>
{
  "navigationBarTitleText": "Sign in",
  "description": "Signs the wearer in and links these glasses to their account. Shows a short code and a web address to open on a phone, then finishes with a press once the wearer approves. Use for 'sign in', 'log in', 'connect my account', or 'link my glasses'.",
  "schema": {
    "data": {
      "type": "object",
      "properties": {},
      "required": []
    }
  }
}
</script>

<script setup>
/**
 * Device sign-in for the glasses — the login flow drawn in docs/11.
 *
 * The glasses start a pairing and show a short code and a web address. The wearer
 * opens that address on a phone, signs in, and approves; the glasses poll until
 * the phone approves, show the confirm word to compare, and finish on a temple
 * press by exchanging the session for a token. Everything happens over Supabase
 * Edge Functions — nothing else. No password ever reaches the glasses.
 *
 * Runtime notes that shape this page (same lessons as the rest of the app):
 *  - `setData` is async, so guards live on the instance (`this.busy`, `this.polling`).
 *  - `setInterval` is not on every build; polling uses a feature-detected
 *    recursive `setTimeout`, and falls back to "press to check" without one.
 *  - No work runs off-screen: `onHide` stops polling.
 */
import wx from 'wx';

import { AUTH, DEBUG } from '../../config.js';
import { createStore, wxBackend } from '../../utils/store.js';
import { createAuthService } from '../../utils/authservice.js';
import { clip } from '../../utils/calendar.js';

function messageOf(error) {
  if (!error) return 'Something went wrong';
  if (typeof error === 'string') return error;
  if (error.message) return String(error.message);
  try { return JSON.stringify(error).slice(0, 120); } catch { return 'Something went wrong'; }
}

/** "green-tiger-42" reads better aloud as "green tiger 42". */
function spoken(code) {
  return String(code || '').split('-').join(' ');
}

export default {
  data: {
    // starting | waiting | approved | signed-in | failed
    status: 'starting',
    userCode: '',
    verifyUrl: '',
    confirmWord: '',
    hint: 'Starting…',
    errorText: '',
  },

  async onLoad() {
    this.store = createStore(wxBackend(wx));
    this.service = createAuthService(AUTH);
    this.visible = true;

    if (!this.service.configured) {
      this.fail('Sign-in is not configured. Set AUTH.projectUrl and AUTH.apiKey in config.js.');
      return;
    }

    // Already signed in? Verify the stored token. A token revoked from the web
    // fails here and drops through to a fresh pairing; a mere network hiccup is
    // treated as still-signed-in so the wearer is never signed out by bad wifi.
    const saved = this.store.read(AUTH.tokenKey);
    if (saved && saved.token) {
      const res = await this.service.check(saved.token);
      if (res.ok) {
        this.setData({ status: 'signed-in', hint: 'You are signed in. Press to continue.' });
        this.speak('You are already signed in.');
        return;
      }
      this.store.write(AUTH.tokenKey, null);
    }

    this.begin();
  },

  onShow() {
    this.visible = true;
    if (this.data.status === 'waiting' && this.deviceCode) this.startPolling();
  },

  onHide() {
    this.visible = false;
    this.stopPolling();
  },

  onUnload() {
    this.stopPolling();
  },

  /* ── start a pairing ──────────────────────────────────────────────────── */

  async begin() {
    this.setData({ status: 'starting', errorText: '', hint: 'Starting…' });
    try {
      const s = await this.service.start();
      this.deviceCode = s.deviceCode;
      this.intervalMs = s.intervalMs || 3000;
      this.setData({
        status: 'waiting',
        userCode: s.userCode,
        // Drop the scheme so the actual Supabase host+path fits the card; set
        // AUTH / PAIR_VERIFY_URL to a short domain if this is too long to type.
        verifyUrl: clip(String(s.verificationUrl || '').replace(/^https?:\/\//, ''), 56),
        confirmWord: '',
        hint: 'Open the address on your phone and enter the code.',
      });
      this.speak('Open the address on your phone and enter ' + spoken(s.userCode));
      this.startPolling();
    } catch (error) {
      this.fail(messageOf(error));
    }
  },

  /* ── polling for approval ─────────────────────────────────────────────── */

  startPolling() {
    if (this.polling) return;
    if (typeof setTimeout !== 'function') {
      // No timers on this host: let the wearer poll by pressing after approving.
      this.setData({ hint: 'After you approve on your phone, press to check.' });
      return;
    }
    this.polling = true;
    const tick = async () => {
      if (!this.polling) return;
      await this.checkOnce();
      if (this.polling) this.timer = setTimeout(tick, this.intervalMs);
    };
    this.timer = setTimeout(tick, this.intervalMs);
  },

  stopPolling() {
    this.polling = false;
    if (this.timer && typeof clearTimeout === 'function') clearTimeout(this.timer);
    this.timer = null;
  },

  /** One poll. Advances the card when the phone has approved (or the code died). */
  async checkOnce() {
    if (this.busy || !this.deviceCode) return;
    try {
      const r = await this.service.poll(this.deviceCode);
      if (!this.visible) return;
      if (r.status === 'approved') {
        this.stopPolling();
        this.setData({
          status: 'approved',
          confirmWord: r.confirmWord,
          hint: 'Check your phone shows the same word, then press the temple.',
        });
        this.speak('Approved. If your phone shows ' + spoken(r.confirmWord) + ', press to finish.');
      } else if (r.status === 'claimed') {
        this.stopPolling();
        this.setData({ status: 'signed-in', hint: 'Signed in. Press to continue.' });
      } else if (r.status === 'expired') {
        this.stopPolling();
        this.setData({ status: 'failed', errorText: 'That code expired.', hint: 'Press to start again.' });
      }
      // 'pending' → keep waiting
    } catch (error) {
      // Transient network error: keep polling, do not disturb the card.
    }
  },

  /* ── finishing (the temple-press confirm) ─────────────────────────────── */

  async finish() {
    if (this.busy) return;
    this.busy = true;
    this.setData({ hint: 'Finishing…' });
    try {
      const r = await this.service.claim(this.deviceCode);
      if (r.status === 'claimed' && r.token) {
        this.store.write(AUTH.tokenKey, { token: r.token, ownerId: r.ownerId });
        this.setData({ status: 'signed-in', errorText: '', hint: 'Signed in.' });
        this.speak('Signed in.');
        this.goToApp();
      } else if (r.status === 'expired') {
        this.setData({ status: 'failed', errorText: 'That code expired.', hint: 'Press to start again.' });
      } else {
        this.setData({ hint: 'Not approved yet — approve on your phone, then press again.' });
      }
    } catch (error) {
      this.fail(messageOf(error));
    } finally {
      this.busy = false;
    }
  },

  goToApp() {
    try {
      wx.redirectTo({ url: '/pages/index/index' });
    } catch (error) {
      // The harness may not navigate; the card already says "Signed in".
    }
  },

  /* ── input ────────────────────────────────────────────────────────────── */

  onKeyUp(event) {
    if (event.code === 'GlobalHook' || event.code === 'Enter') {
      event.preventDefault();
      this.trigger();
    }
  },

  onCardTap() {
    this.trigger();
  },

  /** One press means different things depending on where we are. */
  trigger() {
    switch (this.data.status) {
      case 'approved': this.finish(); return;
      case 'signed-in': this.goToApp(); return;
      case 'waiting': this.checkOnce(); return;
      default: this.begin();            // starting / failed → (re)start
    }
  },

  /* ── drawing and speaking ─────────────────────────────────────────────── */

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

  fail(message) {
    this.stopPolling();
    this.setData({ status: 'failed', errorText: clip(message, 90), hint: 'Press to try again.' });
  },
};
</script>

<page>
  <view class="card" bindtap="onCardTap">

    <view class="head">
      <text class="title">Sign in</text>
      <text class="dots" ink:if="{{ status === 'waiting' }}">•••</text>
    </view>

    <view class="rule"></view>

    <view class="body">
      <!-- waiting for the phone -->
      <view class="block" ink:if="{{ status === 'waiting' }}">
        <text class="label">On your phone, open</text>
        <text class="mono url">{{ verifyUrl }}</text>
        <text class="label">and enter code</text>
        <text class="mono code">{{ userCode }}</text>
      </view>

      <!-- approved: compare the word, then press -->
      <view class="block" ink:elif="{{ status === 'approved' }}">
        <text class="label">Your phone should show</text>
        <text class="mono code">{{ confirmWord }}</text>
        <text class="label">Matches? Press the temple.</text>
      </view>

      <!-- done -->
      <view class="block" ink:elif="{{ status === 'signed-in' }}">
        <text class="ok">Signed in</text>
      </view>

      <!-- footnotes live in their own wrapper (isolated ink:if chains) -->
      <view class="notes">
        <text class="err" ink:if="{{ errorText }}">{{ errorText }}</text>
        <text class="hint">{{ hint }}</text>
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

.block {
  display: flex;
  flex-direction: column;
}

.label {
  font-size: 12px;
  line-height: 1.5;
  padding-top: var(--spacing-xs, 4px);
  color: var(--color-text-secondary, rgba(64, 255, 94, 0.6));
}

.mono {
  font-family: monospace;
  color: var(--color-primary, #40ff5e);
}

.url {
  /* 11px so the full Supabase host+path (~50 chars) fits the 396px content box:
     word-break/white-space are not supported by the Ink CSS engine, so the line
     cannot wrap — it must fit on one line or it clips. */
  font-size: 11px;
  line-height: 1.4;
}

.code {
  font-size: 22px;
  font-weight: 700;
  line-height: 1.4;
  letter-spacing: 1px;
}

.ok {
  font-size: 20px;
  font-weight: 700;
  line-height: 1.4;
  color: var(--color-primary, #40ff5e);
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
