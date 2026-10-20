// Probe only the shared-browser implementation against an isolated localhost page.
const { app, BrowserWindow, WebContentsView } = require('electron');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const output = path.resolve(__dirname, '../../Workspace/qa-browser-read-probe');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile-' + process.pid));
app.setPath('sessionData', app.getPath('userData'));
const bounded = (operation, label) => Promise.race([
  operation.then(value => ({ label, value })),
  new Promise(resolve => setTimeout(() => resolve({ label, timedOut: true }), 700))
]);
app.whenReady().then(async () => {
  const server = http.createServer((request, response) => {
    if (request.url === '/pending-image') return;
    response.setHeader('Content-Type', 'text/html');
    response.end('<title>Still loading fixture</title><h1>The page text is ready</h1><img src="/pending-image">');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const window = new BrowserWindow({ show: false });
  const view = new WebContentsView({ webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  const wc = view.webContents;
  const ready = new Promise(resolve => wc.once('dom-ready', resolve));
  wc.loadURL('http://127.0.0.1:' + server.address().port + '/').catch(() => {});
  try {
    await ready;
    const report = { scope: 'Isolated synthetic localhost page; no remote browsing or accounts.', loading: wc.isLoading() };
    report.webContents = await bounded(wc.executeJavaScript('document.body.innerText'), 'webContents');
    report.mainFrame = await bounded(wc.mainFrame.executeJavaScript('document.body.innerText'), 'mainFrame');
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    if (report.mainFrame.timedOut) process.exitCode = 1;
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { wc.close(); window.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); app.exit(process.exitCode || 0); }
}).catch(error => { console.error(error); app.exit(1); });
