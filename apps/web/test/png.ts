import { inflateSync } from 'node:zlib';

/**
 * Read a PNG's pixels, with no dependency.
 *
 * The app icons are committed as PNGs, and the only way to check a PNG is to look at
 * its pixels. A decoding library would be a new dependency in the test path for the
 * sake of three 8-bit truecolour images, and `sharp`/`canvas` are exactly the kind of
 * thing that works on one machine and not on the runner — so the four things a PNG
 * actually needs (the chunk walk, the inflate, the per-scanline filters, and the
 * channel order) are here instead, in sixty lines that run anywhere Node runs.
 *
 * Only what the shipped files are: 8-bit, RGB or RGBA, no interlacing, no palette.
 * Anything else throws rather than returning a plausible-looking lie.
 */
export interface Png {
  width: number;
  height: number;
  /** Row-major RGBA, one byte per channel, four bytes per pixel. */
  pixels: Uint8Array;
}

const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

export function readPng(buffer: Buffer): Png {
  let width = 0;
  let height = 0;
  let depth = 0;
  let colourType = 0;
  let interlace = 0;
  const idat: Buffer[] = [];

  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colourType = data[9];
      interlace = data[12];
    }
    if (type === 'IDAT') idat.push(data);
    if (type === 'IEND') break;
    offset += 12 + length;
  }

  if (depth !== 8) throw new Error(`only 8-bit PNGs are read here, not ${depth}-bit`);
  if (colourType !== 2 && colourType !== 6) {
    throw new Error(`only truecolour PNGs are read here, not colour type ${colourType}`);
  }
  if (interlace !== 0) throw new Error('interlaced PNGs are not read here');

  const channels = colourType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);

  let cursor = 0;
  for (let row = 0; row < height; row += 1) {
    const filter = raw[cursor];
    cursor += 1;
    const line = raw.subarray(cursor, cursor + stride);
    cursor += stride;
    const previous = row === 0 ? null : out.subarray((row - 1) * stride, row * stride);
    const current = out.subarray(row * stride, (row + 1) * stride);
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? current[x - channels] : 0;
      const b = previous ? previous[x] : 0;
      const c = previous && x >= channels ? previous[x - channels] : 0;
      const value = line[x];
      const unfiltered =
        filter === 0
          ? value
          : filter === 1
            ? value + a
            : filter === 2
              ? value + b
              : filter === 3
                ? value + ((a + b) >> 1)
                : filter === 4
                  ? value + paeth(a, b, c)
                  : Number.NaN;
      if (Number.isNaN(unfiltered)) throw new Error(`unknown PNG filter ${filter} on row ${row}`);
      current[x] = unfiltered & 0xff;
    }
  }

  // One shape out, whatever came in: RGB is widened to RGBA with the alpha channel set,
  // so a caller never has to know which of the two it was handed.
  if (channels === 4) return { width, height, pixels: new Uint8Array(out) };
  const pixels = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    pixels[index * 4] = out[index * 3];
    pixels[index * 4 + 1] = out[index * 3 + 1];
    pixels[index * 4 + 2] = out[index * 3 + 2];
    pixels[index * 4 + 3] = 255;
  }
  return { width, height, pixels };
}

/** Hue in degrees, or null for a pixel with no chroma at all. */
export function hueOf(r: number, g: number, b: number): number | null {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return null;
  const d = max - min;
  const hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return Math.round((((hue * 60) % 360) + 360) % 360);
}

export const saturationOf = (r: number, g: number, b: number): number => {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
};
