// Shared geometry helpers for turning public/icons/icon.svg back into pixels.
//
// The traced mark is a single evenodd path made only of M/L/Z, so parsing it
// needs no general SVG path engine - splitting on the commands is exact. Both
// the trace verifier and the icon builder rasterise that same path, so the
// parse and the containment test live here rather than in either tool.
//
// PURE LIBRARY: no top-level side effects, no CLI, nothing read at import
// time. Importing this module must be free.

/**
 * Parse the traced logo SVG into polygon rings plus its viewBox size.
 * @param {string} svgText - contents of icon.svg
 * @returns {{ rings: number[][][], vbW: number, vbH: number }}
 */
export function parseRings(svgText) {
  const vb = svgText.match(/viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/);
  if (!vb) throw new Error('no viewBox');
  const d = svgText.match(/ d="([^"]+)"/);
  if (!d) throw new Error('no path data');
  const rings = d[1].split('M').filter(Boolean).map((chunk) =>
    chunk.replace(/Z\s*$/, '').split('L').map((pair) => pair.split(',').map(Number))
  );
  return { rings, vbW: Number(vb[1]), vbH: Number(vb[2]) };
}

// Even-odd containment: count crossings of a ray cast to the right.
export function inRings(rings, px, py) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
  }
  return inside;
}
