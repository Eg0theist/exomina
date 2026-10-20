const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, dialog } = require('electron');
app.on('ready', () => console.log('Embedded QA Electron ready'));
app.on('browser-window-created', () => console.log('Embedded QA window created'));
dialog.showErrorBox = (title, message) => { console.error(title, message); app.exit(1); };

// Test-process-only dependency replacement. Production sources are untouched,
// and no provider executable, credential store, or remote model is invoked.
(async () => {
  console.log('Embedded QA loading synthetic provider');
  const { ProviderManager } = await import(pathToFileURL(path.resolve(__dirname, '../desktop/providers.mjs')).href);
  ProviderManager.prototype.status = async () => ['codex', 'claude'].map(id => ({ id, installed: true, connected: true, detail: 'Synthetic local QA provider; no subscription or model request.' }));
  ProviderManager.prototype.connect = async () => { throw new Error('Live sign-in is disabled in this QA process.'); };
  ProviderManager.prototype.run = async function ({ conversationId }) {
    let complete;
    const done = new Promise(resolve => { complete = resolve; });
    globalThis.__embeddedQa = { conversationId, call: (name, args) => this.callTool(name, args, conversationId), complete };
    await done;
    return { sessionId: 'synthetic-embedded-browser-test', text: 'Synthetic browser QA completed without a model request.' };
  };
  console.log('Embedded QA loading production host');
  await import(pathToFileURL(path.resolve(__dirname, '../desktop/main.mjs')).href);
  console.log('Embedded QA production host imported');
})().catch(error => { console.error(error); require('electron').app.exit(1); });
