// Screen Capture component (system_design_plan.md §3.3).
//
//   captureRegion(bbox, displayId) -> { cropPath, fullPath }
//
// bbox is in the overlay's own logical/DIP coordinates — relative to
// whichever display it was drawn on (overlay.js clamps mousemove to
// window.innerWidth/innerHeight, and the overlay window is sized to exactly
// that display's bounds). desktopCapturer's real frames come back at that
// display's physical/backing resolution. Verified 2026-08-22
// (diagnostics/verify_capture_*.js) on both a 2x built-in and a 1x external
// display: actual captured size == display.bounds * display.scaleFactor,
// exactly. All conversion from logical bbox to physical crop rect happens
// HERE, once — this is the only place in the app that does this math.
//
// getUserMedia() is a renderer-only Web API, not available in the main
// process — so this module sends a request to the already-open overlay
// window's renderer and waits for one reply. The renderer's only job is
// handing back the raw captured frame; it does no geometry math at all.
// Which display, which source, and where to crop are all decided here, not
// duplicated in renderer code — see decisions.md on avoiding two
// independently-computed answers to the same question.
//
// Dimensions come from the renderer's own video.videoWidth/videoHeight,
// never from track.getSettings() — measured 2026-08-22 to return stale
// (previous-capture) dimensions on the second getUserMedia() call in a
// renderer session. That's not a diagnostic-script-only quirk: this app
// reuses one overlay renderer across every gesture, so any second-or-later
// capture in a run hits the same shape. See decisions.md.

const { screen, systemPreferences, desktopCapturer, app, ipcMain, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const CAPTURE_TIMEOUT_MS = 5000;

// Tags each capture-request/capture-result round trip so a late reply from
// an abandoned request can never be mistaken for a different, later
// request's own result — see requestFrameFromRenderer() below.
let nextCaptureRequestId = 0;

function createCaptureRegion(overlayWindow) {
  return async function captureRegion(bbox, displayId) {
    const accessStatus = systemPreferences.getMediaAccessStatus('screen');
    if (accessStatus !== 'granted') {
      throw new Error(
        `Screen Recording permission not granted (status: ${accessStatus}). ` +
        `Grant it in System Settings > Privacy & Security > Screen Recording, then relaunch.`
      );
    }

    // Fresh geometry lookup keyed by the display identity already decided
    // at activation (screen.getDisplayNearestPoint, in main.js). Re-deriving
    // *which* display here too — e.g. from the cursor's position now — could
    // disagree with the display the user actually drew on if the cursor
    // moved after release. Only the geometry (bounds/scaleFactor) gets
    // re-read fresh; it is never cached, since this session measured a
    // display's reported bounds changing across app restarts (decisions.md).
    const display = screen.getAllDisplays().find((d) => d.id === displayId);
    if (!display) {
      throw new Error(`No display found for displayId=${displayId}`);
    }

    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    const source = sources.find((s) => s.display_id === String(displayId));
    if (!source) {
      throw new Error(
        `No desktopCapturer source matched displayId=${displayId}. Sources: ` +
        JSON.stringify(sources.map((s) => ({ id: s.id, display_id: s.display_id })))
      );
    }

    const frameDataUrl = await requestFrameFromRenderer(overlayWindow, source.id);
    const fullImage = nativeImage.createFromDataURL(frameDataUrl);

    // Verified formula (2026-08-22): bounds * scaleFactor == actual captured
    // size, on both a 2x and a 1x display. Rounded to integers —
    // nativeImage.crop() requires them. Edges (x, x+width) are rounded
    // independently rather than x/width separately, so rounding error can't
    // accumulate on the far edge — doesn't matter for the integer
    // scaleFactors measured so far (2 and 1), but costs nothing and removes
    // the risk outright for any future fractional scaleFactor.
    const left = Math.round(bbox.x * display.scaleFactor);
    const top = Math.round(bbox.y * display.scaleFactor);
    const cropRect = {
      x: left,
      y: top,
      width: Math.round((bbox.x + bbox.width) * display.scaleFactor) - left,
      height: Math.round((bbox.y + bbox.height) * display.scaleFactor) - top,
    };
    const cropImage = fullImage.crop(cropRect);

    const stamp = Date.now();
    const tempDir = app.getPath('temp');
    const fullPath = path.join(tempDir, `screen-region-full-${stamp}.png`);
    const cropPath = path.join(tempDir, `screen-region-crop-${stamp}.png`);

    fs.writeFileSync(fullPath, fullImage.toPNG());
    fs.writeFileSync(cropPath, cropImage.toPNG());

    return { cropPath, fullPath };
  };
}

// Sends one capture request to the overlay's renderer and resolves with its
// reply (or rejects on error/timeout).
//
// Normally sequential — the hotkey stays unregistered until this resolves
// (see main.js) — but main.js's CAPTURE_OVERALL_TIMEOUT_MS can abandon a
// call while this renderer round-trip is still genuinely in flight (found
// during Step 4 self-review, 2026-08-22). If a new gesture then starts and
// calls this again before the abandoned request's late reply arrives, a
// plain 'capture-result' listener has no way to tell the two apart — it
// would silently resolve the new gesture's promise with the OLD gesture's
// stale frame. requestId closes that regardless of timing: each request is
// tagged, the renderer echoes it back, and a reply that doesn't match the id
// this call is waiting for is ignored rather than consumed.
//
// This can't use ipcMain.once(): a .once() listener unregisters itself on
// the FIRST event it receives whether or not the id matches, which would
// silently orphan the real reply behind a stale one. Uses ipcMain.on()
// instead, removed manually only once a matching id is actually seen.
function requestFrameFromRenderer(overlayWindow, sourceId) {
  const requestId = ++nextCaptureRequestId;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ipcMain.removeListener('capture-result', onResult);
      reject(new Error('Timed out waiting for the renderer to capture a frame.'));
    }, CAPTURE_TIMEOUT_MS);

    function onResult(_event, result) {
      if (result.requestId !== requestId) return; // stale reply for an earlier, abandoned request
      clearTimeout(timer);
      ipcMain.removeListener('capture-result', onResult);
      if (result.error) {
        reject(new Error(result.error));
      } else {
        resolve(result.dataUrl);
      }
    }

    ipcMain.on('capture-result', onResult);
    overlayWindow.webContents.send('capture-request', { sourceId, requestId });
  });
}

module.exports = { createCaptureRegion };
