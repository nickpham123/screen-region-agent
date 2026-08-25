const { contextBridge, ipcRenderer } = require('electron');

// Main App Window preload (system_design_plan.md §3.8). Phase 2.2 is shell +
// navigation only, so this bridge starts nearly empty — same contextIsolation
// posture as every other window here, but no real IPC surface exists to
// expose yet. Real methods (reading conversations.jsonl for Captures,
// settings.js for Settings) get added as 2.3–2.5 actually need them, not
// ahead of time.
contextBridge.exposeInMainWorld('mainWindowAPI', {
  // Routes renderer-side logging to the main process terminal, same as
  // every other window's bridge here.
  debugLog: (msg) => ipcRenderer.send('debug-log', msg),
});
