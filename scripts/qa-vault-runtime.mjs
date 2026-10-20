import { _electron } from 'playwright';
import http from 'node:http';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { WindowsVault } from '../desktop/vault.mjs';
import { ProviderManager } from '../desktop/providers.mjs';

const profile = path.resolve(process.argv[2] || '');
assert.match(path.basename(path.dirname(profile)), /^qa-vault-/); assert.equal(path.basename(profile), 'data');
const server = http.createServer((_req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<!doctype html><title>Synthetic vault browser</title><input aria-label="Synthetic field">'); });
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const env = { ...process.env, EXOMINA_QA_VAULT_PROFILE: profile, EXOMINA_QA_VAULT_URL: `http://127.0.0.1:${server.address().port}` }; delete env.ELECTRON_RUN_AS_NODE;
let app, providers;
try {
  app = await _electron.launch({ args: [path.resolve('scripts/qa-vault-fixture.cjs')], env, timeout: 30000 });
  let result;
  for (let count = 0; count < 100; count++) { result = await app.evaluate(() => globalThis.vaultQa); if (result?.ready) break; await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.equal(result?.ready, true); assert.equal(result.mainSandbox, true); assert.equal(result.browserSandbox, true); assert.equal(result.safeStorage, true); assert.equal(result.browserValue, 'Synthetic ä 中文.'); assert.equal(result.cookieCount, 1);
  await app.close(); app = null;
  const workspace = path.join(profile, 'workspace'); await mkdir(workspace, { recursive: true });
  providers = new ProviderManager({ dataDir: profile, workspace });
  result.providers = (await providers.status()).map(({ id, installed, connected }) => ({ id, installed, connected }));
  assert.ok(result.providers.every(provider => provider.installed && !provider.connected));
  providers.close(); providers = null;
  result.encryption = await new WindowsVault().verify(profile);
  await writeFile(path.join(path.dirname(profile), 'runtime-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { providers?.close(); if (app) await app.close(); await new Promise(resolve => server.close(resolve)); }
