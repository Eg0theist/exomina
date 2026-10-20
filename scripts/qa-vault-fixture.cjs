const { app, BrowserWindow, WebContentsView, session, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const profile = path.resolve(process.env.EXOMINA_QA_VAULT_PROFILE);
app.setPath('userData', profile); app.setPath('sessionData', profile);
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 720, height: 540, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><title>Exomina encrypted-profile QA</title><h1>Synthetic encrypted app profile</h1>'));
  const browserSession = session.fromPartition('persist:synthetic-vault-browser');
  const browser = new WebContentsView({ webPreferences: { session: browserSession, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  window.contentView.addChildView(browser); browser.setBounds({ x: 0, y: 100, width: 600, height: 360 });
  await browser.webContents.loadURL(process.env.EXOMINA_QA_VAULT_URL);
  await browser.webContents.executeJavaScript("localStorage.setItem('synthetic','ENCRYPTED_PROFILE_STORAGE'); document.querySelector('input').value='Synthetic ä 中文.';");
  await browserSession.cookies.set({ url: process.env.EXOMINA_QA_VAULT_URL, name: 'synthetic-vault-cookie', value: 'synthetic-only', expirationDate: Math.floor(Date.now() / 1000) + 3600 });
  await browserSession.cookies.flushStore();
  const protectedBytes = safeStorage.encryptString('SYNTHETIC_DPAPI_SECRET'); fs.writeFileSync(path.join(profile, 'synthetic-dpapi.bin'), protectedBytes);
  globalThis.vaultQa = { ready: true, safeStorage: safeStorage.decryptString(protectedBytes) === 'SYNTHETIC_DPAPI_SECRET', mainSandbox: window.webContents.getLastWebPreferences().sandbox, browserSandbox: browser.webContents.getLastWebPreferences().sandbox, browserValue: await browser.webContents.executeJavaScript("document.querySelector('input').value"), cookieCount: (await browserSession.cookies.get({ url: process.env.EXOMINA_QA_VAULT_URL })).length };
}).catch(error => { process.stderr.write(String(error.stack)); app.exit(1); });
app.on('window-all-closed', () => app.quit());
