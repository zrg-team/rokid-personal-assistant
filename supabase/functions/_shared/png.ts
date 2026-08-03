/**
 * A minimal PNG encoder, so the glasses can be sent a picture they can draw.
 *
 * ## Why this exists
 *
 * The thumbnail used to travel as raw luminance bytes and get painted into a
 * `<canvas>` with `putImageData`. That does not work: on the Ink web host the
 * canvas renders nothing at all. A probe page proved it — `fillRect`,
 * `putImageData` and `flush` were all called without error, `flush` is a real
 * function, and the canvas stayed empty, while an `<image>` with a `data:` URI
 * beside it rendered perfectly.
 *
 * So the server does the encoding and the page just points an `<image>` at the
 * result. That also deletes the whole `thumbToRgba` / `ImageData` dance from the
 * device, which is the right place for it not to be.
 *
 * ## Shape of the output
 *
 * Truecolour (8-bit RGB, colour type 2) with the luminance written into the
 * green channel, because the display is a single green monochrome panel and the
 * other two channels are wasted there. It deflates extremely well — two of the
 * three channels are all zero — so a 64x64 thumbnail lands around 1 KB.
 */

/** Standard CRC-32, built once per instance. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);

  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));

  return out;
}

/** zlib-wrapped deflate — which is what an IDAT holds, not raw deflate. */
async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function base64(bytes: Uint8Array): string {
  // Chunked so a large image cannot blow the argument limit of String.fromCharCode.
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

/**
 * Encode 8-bit luminance as a green PNG, magnified by an integer factor.
 *
 * @param gray   `size * size` luminance bytes
 * @param size   edge of the source square
 * @param scale  integer magnification; pixel replication, which is what suits a
 *               thumbnail this small — smoothing would only blur it
 * @returns a `data:image/png;base64,…` URI ready to drop into `<image src>`
 */
export async function greenPngDataUri(
  gray: Uint8Array, size: number, scale = 1,
): Promise<string> {
  const edge = size * scale;

  // One filter byte per scanline, then RGB triples.
  const raw = new Uint8Array((edge * 3 + 1) * edge);
  let o = 0;
  for (let y = 0; y < edge; y += 1) {
    raw[o] = 0; // filter type 0: none
    o += 1;
    const sy = (y / scale) | 0;
    for (let x = 0; x < edge; x += 1) {
      const value = gray[sy * size + ((x / scale) | 0)];
      raw[o] = 0;
      raw[o + 1] = value;
      raw[o + 2] = 0;
      o += 3;
    }
  }

  const ihdr = new Uint8Array(13);
  const header = new DataView(ihdr.buffer);
  header.setUint32(0, edge);
  header.setUint32(4, edge);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  // 10..12 stay zero: deflate compression, adaptive filtering, no interlace.

  const png = new Uint8Array([
    ...[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    ...chunk('IHDR', ihdr),
    ...chunk('IDAT', await deflate(raw)),
    ...chunk('IEND', new Uint8Array(0)),
  ]);

  return 'data:image/png;base64,' + base64(png);
}
