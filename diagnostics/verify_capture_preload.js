const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('verifyCapture', {
  getDisplaysAndSources: () => ipcRenderer.invoke('get-displays-and-sources'),
  log: (...args) => ipcRenderer.send('log', ...args),
  quit: () => ipcRenderer.send('quit'),
});
