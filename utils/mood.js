/**
 * The agent face — what Kavi looks like while it is doing something.
 *
 * ## Why a face at all
 *
 * Every page used to say what it was doing in prose, and each one invented its
 * own word for it: `index` says `thinking`, `face` says `working`, `connection`
 * says `working`, `signin` says `starting`. Four enums, one meaning. Worse, the
 * one visual cue that existed — the `◉` mark on the agenda card — never worked:
 * `class="mark {{ status === 'listening' ? 'on' : '' }}"` is a mixed attribute,
 * and Ink only evaluates an interpolation that is the *whole* value, so it looked
 * up a variable literally named `status === 'listening' ? 'on' : ''`, warned, and
 * rendered nothing. The highlight has never once appeared on a wearer's display.
 *
 * This module is the single vocabulary all five pages now speak, and the tick
 * that animates it.
 *
 * ## Why shapes, not brightness
 *
 * A dot here is a `<view>` with a `border-radius` — the recipe `.pill` already
 * proves on-device. The tempting way to make one expressive is to vary its size
 * and opacity, but that reads as the same two dots at different volumes; ten
 * states will not fit in it. Shape carries far more: the same box morphing
 * between a circle, a tall oval, a flat lozenge, a thin bar and a hollow ring
 * says "alert", "sleepy", "shut" and "looking" without a word of text.
 *
 * So the face is three boxes — two eyes that change shape, and one mouth bar
 * that stays hidden for most moods. The eyes do the work. The mouth exists for
 * exactly one reason: IDLE, SPEAK and ASK share neutral eyes, and without it
 * those three collapse into each other when nothing is moving.
 *
 * ## Why frame 0 matters more than the animation
 *
 * `setTimeout` is not in the verified AIUI runtime surface — every timer in this
 * repo is feature-detected and degrades (see config.js and signin.ink). On a host
 * without one there is no tick, so the face is frozen on whichever frame it
 * started at. Every mood's frame 0 is therefore chosen to be a complete, correct,
 * unambiguous expression on its own, and no two are alike. The animation is an
 * enhancement on top of a face that is already right standing still.
 *
 * ## The rule that keeps this honest
 *
 * The face may never claim a state the code is not in. Where a page could not
 * tell two states apart — `face.ink` used one `working` for both the open camera
 * shutter and the network round trip — the fix was to split the page's state, not
 * to pick a mood that looked plausible.
 *
 * The CSS that gives these tokens their shapes is duplicated into each page's
 * `<style>` block, between the `agentface:begin` / `agentface:end` markers. The
 * canonical copy is the one in `pages/signin/signin.ink`; `dev/check-face.mjs`
 * fails the build if any other page has drifted from it.
 */

/** Every state the face can express. Pages map their own status onto these. */
export const MOOD = {
  IDLE: 'idle',       // nothing asked; resting
  LISTEN: 'listen',   // microphone open, nobody talking yet
  HEAR: 'hear',       // microphone open and the wearer is mid-sentence
  THINK: 'think',     // a network call or the on-device model is in flight
  LOOK: 'look',       // camera shutter open — the wearer must hold still
  SPEAK: 'speak',     // TTS is (estimated to be) playing
  KNOWN: 'known',     // recognised someone / signed in / it worked
  NEWFACE: 'newface', // saw a person it does not know
  ASK: 'ask',         // waiting on the wearer: a press, the phone, a name
  WARN: 'warn',       // it failed
  GONE: 'gone',       // signed out, or the service is not connected
};

/**
 * Frames, as `[eyeLeft, eyeRight, mouth]` class tokens.
 *
 * A single-frame mood is genuinely static and starts no timer at all, which is
 * the difference between a HUD that idles quietly and one that wakes the CPU
 * three times a second to redraw the same thing.
 *
 * Frame 0 is never a neutral midpoint — it is the most characteristic pose, so
 * that a timerless host still gets the message.
 */
const FRAMES = {
  idle: [['ea', 'ea', 'm0']],
  // Wide eyes, and a level bar under them that stirs while the mic is open.
  listen: [['eb', 'eb', 'm1'], ['eb', 'eb', 'm2']],
  // Same eyes, louder bar: the wearer is actually talking, not just being waited on.
  hear: [['eb', 'eb', 'm3'], ['eb', 'eb', 'm2']],
  // Lowered lids, the pair drifting side to side. Reads as pondering.
  //
  // The margin goes on ONE eye, not both, and on the outside of the pair. Both
  // eyes carrying `margin-right` looks like it should shift them left; it does
  // not — each margin lands *between* the eyes as well, so the pair springs
  // apart instead of moving. Padding only the outer edge lets `justify-content:
  // center` do the shifting, and the gap between the eyes never changes.
  think: [['ed', 'edr', 'm0'], ['edl', 'ed', 'm0']],
  // Hollow rings stopping down, like an aperture. Nothing else in the set is hollow.
  look: [['eh', 'eh', 'm0'], ['ei', 'ei', 'm0']],
  speak: [['ea', 'ea', 'm2'], ['ea', 'ea', 'm3'], ['ea', 'ea', 'm1']],
  known: [['ee', 'ee', 'm2']],
  newface: [['eb', 'eb', 'm4'], ['eb', 'eb', 'm1']],
  // Eyes raised — looking up at the wearer — with a slow, patient blink.
  ask: [['ej', 'ej', 'm1'], ['ef', 'ef', 'm1']],
  warn: [['ef', 'ef', 'm3']],
  gone: [['eg', 'eg', 'm0']],
};

/**
 * 380ms. Two frames read as a calm breath (760ms); three as a typing indicator
 * (1.14s). Faster looks frantic on a display worn on someone's face, and slower
 * stops reading as motion at all.
 */
const TICK_MS = 380;

/**
 * The face keys, at rest. Spread into every page's `data` block.
 *
 * This is not decoration: a variable the template binds but `data` does not
 * declare resolves to empty, the `<view>` gets no class, and since `display`,
 * `width` and `background-color` all live on the class, the dot becomes an
 * invisible zero-size box. A missing key here is the single most likely way for
 * this whole feature to render nothing at all.
 */
export const INITIAL = { eyeL: 'ea', eyeR: 'ea', mouth: 'm0' };

/** The frame a mood shows at a given tick, wrapping. Unknown moods rest. */
export function frameOf(mood, tick) {
  const frames = FRAMES[mood] || FRAMES.idle;
  return frames[(tick || 0) % frames.length];
}

/** True when a mood has something to animate — i.e. it wants a timer. */
export function isAnimated(mood) {
  return (FRAMES[mood] || []).length > 1;
}

/**
 * Every class token the frame table can put on screen.
 *
 * Exported for `dev/check-face.mjs`, which asserts the CSS actually defines all
 * of them. A token with no rule is the nastiest failure this feature has: the
 * `<view>` gets a class nobody styled, so it has no `display`, no `width` and no
 * `background-color` — an invisible zero-size box, with no warning and no error.
 * Nothing about it looks broken; the face just quietly loses a dot.
 */
export function faceTokens() {
  const out = [];
  for (const key of Object.keys(FRAMES)) {
    for (const frame of FRAMES[key]) {
      for (const token of frame) if (out.indexOf(token) === -1) out.push(token);
    }
  }
  return out.sort();
}

/**
 * How long the glasses should assume they are still talking.
 *
 * `wx.speech.playTTS` is fire-and-forget: it returns void, exposes no promise
 * and fires no `onend`, and the host `speechSynthesis` implements `speak()` only
 * — no `speaking` property, no events. So a "speaking" state cannot be observed,
 * only estimated. ~150 words per minute at roughly five characters a word, with
 * a floor for the utterance to start and a ceiling so a long answer cannot leave
 * the face stuck talking to itself.
 */
export function speakMs(text) {
  return Math.min(6000, 700 + String(text || '').length * 55);
}

/**
 * A short caption for the mood, for pages that want one under the face.
 *
 * Deliberately generic — a page with better words for its own situation
 * ("Checking your calendar") should use those instead. Empty means the mood
 * speaks for itself and the caption line should stay blank.
 */
export function moodLabel(mood) {
  switch (mood) {
    case MOOD.LISTEN:
    case MOOD.HEAR: return 'Listening';
    case MOOD.THINK: return 'Working';
    case MOOD.LOOK: return 'Hold still';
    case MOOD.NEWFACE: return 'I do not know them';
    case MOOD.GONE: return 'Not connected';
    default: return '';
  }
}

/**
 * Map a page's own status string onto a mood.
 *
 * Only for the pages whose status alone determines the mood. `index` and `face`
 * do not use this: their mood depends on things the status does not carry (which
 * body the card is showing, whether the shutter or the network is the slow part),
 * so they set moods imperatively next to the `setData` that changes the status.
 *
 * @param {'signin'|'connection'|'schedule'} page
 * @param {string} status
 */
export function moodFor(page, status) {
  if (page === 'signin') {
    switch (status) {
      case 'starting': return MOOD.THINK;
      case 'waiting': return MOOD.ASK;
      case 'approved': return MOOD.KNOWN;
      case 'signed-in': return MOOD.KNOWN;
      case 'failed': return MOOD.WARN;
      default: return MOOD.IDLE;
    }
  }
  if (page === 'connection') {
    switch (status) {
      case 'working': return MOOD.THINK;
      case 'ready': return MOOD.KNOWN;
      case 'not-connected': return MOOD.GONE;
      case 'error': return MOOD.WARN;
      default: return MOOD.IDLE;
    }
  }
  if (page === 'schedule') {
    switch (status) {
      case 'loading': return MOOD.THINK;
      case 'failed': return MOOD.WARN;
      default: return MOOD.IDLE;
    }
  }
  return MOOD.IDLE;
}

/**
 * The face controller. One per page.
 *
 *     this.face = createFace((d) => this.setData(d));
 *     this.face.set(MOOD.THINK);
 *     // onShow → this.face.resume();  onHide/onUnload → this.face.pause();
 *
 * Two invariants make this safe to run alongside a page that is also painting
 * content:
 *
 *  - **State lives in the closure, never in `data`.** `setData` is asynchronous,
 *    so a flag written through it is not readable later in the same tick — the
 *    same reason every re-entrancy guard in this app (`this.busy`, `this.polling`)
 *    sits on the instance.
 *  - **The controller owns the three face keys and writes nothing else**, and no
 *    page writes them. So the tick can never clobber content, and a content
 *    update can never clobber the face.
 *
 * @param {(data: object) => void} setData
 */
export function createFace(setData) {
  let mood = MOOD.IDLE;
  let tick = 0;
  let running = false;
  let timer = null;
  let sayTimer = null;
  let last = '';

  function paint() {
    const f = frameOf(mood, tick);
    const signature = f.join('');
    // Two moods can share a frame (LISTEN and HEAR meet on ['eb','eb','m2']).
    // Skipping the write keeps a mood change from costing a redraw it does not need.
    if (signature === last) return;
    last = signature;
    setData({ eyeL: f[0], eyeR: f[1], mouth: f[2] });
  }

  function stop() {
    running = false;
    if (timer && typeof clearTimeout === 'function') clearTimeout(timer);
    timer = null;
  }

  function clearSay() {
    if (sayTimer && typeof clearTimeout === 'function') clearTimeout(sayTimer);
    sayTimer = null;
  }

  function setMood(next) {
    if (!FRAMES[next] || next === mood) return;
    stop();
    mood = next;
    tick = 0;
    paint();
    start();
  }

  function start() {
    if (running) return;
    if (!isAnimated(mood)) return;              // static mood: no timer wanted
    // `setInterval` is missing on some builds and `setTimeout` is not in the
    // verified API surface either, so this is a recursive, feature-detected
    // timeout — the same shape as the sign-in poll — and its absence simply
    // leaves the face on frame 0.
    if (typeof setTimeout !== 'function') return;
    running = true;
    const step = () => {
      if (!running) return;
      tick += 1;
      paint();
      timer = setTimeout(step, TICK_MS);
    };
    timer = setTimeout(step, TICK_MS);
  }

  return {
    /** Move to a mood. Restarts the animation from its characteristic frame. */
    set(next) {
      clearSay();
      setMood(next);
    },

    /**
     * Look like it is talking for as long as `text` should take, then settle.
     *
     * The duration is an estimate because it has to be — TTS here reports
     * nothing back (see speakMs). The important half is the fallback: with no
     * timers there would be nothing to end SPEAK, so the face skips it entirely
     * and settles immediately rather than sitting there mouthing at a wearer who
     * stopped hearing anything ten minutes ago.
     *
     * @param {string} text     what was just handed to TTS
     * @param {string} [settled] the mood to rest in afterwards
     */
    say(text, settled) {
      const rest = settled || MOOD.IDLE;
      clearSay();
      if (!text || typeof setTimeout !== 'function') {
        setMood(rest);
        return;
      }
      setMood(MOOD.SPEAK);
      sayTimer = setTimeout(() => {
        sayTimer = null;
        setMood(rest);
      }, speakMs(text));
    },

    /** onShow. Forces a repaint, in case the page rebuilt its `data`. */
    resume() {
      last = '';
      paint();
      start();
    },

    /** onHide / onUnload. No work runs off-screen, and no timer outlives the page. */
    pause() {
      clearSay();
      stop();
    },

    current() {
      return mood;
    },
  };
}
