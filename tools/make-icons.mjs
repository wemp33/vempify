#!/usr/bin/env node
/**
 * make-icons.mjs - hand-written PNG encoder for the Vempify app icons.
 *
 * iOS ignores SVG for apple-touch-icon, so real rasters are required. This
 * script rasterises the same geometric "V" mark used in public/icons/icon.svg
 * and encodes it as PNG using nothing but node:zlib + node:fs - no image
 * library, no new npm dependency.
 *
 * PNG structure produced here:
 *   signature | IHDR | IDAT | IEND
 *   colour type 2 (truecolour RGB, 8 bit), filter 0 on every scanline,
 *   IDAT payload = zlib stream (deflateSync already emits the zlib wrapper
 *   that PNG requires - raw deflate would be invalid).
 *
 * Usage: node tools/make-icons.mjs
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync, statSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ICON_DIR = path.join(__dirname, '..', 'public', 'icons');

/* ------------------------------------------------------------------ *
 * CRC-32 (PNG uses the standard IEEE 802.3 polynomial, reflected 0xEDB88320)
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/* ------------------------------------------------------------------ *
 * PNG chunk assembly
 * ------------------------------------------------------------------ */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'latin1');
  const body = Buffer.concat([typeBuf, data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

/**
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} rgb - width*height*3 bytes, no filter bytes
 */
function encodePng(width, height, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(2, 9); // colour type 2 = truecolour RGB
  ihdr.writeUInt8(0, 10); // compression: deflate
  ihdr.writeUInt8(0, 11); // filter method 0
  ihdr.writeUInt8(0, 12); // no interlace

  // Raw scanlines: one leading filter byte (0 = None) per row.
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * stride, stride).copy(raw, rowStart + 1);
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ *
 * The mark - geometry copied from public/icons/icon.svg (512 unit canvas)
 * ------------------------------------------------------------------ */

const CANVAS = 512;
const STROKE_HALF = 23; // icon.svg stroke-width 46, round caps
const STROKES = [
  [61, 41, 256, 399],
  [451, 41, 256, 399],
];
// The foot. Its apex sits at y=370, below y~362 where the two strokes have
// fully merged - any higher and a dark notch opens up between them.
const TRIANGLE = [
  [256, 370],
  [205, 461],
  [307, 461],
];

// iOS masks the touch icon with a squircle, so the mark is scaled down and
// recentred on its own bounding box (y 18..461 -> centre 239.5) to keep the
// stroke caps clear of the clipped corners. icon.svg applies the same
// transform so all three renderings stay identical.
const MARK_SCALE = 0.78;
const MARK_CENTER_Y = 239.5;

// Palette (must match the CSS custom properties in public/app.css).
const BG = [0x0b, 0x0b, 0x0f]; // --bg
const ACCENT_TOP = [0xc0, 0x84, 0xfc]; // --accent-2
const ACCENT_BOTTOM = [0x8b, 0x5c, 0xf6]; // --accent

const SAMPLES = 4; // 4x4 supersampling per pixel

function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  let t = lengthSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lengthSq;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function insideTriangle(px, py) {
  const [[ax, ay], [bx, by], [cx, cy]] = TRIANGLE;
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

/**
 * Is this canvas point part of the V mark? The point is first mapped back
 * into the mark's own 512-space (undoing MARK_SCALE / recentring).
 */
function inMark(canvasX, canvasY) {
  const x = (canvasX - CANVAS / 2) / MARK_SCALE + CANVAS / 2;
  const y = (canvasY - CANVAS / 2) / MARK_SCALE + MARK_CENTER_Y;

  for (const [ax, ay, bx, by] of STROKES) {
    if (distanceToSegment(x, y, ax, ay, bx, by) <= STROKE_HALF) return true;
  }
  return insideTriangle(x, y);
}

function markColorAt(y512) {
  // Vertical gradient: --accent-2 at the top, --accent at the foot.
  const t = Math.min(1, Math.max(0, y512 / CANVAS));
  return [
    Math.round(ACCENT_TOP[0] + (ACCENT_BOTTOM[0] - ACCENT_TOP[0]) * t),
    Math.round(ACCENT_TOP[1] + (ACCENT_BOTTOM[1] - ACCENT_TOP[1]) * t),
    Math.round(ACCENT_TOP[2] + (ACCENT_BOTTOM[2] - ACCENT_TOP[2]) * t),
  ];
}

function renderIcon(size) {
  const rgb = new Uint8Array(size * size * 3);
  const scale = CANVAS / size; // pixel -> 512-space
  const step = 1 / SAMPLES;
  const totalSamples = SAMPLES * SAMPLES;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let hits = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = (px + (sx + 0.5) * step) * scale;
          const y = (py + (sy + 0.5) * step) * scale;
          if (inMark(x, y)) hits++;
        }
      }

      const offset = (py * size + px) * 3;
      if (hits === 0) {
        rgb[offset] = BG[0];
        rgb[offset + 1] = BG[1];
        rgb[offset + 2] = BG[2];
        continue;
      }

      const coverage = hits / totalSamples;
      const mark = markColorAt((py + 0.5) * scale);
      rgb[offset] = Math.round(BG[0] + (mark[0] - BG[0]) * coverage);
      rgb[offset + 1] = Math.round(BG[1] + (mark[1] - BG[1]) * coverage);
      rgb[offset + 2] = Math.round(BG[2] + (mark[2] - BG[2]) * coverage);
    }
  }

  return rgb;
}

/* ------------------------------------------------------------------ *
 * Emit + verify
 * ------------------------------------------------------------------ */

const SIZES = [180, 192, 512];

mkdirSync(ICON_DIR, { recursive: true });

let failed = false;

for (const size of SIZES) {
  const file = path.join(ICON_DIR, `icon-${size}.png`);
  writeFileSync(file, encodePng(size, size, renderIcon(size)));

  // Verify what actually landed on disk.
  const bytes = readFileSync(file);
  const magicOk = bytes.subarray(0, 8).equals(PNG_SIGNATURE);
  const ihdrOk = bytes.subarray(12, 16).toString('latin1') === 'IHDR';
  const declaredWidth = bytes.readUInt32BE(16);
  const declaredHeight = bytes.readUInt32BE(20);
  const iendOk = bytes.subarray(bytes.length - 8, bytes.length - 4).toString('latin1') === 'IEND';
  const { size: byteLength } = statSync(file);
  const bigEnough = byteLength > 500;

  const ok =
    magicOk && ihdrOk && iendOk && bigEnough && declaredWidth === size && declaredHeight === size;
  if (!ok) failed = true;

  console.log(
    `${ok ? 'ok  ' : 'FAIL'} icons/icon-${size}.png  ${byteLength} bytes  ` +
      `${declaredWidth}x${declaredHeight}  magic=${magicOk} ihdr=${ihdrOk} iend=${iendOk}`
  );
}

if (failed) {
  console.error('One or more icons failed verification.');
  process.exit(1);
}

console.log(`Wrote ${SIZES.length} icons to ${ICON_DIR}`);
