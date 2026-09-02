/**
 * Store preview media, rendered by the real thing.
 *
 *   npm run shots
 *
 * AIUI Studio's "Preview Media" tab wants 3-5 JPG/PNG images or MP4 videos,
 * including at least one image and one video (docs/15). This produces them from
 * the actual pages, on the actual Ink WASM runtime, at the reference canvas
 * AIUI 0.17.0 specifies for Rokid Glasses — 480 x 352, captured at 2x — so the
 * store artwork is the agent's real framebuffer rather than a mockup of it.
 *
 * Three stages, all driven by headless Chrome:
 *
 *   1. dev/server.mjs comes up in demo mode (KAVI_DEMO=1), which answers the
 *      Edge Function routes with a fixed sample cast, so a card can be
 *      populated with no backend deployed and the run is repeatable.
 *   2. dev/shot.html paints one page per state onto a bare canvas → raw/*.png,
 *      the untouched 960x704 framebuffer.
 *   3. dev/slide.html mounts each framebuffer in a captioned 1280x720 frame →
 *      the numbered PNGs you upload. ffmpeg, if present, strings those into an
 *      MP4 so the "at least one video" requirement has something to satisfy it.
 *
 * Flags:
 *   --live        shoot against the backend in config.js instead of the demo
 *   --port <n>    harness port (default 5187, clear of the usual 5178)
 *
 * Output: dist/store/. `dist/` is gitignored — this is build output, not source.
 *
 * On the video: the honest one is a screen recording from the glasses, and it
 * is worth more to a reviewer than any slideshow, because it is the only
 * artefact that shows the agent actually being invoked. This writes a
 * storyboard for that recording next to the slideshow stand-in.
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdir, rm, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'dist', 'store');
const RAW = join(OUT, 'raw');

const argv = process.argv.slice(2);
const LIVE = argv.includes('--live');
const PORT = Number(argv[argv.indexOf('--port') + 1]) || 5187;

/** The reference canvas from AIUI 0.17.0 (docs/03). 2x for a crisp upload. */
const WIDTH = 480;
const HEIGHT = 352;
const SCALE = 2;

/** The composed slide. 720p is the safe ceiling for a store listing. */
const SLIDE_W = 1280;
const SLIDE_H = 720;

/**
 * One entry per store slide.
 *
 * `wait` is how long the page gets to settle before the frame is taken — pages
 * that fetch need longer than pages that only draw. `say` is the command that
 * produces the state, so the listing reads as a script the viewer could follow.
 */
const SHOTS = [
  {
    name: '1-agenda',
    page: 'pages/schedule/schedule',
    wait: 5000,
    say: '"Kavi, what\u2019s on my calendar today?"',
    sub: 'Your own Google Calendar, read out in one breath and left on the HUD.',
  },
  {
    name: '2-who-is-this',
    page: 'pages/face/face',
    wait: 6000,
    say: '"Kavi halo"',
    sub: 'It looks at whoever is in front of you and tells you who they are.',
  },
  {
    name: '3-people',
    page: 'pages/face/face',
    query: 'action=list',
    wait: 5000,
    say: '"Kavi, who do I know?"',
    sub: 'Everyone you asked it to remember, with the note you attached.',
  },
  {
    name: '4-signin',
    page: 'pages/signin/signin',
    wait: 5000,
    say: '"Kavi start"',
    sub: 'Sign in once by tapping a link on your phone. No password on the glasses.',
  },
];

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('No Chrome or Edge found. Set CHROME_PATH to a Chromium-based browser.');
}

/** ffmpeg is optional; FFMPEG_PATH lets you point at one that is not on PATH. */
function findFfmpeg() {
  const explicit = process.env.FFMPEG_PATH;
  if (explicit && existsSync(explicit)) return explicit;
  const probe = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  return probe.error ? null : 'ffmpeg';
}

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('dev server did not come up at ' + url);
}

function capture(chrome, url, file, width, height, scale) {
  return new Promise((resolve, reject) => {
    const child = spawn(chrome, [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--hide-scrollbars',
      '--force-device-scale-factor=' + scale,
      '--window-size=' + width + ',' + height,
      // A ceiling, not a delay: the pages signal readiness themselves, but
      // headless Chrome needs an upper bound or a hung fetch hangs the run.
      '--virtual-time-budget=20000',
      '--screenshot=' + file,
      url,
    ], { stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', () => (existsSync(file)
      ? resolve()
      : reject(new Error('no frame written for ' + file))));
  });
}

async function main() {
  const chrome = findChrome();
  const ffmpeg = findFfmpeg();

  console.log('  browser   %s', chrome);
  console.log('  canvas    %d x %d @%dx  →  %d x %d', WIDTH, HEIGHT, SCALE, WIDTH * SCALE, HEIGHT * SCALE);
  console.log('  slide     %d x %d', SLIDE_W, SLIDE_H);
  console.log('  backend   %s', LIVE ? 'live (config.js)' : 'demo (KAVI_DEMO=1)');

  await rm(OUT, { recursive: true, force: true });
  await mkdir(RAW, { recursive: true });

  const server = spawn(process.execPath, [join(ROOT, 'dev', 'server.mjs')], {
    cwd: ROOT,
    stdio: 'ignore',
    env: { ...process.env, PORT: String(PORT), ...(LIVE ? {} : { KAVI_DEMO: '1' }) },
  });

  const base = 'http://localhost:' + PORT;

  try {
    await waitForServer(base + '/bundle', 20000);
    console.log('  harness   %s\n', base);

    for (const shot of SHOTS) {
      const params = new URLSearchParams({
        page: shot.page,
        w: String(WIDTH),
        h: String(HEIGHT),
        wait: String(shot.wait),
      });
      if (shot.query) params.set('q', shot.query);
      // Deliberately NOT `mockpair`: that flag rewrites pair calls onto
      // /mock-pair, which answers with the real project's Supabase URL — fine
      // in the harness, wrong in artwork bound for a public listing. Demo mode
      // already serves /functions/v1/pair, with a neutral link and code.

      const raw = join(RAW, shot.name + '.png');
      await capture(chrome, base + '/dev/shot.html?' + params, raw, WIDTH, HEIGHT, SCALE);

      const slideParams = new URLSearchParams({
        img: '/dist/store/raw/' + shot.name + '.png',
        say: shot.say,
        sub: shot.sub,
      });
      const slide = join(OUT, shot.name + '.png');
      await capture(chrome, base + '/dev/slide.html?' + slideParams, slide, SLIDE_W, SLIDE_H, 1);

      console.log('  ✓ %s', shot.name + '.png');
    }

    await writeFile(join(OUT, 'video-storyboard.md'), STORYBOARD, 'utf8');

    if (ffmpeg) {
      const slides = (await readdir(OUT)).filter((n) => n.endsWith('.png')).sort();
      // 4s a slide: long enough to read the caption, short enough that four of
      // them stay under the twenty seconds anyone will actually watch.
      const list = slides.map((n) => `file '${n}'\nduration 4`).join('\n') +
        `\nfile '${slides[slides.length - 1]}'\n`;
      await writeFile(join(OUT, 'slides.txt'), list, 'utf8');
      const mp4 = spawnSync(ffmpeg, [
        '-y', '-f', 'concat', '-safe', '0', '-i', 'slides.txt',
        // yuv420p and even dimensions, or some players show nothing at all.
        '-vf', 'format=yuv420p',
        '-r', '30', '-c:v', 'libx264', '-preset', 'slow', '-crf', '20',
        '-movflags', '+faststart',
        'kavi-preview.mp4',
      ], { cwd: OUT, stdio: 'ignore' });
      await rm(join(OUT, 'slides.txt'), { force: true });
      if (mp4.status === 0) console.log('  ✓ kavi-preview.mp4');
      else console.log('  ! ffmpeg failed — upload a device recording instead');
    } else {
      console.log('\n  ffmpeg not found (set FFMPEG_PATH) — no MP4 written.');
    }

    console.log('\n  → %s', OUT);
    console.log('  Record the real video on the glasses; see video-storyboard.md.');
  } finally {
    server.kill();
  }
}

const STORYBOARD = `# Preview video — what to record

AIUI Studio wants at least one video alongside the images. A screen recording
from the glasses is worth more than the generated slideshow: it is the only
artefact that shows the agent actually being *invoked*, which is the part a
reviewer is checking.

Record with the glasses' own screen recording, or film the HUD. Target 20-35s.

| t | On screen | What you say |
| --- | --- | --- |
| 0:00 | Assistant idle | wake the assistant, then "Kavi" |
| 0:03 | Kavi opens | "Kavi, what's on my calendar today?" |
| 0:07 | The agenda card fills in | (let it speak its one-line summary) |
| 0:13 | Look at a colleague | "Kavi halo" |
| 0:17 | The face card names them and shows your note | — |
| 0:22 | Still on them | "Kavi remember that she runs the security review" |
| 0:27 | The card confirms the note | — |
| 0:31 | End on the agenda card | — |

Keep out of frame: the sign-in code, the verification URL, and any real
calendar or face belonging to someone who has not agreed to appear. Shoot it on
a demo account with a colleague who has said yes.
`;

main().catch((error) => {
  console.error('\n  shots failed:', (error && error.message) || error);
  process.exit(1);
});
