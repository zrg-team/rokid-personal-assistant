/**
 * SFace embeddings (OpenCV Zoo, face_recognition_sface_2021dec_int8.onnx).
 *
 * Takes the aligned 112x112 crop and returns 128 numbers. Two crops of the same
 * person land close together on the unit sphere; different people do not. This
 * is what makes the feature face *recognition* rather than a pixel comparison —
 * the network was trained to be invariant to the lighting, pose and expression
 * that no appearance signature survives.
 *
 * The int8 build is shipped rather than the 38 MB float one. Measured on twelve
 * photographs of three people, quantisation cost 0.008 of separation margin
 * (0.201 against 0.209) for a quarter of the size — a trade worth making inside
 * an Edge Function, where the model is fetched and held in a tight memory
 * budget on every cold start.
 *
 * Vectors leave here L2-normalised, so pgvector's cosine distance is a plain
 * dot product and stored rows stay comparable.
 */

import { getOrt } from './ort.ts';
import type { Crop } from './align.ts';

export const EMBEDDING_DIM = 128;

/**
 * OpenCV publishes 0.363 as the cosine threshold for "same person" on this
 * model. `TENTATIVE` sits just above it, `CONFIDENT` well above, because a
 * memory aid that says the wrong name with conviction is worse than one that
 * admits doubt — the wearer can recover from "I think that is…" gracefully.
 *
 * On the twelve-photo fixture set these gave no false accepts and no misses,
 * against a worst same-person score of 0.467 and a best stranger score of 0.266.
 */
export const TENTATIVE = 0.38;
export const CONFIDENT = 0.5;

export class FaceEncoder {
  // deno-lint-ignore no-explicit-any
  private session: any;
  // deno-lint-ignore no-explicit-any
  private ort: any;
  private inputName: string;
  private outputName: string;

  // deno-lint-ignore no-explicit-any
  constructor(session: any, ort: any) {
    this.session = session;
    this.ort = ort;
    this.inputName = session.inputNames[0];
    this.outputName = session.outputNames[0];
  }

  static async load(model: Uint8Array) {
    const ort = await getOrt();
    const session = await ort.InferenceSession.create(model, {
      executionProviders: ['wasm'],
      // Memory, not speed, is what this runtime rations. The arena pools
      // allocations across runs, which is faster but keeps the peak resident;
      // without it each run releases what it used. Same for the memory pattern
      // planner, which pre-reserves activation buffers. Turning both off is
      // what lets a large photo's decode peak and the model coexist inside one
      // invocation's budget.
      enableCpuMemArena: false,
      enableMemPattern: false,
      graphOptimizationLevel: 'basic',
    });
    return new FaceEncoder(session, ort);
  }

  async embed(crop: Crop): Promise<number[]> {
    const { width, height, data } = crop;
    const plane = width * height;
    const input = new Float32Array(plane * 3);

    // BGR planar, raw 0-255 — cv::dnn::blobFromImage's defaults, which is how
    // the model was calibrated.
    for (let i = 0; i < plane; i += 1) {
      input[i] = data[i * 3 + 2];
      input[plane + i] = data[i * 3 + 1];
      input[2 * plane + i] = data[i * 3];
    }

    const tensor = new this.ort.Tensor('float32', input, [1, 3, height, width]);
    const output = await this.session.run({ [this.inputName]: tensor });
    return normalize(Array.from(output[this.outputName].data as Float32Array));
  }
}

export function normalize(vec: number[]): number[] {
  let sum = 0;
  for (const v of vec) sum += v * v;
  const norm = Math.sqrt(sum) || 1;
  return vec.map((v) => v / norm);
}

/** Cosine similarity of two unit vectors. Same person is roughly ≥ 0.38. */
export function cosine(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length) return -1;
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
  return dot;
}
