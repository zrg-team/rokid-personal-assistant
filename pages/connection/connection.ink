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
    this.setData({ status: 'working', title: name, subtitle: 'Checking…', lines: [], hasLines: false, errorText: '', hint: '' });

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
        this.setData({
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

  fail(name, message) {
    this.setData({
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

.sub {
  font-size: 13px;
  line-height: 1.5;
  color: var(--color-primary, #40ff5e);
}

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
