// Design QA only: an Electron window on the Vite design preview (synthetic backend, no private data).
const { app, BrowserWindow } = require('electron');
app.commandLine.appendSwitch('mute-audio');
app.setPath('userData', require('node:path').join(process.env.EXOMINA_DESIGN_QA_DIR, 'profile'));
app.whenReady().then(() => { const win = new BrowserWindow({ width: 1360, height: 900, show: false, webPreferences: { contextIsolation: true, backgroundThrottling: false } }); win.loadURL(process.env.EXOMINA_DESIGN_QA_URL); });
