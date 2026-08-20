const { app, BrowserWindow, globalShortcut } = require('electron');

// TEMPORARY: standing in for the real overlay window until Step 3 adds
// the transparent, click-through BrowserWindow. The hotkey handler below
// just shows/focuses this window for now.
let win;

function createWindow() {
  win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile('index.html');
}

app.whenReady().then(() => {
  createWindow();

  globalShortcut.register('CommandOrControl+Shift+Space', () => {
    console.log('Hotkey pressed');
    win.show();
    win.focus();
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
