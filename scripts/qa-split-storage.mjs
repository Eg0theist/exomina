// Production Electron main + real Windows EFS, with fresh synthetic data only.
// Non-vault process starts are intercepted before execution; no provider runs.
import { _electron as electron } from 'playwright';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { createProtectedQaProfile } from './qa-profile.mjs';
import { WindowsVault } from '../desktop/vault.mjs';
import { Store } from '../desktop/store.mjs';

const root = process.cwd(), vault = new WindowsVault();
const reports = [];
async function entries(directory, prefix = '') {
  const names = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name); names.push(relative);
    if (entry.isDirectory()) names.push(...await entries(path.join(directory, entry.name), relative));
  }
  return names.sort();
}
async function setSyntheticEncryption(file, accounts, encrypted, directory = false) {
  if (directory) { assert.equal(file, accounts); assert.equal(path.basename(accounts), 'accounts'); }
  else { assert.equal(path.dirname(file), accounts); assert.equal(path.basename(file), 'synthetic-plaintext.txt'); }
  const script = "$ErrorActionPreference='Stop'; $item=([Console]::In.ReadToEnd() | ConvertFrom-Json); if($item.directory){$flag=if($item.encrypted){'/e'}else{'/d'}; $null=& (Join-Path $env:SystemRoot 'System32/cipher.exe') $flag /h /b $item.path 2>&1; if($LASTEXITCODE -ne 0){throw 'Synthetic cipher change failed'}}elseif($item.encrypted){[System.IO.File]::Encrypt($item.path)}else{[System.IO.File]::Decrypt($item.path)}; if(-not $item.directory -and (Get-Item -LiteralPath $item.path).Length -le 0){throw 'Empty synthetic file'}; $actual=([System.IO.File]::GetAttributes($item.path) -band [System.IO.FileAttributes]::Encrypted) -ne 0; if($actual -ne $item.encrypted){throw 'Unexpected synthetic encryption state'}; [Console]::Out.Write('ok')";
  await new Promise((resolve, reject) => {
    const child = spawn(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.resume();
    child.on('error', reject); child.on('close', code => code === 0 && output.trim() === 'ok' ? resolve() : reject(Error('Could not prepare the synthetic plaintext rejection fixture.')));
    child.stdin.end(JSON.stringify({ path: file, encrypted, directory }));
  });
}
for (const mode of ['valid', 'root-rejected', 'child-manual']) {
  const profile = await createProtectedQaProfile(`split-${mode}`);
  const accounts = path.join(profile.output, 'accounts'), workspace = path.join(profile.output, 'workspace');
  assert.equal(path.dirname(accounts), profile.output); assert.equal(path.dirname(workspace), profile.output);
  const { thumbprint } = JSON.parse(await readFile(profile.profile + '.setup/recovery-backup.json', 'utf8'));
  await mkdir(accounts); await mkdir(workspace);
  await writeFile(path.join(accounts, 'synthetic-account-marker.txt'), 'Synthetic account fixture. Not a credential.');
  await writeFile(path.join(workspace, 'synthetic-project.txt'), 'Synthetic split workspace.');
  await vault.protect(accounts, { recoveryThumbprint: thumbprint });
  await vault.protect(workspace, { recoveryThumbprint: thumbprint });
  if (mode === 'root-rejected') {
    await setSyntheticEncryption(accounts, accounts, false, true);
    await assert.rejects(vault.verifyStartup(accounts, { recoveryThumbprint: thumbprint }));
  }
  if (mode === 'child-manual') {
    const target = path.join(accounts, 'synthetic-plaintext.txt');
    await writeFile(target, 'Intentionally unencrypted synthetic rejection fixture.');
    await setSyntheticEncryption(target, accounts, false);
    await assert.rejects(vault.verify(accounts, { recoveryThumbprint: thumbprint }));
    const startup = await vault.verifyStartup(accounts, { recoveryThumbprint: thumbprint });
    assert.equal(startup.scope, 'root'); assert.equal(startup.recoveryRecipientsVerified, false);
  }
  const originalEntries = await entries(accounts);
  const store = new Store(profile.profile, { workspace }); await store.init();
  const chat = store.create('codex'); chat.title = 'Synthetic split-storage chat'; chat.titleSource = 'manual'; chat.messages = [{ role: 'user', content: 'Synthetic local conversation remains available.' }]; await store.save();
  const wrapper = path.join(profile.output, 'electron-fixture.cjs');
  await writeFile(wrapper, `
const fs=require('node:fs'),fsp=require('node:fs/promises'),cp=require('node:child_process'),path=require('node:path'),{syncBuiltinESMExports}=require('node:module');
globalThis.splitQa={nativeSpawnAttempts:0,accountReadAttempts:0,allowedVaultStarts:0,toolReady:false,firstNativeSpawnAt:null};
const accounts=path.resolve(process.env.EXOMINA_ACCOUNTS_DIR).toLowerCase();
function accountPath(value){try{const p=path.resolve(typeof value==='string'?value:require('node:url').fileURLToPath(value)).toLowerCase();return p===accounts||p.startsWith(accounts+path.sep)}catch{return false}}
for(const [object,key] of [[fs,'readFile'],[fs,'readFileSync'],[fs,'open'],[fs,'openSync'],[fsp,'readFile'],[fsp,'open']]){const original=object[key];object[key]=function(value,...args){if(accountPath(value))globalThis.splitQa.accountReadAttempts++;return original.call(this,value,...args)}}
const originalSpawn=cp.spawn;
cp.spawn=function(exe,args=[],options){if(path.basename(String(exe)).toLowerCase()==='powershell.exe'&&args.includes('-File')&&args.some(value=>path.basename(String(value))==='vault-windows.ps1')){globalThis.splitQa.allowedVaultStarts++;return originalSpawn.call(this,exe,args,options)}globalThis.splitQa.nativeSpawnAttempts++;globalThis.splitQa.firstNativeSpawnAt??=Date.now();throw Error('QA intercepted native launch before execution. No provider process was started.')};
syncBuiltinESMExports();
(async()=>{
 const {WorkspaceTools}=await import(${JSON.stringify(pathToFileURL(path.join(root, 'desktop/workspace-tools.mjs')).href)});
 const descriptor=Object.getOwnPropertyDescriptor(WorkspaceTools.prototype,'definitions');
 Object.defineProperty(WorkspaceTools.prototype,'definitions',{...descriptor,get(){globalThis.splitQa.workspaceTools=this;globalThis.splitQa.toolReady=true;return descriptor.get.call(this)}});
 await import(${JSON.stringify(pathToFileURL(path.join(root, 'desktop/main.mjs')).href)});
})().catch(()=>{require('electron').app.exit(71)});
`);
  const env = { ...process.env, EXOMINA_DATA_DIR: profile.profile, EXOMINA_ACCOUNTS_DIR: accounts, EXOMINA_WORKSPACE_DIR: workspace }; delete env.ELECTRON_RUN_AS_NODE;
  let app, scenarioError;
  const report = { mode, syntheticOnly: true, profilePreparation: profile.report, noProviderProcessExecuted: true };
  try {
    const start = Date.now();
    app = await electron.launch({ args: [wrapper], env, timeout: 60000 });
    const page = await app.firstWindow(); page.setDefaultTimeout(30000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('heading', { name: /^(Good (morning|afternoon|evening)|Up late).$/ }).waitFor();
    report.workspaceVisibleMs = Date.now() - start;
    const initial = await page.evaluate(() => window.studio.invoke('bootstrap'));
    assert.equal(path.resolve(initial.settings.workspace), workspace);
    assert.ok(initial.conversations.some(item => item.id === chat.id));
    await page.getByRole('button', { name: chat.title, exact: true }).click();
    await page.getByText('Synthetic local conversation remains available.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Memory', exact: true }).click();
    await page.getByRole('button', { name: 'Add a memory', exact: true }).click();
    await page.getByLabel('What should be saved?').fill('Synthetic split-storage memory works.');
    await page.getByRole('button', { name: 'Save memory', exact: true }).click();
    await page.getByText('Synthetic split-storage memory works.', { exact: true }).waitFor();
    await app.evaluate(() => { globalThis.splitQa.toolTask = globalThis.splitQa.workspaceTools.call('workspace_write', { path: 'approved-tool-write.txt', text: 'Synthetic approved workspace write.' }); });
    await page.getByRole('alertdialog').getByRole('button', { name: 'Allow once', exact: true }).click();
    const toolResult = await app.evaluate(async () => { const value = await globalThis.splitQa.toolTask; return JSON.parse(value.content[0].text); });
    assert.equal(toolResult.written, 'approved-tool-write.txt');
    assert.equal(await readFile(path.join(workspace, 'approved-tool-write.txt'), 'utf8'), 'Synthetic approved workspace write.');
    await page.getByRole('button', { name: 'Connections', exact: true }).click();
    await page.evaluate(() => window.studio.invoke('connections.refresh'));
    const state = await page.evaluate(() => window.studio.invoke('bootstrap'));
    const native = state.connections.filter(item => ['codex', 'claude', 'antigravity', 'copilot', 'kimi-code'].includes(item.id));
    assert.ok(native.length >= 2); assert.equal(native.every(item => !item.connected && !item.checking), true);
    if (mode === 'root-rejected') {
      const attempts = await page.evaluate(async () => {
        const methods = [['provider.connect', { provider: 'codex' }], ['provider.connect', { provider: 'claude' }], ['provider.models', { provider: 'codex' }]];
        return Promise.all(methods.map(async ([method, payload]) => { try { const result = await window.studio.invoke(method, payload); return { method, rejected: false, emptyModels: Array.isArray(result) && result.length === 0 }; } catch { return { method, rejected: true }; } }));
      });
      assert.equal(attempts.filter(item => item.method === 'provider.connect').every(item => item.rejected), true);
      const counters = await app.evaluate(() => ({ nativeSpawnAttempts: globalThis.splitQa.nativeSpawnAttempts, accountReadAttempts: globalThis.splitQa.accountReadAttempts, allowedVaultStarts: globalThis.splitQa.allowedVaultStarts, firstNativeSpawnAt: globalThis.splitQa.firstNativeSpawnAt }));
      assert.equal(counters.nativeSpawnAttempts, 0, 'A failed account audit must stop before every native launch');
      assert.equal(counters.accountReadAttempts, 0, 'A failed account audit must stop Node credential reads');
      assert.deepEqual(await entries(accounts), originalEntries, 'A failed audit must not prepare runtime account files');
      report.gateChecks = { ...counters, loginRejected: true, modelDiscoveryBlocked: attempts.filter(item => item.method === 'provider.models').every(item => item.rejected || item.emptyModels), accountEntriesUnchanged: true };
    } else {
      const counters = await app.evaluate(() => ({ nativeSpawnAttempts: globalThis.splitQa.nativeSpawnAttempts, accountReadAttempts: globalThis.splitQa.accountReadAttempts, allowedVaultStarts: globalThis.splitQa.allowedVaultStarts, firstNativeSpawnAt: globalThis.splitQa.firstNativeSpawnAt }));
      assert.ok(counters.nativeSpawnAttempts > 0, 'A valid account audit should permit the runtime boundary (intercepted by QA)');
      report.gateChecks = counters;
      report.runtimeBoundaryAllowedMs = counters.firstNativeSpawnAt - start;
    }
    await page.getByRole('button', { name: /^Settings/ }).click();
    await page.getByText('Last full check: not checked in this version.', { exact: true }).waitFor();
    const beforeAudit = await app.evaluate(() => globalThis.splitQa.allowedVaultStarts);
    await page.getByRole('button', { name: 'Check recovery', exact: true }).click();
    // This Playwright build resolves an async waitForFunction predicate to false
    // before retrying it. Await each IPC response explicitly in the test runner.
    let audit; const auditDeadline = Date.now() + 30000;
    do {
      audit = (await page.evaluate(() => window.studio.invoke('bootstrap'))).security.recoveryAudit;
      if (['verified', 'error'].includes(audit.status)) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < auditDeadline);
    assert.equal(audit.status, mode === 'valid' ? 'verified' : 'error');
    if (mode === 'valid') assert.ok(Date.parse(audit.checkedAt));
    else await page.locator('.recovery-audit-row').getByRole('alert').waitFor();
    report.manualAudit = { status: audit.status, invokedOnlyAfterClick: true, vaultCheckCount: (await app.evaluate(() => globalThis.splitQa.allowedVaultStarts)) - beforeAudit, childRecipientScanAtStartup: false };
    assert.equal(errors.length, 0, errors.join('\n'));
    report.coreChecks = { chatsOpened: true, memorySaved: true, defaultWorkspaceOverride: true, realWorkspaceToolApprovedWrite: true, rendererErrors: errors.length };
    await page.screenshot({ path: path.join(profile.output, 'connections.png') });
  } catch (error) { scenarioError = error; report.error = error.message; }
  finally { if (app) await app.close(); }
  await writeFile(path.join(profile.output, 'workflow-result.json'), JSON.stringify(report, null, 2));
  report.finalCoreAudit = await profile.verify();
  report.finalWorkspaceAudit = await vault.verify(workspace, { recoveryThumbprint: thumbprint });
  if (mode !== 'valid') {
    await assert.rejects(vault.verify(accounts, { recoveryThumbprint: thumbprint }));
    report.expectedAccountAuditFailureConfirmedAfterExit = true;
    // Restore only this deliberately altered synthetic fixture after proving rejection.
    await setSyntheticEncryption(mode === 'root-rejected' ? accounts : path.join(accounts, 'synthetic-plaintext.txt'), accounts, true, mode === 'root-rejected');
    report.syntheticAccountProtectionRestored = true;
  }
  report.finalAccountAudit = await vault.verify(accounts, { recoveryThumbprint: thumbprint });
  report.passed = !scenarioError;
  await writeFile(path.join(profile.output, 'result.json'), JSON.stringify(report, null, 2));
  if (scenarioError) throw scenarioError;
  reports.push({ mode, output: profile.output, workspaceVisibleMs: report.workspaceVisibleMs, runtimeBoundaryAllowedMs: report.runtimeBoundaryAllowedMs, coreChecks: report.coreChecks, gateChecks: report.gateChecks, manualAudit: report.manualAudit, passed: true });
  console.log(JSON.stringify(reports.at(-1)));
}
console.log(JSON.stringify({ passed: true, scenarios: reports, syntheticOnly: true, realWindowsEfs: true, recoveryAcknowledgementSimulated: true, noProviderProcessExecuted: true }));
