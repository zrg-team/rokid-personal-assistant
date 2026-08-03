/**
 * Base64 for byte arrays.
 *
 * `btoa`/`atob` are not in the verified AIUI runtime surface, and
 * `wx.arrayBufferToBase64` is import-only `wx` — which would tie these utils to
 * the device and break them in Node and the dev harness. Thirty lines of plain
 * JS keeps every module platform-free.
 *
 * Descriptors and thumbnails are stored base64 rather than as JSON number
 * arrays: a 320-byte record is ~428 characters this way versus ~1300, and
 * device storage is a string store.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

let LOOKUP = null;
function lookup() {
  if (!LOOKUP) {
    LOOKUP = {};
    for (let i = 0; i < ALPHABET.length; i++) LOOKUP[ALPHABET.charAt(i)] = i;
  }
  return LOOKUP;
}

/** @param {Uint8Array|number[]} bytes */
export function toBase64(bytes) {
  const source = bytes || [];
  let out = '';

  for (let i = 0; i < source.length; i += 3) {
    const b0 = source[i] & 0xff;
    const has1 = i + 1 < source.length;
    const has2 = i + 2 < source.length;
    const b1 = has1 ? source[i + 1] & 0xff : 0;
    const b2 = has2 ? source[i + 2] & 0xff : 0;

    out += ALPHABET.charAt(b0 >> 2);
    out += ALPHABET.charAt(((b0 & 0x03) << 4) | (b1 >> 4));
    out += has1 ? ALPHABET.charAt(((b1 & 0x0f) << 2) | (b2 >> 6)) : '=';
    out += has2 ? ALPHABET.charAt(b2 & 0x3f) : '=';
  }
  return out;
}
