<script def>
{
  "navigationBarTitleText": "Schedule",
  "description": "One-day agenda card from Google Calendar: event start times, titles and locations.",
  "schema": {
    "data": {
      "type": "object",
      "properties": {
        "date": {
          "type": "string",
          "description": "Day to display as yyyy-mm-dd (for example 2026-07-28). Defaults to today on the device."
        },
        "calendarId": {
          "type": "string",
          "description": "Calendar to read. Use \"primary\" for the wearer's own calendar unless they name another one."
        }
      },
      "required": []
    }
  }
}
</script>

<script setup>
import wx from 'wx';

import { AUTH } from '../../config.js';
import { createStore, wxBackend } from '../../utils/store.js';
import { createConnectionsClient } from '../../utils/connections.js';
import { dayListArgs, dayRange, normalizeEvents, speakableSummary } from '../../utils/calendar.js';
import { requireSignin } from '../../utils/gate.js';

export default {
  data: {
    loading: true,
    dayLabel: '',
    date: '',
    calendarId: 'primary',
    rows: [],
    hasRows: false,
    eventCount: 0,
    errorText: '',
  },

  async onLoad(query) {
    if (requireSignin(wx)) return;   // sign-in gate (docs/11); inert unless AUTH.required
    const session = createStore(wxBackend(wx)).read(AUTH.tokenKey);
    this.composio = createConnectionsClient({
      projectUrl: AUTH.projectUrl, apiKey: AUTH.apiKey,
      token: (session && session.token) || AUTH.devToken || '', timeoutMs: AUTH.timeoutMs,
    });
    this.setData({
      date: (query && query.date) || '',
      calendarId: (query && query.calendarId) || 'primary',
      dayLabel: dayRange((query && query.date) || '').label,
    });
    await this.load();
  },

  /** Re-read when the card comes back into view so it is never stale. */
  onShow() {
    if (this.composio) this.load();
  },

  async load() {
    // Re-entrancy is tracked on the instance, NOT this.data. onShow fires right
    // after onLoad, and `setData({ loading: true })` is asynchronous — a guard
    // reading `this.data.loading` would still see the old value and fire a
    // second overlapping fetch that races the first to setData.
    if (this.busy) return;
    this.busy = true;
    this.setData({ loading: true, errorText: '' });

    try {
      const result = await this.composio.callTool(
        'GOOGLECALENDAR_EVENTS_LIST',
        dayListArgs(this.data.date, this.data.calendarId)
      );

      if (!result.ok) {
        this.setData({ loading: false, errorText: result.error || 'Calendar unavailable' });
        return;
      }

      const rows = normalizeEvents(result.data);
      this.setData({ loading: false, rows, hasRows: rows.length > 0, eventCount: rows.length });

      if (typeof speechSynthesis !== 'undefined') {
        speechSynthesis.speak(new SpeechSynthesisUtterance(speakableSummary(rows, this.data.dayLabel)), 'immediate');
      }
    } catch (error) {
      this.setData({ loading: false, errorText: String((error && error.message) || error) });
    } finally {
      this.busy = false;
    }
  },

  /** Hand focus back to the host once the wearer is done with the card. */
  done() {
    this.finish();
  },
};
</script>

<page>
  <view class="card">

    <view class="head">
      <text class="day">{{ dayLabel }}</text>
      <text class="count" ink:if="{{ hasRows }}">{{ eventCount }}</text>
    </view>

    <view class="rule"></view>

    <text class="state" ink:if="{{ loading }}">Loading your schedule</text>
    <error-state ink:elif="{{ errorText }}" text="{{ errorText }}"></error-state>
    <text class="state" ink:elif="{{ !hasRows }}">Nothing scheduled.</text>

    <view class="list" ink:else>
      <view class="row" ink:for="{{ rows }}" ink:key="id">
        <view class="rail on" ink:if="{{ item.isNow }}"></view>
        <view class="rail" ink:else></view>
        <text class="start">{{ item.start }}</text>
        <view class="body">
          <text class="title">{{ item.titleShort }}</text>
          <text class="sub" ink:if="{{ item.location }}">{{ item.locationShort }}</text>
        </view>
      </view>
    </view>

    <button bindtap="done" ink:if="{{ !loading }}">Done</button>

  </view>
</page>

<style>
.card {
  display: flex;
  flex-direction: column;
  /* Content-box dimensions: the 448 x 352 canvas minus 12px padding and the
     2px border per side. `box-sizing: border-box` is not honoured by the Ink
     CSS engine, so 448 here would render 476px wide and clip. */
  width: 420px;
  /* The spec's minimum card height (120px, less padding and border). Without a
     floor the card measures ~0 in `width-constrained-auto-height`, the runtime
     reports a ~0 content height, and the host gives the surface no room at all
     — nothing paints, not even the header. */
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

.day {
  font-family: monospace;
  font-size: 18px;
  font-weight: 700;
  line-height: 1.3;
  color: var(--color-primary, #40ff5e);
}

.count {
  font-family: monospace;
  font-size: 13px;
  color: var(--color-text-secondary, rgba(64, 255, 94, 0.6));
}

.rule {
  height: var(--border-width-thin, 1px);
  background: var(--border-color-muted, rgba(64, 255, 94, 0.4));
  margin: var(--spacing-sm, 8px) 0;
}

.state {
  font-size: 15px;
  line-height: 1.5;
  padding: var(--spacing-sm, 8px) 0;
  color: var(--color-text-secondary, rgba(64, 255, 94, 0.6));
}

/* Plain <view>, sized by content — see the note in pages/index/index.ink. */
.list {
  display: flex;
  flex-direction: column;
}

/* Border reserved on every row — see the note in pages/index/index.ink. */
.row {
  /* 420 card content - 16 (own padding) - 4 (own border) = 400.
     Pinned because flex children in this engine grow past the parent's
     content box rather than being constrained by it. */
  width: 400px;
  display: flex;
  flex-direction: row;
  overflow: hidden;
  padding: var(--spacing-sm, 8px);
  border: var(--border-width-default, 2px) solid transparent;
  border-bottom-color: var(--border-color-muted, rgba(64, 255, 94, 0.4));
  border-radius: var(--radius-sm, 12px);
}

.rail {
  width: 3px;
  border-radius: 2px;
  background: transparent;
}

.rail.on {
  background: var(--color-primary, #40ff5e);
}

.start {
  font-family: monospace;
  font-size: 13px;
  line-height: 1.4;
  width: 56px;
  color: var(--color-primary, #40ff5e);
}

/* min-width:0 is required: flex items keep min-width:auto, so a long title
   would push the row past the 448px canvas. */
.body {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  overflow: hidden;
}

.title {
  font-size: 15px;
  line-height: 1.5;
  color: var(--color-primary, #40ff5e);
}

.sub {
  font-size: 11px;
  line-height: 1.4;
  color: var(--color-text-secondary, rgba(64, 255, 94, 0.6));
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
  width: 96px;
  text-align: center;
  margin-top: var(--spacing-md, 12px);
}
</style>
