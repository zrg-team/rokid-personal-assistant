/**
 * Does the Edge Function pipeline actually tell people apart?
 *
 * Runs the real `_shared` modules — pure-JS JPEG decode, YuNet, the alignment
 * warp, int8 SFace — over twelve photographs of three public figures, labelled
 * by hand. Eight of one person and two each of the others, across changes of
 * pose, lighting, hair and makeup.
 *
 * The number that matters is the *margin*: the worst same-person score minus
 * the best different-person score. Positive means one threshold separates every
 * pair. Negative means no threshold can, however flattering the averages look.
 *
 *   docker run --rm \
 *     -v "$PWD/supabase:/app" -v "$PWD/.models:/models:ro" -v /tmp/faces:/fixtures:ro \
 *     -w /app denoland/deno:latest run --allow-all test/pipeline.test.ts
 */

import { configureWasm } from '../functions/_shared/ort.ts';
import { FaceDetector } from '../functions/_shared/yunet.ts';
import { FaceEncoder, cosine, CONFIDENT, TENTATIVE } from '../functions/_shared/sface.ts';
import { alignFace } from '../functions/_shared/align.ts';
import { decodeImage } from '../functions/_shared/image.ts';
import { makeThumb } from '../functions/_shared/thumb.ts';

const MODELS = Deno.env.get('MODEL_DIR') ?? '/models';
const FIXTURES = Deno.env.get('FIXTURE_DIR') ?? '/fixtures';

/* Identities assigned by looking at the photographs, not by any model. */
const LABELS: Record<string, string> = {
  img1: 'A', img2: 'A', img4: 'A', img5: 'A', img6: 'A', img7: 'A', img10: 'A', img11: 'A',
  img3: 'B', img12: 'B',
  img8: 'C', img9: 'C',
};

// Outside a deployed function there is no Storage to sign, so point the loader
// at the public CDN copy of the same binary.
configureWasm('https://cdn.jsdelivr.net/npm/onnxruntime-web@1.16.3/dist/ort-wasm-simd.wasm');

const started = performance.now();
const detector = await FaceDetector.load(await Deno.readFile(MODELS + '/face_detection_yunet_2023mar.onnx'));
const encoder = await FaceEncoder.load(await Deno.readFile(MODELS + '/face_recognition_sface_2021dec_int8.onnx'));
console.log('models loaded in ' + Math.round(performance.now() - started) + ' ms\n');

/* ── detect + embed ──────────────────────────────────────────────────────── */

const embeddings: Record<string, number[]> = {};
let totalMs = 0;
let failures = 0;

for (const name of Object.keys(LABELS)) {
  const bytes = await Deno.readFile(FIXTURES + '/' + name + '.jpg');
  const t0 = performance.now();

  const image = decodeImage(bytes);
  const detections = await detector.detect(image);
  if (!detections.length) {
    console.log('FAIL  no face detected in ' + name);
    failures += 1;
    continue;
  }

  const crop = alignFace(image, detections[0].landmarks);
  embeddings[name] = await encoder.embed(crop);
  const ms = performance.now() - t0;
  totalMs += ms;

  console.log(
    name.padEnd(7) + 'score ' + detections[0].score.toFixed(2) +
    '  ' + image.width + 'x' + image.height +
    '  ' + Math.round(ms) + ' ms' +
    '  thumb ' + makeThumb(crop).length + ' chars'
  );
}

const found = Object.keys(embeddings);
console.log(
  '\ndetected ' + found.length + '/' + Object.keys(LABELS).length +
  ' faces, ' + Math.round(totalMs / Math.max(found.length, 1)) + ' ms per photo end to end\n'
);

/* ── every pair ──────────────────────────────────────────────────────────── */

const same: number[] = [];
const different: number[] = [];
let worstSame = { score: Infinity, a: '', b: '' };
let bestDifferent = { score: -Infinity, a: '', b: '' };

for (let i = 0; i < found.length; i += 1) {
  for (let j = i + 1; j < found.length; j += 1) {
    const a = found[i];
    const b = found[j];
    const score = cosine(embeddings[a], embeddings[b]);
    if (LABELS[a] === LABELS[b]) {
      same.push(score);
      if (score < worstSame.score) worstSame = { score, a, b };
    } else {
      different.push(score);
      if (score > bestDifferent.score) bestDifferent = { score, a, b };
    }
  }
}

const mean = (xs: number[]) => xs.reduce((t, x) => t + x, 0) / xs.length;

console.log('same person      ' + same.length + ' pairs, mean ' + mean(same).toFixed(3) +
            ', worst ' + worstSame.score.toFixed(3) + '  (' + worstSame.a + ' vs ' + worstSame.b + ')');
console.log('different people ' + different.length + ' pairs, mean ' + mean(different).toFixed(3) +
            ', best  ' + bestDifferent.score.toFixed(3) + '  (' + bestDifferent.a + ' vs ' + bestDifferent.b + ')');

const margin = worstSame.score - bestDifferent.score;
console.log('\nmargin ' + margin.toFixed(3) + (margin > 0 ? '  — separable' : '  — OVERLAPPING'));

const falseAccepts = different.filter((s) => s >= TENTATIVE).length;
const missed = same.filter((s) => s < TENTATIVE).length;
const confidentlyWrong = different.filter((s) => s >= CONFIDENT).length;

console.log('\nat TENTATIVE=' + TENTATIVE + '  false accepts ' + falseAccepts + '/' + different.length +
            ', missed ' + missed + '/' + same.length);
console.log('at CONFIDENT=' + CONFIDENT + '   strangers named with confidence: ' + confidentlyWrong);

const ok = failures === 0 && margin > 0 && falseAccepts === 0;
console.log('\n' + (ok ? 'PASS' : 'FAIL'));
if (!ok) Deno.exit(1);
