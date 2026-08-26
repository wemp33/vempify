#!/usr/bin/env node
/**
 * make-icons.mjs - hand-written PNG encoder for the Vempify app icons.
 *
 * iOS ignores SVG for apple-touch-icon and browsers still want a raster
 * favicon, so real PNGs are required. This script rasterises the *actual*
 * traced mark from public/icons/icon.svg - never a re-drawn approximation -
 * and encodes it with nothing but node:zlib + node:fs. No image library, no
 * new npm dependency.
 *
 * Look: black mark (#000000) on a light purple tile (#c4b5fd), matching the
 * header and login-page treatment. The tile is not decoration - the mark is
 * black, so on the app's dark background it would otherwise be invisible.
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
import { parseRings } from './logo-raster.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ICON_DIR = path.join(__dirname, '..', 'public', 'icons');
const SVG_PATH = path.join(ICON_DIR, 'icon.svg');

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
 * Palette + layout
 * ------------------------------------------------------------------ */

const TILE = [0xc4, 0xb5, 0xfd]; // light purple background
const MARK = [0x00, 0x00, 0x00]; // black mark

const SAMPLES = 4; // 4x4 supersampling per output pixel

// The mark is 298x258 - wider than tall - so it is fitted by UNIFORM scale and
// letterboxed, never stretched. 12% margin per side normally; at favicon size
// that much padding shrinks the mark into mush, so 32px gets 6%.
function marginFor(size) {
  return size <= 32 ? 0.06 : 0.12;
}

/**
 * Rasterise the mark into a size x size RGB buffer.
 *
 * Coverage is computed exactly as a 4x4 point-sample grid per pixel would be
 * (identical even-odd test, identical sample positions), but evaluated one
 * sub-scanline at a time: the x-crossings of every edge at a given y are found
 * once, sorted, then swept across that row. Testing all 442 points per sample
 * would be ~1.9 billion edge tests at 512px; this is ~1 million.
 */
function renderIcon(size, rings, vbW, vbH) {
  const margin = marginFor(size);
  const inner = size * (1 - 2 * margin);
  const scale = Math.min(inner / vbW, inner / vbH); // uniform - no distortion
  const offsetX = (size - vbW * scale) / 2; // centred horizontally
  const offsetY = (size - vbH * scale) / 2; // and vertically

  const hits = new Uint16Array(size * size);
  const step = 1 / SAMPLES;
  const xs = [];

  for (let sy = 0; sy < size * SAMPLES; sy++) {
    const py = sy * step + step / 2; // device-space sample y
    const vy = (py - offsetY) / scale; // -> viewBox space

    xs.length = 0;
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        // Half-open y test, matching inRings() in logo-raster.mjs.
        if ((yi > vy) !== (yj > vy)) {
          xs.push(((xj - xi) * (vy - yi)) / (yj - yi) + xi);
        }
      }
    }
    if (xs.length === 0) continue;
    xs.sort((a, b) => a - b);

    const rowBase = Math.floor(sy / SAMPLES) * size;
    // Sub-samples march left to right, so one pointer walks the crossings.
    let p = 0;
    for (let sx = 0; sx < size * SAMPLES; sx++) {
      const px = sx * step + step / 2;
      const vx = (px - offsetX) / scale;
      // A crossing counts only if it is strictly to the right (inRings uses
      // `px < crossing`), so advance past everything at or before vx.
      while (p < xs.length && xs[p] <= vx) p++;
      if ((xs.length - p) & 1) hits[rowBase + Math.floor(sx / SAMPLES)]++;
    }
  }

  // Blend black over purple by coverage, in straight (non-premultiplied) RGB.
  const total = SAMPLES * SAMPLES;
  const rgb = new Uint8Array(size * size * 3);
  for (let i = 0; i < size * size; i++) {
    const coverage = hits[i] / total;
    const o = i * 3;
    rgb[o] = Math.round(TILE[0] + (MARK[0] - TILE[0]) * coverage);
    rgb[o + 1] = Math.round(TILE[1] + (MARK[1] - TILE[1]) * coverage);
    rgb[o + 2] = Math.round(TILE[2] + (MARK[2] - TILE[2]) * coverage);
  }
  return rgb;
}

/* ------------------------------------------------------------------ *
 * Emit + verify
 * ------------------------------------------------------------------ */

const SIZES = [32, 180, 192, 512];

const { rings, vbW, vbH } = parseRings(readFileSync(SVG_PATH, 'utf8'));
const points = rings.reduce((n, r) => n + r.length, 0);
console.log(`mark: ${SVG_PATH}  ${vbW}x${vbH}  ${rings.length} ring(s)  ${points} points`);

mkdirSync(ICON_DIR, { recursive: true });

let failed = false;

for (const size of SIZES) {
  const file = path.join(ICON_DIR, `icon-${size}.png`);
  writeFileSync(file, encodePng(size, size, renderIcon(size, rings, vbW, vbH)));

  // Verify what actually landed on disk.
  const bytes = readFileSync(file);
  const magicOk = bytes.subarray(0, 8).equals(PNG_SIGNATURE);
  const ihdrOk = bytes.subarray(12, 16).toString('latin1') === 'IHDR';
  const declaredWidth = bytes.readUInt32BE(16);
  const declaredHeight = bytes.readUInt32BE(20);
  const iendOk = bytes.subarray(bytes.length - 8, bytes.length - 4).toString('latin1') === 'IEND';
  const { size: byteLength } = statSync(file);
  const bigEnough = byteLength > 200;

  const ok =
    magicOk && ihdrOk && iendOk && bigEnough && declaredWidth === size && declaredHeight === size;
  if (!ok) failed = true;

  console.log(
    `${ok ? 'ok  ' : 'FAIL'} icons/icon-${size}.png  ${declaredWidth}x${declaredHeight}  ` +
      `${byteLength} bytes  magic=${magicOk} ihdr=${ihdrOk} iend=${iendOk}`
  );
}

if (failed) {
  console.error('One or more icons failed verification.');
  process.exit(1);
}

console.log(`Wrote ${SIZES.length} icons to ${ICON_DIR}`);
