const badge = document.getElementById('badge');
const trailCanvas = document.getElementById('trail');
const trailCtx = trailCanvas.getContext('2d');
const resetFlashEl = document.getElementById('resetFlash');

// Minimum selection size (px) below which a release is ignored (see
// system_design_plan.md §7). Placeholder value, not tuned against real
// usage yet.
const MIN_SIZE = 5;

// Gates whether mousemove draws anything at all. Bootstrapped from the
// `activate` signal rather than a local keydown, because a key already
// physically down when this window gains focus generally won't fire a
// keydown here — only the eventual keyup reliably arrives (see
// decisions.md — this pattern recurs at Step 5's hold-to-talk).
let spaceHeld = false;

// Which key's keyup ends the gesture. Supplied by the main process on
// activation rather than hardcoded here — the accelerator and this value
// must agree, and keeping one source of truth avoids the two-file drift
// that bit us while iterating on accelerators.
let triggerKeyCode = null;

let tracking = false;
let lastX, lastY;
// Still computed continuously (feeds the final crop) even though it's no
// longer rendered — see decisions.md, "Live bounding-box preview... Superseded".
let minX, minY, maxX, maxY;

function resizeCanvas() {
  trailCanvas.width = window.innerWidth;
  trailCanvas.height = window.innerHeight;
}

// Re-anchors tracking to a fresh point, clearing the trail. Used both for
// the initial activation and for click-to-reset mid-gesture.
function resetTrackingPoints(x, y) {
  minX = maxX = lastX = x;
  minY = maxY = lastY = y;
  trailCtx.clearRect(0, 0, trailCanvas.width, trailCanvas.height);
}

function resetState(initialPoint) {
  tracking = false;
  resizeCanvas();
  resetTrackingPoints(initialPoint.x, initialPoint.y);

  // Restore the CSS-defined fade for this new gesture. The previous
  // gesture's keyup handler force-disables it for an instant (not faded)
  // hide before capture — undoing that here keeps this gesture's own
  // fade-on-movement behaving normally instead of silently regressing.
  badge.style.transition = '';
  badge.style.left = `${initialPoint.x}px`;
  badge.style.top = `${initialPoint.y}px`;
  badge.style.opacity = '1';
}

function drawTrailSegment(x, y) {
  trailCtx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
  trailCtx.lineWidth = 2;
  trailCtx.lineCap = 'round';
  trailCtx.beginPath();
  trailCtx.moveTo(lastX, lastY);
  trailCtx.lineTo(x, y);
  trailCtx.stroke();
}

function showResetFlash(x, y) {
  resetFlashEl.style.left = `${x}px`;
  resetFlashEl.style.top = `${y}px`;
  resetFlashEl.classList.remove('flash');
  void resetFlashEl.offsetWidth; // restart the CSS animation
  resetFlashEl.classList.add('flash');
}

// The first mousemove after activation is discarded — it carries a bogus
// position.
//
// Showing the overlay under the cursor makes Chromium emit a synthetic
// mousemove (~13-54ms after activation, on 24 of 24 instrumented
// activations). Measured 2026-08-21, that event's coordinates are wrong by a
// location-dependent few pixels, and it is the *only* event that is wrong:
// the activation point from the main process and every subsequent mousemove
// agree exactly, pixel for pixel, while this one sits off to the side. It is
// reproducible — repeated activations from one parked cursor produce the same
// wrong coordinate every time, so it is deterministic, not hand movement.
//
// Left untreated it drew a segment on every activation: a phantom trail at
// rest, a badge faded with no movement, and taps finalizing a bogus selection
// that cleared MIN_SIZE purely from the offset (one measured at 6x31px).
//
// Note the earlier attempt at this fix *anchored* on this event rather than
// discarding it, which moved the anchor onto the one bad coordinate and left
// a smaller trail drawn from bad->good. Discarding is correct precisely
// because the activation point is trustworthy and this event is not.
//
// Checked assumption — a genuine drag still starts exactly where the cursor
// is. The synthetic event fires long before any human reaction, so it is what
// gets discarded; real movement arrives later and draws from the activation
// point, which is correct. If that synthetic event ever fails to fire, the
// first *real* movement sample is discarded instead, costing one ~8ms sample.
// Invisible at ordinary speed, though during a fast flick (40px+ per sample
// was logged) it could shift a drag's visible start. Not observed; it is the
// first thing to check if a drag ever appears to begin late.
//
// Gated on *timing*, not just "the first event": on the very first activation
// the window is shown for the first time and appears to emit no synthetic
// mousemove at all, so discarding blindly ate the user's real first movement
// and drew a straight chord from the activation point to their second sample,
// skipping the curve between. Measured separation makes this easy to gate —
// synthetic events land 13-54ms after activation, while a human reacting to
// the overlay appearing and then moving cannot beat ~150ms. 100ms sits in
// that gap: late enough to catch every synthetic event observed, early enough
// that real movement is never discarded.
// Two events get consumed before drawing starts, for two different reasons.
//
// 1. `pendingSyntheticDiscard` — the synthetic mousemove described above,
//    thrown away entirely because its coordinates are wrong.
// 2. `awaitingAnchor` — the first *trustworthy* event, used to set the
//    drawing origin. The activation point cannot serve as that origin: it is
//    `getCursorScreenPoint()` sampled at hotkey-press time, and if the cursor
//    is still moving when the hotkey is pressed it is already stale by the
//    time drawing begins. Measured 2026-08-21: an activation point 29px away
//    from where the cursor actually was 29ms later, which drew a 29px line
//    the moment real movement began. This is why the artifact only ever
//    showed up on the first gesture — by the second the cursor is parked, so
//    the activation point happens to be accurate.
//
// The activation point is still used to position the badge, where being a few
// pixels stale doesn't matter.
let pendingSyntheticDiscard = false;
let awaitingAnchor = false;
let activationTime = 0;
const SYNTHETIC_MOVE_WINDOW_MS = 100;

window.overlayAPI.onActivate((point) => {
  resetState(point);
  triggerKeyCode = point.triggerKeyCode;
  spaceHeld = true;
  pendingSyntheticDiscard = true;
  awaitingAnchor = true;
  activationTime = performance.now();
});

// The main process force-closed a gesture that never resolved (safety net).
// Hiding the window there isn't enough on its own — without this, the
// renderer keeps spaceHeld true and holds the drawn trail, so the next
// mouse movement carries on drawing a gesture that's already over.
window.overlayAPI.onCancelGesture(() => {
  spaceHeld = false;
  tracking = false;
  badge.style.opacity = '0';
  trailCtx.clearRect(0, 0, trailCanvas.width, trailCanvas.height);
  window.overlayAPI.debugLog('gesture cancelled — renderer state reset');
});

document.addEventListener('keydown', (e) => {
  if (e.code !== triggerKeyCode) return;
  spaceHeld = true;
  // A held key auto-repeats keydowns (~80ms apart). Forwarding them is what
  // lets the main process tell "still drawing" apart from "gesture stuck",
  // so a long deliberate hold isn't force-closed mid-draw.
  window.overlayAPI.gestureAlive();
});

document.addEventListener('mousemove', (e) => {
  if (!spaceHeld) return;

  // Clamp to the overlay's own bounds (which match the display) — a
  // freeform path drifting past the screen edge shouldn't grow the bbox
  // past what's actually on screen (system_design_plan.md §7).
  const x = Math.min(Math.max(e.clientX, 0), window.innerWidth);
  const y = Math.min(Math.max(e.clientY, 0), window.innerHeight);

  // Discard the synthetic activation event — no draw, no `tracking` flip (so
  // the badge survives an activation with no real movement). Only events
  // inside the synthetic window qualify; anything later is real movement and
  // must be drawn. See the note on `awaitingAnchor`.
  // Throw away the synthetic activation event — bogus coordinates. Only
  // events inside the synthetic window qualify; if none arrives (seen on the
  // very first activation), the first real event falls through to anchoring
  // below instead, which is also correct.
  if (pendingSyntheticDiscard) {
    pendingSyntheticDiscard = false;
    if (performance.now() - activationTime < SYNTHETIC_MOVE_WINDOW_MS) return;
  }

  // First trustworthy event: it becomes the drawing origin. No draw, no
  // `tracking` flip, so the badge survives an activation with no movement.
  if (awaitingAnchor) {
    awaitingAnchor = false;
    resetTrackingPoints(x, y);
    return;
  }

  // Chromium emits repeat mousemoves at an unchanged position (common right
  // after activation). Stroking one is a zero-length path, which `lineCap:
  // round` renders as a 2px dot at the cursor — and it would fade the badge
  // on non-movement too. Exact equality, deliberately not a distance
  // threshold: a pixel that hasn't moved isn't movement, and real 1px drags
  // must still draw.
  if (x === lastX && y === lastY) return;

  if (!tracking) {
    tracking = true;
    badge.style.opacity = '0';
  }

  drawTrailSegment(x, y);
  lastX = x;
  lastY = y;

  minX = Math.min(minX, x);
  minY = Math.min(minY, y);
  maxX = Math.max(maxX, x);
  maxY = Math.max(maxY, y);
});

// Click-to-reset: a plain click while the hotkey is still held discards the
// current trail/bbox and starts fresh from the click point. Whatever's
// accumulated since the last reset (activation or most recent click) is
// what finalizes on key release.
document.addEventListener('click', (e) => {
  if (!spaceHeld) return;

  const x = Math.min(Math.max(e.clientX, 0), window.innerWidth);
  const y = Math.min(Math.max(e.clientY, 0), window.innerHeight);

  resetTrackingPoints(x, y);
  showResetFlash(x, y);
});

document.addEventListener('keyup', (e) => {
  if (e.code !== triggerKeyCode) return;
  spaceHeld = false;

  // Clear every piece of visible overlay content before finalizing, so a
  // capture that follows this can never bake in the trail/badge/reset-flash.
  // Deterministic (content-based), not a timing guess — see decisions.md for
  // why a guessed post-hide() settle delay was tried first and rejected.
  trailCtx.clearRect(0, 0, trailCanvas.width, trailCanvas.height);
  // #badge has a CSS `transition: opacity 0.15s ease` (overlay.html) — setting
  // opacity alone would start a 150ms fade, not an instant hide. Disabling
  // the transition first makes the disappearance immediate.
  badge.style.transition = 'none';
  badge.style.opacity = '0';
  // #resetFlash has no `transition` of its own — its fade is a `.flash`
  // class `animation`, which stops immediately when the class is removed, no
  // disable-first trick needed. Zeroing opacity too is belt-and-suspenders,
  // not load-bearing.
  resetFlashEl.classList.remove('flash');
  resetFlashEl.style.opacity = '0';

  const width = maxX - minX;
  const height = maxY - minY;

  if (width < MIN_SIZE || height < MIN_SIZE) {
    window.overlayAPI.finalizeSelection(null);
    return;
  }

  window.overlayAPI.finalizeSelection({ x: minX, y: minY, width, height });
});

// Step 4: main hands us a desktopCapturer source id it has already matched
// to the right display (see capture.js) and asks for one raw frame. This
// side does no geometry math — just capture, draw, hand back a data URL.
//
// Dimensions come from the video element's own videoWidth/videoHeight, never
// from track.getSettings() — measured 2026-08-22 to return stale dimensions
// (the previous capture's) on the second getUserMedia() call in a renderer
// session, which this app's long-lived overlay renderer will hit across
// gestures. See decisions.md.
window.overlayAPI.onCaptureRequest(async ({ sourceId }) => {
  let track;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId,
        },
      },
    });
    track = stream.getVideoTracks()[0];

    const video = document.createElement('video');
    video.srcObject = stream;
    await new Promise((resolve) => { video.onloadedmetadata = resolve; });
    await video.play();
    // Let the decoder produce a real frame before drawing — same reasoning
    // as diagnostics/verify_capture_renderer.js.
    await new Promise((resolve) => setTimeout(resolve, 150));

    const width = video.videoWidth;
    const height = video.videoHeight;

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(video, 0, 0, width, height);

    window.overlayAPI.captureResult({ dataUrl: canvas.toDataURL('image/png') });
  } catch (err) {
    window.overlayAPI.captureResult({ error: err.message || String(err) });
  } finally {
    if (track) track.stop();
  }
});
