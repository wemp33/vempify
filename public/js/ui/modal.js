// Dismissal and exit motion for every panel in the app.
//
// Each panel module builds its own card - they have nothing in common inside -
// but they all wrap it in a .modal-backdrop, and they all have to answer the
// same two questions the same way: how does a tap outside close this, and how
// does it leave the screen. Both answers live here so a fix lands once.
//
// ---------------------------------------------------------------------------
// Why the old outside-tap did not work
//
// Every panel used to close with:
//
//     backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
//
// which is correct as far as the DOM is concerned, and works with a mouse.
// It does nothing on the phone, and the reason is Safari, not the listener:
// iOS only synthesises a click for a tap on an element it treats as clickable
// - a link, a form control, an element carrying an onclick ATTRIBUTE, or one
// with cursor:pointer. A plain <div> that merely had a listener added from
// script is none of those, so the tap produced touchstart/touchend and the
// click never arrived. Every other tap target in this app is a real <button>,
// which is why the dim backdrop was the only dead one.
//
// So the fix is not a second listener on top of the click - it is to stop
// depending on a synthesised click at all. Pointer events are delivered by
// hit-testing, to any element, clickable or not, on every engine the app runs
// on. Requiring the press to BEGIN and END on the backdrop also buys two
// things the old handler got wrong:
//
//   * a drag that starts inside the card and releases over the dim area no
//     longer counts as "tapped outside" (the old click fired on the nearest
//     common ancestor - the backdrop - and dismissed the panel);
//   * the stray tap-through that can follow the swipe which OPENS the picker
//     has no matching pointerdown on the backdrop, so it is ignored instead of
//     shutting the panel again the instant it appears.
//
// app.css also sets cursor:pointer on .modal-backdrop, which puts Safari's own
// heuristic back on side and tells a desktop user the area is live.

// Must stay in step with --t-panel in app.css.
const EXIT_MS = 180;

// Slack for the frame the animation is scheduled on. This timer is a
// guarantee, not the normal path: if animationend never fires - the tab was
// backgrounded mid-close, the node was display:none'd, an engine skipped the
// event - a panel left in #modal-root would block every later panel, because
// main.js opens nothing while that container has a child.
const EXIT_GUARD_MS = EXIT_MS + 140;

export function prefersReducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    // matchMedia is missing or throwing (very old engines, some privacy
    // modes). Motion is the safe default here - the app has always animated.
    return false;
  }
}

// Animate `backdrop` out, then take it out of the DOM and call `onDone`.
// Idempotent: a second call while the first is still running is a no-op, so a
// double tap on Cancel cannot remove the node twice or fire onDone twice.
export function dismissModal(backdrop, onDone) {
  if (!backdrop || backdrop.dataset.closing === '1') return;
  backdrop.dataset.closing = '1';

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    backdrop.remove();
    if (typeof onDone === 'function') onDone();
  };

  if (prefersReducedMotion()) {
    finish();
    return;
  }

  backdrop.classList.add('is-closing');
  backdrop.addEventListener('animationend', (event) => {
    // The card animates too and its event bubbles through here; wait for the
    // backdrop's own fade, which is the one that ends last.
    if (event.target === backdrop) finish();
  });
  setTimeout(finish, EXIT_GUARD_MS);
}

// Close on a press that both starts and ends on the dim area, and on Escape.
// `close` is the panel's own teardown - this never removes anything itself.
export function bindDismiss(backdrop, close) {
  // The pointerId of a press that began on the backdrop, or null. Not a
  // boolean: a second finger landing on the card must not be able to complete
  // a dismissal the first one started.
  let pressId = null;

  backdrop.addEventListener('pointerdown', (event) => {
    pressId = event.target === backdrop ? event.pointerId : null;
  });

  backdrop.addEventListener('pointerup', (event) => {
    const startedOutside = pressId !== null && pressId === event.pointerId;
    pressId = null;
    if (startedOutside && event.target === backdrop) close();
  });

  // Scrolling taken over by the browser, the finger dragged off-screen, a
  // system gesture: the press is over and it was not a tap.
  backdrop.addEventListener('pointercancel', () => {
    pressId = null;
  });

  // Escape belongs to the topmost panel. The handler has to sit on the
  // document (the backdrop is not focusable), and it retires itself the first
  // time it runs after its panel has left the DOM, so a dismissed dialog never
  // leaves a live key handler behind.
  const onKeyDown = (event) => {
    if (!backdrop.isConnected) {
      document.removeEventListener('keydown', onKeyDown);
      return;
    }
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    document.removeEventListener('keydown', onKeyDown);
    close();
  };
  document.addEventListener('keydown', onKeyDown);
}
