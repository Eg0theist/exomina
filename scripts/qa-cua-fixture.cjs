const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const profile = path.resolve(__dirname, '../../qa-cua-profile');
fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
app.setPath('sessionData', profile);

app.whenReady().then(async () => {
  app.setAccessibilitySupportEnabled(true);
  const title = 'Exomina CUA QA fixture';
  const fixture = new BrowserWindow({
    title, width: 640, height: 420, show: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  fixture.setMenu(null);
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
    <style>body{font:18px system-ui;background:#12121a;color:#f4f3ff;padding:32px}input,button{display:block;font:inherit;padding:12px;margin:18px 0;width:450px;box-sizing:border-box}button{background:#a998ff;border:0;border-radius:8px}input{background:#20202b;color:white;border:1px solid #888;border-radius:6px}</style>
    </head><body><h1>Computer-use test fixture</h1><p>This window contains synthetic test data only.</p>
    <label for="cua-field">CUA test field</label><input id="cua-field" aria-label="CUA test field" autocomplete="off">
    <button id="cua-apply">Apply CUA test</button><p id="cua-status" role="status">Waiting for the synthetic test.</p>
    <script>window.fixtureEvents=[];for(const event of ['keydown','beforeinput','input'])document.getElementById('cua-field').addEventListener(event,e=>window.fixtureEvents.push({event:e.type,key:e.key,code:e.code,data:e.data,inputType:e.inputType,ctrl:e.ctrlKey,alt:e.altKey,value:e.target.value}));document.getElementById('cua-apply').addEventListener('click',()=>{document.getElementById('cua-status').textContent='Confirmed: '+document.getElementById('cua-field').value;});</script>
    </body></html>`;
  await fixture.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
});
app.on('window-all-closed', () => app.quit());
