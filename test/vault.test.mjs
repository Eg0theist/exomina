import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WindowsVault } from '../desktop/vault.mjs';

function fake(result, status = 0) {
  const calls = [];
  const spawnImpl = (executable, args, options) => {
    const child = new EventEmitter(); Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => {} });
    const call = { executable, args, options, input: '' }; calls.push(call);
    child.stdin.on('data', data => { call.input += data.toString('utf8'); });
    child.stdin.once('finish', () => { queueMicrotask(() => { const value=typeof result==='function'?result(calls.length):result;child.stdout.write(typeof value === 'string' ? value : JSON.stringify(value)); child.stdout.end(); child.stderr.end(); child.emit('close', status); }); });
    return child;
  };
  return { calls, vault: new WindowsVault({ platform: 'win32', spawnImpl, scriptPath: 'C:\\app\\vault-windows.ps1' }) };
}

test('vault only invokes its fixed PowerShell file and carries values over stdin', async () => {
  const { vault, calls } = fake({ ok: true, supported: true, encrypted: false, files: 1 });
  const result = await vault.preflight('C:\\App data\\Exomina'); assert.equal(result.encrypted, false);
  assert.deepEqual(JSON.parse(calls[0].input), { action: 'preflight', path: 'C:\\App data\\Exomina' });
  assert.equal(calls[0].options.shell, false); assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].args.includes('C:\\App data\\Exomina'), false);
  assert.deepEqual(calls[0].args, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\app\\vault-windows.ps1']);
  assert.equal(calls[0].args.some(value => /Set-ExecutionPolicy|CurrentUser|LocalMachine|Scope/i.test(value)), false);
});

test('unsupported OS, unsafe root paths, and absent recovery acknowledgment fail closed before spawning', async () => {
  await assert.rejects(new WindowsVault({ platform: 'linux' }).preflight('/var/exomina'), /Windows EFS/);
  const { vault, calls } = fake({ ok: true });
  for (const directory of ['C:\\', 'C:\\Windows', '\\\\server\\share', 'relative', 'C:\\app\\private:stream', 'C:\\app\\*']) await assert.rejects(vault.preflight(directory));
  assert.throws(() => vault.protect('C:\\app\\data'), /recovery/); assert.equal(calls.length, 0);
});

test('certificate passwords never appear in command arguments and encrypted bytes are bounded', async () => {
  const bytes = Buffer.alloc(150, 7), password = 'SyntheticLongPassword-123!';
  const { vault, calls } = fake({ ok: true, thumbprint: 'A'.repeat(40), algorithm: 'AES256_SHA256', pfx: bytes.toString('base64') });
  const output = await vault.exportRecovery('C:\\app\\probe', password);
  assert.deepEqual(output.bytes, bytes); assert.equal(output.algorithm, 'AES256_SHA256'); assert.equal('pfx' in output, false);
  assert.equal(JSON.stringify(calls[0].args).includes(password), false); assert.equal(JSON.stringify(calls[0].options).includes(password), false);
  assert.equal(JSON.parse(calls[0].input).password, password);
  await assert.rejects(vault.exportRecovery('C:\\app\\probe', 'short'), /16/);
  const invalid = fake({ ok: true, thumbprint: 'A'.repeat(40), algorithm: 'NONE', pfx: 'bad' }); await assert.rejects(invalid.vault.exportRecovery('C:\\app\\probe', password), /verified/);
});

test('native failures and malformed helper output never become successful protection', async () => {
  const failed = fake({ ok: false, error: 'Synthetic EFS unavailable.' }, 1);
  await assert.rejects(failed.vault.protect('C:\\app\\data', { recoveryThumbprint: 'A'.repeat(40) }), /Synthetic EFS unavailable/);
  const malformed = fake('non-JSON native diagnostic', 1); await assert.rejects(malformed.vault.verify('C:\\app\\data'), /could not be verified/);
});

test('existing recovery verification uses stdin and accepts the existing backup password without exporting', async () => {
  const { vault, calls } = fake({ ok: true, verified: true, thumbprint: 'B'.repeat(40) });
  assert.deepEqual(await vault.verifyRecoveryFile('C:\\app\\probe', 'C:\\backups\\Exomina.pfx', 'chosen'), { verified: true, thumbprint: 'B'.repeat(40) });
  assert.equal(JSON.parse(calls[0].input).action, 'verifyRecovery'); assert.equal(JSON.stringify(calls[0].args).includes('chosen'), false);
  await assert.rejects(vault.verifyRecoveryFile('C:\\app\\probe', 'C:\\backups\\file.txt', 'chosen'), /PFX/);
  await assert.rejects(vault.verifyRecoveryFile('C:\\app\\probe', 'C:\\backups\\file.pfx', ''), /password/);
});

test('a disappearing file restarts the whole read-only audit, with a strict retry bound',async()=>{
  const missing={ok:false,error:'Synthetic temporary file vanished.',diagnostic:{phase:'validation',category:'ItemNotFoundException'}};
  const eventual=fake(attempt=>attempt<3?missing:{ok:true,encrypted:true,restrictedAccess:true});assert.equal((await eventual.vault.verify('C:\\app\\data')).encrypted,true);assert.equal(eventual.calls.length,3);assert.ok(eventual.calls.every(call=>JSON.parse(call.input).action==='verify'));
  const persistent=fake(missing);await assert.rejects(persistent.vault.verify('C:\\app\\data'),/vanished/);assert.equal(persistent.calls.length,3);
  const denied=fake({ok:false,error:'Unsafe synthetic permissions.',diagnostic:{phase:'validation',category:'UnauthorizedAccessException'}});await assert.rejects(denied.vault.verify('C:\\app\\data'),/Unsafe/);assert.equal(denied.calls.length,1);
});

test('startup verification is a distinct root-only action requiring the recovery thumbprint',async()=>{
  const {vault,calls}=fake({ok:true,encrypted:true,restrictedAccess:true,scope:'root',recoveryRecipientsVerified:false});
  assert.throws(()=>vault.verifyStartup('C:\\app\\data'),/recovery backup/);
  const result=await vault.verifyStartup('C:\\app\\data',{recoveryThumbprint:'a'.repeat(40)});
  assert.equal(result.scope,'root');assert.equal(result.recoveryRecipientsVerified,false);
  assert.deepEqual(JSON.parse(calls[0].input),{action:'startup',path:'C:\\app\\data',recoveryThumbprint:'A'.repeat(40)});
});

test('closing the vault cancels every pending helper and refuses subsequent requests',async()=>{
  const children=[];let killed=0;
  const vault=new WindowsVault({platform:'win32',spawnImpl:()=>{
    const child=new EventEmitter();Object.assign(child,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill:()=>{killed++;}});children.push(child);return child;
  }});
  const first=vault.verify('C:\\app\\first'),second=vault.verifyStartup('C:\\app\\second',{recoveryThumbprint:'A'.repeat(40)});
  const rejected=Promise.all([assert.rejects(first,/closed/),assert.rejects(second,/closed/)]);
  assert.equal(vault.children.size,2);vault.close();await rejected;
  assert.equal(killed,2);assert.equal(vault.children.size,0);vault.close();assert.equal(killed,2);
  await assert.rejects(vault.preflight('C:\\app\\third'),/closed/);assert.equal(children.length,2);
  for(const child of children){child.stdout.end(JSON.stringify({ok:true}));child.emit('close',0);}
});
