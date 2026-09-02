# 20 — AIUI 0.17.0: what changed, and what it changed here

Rokid rewrote and versioned its AIUI documentation. This is a pass over the
0.17.0 docs against what this project believed, recording **what we had wrong**,
**what we changed**, and **what is newly available that we do not use yet**.

**Where the docs actually live.** `js.rokid.com/AIUI` is a client-rendered app —
fetching the URL gets you an empty shell. The prose is the `documentation/`
directory of the public repo **`jsar-project/AIUI`**, and the version picker maps
to git tags (`0.17.0` → `v0.17.0`, `latest` → `main`, newest constant `0.18.0`).
To read a version verbatim:

```bash
curl -sL https://codeload.github.com/jsar-project/AIUI/tar.gz/refs/tags/v0.17.0 | tar xz
# documentation/0-guide/…  1-framework/…  2-components/…  3-api/…  6-tools/…
# skills/aiui-dev/…        ← the vendored skill in .agents/ comes from here
```

Files ending `.en-US.md` are English; the bare `.md` is Chinese.

---

## 1. The reference canvas is 480 × 352, not 448 × 352

**The correction that mattered.** The vendored skill we had pinned said *"the
application width is strictly 448px"*. In 0.17.0 it says **480px**, and the
`rpx` unit is defined against a **480rpx** screen width across four separate
documents. The design spec adds the numbers underneath it:

| | Value |
| --- | --- |
| Reference canvas | **480 × 352 px** |
| Safe horizontal inset | **16 px** |
| Safe vertical inset | **12 px** |
| Effective content width | **448 px** |

So 448 was never the canvas — it is the *content width you get after the safe
inset*. The old number was the right value under the wrong name.

**What that cost us.** Every page sets `.card { width: 420px }`, which with
12px padding and a 2px border on each side is an outer box of exactly **448px**
— correct, and correct for the right reason. But the card was positioned at the
canvas origin, because a 448-wide box on a believed-448 canvas needs no inset.
On the real 480 canvas that left the card flush against the left edge with 32px
of dead panel on the right.

Fixed by giving every card the documented inset:

```css
.card {
  width: 420px;
  margin-left: 16px;
  margin-right: 16px;
}
```

Applied to all five shipped pages and `pages/probe`. Widths are unchanged — only
the position was wrong.

**The harness was measuring the wrong surface too.** `dev/runtime.html`
hardcoded a 448-wide `InkView`, so nothing had ever been rendered at the real
full-screen width. It now carries a `surfaceWidth`, defaults to 480 × 352, and
offers both real surfaces as buttons:

- **480 × 352** — full screen, the 0.17.0 reference canvas.
- **448 × 150** — the Interactive InkView card. This one is a *measurement*
  (it reports 896 × 300 at 2x), not a spec value, and it is genuinely narrower.
  Keep testing both: a card that fits full screen can still clip here.

`dev/preview.html` follows with `--app-width: 480px`.

---

## 2. On-device deployment: read the screenshots, not just the prose

The 0.17.0 quickstart says *"On the glasses, go to Settings > Developer > AIUI >
Update Glasses Resource Package"*. Taken literally that describes a HUD menu —
and it is misleading. The screenshot printed beside that line is a **phone**
screenshot: a Developer page listing *Glasses ADB debugging*, *Agent debug*,
*Retail Demo Mode*, and **AIUI → Update glasses resources**. It is the Hi Rokid
companion app's settings *for the glasses*, which is exactly the "更新眼镜资源"
the forum write-ups always described. `docs/12` was right the first time.

What genuinely happens on the glasses is the *result*: a download indicator in
the HUD's lower-right while it pulls, then a **"已就绪" / "is ready"** toast.

The quickstart is unambiguous about the rest, and this part was new to us:

- the project must be **bound to an AIUI Agent, packaged, and uploaded** before
  on-device debugging is possible at all;
- you invoke it by **waking the AI assistant, then saying the agent's name**;
- the **default icon is rejected at review**.

**Lesson for the next doc pass:** these pages are thin prose over screenshots,
and the screenshots carry details the text omits or garbles. Pull the images out
of `documentation/image/` and look at them.

`docs/12` is rewritten around this.

---

## 3. Tooling names we were vague about

| | Command |
| --- | --- |
| New project | `npm create @yodaos-pkg/aiui-agent@latest my-agent` |
| Official CLI | `npm install -g @yodaos-pkg/aix-cli` |
| Pack | `aix pack . [-o out.aix] [--optimize] [--opt-level 1..3]` |
| Inspect | `aix list <file.aix>` (alias `aix ls`) |
| Craft (global) | <https://js.rokid.com/craft?region=global> |
| Studio (global) | <https://aiui-global.rokid.com/space> |

`.aixignore` is confirmed as `.gitignore` syntax read from the source root — ours
is doing exactly the job it should. Packing generates the `VERSION` file, a UUID
the platform validates on upload and keys hot updates on; it is never
hand-written.

---

## 4. API corrections that touch code we ship

**`speechSynthesis` grew a second workflow.** `speak()` now takes a mode —
`'enqueue'` (default) or `'immediate'` — and there is a separate
`synthesize()` returning a `SpeechSynthesisTask` you play through a
`SpeechAudioPlayer`. The two are independent; do not mix them for one playback.
All five of our call sites already pass `'immediate'`, so they were right.

**`SpeechSynthesisUtterance` lost `pitch` and `rate`**, and `volume` is now
documented as an integer `0`–`10` (default `1`), not a `0.0`–`1.0` float. We set
none of them, so nothing to change — but do not add them back. `lang` exists and
is documented as *not currently supported*. Voice IDs are enumerated now
(`female-tianmei`, `English_radiant_girl`, …).

**`onVoiceWakeup(event)` delivers `event.keyword`, defaulting to `leqi`** — the
*system* wake word, not the agent's name. `pages/index` gated on
`event.keyword === WAKE_WORD` ('kavi') and returned otherwise, which on any
device left at the default silently dropped the event it existed to handle. Now
it logs the mismatch and proceeds: the page only receives this event once the
agent is foregrounded, so the wakeup was for us regardless of the word.

The quickstart's own screenshots corroborate `leqi`: the glasses' idle HUD reads
*唤起AI助手，请说"乐奇"* — "to wake the AI assistant, say **乐奇** (lèqí)". So on a
device left at the default, `event.keyword` will not be 'kavi'. Still **worth
confirming on hardware**, but the documented default is visibly the shipped one.

**`AudioPlayer` is the documented general playback API** (`import { AudioPlayer }
from 'audio'`), handling both files and streaming, with leading-slash asset
paths (`/assets/foo.ogg`) explicitly supported. `Sound` remains the low-latency
local-only effect player. We use neither yet.

---

## 5. Newly available, and worth a look

None of these are in use here. Listed so the next feature does not get built by
hand when the platform now supplies it.

**`target` — the same page in two hosting slots.** `_current` is the card inside
the conversation flow; `_blank` is the full-screen container the wearer reaches
by double-tapping. You can branch on it in CSS:

```css
@media (target: _current) { .panel { max-height: 320rpx; } }
@media (target: _blank)   { .panel { max-width: 100%; padding: 24rpx; } }
```

…and in logic, via `onTargetChanged(target, previousTarget)` on both `App` and
`Page`. We do neither, which is exactly why `docs/09` had to discover the
auto-height chat-card behaviour empirically. This is the supported way to show a
summary in the card and the full agenda full-screen.

**Environment awareness** (0.16.0, expanded in 0.17.0) — opt in with
`this.enableWorldAwareness()` in `onLoad`, then handle `onHeadGesture(event)`
(`nod`, `shake`) and `onOrientationStabilityChange(event)`. A nod to confirm the
sign-in approval, or to accept an added event, would remove a temple press from
two of our flows.

**Components added in 0.17.0** — `<video>`, `<table>`, `<streamdown>`
(streaming Markdown), `<timed-text>` (synchronised transcript + TTS audio), plus
Markdown primitives `<p> <header> <blockquote> <list> <list-item> <b> <i>
<snippet> <formula>`. `<table>` is a plausible fit for the agenda; `<timed-text>`
for the spoken summary.

**APIs added in 0.17.0** — media capture and recording (`getUserMedia`,
`MediaRecorder`, Opus output), video playback, the full W3C Battery Status API,
and **OPFS** persistent storage:

```js
const root = await navigator.storage.getDirectory();
const file = await root.getFileHandle('session.json', { create: true });
```

OPFS is a better home for the device token and the cached directory than
`localStorage`, which 0.14.0's changelog notes had to be *fixed* for surviving a
package update.

**Named slots** for custom components, and third-party npm packages loadable
through `node_modules` with components exported via `ink.components`.

---

## 6. The vendored skill is now pinned to v0.17.0

`.agents/skills/aiui-dev/` was tracking `main` at an old commit. Re-synced from
tag `v0.17.0`; `skills-lock.json` now records that ref.

Changes worth knowing:

- **`apis-web.md` is new** — browser-style networking and encoding (`Headers`,
  `ReadableStream`, `TextDecoder` with `{ stream: true }`).
- **`design-system-green.md` was rewritten** (`alpha` → `beta`, "Visual Design
  Language" → "Scientific Interface"), and now carries the 480 × 352 reference
  canvas and the inset numbers in §1.
- `SKILL.md` gained the environment-aware page pattern and the 480px correction.

`skills-lock.json`'s `computedHash` is written by an external skills tool whose
scheme is not reproducible from this repo; it now holds `sha256(SKILL.md)` and
says so in a `hashAlgorithm` field. **Re-run that tool to restore a lock it
recognises.**

---

## 7. Still open

- **The wake-word fix is unverified on hardware** (§4). Everything else here is
  either a documentation correction or was checked in the real Ink runtime.
- **0.18.0 exists** as the newest constant in the docs site bundle, with no
  changelog entry yet at the time of writing. This pass is against 0.17.0
  because that is the version the docs pin as stable.
