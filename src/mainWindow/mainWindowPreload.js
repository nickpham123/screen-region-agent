const { contextBridge, ipcRenderer } = require('electron');

// Main App Window preload (system_design_plan.md §3.8). Phase 2.2 shipped
// this nearly empty (shell + navigation only, no real IPC surface yet).
// Phase 2.3 adds the Settings page's methods — Captures (2.4) will add its
// own conversations.jsonl-reading methods when that page is actually built,
// not ahead of time.
contextBridge.exposeInMainWorld('mainWindowAPI', {
  // Routes renderer-side logging to the main process terminal, same as
  // every other window's bridge here.
  debugLog: (msg) => ipcRenderer.send('debug-log', msg),

  // Settings (Phase 2.3) — plain send/on request-response, matching every
  // other window's IPC idiom in this codebase rather than introducing
  // invoke/handle as a second one.
  getSettings: () => ipcRenderer.send('settings-get'),
  onSettingsData: (callback) => ipcRenderer.on('settings-data', (event, settings) => callback(settings)),
  setDisplayName: (displayName) => ipcRenderer.send('settings-set-display-name', displayName),
  setTheme: (theme) => ipcRenderer.send('settings-set-theme', theme),
  setDictationLanguage: (lang) => ipcRenderer.send('settings-set-dictation-language', lang),

  // Hotkey test flow (decisions.md) — start arms a candidate accelerator via
  // a real gesture; results (armed/pass/too-small/timeout/already-in-use/
  // busy) arrive on the same 'hotkey-test-result' channel as they happen.
  startHotkeyTest: (accelerator, triggerKeyCode) => ipcRenderer.send('hotkey-test-start', { accelerator, triggerKeyCode }),
  cancelHotkeyTest: () => ipcRenderer.send('hotkey-test-cancel'),
  onHotkeyTestResult: (callback) => ipcRenderer.on('hotkey-test-result', (event, result) => callback(result)),
  saveHotkey: (accelerator, triggerKeyCode) => ipcRenderer.send('hotkey-save', { accelerator, triggerKeyCode }),

  // Data and privacy
  openDataFolder: () => ipcRenderer.send('data-open-folder'),
  clearAllData: () => ipcRenderer.send('data-clear-all'),
  onDataClearResult: (callback) => ipcRenderer.on('data-clear-result', (event, result) => callback(result)),
});
