/**
 * Getting pixels out of whatever the glasses camera produced.
 *
 * Edge Functions have no `sharp` and no native image libraries, so decode,
 * orientation and resampling are all plain TypeScript here.
 *
 * ## Why this is one fused pass
 *
 * The obvious shape — decode, rotate into a new buffer, downscale into another
 * — allocates two full-resolution copies and walks every pixel twice. On a
 * 2.2 MB photo (about 5 megapixels) that was enough to blow the invocation's
 * resource budget: the platform killed the request with HTTP 546 while smaller
 * photos of the same subject went through fine. Failures tracked file size, not
 * content, which is what gave it away.
 *
 * So orientation and downscale happen together, in a single loop over the
 * *output* pixels, sampling the source directly. Nothing full-size is allocated
 * beyond what the decoder itself returns.
 *
 * ## Why sampling is bounded
 *
 * A true box filter reads every source pixel, so its cost scales with the input
 * — exactly the thing that broke. This averages at most `MAX_SAMPLES²` points
 * spread across each source box, which caps the work at the output size no
 * matter how large the photo is. It is still a real average, so it does not
 * alias the way point sampling would, and aliasing around the eyes is what
 * would cost landmark accuracy.
 *
 * Applying the EXIF rotation at all is not optional: head-mounted cameras
 * habitually record a rotation flag instead of rotating pixels, and a sideways
 * face is one the detector simply does not find.
 */

import jpeg from 'npm:jpeg-js@0.4.4';

export interface RgbImage {
  data: Uint8Array;
  width: number;
  height: number;
  channels: number;
}

/**
 * Longest edge of the working image.
 *
 * The detector letterboxes to 640 anyway, so more than this buys nothing for
 * detection; it only helps the aligned crop when a face is small in frame.
 */
export const MAX_WORKING_EDGE = 960;

/** Samples per axis when averaging a source box. */
const MAX_SAMPLES = 3;

/* -------------------------------------------------------------------------- */
/* EXIF                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Read the EXIF orientation tag (0x0112), or 1 when there is none.
 *
 * Walks the JPEG marker segments to APP1, then the TIFF header inside it. Only
 * that one tag is wanted, so this is a targeted scan rather than a real parser.
 */
export function exifOrientation(bytes: Uint8Array): number {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return 1;

  let offset = 2;
  while (offset + 4 < bytes.length) {
    if (bytes[offset] !== 0xff) break;

    const marker = bytes[offset + 1];
    const size = (bytes[offset + 2] << 8) | bytes[offset + 3];

    // SOS: entropy-coded data starts, and any EXIF block is long behind us.
    if (marker === 0xda) break;

    if (marker === 0xe1) {
      const start = offset + 4;
      const isExif =
        bytes[start] === 0x45 && bytes[start + 1] === 0x78 &&
        bytes[start + 2] === 0x69 && bytes[start + 3] === 0x66;
      if (isExif) return readOrientationTag(bytes, start + 6);
    }

    offset += 2 + size;
  }
  return 1;
}

function readOrientationTag(bytes: Uint8Array, tiff: number): number {
  if (tiff + 8 > bytes.length) return 1;

  // "II" little-endian or "MM" big-endian — both occur in the wild.
  const little = bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49;
  const u16 = (at: number) =>
    little ? bytes[at] | (bytes[at + 1] << 8) : (bytes[at] << 8) | bytes[at + 1];
  const u32 = (at: number) =>
    little
      ? bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)
      : (bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3];

  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > bytes.length) return 1;

  const count = u16(ifd);
  for (let i = 0; i < count; i += 1) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > bytes.length) break;
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

/** Do orientations 5-8 exchange width and height? */
export function turns(orientation: number): boolean {
  return orientation >= 5;
}

/**
 * Map a pixel in the *oriented* image back to its source coordinates.
 *
 * The inverse of the usual EXIF table: we walk output pixels, so we need to know
 * where each one came from rather than where each source pixel goes.
 */
function toSource(
  ox: number, oy: number, width: number, height: number, orientation: number,
): [number, number] {
  switch (orientation) {
    case 2: return [width - 1 - ox, oy];
    case 3: return [width - 1 - ox, height - 1 - oy];
    case 4: return [ox, height - 1 - oy];
    case 5: return [oy, ox];
    case 6: return [oy, height - 1 - ox];
    case 7: return [width - 1 - oy, height - 1 - ox];
    case 8: return [width - 1 - oy, ox];
    default: return [ox, oy];
  }
}

/* -------------------------------------------------------------------------- */
/* the fused pass                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Straighten and shrink in one go.
 *
 * @param decoded     raw decoder output
 * @param orientation EXIF orientation, 1-8
 * @param maxEdge     cap for the longest edge of the result
 * @returns RGB (3 channels), upright, at or below `maxEdge`
 */
export function normalize(
  decoded: RgbImage, orientation: number, maxEdge: number,
): RgbImage {
  const { data, width, height, channels } = decoded;

  const orientedW = turns(orientation) ? height : width;
  const orientedH = turns(orientation) ? width : height;

  const scale = Math.min(1, maxEdge / Math.max(orientedW, orientedH));
  const outW = Math.max(1, Math.round(orientedW * scale));
  const outH = Math.max(1, Math.round(orientedH * scale));

  const out = new Uint8Array(outW * outH * 3);

  // How much of the oriented image each output pixel covers.
  const boxW = orientedW / outW;
  const boxH = orientedH / outH;
  const nx = Math.max(1, Math.min(MAX_SAMPLES, Math.floor(boxW)));
  const ny = Math.max(1, Math.min(MAX_SAMPLES, Math.floor(boxH)));
  const weight = 1 / (nx * ny);

  for (let y = 0; y < outH; y += 1) {
    const top = y * boxH;
    for (let x = 0; x < outW; x += 1) {
      const left = x * boxW;

      let r = 0;
      let g = 0;
      let b = 0;

      for (let sy = 0; sy < ny; sy += 1) {
        // Sample at box centres, so the points sit inside the box rather than
        // on its edge and the average stays unbiased.
        const oy = Math.min(orientedH - 1, Math.floor(top + (sy + 0.5) * boxH / ny));
        for (let sx = 0; sx < nx; sx += 1) {
          const ox = Math.min(orientedW - 1, Math.floor(left + (sx + 0.5) * boxW / nx));
          const [px, py] = toSource(ox, oy, width, height, orientation);
          const i = (py * width + px) * channels;
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
        }
      }

      const o = (y * outW + x) * 3;
      out[o] = Math.round(r * weight);
      out[o + 1] = Math.round(g * weight);
      out[o + 2] = Math.round(b * weight);
    }
  }

  return { data: out, width: outW, height: outH, channels: 3 };
}

/* -------------------------------------------------------------------------- */
/* entry point                                                                */
/* -------------------------------------------------------------------------- */

export function looksLikeJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/** Decode, straighten and shrink a captured photo. */
export function decodeImage(bytes: Uint8Array, maxEdge = MAX_WORKING_EDGE): RgbImage {
  if (!looksLikeJpeg(bytes)) {
    throw new Error('Only JPEG is supported; the camera sent something else.');
  }

  // `useTArray` returns a Uint8Array rather than a Node Buffer polyfill.
  // `formatAsRGBA: false` drops the alpha channel the decoder would otherwise
  // fabricate — a quarter less memory for the single largest allocation in the
  // request, which matters because the decode peak and the loaded model have to
  // fit in one invocation's budget together.
  // `maxMemoryUsageInMB` stops a corrupt or hostile file from exhausting it.
  const raw = jpeg.decode(bytes, {
    useTArray: true,
    formatAsRGBA: false,
    maxMemoryUsageInMB: 96,
  });

  const decoded: RgbImage = {
    data: raw.data as Uint8Array,
    width: raw.width,
    height: raw.height,
    channels: 3,
  };

  return normalize(decoded, exifOrientation(bytes), maxEdge);
}
