// Traces the hand-drawn Vempify mark (a flat black shape on white) into clean
// SVG polygons. Dependency-free: node:zlib does the PNG inflate, everything
// else is done here.
//
// Why trace instead of embedding the PNG: the mark is the app icon at 16px and
// at 512px, and a 312x312 raster looks soft at both ends. The source is hard-
// edged flat colour, so a contour trace reproduces it exactly and scales.

import fs from 'node:fs';
import zlib from 'node:zlib';

// --- PNG decode ---------------------------------------------------------

function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  let palette = null, trns = null;

  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('interlaced PNG not supported');
    } else if (type === 'PLTE') palette = Buffer.from(data);
    else if (type === 'tRNS') trns = Buffer.from(data);
    else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`unsupported colour type ${colorType}`);

  const stride = width * channels;
  const out = Buffer.alloc(height * stride);

  // Undo the per-scanline filters (PNG spec 9.2).
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 0xff;
    }
  }

  // Collapse to a boolean "is this pixel part of the mark" grid. The drawing is
  // black on white, so luminance below the midpoint counts as ink. Fully
  // transparent pixels are background regardless of their colour.
  const ink = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * stride + x * channels;
      let r, g, b, a = 255;
      if (colorType === 3) {
        const idx = out[i];
        r = palette[idx * 3]; g = palette[idx * 3 + 1]; b = palette[idx * 3 + 2];
        if (trns && idx < trns.length) a = trns[idx];
      } else if (colorType === 0) { r = g = b = out[i]; }
      else if (colorType === 4) { r = g = b = out[i]; a = out[i + 1]; }
      else if (colorType === 2) { r = out[i]; g = out[i + 1]; b = out[i + 2]; }
      else { r = out[i]; g = out[i + 1]; b = out[i + 2]; a = out[i + 3]; }
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      ink[y * width + x] = a > 128 && lum < 128 ? 1 : 0;
    }
  }
  return { width, height, ink };
}

// --- contour trace ------------------------------------------------------

// Boundary extraction by edge cancellation.
//
// Every ink pixel contributes its four edges, wound clockwise. An edge shared
// by two ink pixels gets contributed twice in opposite directions, so simply
// skipping edges whose neighbour is also ink leaves exactly the outline. Those
// leftover edges then chain head-to-tail into closed loops. Outer boundaries
// and holes both fall out of this naturally, with opposite winding - which is
// why the SVG below fills with evenodd.
function traceLoops(ink, width, height) {
  const at = (x, y) => (x < 0 || y < 0 || x >= width || y >= height ? 0 : ink[y * width + x]);
  const key = (x, y) => y * (width + 1) + x;
  const edges = new Map();
  const addEdge = (sx, sy, ex, ey) => {
    const k = key(sx, sy);
    let list = edges.get(k);
    if (!list) edges.set(k, (list = []));
    list.push([ex, ey]);
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!at(x, y)) continue;
      if (!at(x, y - 1)) addEdge(x, y, x + 1, y);
      if (!at(x + 1, y)) addEdge(x + 1, y, x + 1, y + 1);
      if (!at(x, y + 1)) addEdge(x + 1, y + 1, x, y + 1);
      if (!at(x - 1, y)) addEdge(x, y + 1, x, y);
    }
  }

  const loops = [];
  for (const startKey of [...edges.keys()]) {
    while (edges.get(startKey)?.length) {
      const startX = startKey % (width + 1);
      const startY = (startKey - startX) / (width + 1);
      const pts = [];
      let cx = startX, cy = startY;
      let guard = 0;
      while (guard++ < width * height * 8) {
        const list = edges.get(key(cx, cy));
        if (!list || !list.length) break;
        const [nx, ny] = list.pop();
        pts.push([cx, cy]);
        cx = nx; cy = ny;
        if (cx === startX && cy === startY) break;
      }
      if (pts.length > 2) loops.push(pts);
    }
  }
  return loops;
}

// Drop points that sit on a straight run, so a long flat or 45-degree edge
// becomes two endpoints instead of hundreds of stair-steps.
function dropCollinear(pts) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[(i - 1 + pts.length) % pts.length];
    const c = pts[i];
    const n = pts[(i + 1) % pts.length];
    const cross = (c[0] - p[0]) * (n[1] - p[1]) - (c[1] - p[1]) * (n[0] - p[0]);
    if (cross !== 0) out.push(c);
  }
  return out;
}

// RDP on a *closed* ring. Feeding a ring straight into rdp() silently destroys
// it: the first and last point coincide, so the baseline has zero length, every
// perpendicular distance measures as 0, and the whole outline collapses to two
// points. Splitting the ring at its two most distant points gives each half a
// real baseline.
function rdpClosed(pts, eps) {
  if (pts.length < 4) return pts;
  let far = 0, fd = -1;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]);
    if (d > fd) { fd = d; far = i; }
  }
  const a = rdp(pts.slice(0, far + 1), eps);
  const b = rdp([...pts.slice(far), pts[0]], eps);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

// Ramer-Douglas-Peucker: straightens the residual 1px staircase that a diagonal
// drawn in Paint leaves behind, without rounding off real corners.
function rdp(pts, eps) {
  if (pts.length < 3) return pts;
  let maxD = 0, idx = 0;
  const [ax, ay] = pts[0], [bx, by] = pts[pts.length - 1];
  const dx = bx - ax, dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / len;
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD <= eps) return [pts[0], pts[pts.length - 1]];
  return [...rdp(pts.slice(0, idx + 1), eps).slice(0, -1), ...rdp(pts.slice(idx), eps)];
}

export { decodePNG, traceLoops, dropCollinear, rdp, rdpClosed };

// --- main ---------------------------------------------------------------

// Only run the CLI when invoked directly, so the decoder above can be imported
// by the icon builder and the trace verifier without side effects.
const invokedDirectly = (process.argv[1] || '').replace(/\\/g, '/').endsWith('tools/trace-logo.mjs');
const [, , inPath, outPath, epsArg] = process.argv;
const EPS = epsArg ? Number(epsArg) : 1.0;
if (!invokedDirectly) {
  // imported as a library
} else if (!inPath || !outPath) {
  console.error('usage: node tools/trace-logo.mjs <input.png> <output.svg>');
  process.exit(1);
} else {

const { width, height, ink } = decodePNG(fs.readFileSync(inPath));

// Tight crop to the drawn mark, so the SVG viewBox hugs the artwork and the
// logo can be centred by whatever places it.
let minX = width, minY = height, maxX = -1, maxY = -1;
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    if (ink[y * width + x]) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
}
if (maxX < 0) throw new Error('no ink found - is the image blank?');

const polys = [];
for (const raw of traceLoops(ink, width, height)) {
  let pts = dropCollinear(raw);
  if (pts.length < 3) continue;
  pts = rdpClosed(pts, EPS);
  if (pts.length < 3) continue;
  // Ignore stray specks (a slipped pixel or a stray click in Paint).
  const area = Math.abs(pts.reduce((a, p, i) => {
    const q = pts[(i + 1) % pts.length];
    return a + (p[0] * q[1] - q[0] * p[1]);
  }, 0) / 2);
  if (area < 40) continue;
  polys.push(pts);
}

const w = maxX - minX + 1;
const h = maxY - minY + 1;
// One path with evenodd so any enclosed counter reads as a hole rather than
// being painted over by the shape that contains it.
const d = polys.map((p) =>
  'M' + p.map(([x, y]) => `${+(x - minX).toFixed(1)},${+(y - minY).toFixed(1)}`).join('L') + 'Z'
).join('');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" fill="currentColor" fill-rule="evenodd" role="img" aria-label="Vempify">
  <path d="${d}"/>
</svg>
`;
fs.writeFileSync(outPath, svg);
console.log(`traced ${polys.length} shape(s), ${polys.reduce((a, p) => a + p.length, 0)} points -> ${outPath} (viewBox ${w}x${h})`);
}
