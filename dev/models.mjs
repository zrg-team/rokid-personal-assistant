/**
 * Put the two ONNX models into the project's private `models` bucket.
 *
 * They are not committed and not bundled into the functions: 10 MB of weights
 * make deploys slow, and keeping them in Storage means swapping a model is an
 * upload rather than a redeploy.
 *
 *   SUPABASE_URL=https://<ref>.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=… \
 *   npm run models
 *
 * Both come from OpenCV Zoo, which stores them in Git LFS — hence the
 * `media.githubusercontent.com` host, since `raw.githubusercontent.com` serves a
 * 133-byte pointer file instead of the model.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(HERE, '..', '.models');
const ZOO = 'https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models';

const MODELS = [
  {
    name: 'face_detection_yunet_2023mar.onnx',
    url: ZOO + '/face_detection_yunet/face_detection_yunet_2023mar.onnx',
    minBytes: 200_000,
  },
  {
    // The int8 build, not the 38 MB float one: quantisation cost 0.008 of
    // separation margin on the fixture set, for a quarter of the size.
    name: 'face_recognition_sface_2021dec_int8.onnx',
    url: ZOO + '/face_recognition_sface/face_recognition_sface_2021dec_int8.onnx',
    minBytes: 8_000_000,
  },
  {
    // The ONNX Runtime itself. The edge runtime cannot allocate shared memory,
    // so the function pins onnxruntime-web 1.16.3 and uses its *non-threaded*
    // build — see supabase/functions/_shared/ort.ts. The loader fetches this
    // file by URL at cold start, so it lives in the same private bucket and is
    // reached through a signed URL. Fetched from the CDN here, at upload time,
    // so nothing outside the project is contacted at runtime.
    name: 'ort-wasm-simd.wasm',
    url: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.16.3/dist/ort-wasm-simd.wasm',
    minBytes: 8_000_000,
  },
];

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

async function cached(model) {
  const file = path.join(CACHE, model.name);
  if (fs.existsSync(file) && fs.statSync(file).size >= model.minBytes) {
    return fs.readFileSync(file);
  }

  process.stdout.write('fetch    ' + model.name + ' … ');
  const response = await fetch(model.url);
  if (!response.ok) throw new Error(model.name + ': HTTP ' + response.status);
  const bytes = Buffer.from(await response.arrayBuffer());

  // An LFS pointer is a couple of hundred bytes of text; it would be written
  // happily here and then fail much later, inside onnxruntime.
  if (bytes.length < model.minBytes) {
    throw new Error(model.name + ': got ' + bytes.length + ' bytes, expected a model');
  }

  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(file, bytes);
  console.log((bytes.length / 1e6).toFixed(1) + ' MB');
  return bytes;
}

async function upload(model, bytes) {
  const url = SUPABASE_URL + '/storage/v1/object/models/' + model.name;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + SERVICE_KEY,
      apikey: SERVICE_KEY,
      'content-type': 'application/octet-stream',
      // Re-running this should replace the model, not fail on a name clash.
      'x-upsert': 'true',
    },
    body: bytes,
  });

  if (!response.ok) {
    throw new Error(
      'upload failed for ' + model.name + ': HTTP ' + response.status + ' ' +
      (await response.text()).slice(0, 200)
    );
  }
  console.log('upload   ' + model.name + '  ' + (bytes.length / 1e6).toFixed(1) + ' MB');
}

const files = [];
for (const model of MODELS) files.push([model, await cached(model)]);

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.log(
    '\nModels cached in .models/ — that is all this can do without credentials.\n' +
    'To upload them, set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY and run again.\n' +
    'Both are under Project Settings > API in the Supabase dashboard.'
  );
  process.exit(0);
}

for (const [model, bytes] of files) await upload(model, bytes);
console.log('\nBoth models are in the private `models` bucket. Deploy the functions next.');
