// Checks that the traced SVG actually reproduces the source drawing, by
// rasterising the vector back to a mask and comparing it against the source's
// own ink mask. Reports intersection-over-union plus where the two disagree.
//
// This exists because the trace is otherwise unverifiable without eyeballing
// it: a silently-wrong outline still produces a perfectly valid SVG file.

import fs from 'node:fs';
import { decodePNG } from './trace-logo.mjs';
import { parseRings, inRings } from './logo-raster.mjs';

const svgPath = process.argv[2];
const pngPath = process.argv[3];
if (!svgPath || !pngPath) {
  console.error('usage: node tools/verify-trace.mjs <traced.svg> <source.png>');
  process.exit(1);
}

const { rings, vbW, vbH } = parseRings(fs.readFileSync(svgPath, 'utf8'));
const { width, height, ink } = decodePNG(fs.readFileSync(pngPath));

// The SVG was cropped to the source's ink bounding box, so recover that offset
// to line the two masks up.
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

let both = 0, onlySrc = 0, onlySvg = 0;
for (let y = 0; y < vbH; y++) {
  for (let x = 0; x < vbW; x++) {
    const sx = x + minX, sy = y + minY;
    const srcInk = sx < width && sy < height ? ink[sy * width + sx] : 0;
    // Sample at the pixel centre.
    const svgInk = inRings(rings, x + 0.5, y + 0.5) ? 1 : 0;
    if (srcInk && svgInk) both++;
    else if (srcInk) onlySrc++;
    else if (svgInk) onlySvg++;
  }
}

const iou = both / (both + onlySrc + onlySvg);
console.log(`matched      : ${both}`);
console.log(`missing      : ${onlySrc}  (in drawing, not in trace)`);
console.log(`extra        : ${onlySvg}  (in trace, not in drawing)`);
console.log(`IoU          : ${(iou * 100).toFixed(3)}%`);
console.log(iou > 0.99 ? 'PASS - trace is faithful' : 'FAIL - trace does not match the drawing');
process.exit(iou > 0.99 ? 0 : 1);
