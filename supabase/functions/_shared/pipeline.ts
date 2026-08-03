/**
 * The pipeline, and the one copy of the models.
 *
 *   decode -> detect (YuNet) -> align (5-point) -> embed (SFace int8)
 *
 * Both models live in a private Storage bucket rather than in the function
 * bundle: ten megabytes of weights make deploys slow and the bundle awkward,
 * and keeping them in Storage means swapping a model is an upload rather than a
 * redeploy.
 *
 * They are fetched once per *instance*, not once per request. Edge Functions
 * keep a warm instance alive between invocations, so this module-level promise
 * is the difference between a few hundred milliseconds and several seconds on
 * every capture. Holding the promise rather than the value also means two
 * requests arriving during a cold start share one download instead of racing.
 */

import { ORT_WASM_FILE, configureWasm } from './ort.ts';
import { FaceDetector, type Detection } from './yunet.ts';
import { FaceEncoder, type FaceEncoder as Encoder } from './sface.ts';
import { alignFace, type Crop } from './align.ts';
import { decodeImage, type RgbImage } from './image.ts';

export const DETECTOR_FILE = 'face_detection_yunet_2023mar.onnx';
export const ENCODER_FILE = 'face_recognition_sface_2021dec_int8.onnx';
export const MODEL_BUCKET = 'models';

export interface AnalyzedFace extends Detection {
  embedding: number[];
  crop: Crop;
}

let cached: Promise<{ detector: FaceDetector; encoder: Encoder }> | null = null;

/**
 * Cold-start stage timings, in milliseconds.
 *
 * Kept because the first deploy timed out at the platform's wall clock with no
 * way to see which stage was responsible — the runtime offers no log tail here.
 */
export const timings: Record<string, number> = {};

async function timed<T>(name: string, work: Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    return await work;
  } finally {
    timings[name] = Date.now() - started;
  }
}

function credentials() {
  const base = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!base || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  }
  return { base, key };
}

/**
 * A time-limited public URL for one object in the private bucket.
 *
 * The WASM loader does its own `fetch` and cannot be given an Authorization
 * header, so this is how it reaches a file that is not world-readable.
 */
async function signedUrl(file: string, seconds = 3600): Promise<string> {
  const { base, key } = credentials();
  const response = await fetch(
    base + '/storage/v1/object/sign/' + MODEL_BUCKET + '/' + file,
    {
      method: 'POST',
      headers: { authorization: 'Bearer ' + key, apikey: key, 'content-type': 'application/json' },
      body: JSON.stringify({ expiresIn: seconds }),
    },
  );
  if (!response.ok) {
    throw new Error(
      'Could not sign ' + file + ' (HTTP ' + response.status + '). Run `npm run models`.'
    );
  }
  const { signedURL } = await response.json();
  return base + '/storage/v1' + signedURL;
}

async function download(file: string): Promise<Uint8Array> {
  const { base, key } = credentials();
  const url = base + '/storage/v1/object/' + MODEL_BUCKET + '/' + file;
  const response = await fetch(url, {
    headers: { authorization: 'Bearer ' + key, apikey: key },
  });

  if (!response.ok) {
    throw new Error(
      'Could not load ' + file + ' from the ' + MODEL_BUCKET + ' bucket (HTTP ' +
      response.status + '). Run `npm run models:upload`.'
    );
  }

  return new Uint8Array(await response.arrayBuffer());
}

export function loadModels() {
  if (!cached) {
    cached = (async () => {
      // The wasm URL has to be in place before the first session is created.
      const [wasmUrl, detectorBytes, encoderBytes] = await Promise.all([
        timed('signUrl', signedUrl(ORT_WASM_FILE)),
        timed('downloadDetector', download(DETECTOR_FILE)),
        timed('downloadEncoder', download(ENCODER_FILE)),
      ]);
      configureWasm(wasmUrl);

      // Sequential, not parallel: the first session is what compiles and
      // instantiates the WASM runtime, and that cost belongs to it alone.
      const detector = await timed('detectorSession', FaceDetector.load(detectorBytes));
      const encoder = await timed('encoderSession', FaceEncoder.load(encoderBytes));
      return { detector, encoder };
    })().catch((error) => {
      // A failed cold start must not poison the instance forever; clear the
      // cache so the next request retries instead of replaying the error.
      cached = null;
      throw error;
    });
  }
  return cached;
}

/** Every face in the frame, with its embedding, nearest to the camera first. */
export async function analyze(
  bytes: Uint8Array,
  options: { maxFaces?: number } = {},
): Promise<{ faces: AnalyzedFace[]; image: RgbImage }> {
  const { detector, encoder } = await loadModels();
  const image = decodeImage(bytes);
  const detections = await detector.detect(image);

  const faces: AnalyzedFace[] = [];
  for (const detection of detections.slice(0, options.maxFaces ?? 4)) {
    const crop = alignFace(image, detection.landmarks);
    faces.push({ ...detection, embedding: await encoder.embed(crop), crop });
  }

  return { faces, image };
}
