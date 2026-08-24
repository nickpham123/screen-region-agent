// Standalone check (2026-08-22 self-review): does re-triggering #resetFlash's
// `.flash` animation override a stale inline `opacity: 0` left behind by
// overlay.js's keyup cleanup, or does the inline style win and the flash cue
// silently stop animating on a later gesture? Reasoned in decisions.md that
// CSS animations take cascade priority over a plain inline style while
// running — this measures it instead of leaving it assumed.
//
// Run with: npx electron diagnostics/verify_resetflash_main.js

const { app, BrowserWindow } = require('electron');
const path = require('path');

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 300,
    height: 200,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  win.webContents.on('console-message', (_event, _level, message) => {
    console.log('[renderer]', message);
  });

  win.loadFile(path.join(__dirname, 'verify_resetflash.html'));

  setTimeout(() => app.quit(), 1500);
});
