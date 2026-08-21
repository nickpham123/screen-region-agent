const { contextBridge, ipcRenderer } = require('electron');

// First IPC surface in the project — kept deliberately small. The overlay
// renderer never touches ipcRenderer/Node directly (contextIsolation is on);
// this is the only bridge it gets.
contextBridge.exposeInMainWorld('overlayAPI', {
  onActivate: (callback) => ipcRenderer.on('activate', (event, point) => callback(point)),
  onCancelGesture: (callback) => ipcRenderer.on('cancel-gesture', () => callback()),
  finalizeSelection: (bbox) => ipcRenderer.send('selection-finalized', bbox),
  // Liveness ping from the held trigger key's auto-repeat, so the main
  // process's stuck-gesture watchdog can tell an active hold from a stuck one.
  gestureAlive: () => ipcRenderer.send('gesture-alive'),
  // Routes renderer-side logging to the main process terminal, where the
  // rest of the app's log output goes.
  debugLog: (msg) => ipcRenderer.send('debug-log', msg),
});
