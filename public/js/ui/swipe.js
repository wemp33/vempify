// Horizontal swipe detection for one track row. Vertical scrolling must keep
// working, so the gesture is only claimed once horizontal intent is clear
// (|dx| > 12 and |dx| > |dy|); until then every event is left alone and the
// stylesheet's touch-action: pan-y lets iOS scroll the list normally. All
// listeners are passive - we never preventDefault on move.

const CLAIM_DISTANCE = 12;
const MAX_DRAG = 90;
const PASSIVE = { passive: true };

export function attachSwipe(element, { onLeft, onRight, threshold = 56 } = {}) {
  let pointerId = null;
  let startX = 0;
  let startY = 0;
  let claimed = false;
  let lastDx = 0;

  function setTranslate(dx) {
    element.style.transition = 'none';
    element.style.transform = dx ? `translateX(${dx}px)` : '';
  }

  // Animate the row back to rest, then drop the inline styles so the
  // stylesheet owns the element again.
  function settle() {
    element.style.transition = 'transform 180ms ease';
    element.style.transform = '';
    const clear = () => {
      element.style.transition = '';
      element.style.transform = '';
      element.removeEventListener('transitionend', clear);
    };
    element.addEventListener('transitionend', clear);
    // transitionend does not fire when the transform was already at rest.
    setTimeout(clear, 240);
  }

  // A completed swipe must not also count as a tap on the row, so trap the
  // click that follows the pointerup. If no click follows (iOS often skips it
  // after a drag), the trap removes itself shortly after.
  function suppressNextClick() {
    const block = (event) => {
      event.stopPropagation();
      event.preventDefault();
    };
    element.addEventListener('click', block, { capture: true, once: true });
    setTimeout(() => element.removeEventListener('click', block, { capture: true }), 350);
  }

  function reset() {
    pointerId = null;
    claimed = false;
    lastDx = 0;
  }

  function onPointerDown(event) {
    if (pointerId !== null) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    pointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    claimed = false;
    lastDx = 0;
  }

  function onPointerMove(event) {
    if (event.pointerId !== pointerId) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;

    if (!claimed) {
      if (Math.abs(dx) <= CLAIM_DISTANCE || Math.abs(dx) <= Math.abs(dy)) return;
      claimed = true;
      // Keep receiving moves even if the pointer wanders off the row.
      try {
        element.setPointerCapture(pointerId);
      } catch {
        /* capture is best-effort */
      }
    }

    lastDx = Math.max(-MAX_DRAG, Math.min(MAX_DRAG, dx));
    setTranslate(lastDx);
  }

  function onPointerEnd(event) {
    if (event.pointerId !== pointerId) return;
    const wasClaimed = claimed;
    const dx = lastDx;
    const cancelled = event.type === 'pointercancel';
    reset();

    if (!wasClaimed) return;

    try {
      element.releasePointerCapture(event.pointerId);
    } catch {
      /* already released */
    }

    suppressNextClick();

    // Exactly one callback per completed gesture; a cancelled pointer (the
    // browser took over for a scroll) fires neither.
    if (!cancelled) {
      if (dx >= threshold && typeof onRight === 'function') onRight();
      else if (dx <= -threshold && typeof onLeft === 'function') onLeft();
    }

    settle();
  }

  element.addEventListener('pointerdown', onPointerDown, PASSIVE);
  element.addEventListener('pointermove', onPointerMove, PASSIVE);
  element.addEventListener('pointerup', onPointerEnd, PASSIVE);
  element.addEventListener('pointercancel', onPointerEnd, PASSIVE);

  return function detach() {
    element.removeEventListener('pointerdown', onPointerDown, PASSIVE);
    element.removeEventListener('pointermove', onPointerMove, PASSIVE);
    element.removeEventListener('pointerup', onPointerEnd, PASSIVE);
    element.removeEventListener('pointercancel', onPointerEnd, PASSIVE);
    element.style.transition = '';
    element.style.transform = '';
    reset();
  };
}
