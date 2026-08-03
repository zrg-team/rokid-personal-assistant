/**
 * YuNet face detection (OpenCV Zoo, face_detection_yunet_2023mar.onnx).
 *
 * A 233 KB anchor-free detector with three heads, one per stride (8/16/32).
 * Each head emits, per grid cell:
 *
 *   cls_S  [N,1]  face score        obj_S  [N,1]  objectness
 *   bbox_S [N,4]  cx,cy offset + log w,h
 *   kps_S  [N,10] five landmarks as cell offsets
 *
 * The export is compiled at a fixed 640x640, so frames are letterboxed onto a
 * square canvas and the boxes mapped back afterwards. Letterboxing rather than
 * a plain resize preserves the aspect ratio, which matters: a squashed face
 * shifts the landmarks, and the alignment inherits the error.
 */

import { getOrt } from './ort.ts';
import type { RgbImage } from './image.ts';
import type { Point } from './align.ts';

export const INPUT_SIZE = 640;
export const STRIDES = [8, 16, 32];

export interface Detection {
  score: number;
  box: [number, number, number, number];
  landmarks: Point[];
}

/**
 * Letterbox onto a square canvas as BGR NCHW, raw 0-255 — both models were
 * calibrated on OpenCV's unnormalised BGR blobs.
 */
export function letterbox(image: RgbImage, size: number) {
  const { width, height, channels, data: src } = image;

  const scale = Math.min(size / width, size / height);
  const newW = Math.round(width * scale);
  const newH = Math.round(height * scale);
  const padX = Math.floor((size - newW) / 2);
  const padY = Math.floor((size - newH) / 2);

  const plane = size * size;
  const out = new Float32Array(plane * 3); // zero-filled = black bars

  for (let y = 0; y < newH; y += 1) {
    // Nearest-neighbour is enough: the detector is robust to it, and the crop
    // that reaches the recogniser is sampled from the full frame, not this.
    const sy = Math.min(height - 1, Math.floor(y / scale));
    for (let x = 0; x < newW; x += 1) {
      const sx = Math.min(width - 1, Math.floor(x / scale));
      const s = (sy * width + sx) * channels;
      const d = (y + padY) * size + (x + padX);
      out[d] = src[s + 2];
      out[plane + d] = src[s + 1];
      out[2 * plane + d] = src[s];
    }
  }

  return { data: out, scale, padX, padY };
}

function sigmoidIfNeeded(v: number) {
  // The 2023mar export already applies sigmoid. Guard anyway: a value outside
  // [0,1] means a raw logit slipped through.
  return v >= 0 && v <= 1 ? v : 1 / (1 + Math.exp(-v));
}

function iou(a: number[], b: number[]) {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[0] + a[2], b[0] + b[2]);
  const y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (a[2] * a[3] + b[2] * b[3] - inter);
}

function nms(faces: Detection[], threshold: number) {
  const kept: Detection[] = [];
  for (const face of faces) {
    if (kept.every((k) => iou(k.box, face.box) < threshold)) kept.push(face);
  }
  return kept;
}

export class FaceDetector {
  // deno-lint-ignore no-explicit-any
  private session: any;
  // deno-lint-ignore no-explicit-any
  private ort: any;
  private inputName: string;
  size: number;
  scoreThreshold: number;
  nmsThreshold: number;
  topK: number;

  // deno-lint-ignore no-explicit-any
  constructor(session: any, ort: any, options: Record<string, number> = {}) {
    this.session = session;
    this.ort = ort;
    this.inputName = session.inputNames[0];
    this.size = options.size || INPUT_SIZE;
    this.scoreThreshold = options.scoreThreshold ?? 0.7;
    this.nmsThreshold = options.nmsThreshold ?? 0.3;
    this.topK = options.topK ?? 20;
  }

  static async load(model: Uint8Array, options: Record<string, number> = {}) {
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

    // A fixed-shape export rejects any other size outright, so trust the model
    // over the caller.
    const shape = (session as unknown as {
      inputMetadata?: Array<{ shape?: Array<number | string> }>;
    }).inputMetadata?.[0]?.shape;
    const fixed = typeof shape?.[2] === 'number' && shape[2] > 0 ? (shape[2] as number) : null;

    return new FaceDetector(session, ort, { ...options, size: fixed || options.size || INPUT_SIZE });
  }

  /** Faces in the original image's pixel coordinates, biggest first. */
  async detect(image: RgbImage): Promise<Detection[]> {
    const size = this.size;
    const { data, scale, padX, padY } = letterbox(image, size);
    const tensor = new this.ort.Tensor('float32', data, [1, 3, size, size]);
    const output = await this.session.run({ [this.inputName]: tensor });

    const candidates: Detection[] = [];
    for (const stride of STRIDES) {
      const cls = output['cls_' + stride].data as Float32Array;
      const obj = output['obj_' + stride].data as Float32Array;
      const bbox = output['bbox_' + stride].data as Float32Array;
      const kps = output['kps_' + stride].data as Float32Array;

      const cols = size / stride;

      for (let i = 0; i < cls.length; i += 1) {
        const score = Math.sqrt(sigmoidIfNeeded(cls[i]) * sigmoidIfNeeded(obj[i]));
        if (score < this.scoreThreshold) continue;

        const row = Math.floor(i / cols);
        const col = i % cols;

        const cx = (col + bbox[i * 4]) * stride;
        const cy = (row + bbox[i * 4 + 1]) * stride;
        const w = Math.exp(bbox[i * 4 + 2]) * stride;
        const h = Math.exp(bbox[i * 4 + 3]) * stride;

        // Undo the letterbox: subtract the bar, then divide by the fit scale.
        const box: [number, number, number, number] = [
          (cx - w / 2 - padX) / scale,
          (cy - h / 2 - padY) / scale,
          w / scale,
          h / scale,
        ];

        const landmarks: Point[] = [];
        for (let k = 0; k < 5; k += 1) {
          landmarks.push([
            ((col + kps[i * 10 + k * 2]) * stride - padX) / scale,
            ((row + kps[i * 10 + k * 2 + 1]) * stride - padY) / scale,
          ]);
        }

        candidates.push({ score, box, landmarks });
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    const kept = nms(candidates.slice(0, 400), this.nmsThreshold).slice(0, this.topK);

    // Nearest face first: the wearer is looking at whoever fills the frame.
    kept.sort((a, b) => b.box[2] * b.box[3] - a.box[2] * a.box[3]);
    return kept;
  }
}
