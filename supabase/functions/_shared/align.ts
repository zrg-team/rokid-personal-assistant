/**
 * Face alignment: five landmarks -> a canonical 112x112 crop.
 *
 * SFace, like every ArcFace-lineage recogniser, is trained on faces warped onto
 * a fixed template. Feeding it a raw bounding box instead costs a lot of
 * accuracy, because the network never learned to be invariant to the in-plane
 * rotation and scale that alignment removes.
 *
 * The transform is a *similarity* (rotation + uniform scale + translation, no
 * shear, no reflection), solved in closed form rather than by SVD: writing it as
 *
 *     u = a*x - b*y + tx
 *     v = b*x + a*y + ty
 *
 * the least-squares fit over centred points separates into two ratios, which is
 * exact for five points and needs no matrix library in the function bundle.
 */

import type { RgbImage } from './image.ts';

export type Point = [number, number];

/** ArcFace 112x112 template — the same constants OpenCV's alignCrop uses. */
export const REFERENCE_LANDMARKS: Point[] = [
  [38.2946, 51.6963], // right eye (the subject's left)
  [73.5318, 51.5014], // left eye
  [56.0252, 71.7366], // nose tip
  [41.5493, 92.3655], // right mouth corner
  [70.7299, 92.2041], // left mouth corner
];

export const CROP_SIZE = 112;

export interface Crop {
  data: Uint8Array;
  width: number;
  height: number;
}

export function similarityTransform(src: Point[], dst: Point[]) {
  const n = src.length;
  let mx = 0, my = 0, mu = 0, mv = 0;
  for (let i = 0; i < n; i += 1) {
    mx += src[i][0];
    my += src[i][1];
    mu += dst[i][0];
    mv += dst[i][1];
  }
  mx /= n; my /= n; mu /= n; mv /= n;

  let num1 = 0; // Σ (x·u + y·v)
  let num2 = 0; // Σ (x·v - y·u)
  let den = 0;  // Σ (x² + y²)
  for (let i = 0; i < n; i += 1) {
    const x = src[i][0] - mx;
    const y = src[i][1] - my;
    const u = dst[i][0] - mu;
    const v = dst[i][1] - mv;
    num1 += x * u + y * v;
    num2 += x * v - y * u;
    den += x * x + y * y;
  }

  // Degenerate only if every landmark collapsed onto one point, which a real
  // detection cannot do; fall back to identity so callers never see NaN.
  if (den < 1e-9) return { a: 1, b: 0, tx: mu - mx, ty: mv - my };

  const a = num1 / den;
  const b = num2 / den;
  return { a, b, tx: mu - (a * mx - b * my), ty: mv - (b * mx + a * my) };
}

/**
 * Warp a face out of the full frame onto the 112x112 template.
 *
 * Inverse-mapped with bilinear sampling: we walk the *output* pixels and pull
 * from the source, which is what avoids the holes a forward map leaves behind.
 */
export function alignFace(image: RgbImage, landmarks: Point[]): Crop {
  const { a, b, tx, ty } = similarityTransform(landmarks, REFERENCE_LANDMARKS);

  // Invert [a -b; b a]; its determinant a² + b² is positive for any similarity
  // with non-zero scale.
  const inv = 1 / (a * a + b * b);

  const { data, width, height, channels } = image;
  const out = new Uint8Array(CROP_SIZE * CROP_SIZE * 3);

  for (let oy = 0; oy < CROP_SIZE; oy += 1) {
    for (let ox = 0; ox < CROP_SIZE; ox += 1) {
      const dx = ox - tx;
      const dy = oy - ty;
      const sx = (a * dx + b * dy) * inv;
      const sy = (-b * dx + a * dy) * inv;
      const o = (oy * CROP_SIZE + ox) * 3;

      // The template reaches past the photo edge on tightly cropped shots.
      // Black is what OpenCV's warpAffine leaves there too.
      if (sx < 0 || sy < 0 || sx > width - 1 || sy > height - 1) {
        out[o] = 0; out[o + 1] = 0; out[o + 2] = 0;
        continue;
      }

      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const x1 = Math.min(x0 + 1, width - 1);
      const y1 = Math.min(y0 + 1, height - 1);
      const fx = sx - x0;
      const fy = sy - y0;

      const i00 = (y0 * width + x0) * channels;
      const i01 = (y0 * width + x1) * channels;
      const i10 = (y1 * width + x0) * channels;
      const i11 = (y1 * width + x1) * channels;

      for (let c = 0; c < 3; c += 1) {
        const top = data[i00 + c] * (1 - fx) + data[i01 + c] * fx;
        const bottom = data[i10 + c] * (1 - fx) + data[i11 + c] * fx;
        out[o + c] = Math.round(top * (1 - fy) + bottom * fy);
      }
    }
  }

  return { data: out, width: CROP_SIZE, height: CROP_SIZE };
}
