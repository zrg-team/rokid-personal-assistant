<script def>
{
  "navigationBarTitleText": "Sign in",
  "description": "Signs the wearer in and links these glasses to their account. Shows a short code and a web address to open on a phone, then finishes with a press once the wearer approves. Use for 'start', 'bắt đầu', 'sign in', 'log in', 'đăng nhập', 'connect my account', or 'link my glasses'. Pass the wearer's words as `utterance` so a 'sync'/'cập nhật' said after authorizing on the phone finishes the sign-in without a press.",
  "schema": {
    "data": {
      "type": "object",
      "properties": {
        "utterance": {
          "type": "string",
          "description": "The wearer's spoken words, verbatim."
        }
      },
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
import { syncCommand } from '../../utils/planner.js';
import { clip } from '../../utils/calendar.js';
import { MOOD, INITIAL, createFace, moodFor } from '../../utils/mood.js';

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

/**
 * A query value, decoded. The gate percent-encodes what the wearer said on its
 * way here; the host model hands it over already plain. Both must work, and a
 * stray '%' in dictated text is not worth failing the command over.
 */
function param(query, key) {
  const raw = (query && query[key]) || '';
  if (!raw) return '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return String(raw);
  }
}

export default {
  data: {
    // The three agent-face keys. Spread rather than written out so a page can
    // never fall behind the vocabulary: a key the template binds but `data` omits
    // resolves to empty, and the dot renders as an invisible zero-size box.
    ...INITIAL,
    // starting | waiting | approved | signed-in | failed
    status: 'starting',
    userCode: '',
    link: '',
    confirmWord: '',
    hint: 'Starting…',
    errorText: '',
    // Hidden while the card is showing a code to read (see `show`).
    showFace: true,
  },

  async onLoad(query) {
    this.store = createStore(wxBackend(wx));
    this.service = createAuthService(AUTH);
    this.face = createFace((d) => this.setData(d));
    this.visible = true;

    if (!this.service.configured) {
      this.fail('Sign-in is not configured. Set AUTH.projectUrl and AUTH.apiKey in config.js.');
      return;
    }

    this.face.set(MOOD.THINK);

    // Already signed in? Verify the stored token. A token revoked from the web
    // fails here and drops through to a fresh pairing; a mere network hiccup is
    // treated as still-signed-in so the wearer is never signed out by bad wifi.
    const saved = this.store.read(AUTH.tokenKey);
    if (saved && saved.token) {
      const res = await this.service.check(saved.token);
      if (res.ok) {
        this.show({ status: 'signed-in', hint: 'You are signed in. Press to continue.' });
        this.speak('You are already signed in.');
        return;
      }
      this.store.write(AUTH.tokenKey, null);
    }

    // A pairing left over from a previous run: the wearer may have authorized it
    // on their phone while this card was closed. Pick it up rather than burning
    // a fresh code — the one they are looking at on the phone is still the live
    // one. "Kavi sync" said here means "I have authorized it, finish up", so it
    // claims outright; a plain reopen stops at the confirm word for the press.
    const pending = this.store.read(AUTH.pendingKey);
    if (pending && pending.deviceCode) {
      await this.resume(pending, syncCommand(param(query, 'utterance')));
      return;
    }

    this.begin();
  },

  onShow() {
    this.visible = true;
    if (this.face) this.face.resume();
    if (this.data.status === 'waiting' && this.deviceCode) this.startPolling();
  },

  onHide() {
    this.visible = false;
    if (this.face) this.face.pause();
    this.stopPolling();
  },

  onUnload() {
    if (this.face) this.face.pause();
    this.stopPolling();
  },

  /* ── start a pairing ──────────────────────────────────────────────────── */

  async begin() {
    this.show({ status: 'starting', errorText: '', hint: 'Starting…' });
    try {
      // Identify these glasses to the backend so a repeat sign-in returns to the
      // wearer's existing memories. Empty on the very first pairing; the response
      // carries the secret to keep from then on.
      const held = this.store.read(AUTH.deviceUidKey);
      const s = await this.service.start((held && held.uid) || '');
      if (s.deviceUid) this.store.write(AUTH.deviceUidKey, { uid: s.deviceUid });
      this.deviceCode = s.deviceCode;
      this.intervalMs = s.intervalMs || 3000;
      // Survive this page closing: the wearer is about to walk to their phone,
      // and the code they authorize there has to still be claimable afterwards.
      this.store.write(AUTH.pendingKey, {
        deviceCode: s.deviceCode,
        userCode: s.userCode,
        link: s.link,
      });
      this.show({
        status: 'waiting',
        userCode: s.userCode,
        // The full https link with the code baked in. Kept whole (scheme + all)
        // so the Hi Rokid app renders it as a clickable link the wearer can tap
        // to open the sign-in page with the code already filled.
        link: s.link,
        confirmWord: '',
        hint: 'In the Hi Rokid app, tap the link to sign in with Google.',
      });
      this.speak('To sign in, tap the link on your phone and connect your Google Calendar.');
      this.startPolling();
    } catch (error) {
      this.fail(messageOf(error));
    }
  },

  /**
   * Take up a pairing started by an earlier run of this page.
   *
   * @param {{deviceCode: string, userCode: string, link: string}} pending
   * @param {boolean} finishNow  claim straight away ("Kavi sync"), rather than
   *                             stopping at the confirm word for a press.
   */
  async resume(pending, finishNow) {
    this.deviceCode = pending.deviceCode;
    this.intervalMs = 3000;
    this.show({ status: 'starting', errorText: '', hint: 'Checking…' });

    let status = '';
    try {
      const r = await this.service.poll(pending.deviceCode);
      status = r.status;
      if (status === 'approved') {
        // Draw the approved card before claiming, not instead of it: if the
        // claim then fails on a blip, the wearer is left holding the confirm
        // word and a press that works, rather than a stuck "Checking…".
        this.show({
          status: 'approved',
          userCode: pending.userCode,
          confirmWord: r.confirmWord,
          hint: 'Check your phone shows the same word, then press the temple.',
        });
        if (finishNow) { await this.finish(); return; }
        this.speak('Approved. If your phone shows ' + spoken(r.confirmWord) + ', press to finish.');
        return;
      }
    } catch (error) {
      // Offline: keep the pairing and show it again rather than losing the code.
      status = 'pending';
    }

    if (status === 'pending') {
      this.show({
        status: 'waiting',
        userCode: pending.userCode,
        link: pending.link,
        confirmWord: '',
        hint: 'In the Hi Rokid app, tap the link to sign in with Google.',
      });
      this.startPolling();
      return;
    }

    // 'claimed' with no token on this device, or 'expired': the pairing is spent.
    this.store.write(AUTH.pendingKey, null);
    this.begin();
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
        this.show({
          status: 'approved',
          confirmWord: r.confirmWord,
          hint: 'Check your phone shows the same word, then press the temple.',
        });
        this.speak('Approved. If your phone shows ' + spoken(r.confirmWord) + ', press to finish.');
      } else if (r.status === 'claimed') {
        this.stopPolling();
        this.show({ status: 'signed-in', hint: 'Signed in. Press to continue.' });
      } else if (r.status === 'expired') {
        this.stopPolling();
        this.store.write(AUTH.pendingKey, null);
        this.show({ status: 'failed', errorText: 'That code expired.', hint: 'Press to start again.' });
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
    // A hint-only change, so the mood is set by hand: the status is still
    // 'approved' while the claim is in flight, and the face should say "working"
    // rather than keep smiling at a request that has not landed yet.
    this.face.set(MOOD.THINK);
    this.setData({ hint: 'Finishing…' });
    try {
      const r = await this.service.claim(this.deviceCode);
      if (r.status === 'claimed' && r.token) {
        this.store.write(AUTH.tokenKey, { token: r.token, ownerId: r.ownerId });
        this.store.write(AUTH.pendingKey, null);
        this.show({ status: 'signed-in', errorText: '', hint: 'Signed in.' });
        this.speak('Signed in.');
        this.goToApp();
      } else if (r.status === 'expired') {
        this.store.write(AUTH.pendingKey, null);
        this.show({ status: 'failed', errorText: 'That code expired.', hint: 'Press to start again.' });
      } else {
        this.face.set(MOOD.ASK);
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

  /**
   * Paint the card and move the face with it.
   *
   * Every state this page can be in is derivable from `status` alone, so the
   * mapping lives in utils/mood.js rather than being repeated at each call site.
   * The two transitions that change only the hint — claiming, and "not approved
   * yet" — set their mood by hand, because there the status has deliberately not
   * moved.
   */
  show(patch) {
    const next = patch.status;
    if (next) {
      // The tap-link and the code ARE the card in `waiting` and `approved`, and
      // on the 448x150 surface there is no room for both them and a 48px face.
      // Content wins, the same way it does on every other page.
      patch.showFace = next !== 'waiting' && next !== 'approved';
    }
    this.setData(patch);
    if (next && this.face) this.face.set(moodFor('signin', next));
  },

  fail(message) {
    this.stopPolling();
    this.show({ status: 'failed', errorText: clip(message, 90), hint: 'Press to try again.' });
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

      <!-- The agent face: two eyes that change shape, and a mouth bar that is
           hidden for most moods.

           Unconditional, and first, so it cannot join the ink:if chain below —
           Ink resolves every conditional sibling in a parent as ONE chain, and a
           stray branch here would silently swallow one of the states.

           Each class attribute is a SINGLE bound token, never a space-separated
           list: whether Ink splits a bound class on whitespace is unverified, and
           if it does not, the face renders as nothing at all with no warning. -->
      <view class="stage">
        <view class="face" ink:if="{{ showFace }}">
          <view class="eyes">
            <view class="{{ eyeL }}"></view>
            <view class="{{ eyeR }}"></view>
          </view>
          <view class="mouth">
            <view class="{{ mouth }}"></view>
          </view>
        </view>
      </view>

      <!-- waiting for the phone -->
      <view class="block" ink:if="{{ status === 'waiting' }}">
        <text class="label">Tap this on your phone to sign in</text>
        <text class="mono url">{{ link }}</text>
        <text class="label">or enter code</text>
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

.stage {
  display: flex;
  flex-direction: column;
  align-items: center;
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
