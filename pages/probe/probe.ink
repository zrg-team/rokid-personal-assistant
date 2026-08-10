<script def>
{
  "navigationBarTitleText": "Face probe",
  "description": "Developer probe. Renders every agent-face mood at once so the shape vocabulary can be checked against the real Ink runtime. Not a wearer-facing page.",
  "schema": { "data": { "type": "object", "properties": {}, "required": [] } }
}
</script>

<script setup>
/**
 * Every agent-face mood, on one card.
 *
 * The classes below are HARDCODED LITERALS on purpose. This is step P0 of the
 * plan: prove the CSS vocabulary paints on the real Ink WASM runtime before any
 * JS is involved, so a blank face can only mean the CSS, never the binding or
 * the tick. It tests every unknown at once — the shape morphs, `margin-top`
 * placement, the dart margins, the hollow ring, and `rgba(…, 0)` for a dot that
 * is meant to hold its space without painting.
 *
 * ## Opening it
 *
 * Deliberately NOT in app.json — a page listed there is dispatchable by the host
 * model, and "Face probe" is not something a wearer should ever be shown. Add
 * `"pages/probe/probe"` to app.json while you need it, then take it out again.
 * `dev/pack.mjs` excludes `pages/probe/*` from the .aix regardless, so it cannot
 * reach a device even if the app.json line is left in by mistake.
 *
 *     http://localhost:5178/dev/runtime.html?page=pages/probe/probe&h=352
 *
 * ## Reading the result
 *
 * The static grid must show twelve distinguishable poses. The live cell must
 * MOVE — and `chrome --headless --virtual-time-budget` will not show that, since
 * Ink's timers live inside its WASM runtime and Chrome's virtual clock does not
 * advance them. Watch it in a real browser, or drive CDP on the wall clock.
 */
import { MOOD, INITIAL, createFace } from '../../utils/mood.js';

/** Cycled by the live cell, so one run exercises every mood in turn. */
const TOUR = [
  MOOD.IDLE, MOOD.LISTEN, MOOD.HEAR, MOOD.THINK, MOOD.LOOK,
  MOOD.SPEAK, MOOD.KNOWN, MOOD.NEWFACE, MOOD.ASK, MOOD.WARN, MOOD.GONE,
];

export default {
  data: { ...INITIAL, tourLabel: MOOD.IDLE },

  onLoad() {
    // The live cell is step P2: the static grid above proves the CSS paints,
    // this proves the whole chain — createFace → setData → Ink repaint. If the
    // grid renders and this one never moves, the fault is the tick, not the CSS.
    this.frames = 0;
    this.face = createFace((d) => {
      this.frames += 1;
      console.log('[people-memory] frame ' + this.frames + ' ' + d.eyeL + ',' + d.eyeR + ',' + d.mouth);
      this.setData(d);
    });
    this.at = 0;

    // Report what this host actually has. The whole degradation ladder turns on
    // it: with no timers every mood is frozen on frame 0, which is why frame 0
    // has to be a complete expression on its own.
    console.log('[people-memory] timers: setTimeout=' + (typeof setTimeout)
      + ' setInterval=' + (typeof setInterval)
      + ' clearTimeout=' + (typeof clearTimeout));

    if (typeof setInterval !== 'function') return;
    this.timer = setInterval(() => {
      this.at = (this.at + 1) % TOUR.length;
      this.face.set(TOUR[this.at]);
      this.setData({ tourLabel: TOUR[this.at] });
    }, 1500);
  },

  onShow() { if (this.face) this.face.resume(); },
  onHide() { if (this.face) this.face.pause(); },

  onUnload() {
    if (this.face) this.face.pause();
    if (this.timer && typeof clearInterval === 'function') clearInterval(this.timer);
  },
};
</script>

<page>
  <view class="card">

    <view class="row">
      <view class="cell">
        <view class="face">
          <view class="eyes"><view class="ea"></view><view class="ea"></view></view>
          <view class="mouth"><view class="m0"></view></view>
        </view>
        <text class="tag">idle</text>
      </view>
      <view class="cell">
        <view class="face">
          <view class="eyes"><view class="eb"></view><view class="eb"></view></view>
          <view class="mouth"><view class="m1"></view></view>
        </view>
        <text class="tag">listen</text>
      </view>
      <view class="cell">
        <view class="face">
          <view class="eyes"><view class="eb"></view><view class="eb"></view></view>
          <view class="mouth"><view class="m3"></view></view>
        </view>
        <text class="tag">hear</text>
      </view>
      <view class="cell">
        <view class="face">
          <view class="eyes"><view class="ed"></view><view class="edr"></view></view>
          <view class="mouth"><view class="m0"></view></view>
        </view>
        <text class="tag">think a</text>
      </view>
    </view>

    <view class="row">
      <view class="cell">
        <view class="face">
          <view class="eyes"><view class="edl"></view><view class="ed"></view></view>
          <view class="mouth"><view class="m0"></view></view>
        </view>
        <text class="tag">think b</text>
      </view>
      <view class="cell">
        <view class="face">
          <view class="eyes"><view class="eh"></view><view class="eh"></view></view>
          <view class="mouth"><view class="m0"></view></view>
        </view>
        <text class="tag">look</text>
      </view>
      <view class="cell">
        <view class="face">
          <view class="eyes"><view class="ei"></view><view class="ei"></view></view>
          <view class="mouth"><view class="m0"></view></view>
        </view>
        <text class="tag">look b</text>
      </view>
      <view class="cell">
        <view class="face">
          <view class="eyes"><view class="ea"></view><view class="ea"></view></view>
          <view class="mouth"><view class="m2"></view></view>
        </view>
        <text class="tag">speak</text>
      </view>
    </view>

    <view class="row">
      <view class="cell">
        <view class="face">
          <view class="eyes"><view class="ee"></view><view class="ee"></view></view>
          <view class="mouth"><view class="m2"></view></view>
        </view>
        <text class="tag">known</text>
      </view>
      <view class="cell">
        <view class="face">
          <view class="eyes"><view class="eb"></view><view class="eb"></view></view>
          <view class="mouth"><view class="m4"></view></view>
        </view>
        <text class="tag">newface</text>
      </view>
      <view class="cell">
        <view class="face">
          <view class="eyes"><view class="ej"></view><view class="ej"></view></view>
          <view class="mouth"><view class="m1"></view></view>
        </view>
        <text class="tag">ask</text>
      </view>
      <view class="cell">
        <view class="face">
          <view class="eyes"><view class="eg"></view><view class="eg"></view></view>
          <view class="mouth"><view class="m0"></view></view>
        </view>
        <text class="tag">gone</text>
      </view>
    </view>

    <view class="rule"></view>

    <!-- Live: bound tokens, driven by the real controller. -->
    <view class="cell wide">
      <view class="face">
        <view class="eyes">
          <view class="{{ eyeL }}"></view>
          <view class="{{ eyeR }}"></view>
        </view>
        <view class="mouth">
          <view class="{{ mouth }}"></view>
        </view>
      </view>
      <text class="tag">live · {{ tourLabel }}</text>
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

.row {
  display: flex;
  flex-direction: row;
  justify-content: center;
}

.cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 105px;
}

.wide {
  width: 420px;
}

.rule {
  height: var(--border-width-thin, 1px);
  background: var(--border-color-muted, rgba(64, 255, 94, 0.4));
  margin: var(--spacing-sm, 8px) 0;
}

.tag {
  font-size: 11px;
  line-height: 1.4;
  color: var(--color-text-secondary, rgba(64, 255, 94, 0.6));
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
</style>
