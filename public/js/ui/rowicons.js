// The play triangle and the pause bars, in one place.
//
// The track row's leading button and the bottom bar's transport button show
// the same two glyphs, and they used to be drawn twice - once inline in
// index.html, once by hand in main.js. Two copies of the same geometry drift:
// one gets nudged, the other does not, and the row stops looking like the
// button it mirrors. Everything that needs either shape imports it from here.
//
// Both helpers return a FRESH element every call. An <svg> node can only live
// at one place in the document, so a shared singleton would silently teleport
// out of the previous row the moment a second row asked for it.
//
// Colour is never set here: the shapes carry .solid, and app.css paints
// .icon .solid with currentColor, so the icon simply takes the colour of the
// button it is dropped into (muted, --text on press, --accent-2 while that row
// is the playing one). The geometry below is character-for-character the same
// as the markup in index.html's #play-pause.

const SVG_NS = 'http://www.w3.org/2000/svg';

function iconSvg() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  return svg;
}

export function playIcon() {
  const svg = iconSvg();
  svg.classList.add('icon-play');

  const triangle = document.createElementNS(SVG_NS, 'polygon');
  triangle.setAttribute('class', 'solid');
  triangle.setAttribute('points', '7.5,5 19,12 7.5,19');
  svg.appendChild(triangle);

  return svg;
}

export function pauseIcon() {
  const svg = iconSvg();
  svg.classList.add('icon-pause');

  for (const x of ['7', '13.4']) {
    const bar = document.createElementNS(SVG_NS, 'rect');
    bar.setAttribute('class', 'solid');
    bar.setAttribute('x', x);
    bar.setAttribute('y', '5');
    bar.setAttribute('width', '3.6');
    bar.setAttribute('height', '14');
    bar.setAttribute('rx', '1.4');
    svg.appendChild(bar);
  }

  return svg;
}
