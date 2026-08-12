<script def>
{
  "navigationBarTitleText": "Who is this",
  "description": "Remembers people: photographs whoever is in front of the wearer and says who they are, with notes and any shared meeting today; enrols, notes, forgets and lists people.",
  "schema": {
    "data": {
      "type": "object",
      "properties": {
        "action": {
          "type": "string",
          "enum": ["identify", "remember", "note", "forget", "list"],
          "description": "identify: photograph the person in front of the wearer and say who they are. remember: photograph them and store them under `name`. note: attach `note` to a person already known, named by `name` or, when no name is given, the last person recognised. forget: delete the person called `name`. list: say who is remembered. Defaults to identify, which offers to enrol when it recognises nobody."
        },
        "name": {
          "type": "string",
          "description": "The person's name. Required for `forget`, and for `remember` unless the wearer is going to say it out loud afterwards. Optional for `note`, where it picks which known person the note is about."
        },
        "note": {
          "type": "string",
          "description": "Something worth recalling next time, in the wearer's own words, e.g. 'runs the security review' or 'met at the PD offsite'. Used by `note`, and may also accompany `remember`."
        }
      },
      "required": []
    }
  }
}
</script>

<script setup>
/**
 * Face memory, driven by voice.
 *
 * Every command the wearer can speak is declared twice on purpose: once in the
 * `schema` above, so the host model can dispatch straight to this page with
 * structured arguments, and once in `faceCommand()` in utils/planner.js, so the
 * agent's own voice loop routes the same phrasings when it heard the utterance
 * itself. One vocabulary, two entry points.
 *
 * Nothing about recognition happens here. The photo goes to the Supabase Edge
 * Function, which detects, aligns, embeds, searches pgvector and returns the
 * finished card — title, lines, and the sentence to speak. This page takes the
 * picture and draws the answer.
 *
 * ## The interaction gate
 *
 * `takePhoto()` and `SpeechRecognition.start()` both require an interactive
 * call site and throw otherwise. A page opened by the host model has not
 * necessarily had a gesture, so a capture is *attempted* immediately and, if
 * the gate refuses, the page arms itself and waits for the temple key or a tap.
 * Hands-free where the host allows it, one press where it does not.
 */
import wx from 'wx';

import { FACE, TIMEZONE, REFRESH, DEBUG, AUTH } from '../../config.js';
import { createStore, wxBackend } from '../../utils/store.js';
import { createFaceService } from '../../utils/faceservice.js';
import { setOffset, clip } from '../../utils/calendar.js';
import { resolvePerson } from '../../utils/people.js';
import { requireSignin } from '../../utils/gate.js';
import { MOOD, INITIAL, createFace } from '../../utils/mood.js';

/** Where the last recognised person is kept, so "note that…" has a target. */
const LAST_PERSON_KEY = 'people-memory:last-face';

/**
 * A readable message out of whatever was thrown.
 *
 * The Ink bridge does not always throw an `Error`. Asking the web host for a
 * camera rejects with a `CameraContext`, and the runtime's own conversion fails
 * before we ever see it — which reached the card as "Error converting from js
 * 'CameraContext' into type 'Error'", truncated mid-word. Nobody wearing
 * glasses can act on that.
 */
function messageOf(error) {
  if (!error) return 'Unknown error';
  if (typeof error === 'string') return error;
  if (error.message) return String(error.message);
  try {
    return JSON.stringify(error).slice(0, 120);
  } catch {
    return 'Unknown error';
  }
}

/**
 * Read one query parameter.
 *
 * `wx.navigateTo` hands the page its query string *un-decoded*, so a name
 * routed from the voice loop arrives as "Tracy%20Lam" and is then looked up
 * literally — "I do not know anyone called Tracy%20Lam." Values dispatched by
 * the host model against the page schema are already plain, and decoding one of
 * those is a no-op, so this is safe for both entry points.
 */
function param(query, key) {
  const raw = (query && query[key]) || '';
  if (!raw) return '';
  try {
    return decodeURIComponent(raw);
  } catch {
    // A stray '%' in dictated text is not worth failing the command over.
    return String(raw);
  }
}

/**
 * Rows for the card's line list.
 *
 * Objects with an explicit `id`, not bare strings: Ink resolves `item` against
 * the page data and warns "Template variable 'item' is missing from data" when
 * a loop binds a primitive with `ink:key="*this"`. The agenda list loops over
 * keyed objects for the same reason, and that is the shape known to render.
 */
function toLines(lines) {
  return (lines || []).map((text, index) => ({ id: 'l' + index, text: clip(text, 40) }));
}

export default {
  data: {
    // The agent face (utils/mood.js). Spread so this page cannot fall behind
    // the vocabulary — an undeclared key binds to empty and the dot vanishes.
    ...INITIAL,
    // idle | armed | working | known | unknown | naming | saved | failed
    status: 'idle',
    // The person's name — and ONLY that. It also decides whether the card shows
    // the person or the agent face, so a status word here ("Looking…") would
    // read as somebody's name and hide the face that is reporting the work.
    // Status goes to `faceLabel` instead.
    title: '',
    faceLabel: '',
    subtitle: '',
    lines: [],
    hasLines: false,
    hint: '',
    errorText: '',
    hasThumb: false,
    thumbSrc: '',
    knownCount: 0,
    heard: '',
  },

  onLoad(query) {
    if (requireSignin(wx)) return;   // sign-in gate (docs/11); inert unless AUTH.required
    setOffset(TIMEZONE.offsetMinutes);

    this.face = createFace((d) => this.setData(d));
    this.store = createStore(wxBackend(wx));
    // Scope faces to the signed-in wearer: their device token → their own people.
    const kaviSession = this.store.read(AUTH.tokenKey);
    this.service = createFaceService({ ...FACE, deviceToken: (kaviSession && kaviSession.token) || '' });

    // Visibility and a per-action token, so a result that arrives after the
    // wearer cancelled, moved on, or left the card cannot draw over it.
    this.visible = true;
    this.epoch = 0;

    this.action = param(query, 'action') || 'identify';
    this.pendingName = param(query, 'name');
    this.pendingNote = param(query, 'note');

    // Kept so a name spoken *after* the capture enrols that same photo, rather
    // than asking the wearer to hold still for a second one.
    this.lastPhoto = null;
    this.candidateId = null;

    // Written by the agenda page; lets a spoken name resolve to a colleague's
    // address, and a recognised face line up with a meeting you are both in.
    // Both caches are version-stamped, so a stale-shaped one is dropped rather
    // than trusted — and rows are shipped to the service, so this matters.
    const directory = this.store.read(FACE.directoryKey);
    this.directory = directory && directory.version === REFRESH.cacheVersion ? directory.people || [] : [];
    const cached = this.store.read(REFRESH.cacheKey);
    this.myRows = cached && cached.version === REFRESH.cacheVersion ? cached.rows || [] : [];

    if (!this.service.configured) {
      this.fail('Supabase is not configured. Set FACE.projectUrl and FACE.apiKey.');
      return;
    }

    this.refreshCount();
    this.run();
  },

  onShow() {
    this.visible = true;
    if (this.face) this.face.resume();
  },

  onHide() {
    // Out of view: no work should keep running. The Ink `fetch` cannot be
    // aborted, but invalidating the current turn stops a late result drawing or
    // speaking, the microphone is released outright, and the face stops ticking.
    this.visible = false;
    this.epoch++;
    if (this.face) this.face.pause();
    if (this.recognition && this.recognition.abort) this.recognition.abort();
  },

  onUnload() {
    this.epoch++;
    if (this.face) this.face.pause();
    if (this.recognition && this.recognition.abort) this.recognition.abort();
  },

  /** A monotonic token per user action; a result from an older one is dropped. */
  beginTurn() {
    return ++this.epoch;
  },

  /** Still the current action, and the card still on screen? */
  live(turn) {
    return turn === this.epoch && this.visible;
  },

  /* The interaction gate: a real press drives the camera, or cancels a capture
     that is already running so the wearer is never stuck waiting on it. */
  onKeyUp(event) {
    if (event.code === 'GlobalHook' || event.code === 'Enter') {
      event.preventDefault();
      this.trigger();
    }
  },

  /** A press or tap: cancel an in-progress capture, otherwise start one. */
  trigger() {
    if (this.data.status === 'working') {
      this.cancel();
      return;
    }
    this.capture();
  },

  /** Abandon whatever is in flight and return to a ready state. */
  cancel() {
    this.epoch++;                 // any pending result now fails its live() check
    this.busy = false;
    if (this.recognition && this.recognition.abort) this.recognition.abort();
    this.face.set(MOOD.ASK);
    this.setData({
      status: 'armed', title: '', faceLabel: '', subtitle: '',
      lines: [], hasLines: false, heard: '', hasThumb: false,
      hint: 'Cancelled — press to look',
    });
  },

  /* ── dispatch ───────────────────────────────────────────────────────────── */

  /** Carry out whatever the wearer asked for. */
  run() {
    switch (this.action) {
      case 'note':
        this.attachNote();
        return;
      case 'forget':
        this.forgetNamed();
        return;
      case 'list':
        this.listPeople();
        return;
      case 'remember':
        // A name spoken straight after "who is this" should attach to the face
        // already looked at, not send the wearer hunting for the person again.
        // The service holds the last capture for a few minutes; if it has none,
        // it says so and this falls through to taking a photo.
        this.service.warm();
        this.enrolLastSeen();
        return;
      default:
        // Warming now overlaps the model load with the wearer taking aim.
        this.service.warm();
        this.capture();
    }
  },

  async refreshCount() {
    const count = await this.service.count();
    if (!this.visible) return;   // header decoration; never draw it onto a hidden card
    this.setData({ knownCount: count });
  },

  /* ── the camera ─────────────────────────────────────────────────────────── */

  async capture() {
    if (this.busy) return;
    this.busy = true;
    const turn = this.beginTurn();
    // LOOK, not THINK. `status: 'working'` covers two situations that ask
    // opposite things of the wearer — "the shutter is open, hold still" and
    // "I am waiting on the network, carry on" — and until now they were
    // indistinguishable. The face is not allowed to blur them, so the page
    // learned to tell them apart instead.
    this.face.set(MOOD.LOOK);
    this.setData({
      status: 'working', title: '', faceLabel: 'Looking…',
      lines: [], hasLines: false, errorText: '', heard: '', hasThumb: false,
    });

    try {
      const camera = this.openCamera();
      if (camera === 'blocked') {
        // The gate refused, not the hardware. Wait for a press and try again.
        this.arm('Press to look');
        return;
      }
      if (!camera) {
        this.fail('No camera on this host. Run this on the glasses.');
        return;
      }

      let photo;
      try {
        photo = await camera.takePhoto({ quality: 'high' });
      } catch (error) {
        // The interaction gate again — but thrown by the SHUTTER, not by
        // `createCameraContext()`. Craft's InkView hands over a perfectly good
        // CameraContext and only then refuses with "takePhoto() is unavailable
        // while InkView is non-interactive", so guarding the constructor alone
        // let a raw InvalidStateError land on the card in place of a hint the
        // wearer can act on. Both call sites need the check.
        const text = messageOf(error);
        if (/interact|gesture|user activation|InvalidState/i.test(text)) {
          console.log('[people-memory] shutter refused: ' + text);
          this.arm('Press to look');
          return;
        }
        throw error;
      }
      if (!this.live(turn)) return;   // cancelled or hidden while the shutter was open
      const bytes = new Uint8Array(photo && photo.data ? photo.data : []);
      if (!bytes.length) {
        this.fail('The camera returned an empty frame.');
        return;
      }
      this.lastPhoto = bytes;

      // "remember him as Kevin" already has the name; skip straight to storing.
      if (this.action === 'remember' && this.pendingName) {
        await this.save(this.pendingName, this.pendingNote);
        return;
      }

      // The shutter is shut and the photo is in hand — the wearer can stop
      // holding still now, so say so before the round trip starts.
      this.face.set(MOOD.THINK);
      this.setData({ faceLabel: 'Thinking…' });

      // Today's events ride along so the function can name the meeting the two
      // of you share without a second round trip.
      const card = await this.service.identify(this.lastPhoto, { rows: this.myRows });
      if (!this.live(turn)) return;   // a newer press or a hide superseded this result
      this.render(card, card.known ? MOOD.KNOWN : MOOD.NEWFACE);

      if (card.known) {
        this.candidateId = card.person ? card.person.id : null;
        this.rememberWho(card.person);
        this.setData({ status: 'known', hint: 'Say a note about them, or press to look again' });
      } else {
        this.candidateId = null;
        this.setData({ status: 'unknown', hint: 'New face — say "Kavi halo <name>" to remember them' });
        this.listenForName();
      }
    } catch (error) {
      this.handleError(error);
    } finally {
      this.busy = false;
    }
  },

  /**
   * @returns {object|null|'blocked'} the camera, `null` when the host has none,
   *          or `'blocked'` when the interaction gate refused this call site.
   */
  openCamera() {
    try {
      if (wx.media && wx.media.createCameraContext) {
        const camera = wx.media.createCameraContext();
        if (camera) return camera;
      }
    } catch (error) {
      const text = messageOf(error);
      console.log('[people-memory] camera refused: ' + text);
      // "not supported on web media provider" is a missing capability; an
      // interaction-gate refusal is a timing problem that a press can solve.
      if (/interact|gesture|user activation/i.test(text)) return 'blocked';
    }
    // Only reached when there is no real camera, so it can never shadow one.
    return this.devCamera();
  },

  /**
   * The harness stand-in, shaped exactly like a `CameraContext`.
   *
   * Returning the same interface rather than special-casing the caller is the
   * point: the capture path, the byte handling and everything downstream run
   * unchanged, so what the harness exercises is what the glasses will run.
   */
  devCamera() {
    if (!FACE.devCameraUrl) return null;
    const url = FACE.devCameraUrl;

    return {
      async takePhoto() {
        const response = await fetch(url);
        if (response.status === 404) {
          throw new Error('No photo loaded — choose one in the dev harness.');
        }
        if (!response.ok) {
          throw new Error('Dev camera returned HTTP ' + response.status);
        }
        console.log('[people-memory] using the dev camera at ' + url);
        return { data: await response.arrayBuffer(), mimeType: 'image/jpeg' };
      },
    };
  },

  arm(hint) {
    this.face.set(MOOD.ASK);
    this.setData({
      status: 'armed',
      // Empty, not 'Ready'. `title` is the person's name slot, and it now also
      // decides whether the card shows the person or the agent face — so a
      // status word there reads as somebody called "Ready" AND suppresses the
      // very face that is meant to be saying "waiting on you". The hint below
      // already carries the instruction.
      title: this.action === 'remember' && this.pendingName ? this.pendingName : '',
      // The caption has to move with the mood. Without this the face drops back
      // to ASK while "Looking…" — set by the capture that just got refused —
      // stays on screen, so the card claims to be doing the one thing it isn't.
      faceLabel: hint,
      subtitle: '',
      lines: [],
      hasLines: false,
      hint,
      hasThumb: false,
    });
    this.speak('Press when you are looking at them.');
  },

  /**
   * Enrol the face the service saw most recently, with no new photograph.
   *
   * Falls back to the camera when there is nothing recent to attach the name
   * to, so "remember her as Tracy" still works as a standalone command.
   */
  async enrolLastSeen() {
    if (!this.pendingName) {
      this.capture();
      return;
    }

    const turn = this.beginTurn();
    this.face.set(MOOD.THINK);
    this.setData({ status: 'working', title: '', faceLabel: 'Saving…', lines: [], hasLines: false });
    const colleague = resolvePerson(this.pendingName, this.directory);

    try {
      const card = await this.service.remember(null, {
        name: this.pendingName,
        note: this.pendingNote,
        email: colleague ? colleague.email : '',
      });
      if (!this.live(turn)) return;

      if (card.ok === false) {
        // Nothing recent to name — take a picture instead.
        this.capture();
        return;
      }

      this.render(card, MOOD.KNOWN);
      this.rememberWho(card.person);
      this.setData({ status: 'saved', hint: 'Say a note about them, or press to capture someone else' });
      this.refreshCount();
    } catch (error) {
      this.handleError(error);
    }
  },

  /* ── enrol ──────────────────────────────────────────────────────────────── */

  listenForName() {
    if (typeof SpeechRecognition === 'undefined') {
      // No microphone to open, so the face must not claim one is open. It stays
      // on NEWFACE — "I do not know them" — which is still exactly true.
      this.setData({ hint: 'Say "Kavi halo <name>" to store this face' });
      return;
    }
    this.face.set(MOOD.LISTEN);
    this.setData({ status: 'naming', heard: '' });

    try {
      const recognition = new SpeechRecognition();
      this.recognition = recognition;

      // The real microphone lifecycle, not an assumption about it: `onstart` is
      // the mic actually opening, `onspeechstart` the wearer beginning to say a
      // name, `onspeechend` them finishing. Only `onresult`/`onerror` were wired
      // before, so the card could not tell "waiting for you" from "you are
      // talking" — the exact distinction the face exists to show.
      recognition.onstart = () => this.face.set(MOOD.LISTEN);
      recognition.onspeechstart = () => this.face.set(MOOD.HEAR);
      recognition.onspeechend = () => this.face.set(MOOD.THINK);

      recognition.onresult = (event) => {
        // A name can arrive after the wearer has pressed to look at someone new,
        // or after the card left view. Drop it rather than let it overwrite the
        // newer state.
        if (this.busy || !this.visible) return;
        const best = event.results && event.results[0] && event.results[0][0];
        const said = (best && best.transcript) || '';
        this.setData({ heard: said });
        this.save(said, this.pendingNote);
      };
      recognition.onerror = () => {
        this.face.set(MOOD.ASK);
        this.setData({ status: 'unknown', hint: 'Did not catch that — press to retry' });
      };
      recognition.start();
    } catch (error) {
      // The same interaction gate as the camera. Not worth failing the card:
      // the wearer can still say "Kavi halo …" as a fresh command.
      console.log('[people-memory] cannot listen: ' + messageOf(error));
      this.face.set(MOOD.NEWFACE);
      this.setData({ status: 'unknown', hint: 'Say "remember him as …" to store this face' });
    }
  },

  async save(spoken, note) {
    // "remember him as Kevin Nguyen" -> "Kevin Nguyen", and "halo Tracy" ->
    // "Tracy" so the reply to "Kavi halo" stores just the name, whether it
    // arrived through the page's own mic or as a fresh "Kavi halo …" command.
    const name = String(spoken || '')
      .replace(/^.*\b(?:remember|call|name|halo|hallo|hello|xin\s+chao|chao|this\s+is)\b\s*(?:him|her|them|this|as)?\s*/i, '')
      .replace(/[.?!]+$/, '')
      .trim();

    if (!name) {
      this.face.set(MOOD.ASK);
      this.setData({ status: 'unknown', hint: 'No name heard — press to retry' });
      return;
    }
    if (!this.lastPhoto) {
      this.fail('Nothing captured yet — press to take a photo first.');
      return;
    }

    // If that name belongs to someone on the calendar, send the address too, so
    // the card can show the meeting the two of you share.
    const colleague = resolvePerson(name, this.directory);

    const turn = this.beginTurn();
    this.face.set(MOOD.THINK);
    this.setData({ status: 'working', title: '', faceLabel: 'Saving…', lines: [], hasLines: false });
    try {
      const card = await this.service.remember(this.lastPhoto, {
        name,
        note: note || '',
        email: colleague ? colleague.email : '',
        id: this.candidateId || undefined,
      });
      if (!this.live(turn)) return;
      this.render(card, MOOD.KNOWN);
      this.rememberWho(card.person);
      this.setData({ status: 'saved', hint: 'Say a note about them, or press to capture someone else' });
      this.refreshCount();
    } catch (error) {
      this.handleError(error);
    }
  },

  /* ── notes, forgetting, listing ─────────────────────────────────────────── */

  /** Which person a bare "note that…" is about. */
  rememberWho(person) {
    if (!person || !person.id) return;
    this.store.write(LAST_PERSON_KEY, { id: person.id, name: person.name });
  },

  /**
   * The person a command is about: the one named, or the last one recognised.
   * @returns {{id: string, name: string} | null}
   */
  async findPerson(name) {
    if (name) {
      const { people } = await this.service.people();
      const wanted = name.toLowerCase();
      return (
        people.find((p) => p.name.toLowerCase() === wanted) ||
        people.find((p) => p.name.toLowerCase().indexOf(wanted) !== -1) ||
        null
      );
    }
    const last = this.store.read(LAST_PERSON_KEY);
    return last && last.id ? last : null;
  },

  async attachNote() {
    const note = this.pendingNote;
    if (!note) {
      this.fail('I did not catch what to note.');
      return;
    }

    const turn = this.beginTurn();
    this.face.set(MOOD.THINK);
    this.setData({ status: 'working', title: '', faceLabel: 'Noting…', lines: [], hasLines: false });
    try {
      const target = await this.findPerson(this.pendingName);
      if (!this.live(turn)) return;
      if (!target) {
        const who = this.pendingName ? 'anyone called ' + this.pendingName : 'who that is about';
        this.fail('I do not know ' + who + '.');
        this.speak('I do not know ' + who + '. Ask me who they are first.');
        return;
      }

      await this.service.annotate(target.id, { note });
      if (!this.live(turn)) return;
      this.rememberWho(target);

      this.setData({
        status: 'saved',
        title: target.name,
        subtitle: 'Noted',
        lines: toLines([note]),
        hasLines: true,
        hasThumb: false,
        hint: 'Press to capture someone',
      });
      const noted = 'Noted about ' + target.name + '.';
      this.speak(noted);
      this.face.say(noted, MOOD.KNOWN);
    } catch (error) {
      this.handleError(error);
    }
  },

  async forgetNamed() {
    const turn = this.beginTurn();
    this.face.set(MOOD.THINK);
    this.setData({ status: 'working', title: '', faceLabel: 'Forgetting…', lines: [], hasLines: false });
    try {
      const target = await this.findPerson(this.pendingName);
      if (!this.live(turn)) return;
      if (!target) {
        this.fail('I do not know anyone called ' + (this.pendingName || 'that') + '.');
        return;
      }

      await this.service.forget(target.id);
      if (!this.live(turn)) return;
      this.store.write(LAST_PERSON_KEY, null);
      this.candidateId = null;

      this.setData({
        status: 'saved',
        title: target.name,
        subtitle: 'Forgotten',
        lines: [],
        hasLines: false,
        hasThumb: false,
        hint: 'Press to capture someone',
      });
      const gone = 'I have forgotten ' + target.name + '.';
      this.speak(gone);
      this.face.say(gone, MOOD.IDLE);
      this.refreshCount();
    } catch (error) {
      this.handleError(error);
    }
  },

  async listPeople() {
    const turn = this.beginTurn();
    this.face.set(MOOD.THINK);
    this.setData({ status: 'working', title: '', faceLabel: 'Checking…', lines: [], hasLines: false });
    try {
      const { people, count } = await this.service.people();
      if (!this.live(turn)) return;

      if (!count) {
        this.setData({
          status: 'idle', title: '', faceLabel: 'Nobody yet', subtitle: '',
          lines: [], hasLines: false, hasThumb: false,
          hint: 'Press to capture someone',
        });
        this.speak('I do not know anyone yet.');
        this.face.say('I do not know anyone yet.', MOOD.IDLE);
        return;
      }

      // The card is a few rows tall; the rest are counted rather than listed.
      const shown = people.slice(0, 4);
      const lines = shown.map((p) => p.name + (p.note ? ' — ' + p.note : ''));
      if (count > shown.length) lines.push('+' + (count - shown.length) + ' more');

      this.setData({
        status: 'idle',
        title: count === 1 ? '1 person' : count + ' people',
        subtitle: '',
        lines: toLines(lines),
        hasLines: true,
        hasThumb: false,
        hint: 'Press to capture someone',
      });
      const roster = 'You know ' + shown.map((p) => p.name).join(', ') +
        (count > shown.length ? ' and ' + (count - shown.length) + ' more.' : '.');
      this.speak(roster);
      this.face.say(roster, MOOD.IDLE);
    } catch (error) {
      this.handleError(error);
    }
  },

  /* ── drawing and speaking ───────────────────────────────────────────────── */

  /**
   * Draw whatever the function decided this card should say.
   *
   * @param {object} card
   * @param {string} [settled] the mood to rest in once the card has finished
   *   being spoken. The caller knows it and this does not — recognising someone
   *   and failing to is the same call from here.
   */
  render(card, settled) {
    if (!card) return;

    this.setData({
      title: card.title || '',
      faceLabel: '',
      subtitle: card.subtitle || '',
      lines: toLines(card.lines),
      hasLines: Boolean((card.lines || []).length),
      errorText: '',
      thumbSrc: card.thumb || '',
      hasThumb: Boolean(card.thumb),
    });

    this.speak(card.spoken);
    this.face.say(card.spoken, settled || MOOD.IDLE);
  },

  /** AIUI's own TTS first; the Web speech API only as a fallback. */
  speak(text) {
    if (!text) return;
    // The spoken line is a person's name and the private note about them, so it
    // is logged in full only for the dev harness (DEBUG.logSpeech), never on a
    // device — where the length alone confirms it spoke.
    console.log(DEBUG.logSpeech ? '[people-memory] speak: ' + text : '[people-memory] speak (' + text.length + ' chars)');
    try {
      if (wx.speech && wx.speech.playTTS) {
        wx.speech.playTTS(text);
        return;
      }
    } catch (error) {
      console.log('[people-memory] playTTS failed: ' + messageOf(error));
    }
    if (typeof speechSynthesis === 'undefined') return;
    speechSynthesis.speak(new SpeechSynthesisUtterance(text), 'immediate');
  },

  fail(message) {
    this.face.set(MOOD.WARN);
    this.setData({
      status: 'failed',
      title: '',
      // Same reason as `arm`: a stale "Saving…" above an error reads as though
      // the work is still running.
      faceLabel: '',
      errorText: clip(message, 90),
      hint: 'Press to try again',
      hasThumb: false,
    });
  },

  /**
   * A thrown error, handled where it should be handled.
   *
   * A revoked or expired device token is not a face-recognition failure and
   * "press to try again" will never fix it, so it routes to sign-in the way the
   * agenda and connection cards already do. Everything else stays on the card.
   */
  handleError(error) {
    if (error && error.reason === 'signed-out') {
      // Set the mood before navigating, not after: if the host declines the
      // navigation the wearer is left on this card, and GONE is the honest
      // thing for it to be showing them.
      this.face.set(MOOD.GONE);
      try {
        wx.navigateTo({ url: '/pages/signin/signin' });
        return;
      } catch (e) {
        /* the harness may not navigate; fall through and show the message */
      }
    }
    this.fail(messageOf(error));
  },

  /* Tapping the card is the other interactive call site. */
  onCardTap() {
    this.trigger();
  },
};
</script>

<page>
  <view class="card" bindtap="onCardTap">

    <view class="head">
      <text class="day">Who is this</text>
      <text class="fresh">{{ knownCount }} known</text>
    </view>

    <view class="rule"></view>

    <view class="body">
      <!-- The name is tied to `title`, not to the thumbnail. Nesting it under
           `hasThumb` meant a card with no picture showed the notes with nobody's
           name attached to them. -->
      <!-- The person, or — before there is one — Kavi's own face.
           An if/else pair alone in its own wrapper, which is the shape Ink
           resolves reliably: every conditional sibling in a parent joins one
           chain, so this must not share a parent with the list below.

           They are exclusive on purpose. This card already shows a 64px human
           face; a second, agent face beside it reads as two subjects rather
           than one assistant looking at one person. So the agent expresses
           LOOK → THINK → NEWFACE/KNOWN, and then hands the card over. -->
      <view class="stage">
        <view class="shot" ink:if="{{ title }}">
          <!-- An <image>, not a <canvas>. The Ink web host renders nothing into
               a canvas: a probe page called fillRect, putImageData and flush
               without error and the surface stayed blank, while an <image> with a
               data: URI beside it drew perfectly. The service now sends a PNG. -->
          <image class="thumb" src="{{ thumbSrc }}" ink:if="{{ hasThumb }}"></image>
          <view class="who">
            <text class="name">{{ title }}</text>
            <text class="sub" ink:if="{{ subtitle }}">{{ subtitle }}</text>
          </view>
        </view>
        <view class="agent" ink:else>
          <view class="face">
            <view class="eyes">
              <view class="{{ eyeL }}"></view>
              <view class="{{ eyeR }}"></view>
            </view>
            <view class="mouth">
              <view class="{{ mouth }}"></view>
            </view>
          </view>
          <!-- Own wrapper: its conditional must not join a chain. -->
          <view class="cap">
            <text class="centertext" ink:if="{{ faceLabel }}">{{ faceLabel }}</text>
          </view>
        </view>
      </view>

      <!-- `ink:for` goes on a <view>, and the interpolation on a <text> child
           of it — never on the element carrying the loop. That is the shape the
           agenda list uses, and the only one that binds without Ink warning
           that `item` is missing from data. -->
      <view class="lines" ink:if="{{ hasLines }}">
        <view class="linerow" ink:for="{{ lines }}" ink:key="id">
          <text class="line">{{ item.text }}</text>
        </view>
      </view>

      <!-- Footnotes live in their own wrapper so their conditionals cannot join
           the chain above them. -->
      <view class="notes">
        <text class="heard" ink:if="{{ heard }}">“{{ heard }}”</text>
        <text class="err" ink:if="{{ errorText }}">{{ errorText }}</text>
        <text class="hint">{{ hint }}</text>
      </view>
    </view>

  </view>
</page>

<style>
/* Same layout rules the agenda card learned the hard way: content sizing only,
   static classes, no scroll-view, nothing bound that affects layout. */

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

.day {
  font-family: monospace;
  font-size: 18px;
  font-weight: 700;
  line-height: 1.3;
  color: var(--color-primary, #40ff5e);
}

.fresh {
  font-size: 11px;
  line-height: 1.4;
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

/* Holds exactly one of: the person, or the agent face. */
.stage {
  display: flex;
  flex-direction: column;
  align-items: center;
}

/* The agent side of that choice: face plus its status caption. */
.agent {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: var(--spacing-xs, 4px) 0;
}

/* One conditional per wrapper; empty costs nothing. */
.cap {
  display: flex;
  flex-direction: column;
  align-items: center;
}

.centertext {
  font-size: 15px;
  line-height: 1.5;
  padding-top: var(--spacing-sm, 8px);
  color: var(--color-text-secondary, rgba(64, 255, 94, 0.6));
}

.shot {
  display: flex;
  flex-direction: row;
  padding: var(--spacing-xs, 4px) 0;
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

.thumb {
  width: 64px;
  height: 64px;
  border: var(--border-width-thin, 1px) solid var(--border-color-muted, rgba(64, 255, 94, 0.4));
  border-radius: var(--radius-sm, 12px);
}

.who {
  display: flex;
  flex-direction: column;
  width: 330px;
  padding-left: var(--spacing-md, 12px);
}

.name {
  font-size: 18px;
  font-weight: 700;
  line-height: 1.3;
  color: var(--color-primary, #40ff5e);
}

.sub {
  font-size: 11px;
  line-height: 1.4;
  color: var(--color-text-secondary, rgba(64, 255, 94, 0.6));
}

.lines {
  display: flex;
  flex-direction: column;
}

.linerow {
  display: flex;
  flex-direction: row;
}

.notes {
  display: flex;
  flex-direction: column;
}

.line {
  font-size: 14px;
  line-height: 1.5;
  color: var(--color-text-primary, #40ff5e);
}

.heard {
  font-size: 12px;
  line-height: 1.4;
  color: var(--color-text-secondary, rgba(64, 255, 94, 0.6));
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
