/*
 * Write the app icons.
 *
 * These are the least-read asset in the repository: generated once, committed, and
 * then seen in every browser tab and on every home screen for months. They were also
 * the last thing still wearing the *previous* brand — a navy ground with a light blue
 * mark, measured at 92 % blue-dominant pixels — because changing a stylesheet does
 * not change a PNG. So they are not edited by hand any more: they are generated, from
 * the same values the stylesheets and the manifest use, by a script anyone can re-run.
 *
 * The mark is the one the console and the landing page both draw: a rounded tile with
 * three bars, the last of them in the accent. The colours are the product's own
 * materials, not picked here:
 *
 *   ground  #191c21  --surface, and the manifest's `background_color`/`theme_color`
 *   bars    #ffffff  --on-surface, the type colour on that material
 *   accent  #ea580c  --primary, the accent the mark's last bar carries
 *
 * Run with `pnpm icons` from the repository root. No dependency: the pixels are drawn
 * here and encoded with `node:zlib`, so the output is byte-stable on any machine.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'web', 'public');

const GROUND = [0x19, 0x1c, 0x21];
const BAR = [0xff, 0xff, 0xff];
const ACCENT = [0xea, 0x58, 0x0c];

/** Samples per axis inside one pixel, so the corners are smooth rather than stepped. */
const SAMPLES = 4;

/**
 * The mark on a 92-unit grid, taken from the tile the product draws in its own header:
 * a rounded square, two bars the full width of the block, a third that is shorter, and
 * the third in the accent. Everything is expressed as a fraction of the tile so one
 * description serves 180, 192 and 512 pixels.
 */
const TILE = 92;
const SHAPES = [
  { kind: 'tile', x: 0, y: 0, w: 92, h: 92, r: 24 },
  // The bar block spans 23.5 to 68.5 vertically, which centres it on the tile's own
  // midpoint (46) rather than on the first row: an icon is looked at as a shape, and a
  // block sitting two and a half units low reads as a mistake at 16 pixels.
  { kind: 'bar', x: 26, y: 23.5, w: 40, h: 9, r: 4.5, colour: BAR },
  { kind: 'bar', x: 26, y: 41.5, w: 40, h: 9, r: 4.5, colour: BAR },
  { kind: 'bar', x: 26, y: 59.5, w: 24, h: 9, r: 4.5, colour: ACCENT },
];

/** The mark occupies this share of the frame, leaving the margin a maskable icon needs. */
const MARK_SHARE = 0.78;

/**
 * A point is inside a rounded rectangle when it is within the radius of the clamped
 * centre point: in the straight middle the clamp is the point itself, so the distance
 * is zero, and past a corner it measures from that corner's circle.
 */
const insideRounded = (px, py, x, y, w, h, r) => {
  if (px < x || py < y || px > x + w || py > y + h) return false;
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
};

/** Draw one size, supersampled, as straight RGBA. */
function draw(size) {
  const side = size * MARK_SHARE;
  const k = side / TILE;
  const ox = (size - side) / 2;
  const oy = (size - side) / 2;
  const pixels = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let groundHits = 0;
      let barHits = 0;
      let accentHits = 0;
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const px = (x + (sx + 0.5) / SAMPLES - ox) / k;
          const py = (y + (sy + 0.5) / SAMPLES - oy) / k;
          for (const shape of SHAPES) {
            if (!insideRounded(px, py, shape.x, shape.y, shape.w, shape.h, shape.r)) continue;
            if (shape.kind === 'tile') groundHits += 1;
            else if (shape.colour === ACCENT) accentHits += 1;
            else barHits += 1;
          }
        }
      }
      const total = SAMPLES * SAMPLES;
      // Bars are drawn last, so where a bar meets the tile the bar wins — as it does
      // in the drawn mark, where the bars sit on top of the tile.
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      const weights = [
        [groundHits, GROUND],
        [barHits, BAR],
        [accentHits, ACCENT],
      ];
      for (const [hits, colour] of weights) {
        if (hits === 0) continue;
        const cover = hits / total;
        // Composite in order: each later shape paints over what is already there.
        r = colour[0] * cover + r * (1 - cover);
        g = colour[1] * cover + g * (1 - cover);
        b = colour[2] * cover + b * (1 - cover);
        a = cover + a * (1 - cover);
      }
      const offset = (y * size + x) * 4;
      // Straight (not premultiplied) alpha, which is what PNG stores: the colour of a
      // partly covered edge pixel is the shape's own colour, so an edge of the tile
      // stays the tile's colour at 60 % opacity instead of turning into a dark fringe.
      pixels[offset] = a > 0 ? Math.round(r / a) : 0;
      pixels[offset + 1] = a > 0 ? Math.round(g / a) : 0;
      pixels[offset + 2] = a > 0 ? Math.round(b / a) : 0;
      pixels[offset + 3] = Math.round(a * 255);
    }
  }
  return pixels;
}

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

const crc32 = (buffer) => {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};

function encode(size) {
  const pixels = draw(size);
  // One filter byte per row, filter 0 (none): the image is flat and the encoder is not
  // a compressor, so there is nothing to gain from predicting and everything to lose in
  // bytes nobody reads.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT, { recursive: true });
for (const [file, size] of [
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['apple-touch-icon.png', 180],
]) {
  const png = encode(size);
  writeFileSync(join(OUT, file), png);
  console.log(`${file} — ${size}x${size}, ${png.length} bytes`);
}
