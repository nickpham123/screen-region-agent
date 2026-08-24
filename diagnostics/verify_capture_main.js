// Standalone Step 4 coordinate-verification script — NOT wired into the real
// app, and does not touch main.js/overlay.js/preload.js. Its only job is to
// measure, on every connected display, whether the assumptions the real
// captureRegion(bbox) (system_design_plan.md §3.3) would depend on actually
// hold on this machine, before any of that math gets written for real.
//
// Run with:
//   npx electron diagnostics/verify_capture_main.js
//
// What it checks, per display — logged, never assumed:
//   1. desktopCapturer source -> display mapping, via source.display_id,
//      not list order or "assume primary".
//   2. The exact getUserMedia constraints passed (logged verbatim) — proves
//      no implicit width/height/min/max is reshaping the frame.
//   3. Actual captured video dimensions: track.getSettings() AND
//      video.videoWidth/videoHeight, cross-checked against each other.
//   4. Canvas dimensions, sized ONLY from the video track's own reported
//      size — never recomputed from display.bounds independently (that
//      "two independently-computed sizes" shape of bug is what caused the
//      Step 3 activation-trail coordinate mismatch).
//   5. Actual video dimensions vs. display.bounds * display.scaleFactor —
//      the formula the real crop math in captureRegion() would use.
//
// This produces a cropped canvas frame but never saves it — it's a
// measurement tool, not the real crop path.

const { app, BrowserWindow, ipcMain, desktopCapturer, screen } = require('electron');
const path = require('path');

function log(...args) {
  console.log(...args);
}

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 480,
    height: 320,
    webPreferences: {
      preload: path.join(__dirname, 'verify_capture_preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'verify_capture.html'));

  ipcMain.handle('get-displays-and-sources', async () => {
    const displays = screen.getAllDisplays().map(d => ({
      id: d.id,
      bounds: d.bounds,
      scaleFactor: d.scaleFactor,
    }));

    let sources = [];
    try {
      sources = await desktopCapturer.getSources({ types: ['screen'] });
    } catch (err) {
      log('[main] desktopCapturer.getSources() threw:', err);
      return { displays, sources: [], error: String(err) };
    }

    if (sources.length === 0) {
      log('[main] desktopCapturer.getSources() returned zero sources.');
      log('[main] Likely cause: Screen Recording permission not granted yet.');
      log('[main] Check: System Settings > Privacy & Security > Screen Recording.');
    }

    log('[main] Displays:', JSON.stringify(displays, null, 2));
    log('[main] All screen sources reported by desktopCapturer:');
    sources.forEach(s =>
      log(`  id=${s.id}  display_id=${JSON.stringify(s.display_id)}  name=${s.name}`)
    );

    return {
      displays,
      sources: sources.map(s => ({ id: s.id, name: s.name, display_id: s.display_id })),
    };
  });

  ipcMain.on('log', (_event, ...args) => {
    log('[renderer]', ...args);
  });

  ipcMain.on('quit', () => {
    // Small delay so the last log line is flushed before the process exits.
    setTimeout(() => app.quit(), 200);
  });
});

app.on('window-all-closed', () => app.quit());
