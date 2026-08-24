// Standalone check (2026-08-22, capture.js self-review follow-up): does the
// requestId-guarded listener in requestFrameFromRenderer() actually ignore a
// stale/mismatched reply rather than being silently consumed by it? Mirrors
// the exact onResult guard from capture.js — no renderer/getUserMedia
// involved, this tests only the IPC correlation logic itself, which is what
// changed.
//
// The scenario being reproduced: gesture A's request (id=1) is abandoned but
// its listener is still attached; gesture B's request (id=2) then starts and
// registers its own listener; A's stale reply arrives after both are
// listening. B's listener must NOT resolve with A's data.
//
// Run with: npx electron diagnostics/verify_capture_requestid.js

const { app, ipcMain } = require('electron');

function makeListener(requestId, label) {
  return new Promise((resolve) => {
    function onResult(_event, result) {
      if (result.requestId !== requestId) {
        console.log(`[${label}] saw requestId=${result.requestId}, mine is ${requestId} — ignored, still listening`);
        return;
      }
      ipcMain.removeListener('capture-result', onResult);
      console.log(`[${label}] matched requestId=${requestId} — resolved`);
      resolve(result);
    }
    ipcMain.on('capture-result', onResult);
  });
}

app.whenReady().then(async () => {
  // Both listeners registered BEFORE either reply arrives — this is the
  // exact risky window: a stale reply landing after a new gesture's own
  // listener already exists.
  const resultA = makeListener(1, 'A (stale/abandoned)');
  const resultB = makeListener(2, 'B (current)');

  console.log("Emitting A's stale reply (requestId=1) while both are listening...");
  ipcMain.emit('capture-result', {}, { requestId: 1, dataUrl: 'stale-A-data' });

  console.log("Emitting B's real reply (requestId=2)...");
  ipcMain.emit('capture-result', {}, { requestId: 2, dataUrl: 'real-B-data' });

  const [a, b] = await Promise.all([resultA, resultB]);
  console.log(`B resolved with: ${b.dataUrl} — PASS requires this to be "real-B-data", not "stale-A-data"`);
  console.log(`A resolved with: ${a.dataUrl} — confirms A's own listener wasn't dropped either, just correctly deferred to its own matching reply`);

  app.quit();
});
