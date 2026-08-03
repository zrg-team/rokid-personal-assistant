/**
 * A face thumbnail the glasses can actually draw.
 *
 * The Ink runtime has no image decoder, so a JPEG would be useless to it. What
 * it does have is a canvas that accepts raw `ImageData`. So the thumbnail
 * travels as plain 8-bit luminance — one byte per pixel, base64'd — and the
 * page expands it into RGBA on arrival.
 *
 * 32x32 is 1 KB before base64: small enough to ride inside the JSON response,
 * big enough to be recognisable on a 448x352 single-colour display.
 */

import type { Crop } from './align.ts';

/** bytes → base64, without a jsr dependency (btoa is a Deno/Edge global). */
function encodeBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export const THUMB_SIZE = 32;

export function makeThumb(crop: Crop, size = THUMB_SIZE): string {
  const { data, width, height } = crop;
  const out = new Uint8Array(size * size);
  const boxW = width / size;
  const boxH = height / size;

  for (let ty = 0; ty < size; ty += 1) {
    const y0 = Math.floor(ty * boxH);
    const y1 = Math.max(y0 + 1, Math.floor((ty + 1) * boxH));
    for (let tx = 0; tx < size; tx += 1) {
      const x0 = Math.floor(tx * boxW);
      const x1 = Math.max(x0 + 1, Math.floor((tx + 1) * boxW));

      // Box average rather than point sampling: on a one-colour display a
      // point-sampled thumbnail reads as noise.
      let sum = 0;
      let count = 0;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const i = (y * width + x) * 3;
          sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          count += 1;
        }
      }
      out[ty * size + tx] = Math.round(sum / (count || 1));
    }
  }

  return encodeBase64(out);
}
