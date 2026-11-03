import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {assertWindowsProfileOwner} from '../desktop/profile-owner.mjs';
function helper(result,{code=0}={}){
  const calls=[];
  const launch=(...args)=>{
    calls.push(args);const child=new EventEmitter();
    child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};
    queueMicrotask(()=>{child.stdout.end(JSON.stringify(result));child.emit('close',code);});return child;
  };return {launch,calls};
}
test('Windows owner inspection uses a fixed read-only helper without input',async()=>{
  const value={owner:'current-user',elevated:false},h=helper(value);
  assert.deepEqual(await assertWindowsProfileOwner({platform:'win32',launch:h.launch}),value);
  const [exe,args,options]=h.calls[0];
  assert.match(exe,/System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/i);
  assert.equal(args[args.indexOf('-File')+1].endsWith('profile-owner.ps1'),true);
  assert.equal(options.windowsHide,true);assert.equal(options.shell,false);assert.equal(options.stdio[0],'ignore');
  assert.equal(Object.keys(options.env).some(key=>key.toLowerCase()==='psmodulepath'),false);
  const script=await readFile(new URL('../desktop/profile-owner.ps1',import.meta.url),'utf8');
  assert.doesNotMatch(script,/SetTokenInformation|OpenProcess|Set-Acl|SetOwner|Add-Type|Start-Process|New-Item/);
});
test('Administrators, unknown owners and malformed observations fail with actionable errors',async()=>{
  for(const elevated of [true,false]){
    const h=helper({owner:'administrators',elevated});
    await assert.rejects(assertWindowsProfileOwner({platform:'win32',launch:h.launch}),error=>error.code==='WINDOWS_PROFILE_OWNER_UNSAFE'&&/Open Exomina normally/.test(error.message));
  }
  const h=helper({owner:'other',elevated:true});await assert.rejects(assertWindowsProfileOwner({platform:'win32',launch:h.launch}),/different owner/);
  for(const value of [null,{},[],{owner:'current-user'},{owner:'invented',elevated:false}]){
    const h=helper(value);await assert.rejects(assertWindowsProfileOwner({platform:'win32',launch:h.launch}),/could not be verified/);
  }
  const failed=helper({}, {code:1});await assert.rejects(assertWindowsProfileOwner({platform:'win32',launch:failed.launch}),/could not be checked/);
});
test('current-user creators remain accepted and other platforms never launch PowerShell',async()=>{
  for(const elevated of [false,true]){
    const value={owner:'current-user',elevated},h=helper(value);
    assert.deepEqual(await assertWindowsProfileOwner({platform:'win32',launch:h.launch}),value);
  }
  for(const platform of ['darwin','linux'])assert.deepEqual(await assertWindowsProfileOwner({platform,launch:()=>{throw Error('Unexpected helper');}}),{status:'not-required'});
});
test('app checks creator ownership before creating profile directories or an updater',async()=>{
  const main=await readFile(new URL('../desktop/main.mjs',import.meta.url),'utf8');
  const inspection=main.indexOf('await assertWindowsProfileOwner()');assert.ok(inspection>0);
  for(const statement of ['await mkdir(dataDir','await ensureWindowsAppIndependence()','const updater=new Updater'])assert.ok(main.indexOf(statement)>inspection,statement);
  const diagnostic=main.indexOf('const startupDiagnostic=');if(diagnostic!==-1)assert.ok(diagnostic>inspection);
});
test('native owner inspection preserves its creator and rejects unsafe file ownership',{skip:process.platform!=='win32',timeout:30000},async t=>{
  const {stdout}=await promisify(execFile)(process.execPath,[fileURLToPath(new URL('../scripts/qa-profile-owner.mjs',import.meta.url))],{windowsHide:true,encoding:'utf8',timeout:25000,maxBuffer:16000});
  const result=JSON.parse(stdout);assert.equal(result.ownerUnchanged,true);assert.equal(result.futureDirectoryAbsent,true);
  assert.ok(result.accepted===true||result.elevatedRefused===true);t.diagnostic(JSON.stringify(result));
});
