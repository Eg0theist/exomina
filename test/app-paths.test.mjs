import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {appPaths,resolveAppLocations,installDistribution,distributionMetadataDirectory} from '../desktop/app-paths.mjs';
import {privateGate} from '../desktop/private-gate.mjs';

test('packaged paths belong to Exomina, independently of its build directory',()=>{
  const result=appPaths({platform:'win32',packaged:true,root:'C:\\build\\app',localAppData:'C:\\Users\\test\\AppData\\Local',documents:'D:\\Documents',env:{},pathApi:path.win32});
  assert.deepEqual(result,{dataDir:'D:\\Documents\\Exomina\\Private\\data',accountsDir:'D:\\Documents\\Exomina\\Private\\accounts',workspace:'D:\\Documents\\Exomina\\Workspace'});
});
test('explicit profiles stay isolated and can exercise separated account storage',()=>{
  const base={platform:'win32',packaged:true,root:'C:\\build',env:{EXOMINA_DATA_DIR:'C:\\qa\\data'},pathApi:path.win32};
  assert.deepEqual(appPaths(base),{dataDir:'C:\\qa\\data',accountsDir:'C:\\qa\\data',workspace:'C:\\qa\\data\\workspace'});
  assert.equal(appPaths({...base,env:{...base.env,EXOMINA_ACCOUNTS_DIR:'C:\\qa\\accounts'}}).accountsDir,'C:\\qa\\accounts');
});

test('explicit profile locations never discover or probe a real user profile',()=>{
 const noAccess=()=>{throw Error('No OS folder lookup or real profile probe is allowed.');};
 const options={packaged:true,root:'/app',platform:'darwin',pathApi:path.posix,getPath:noAccess,exists:noAccess,
  env:{EXOMINA_DATA_DIR:'/qa/data',EXOMINA_ACCOUNTS_DIR:'/qa/accounts',EXOMINA_WORKSPACE_DIR:'/qa/workspace'}};
 assert.deepEqual(resolveAppLocations(options),{dataDir:'/qa/data',accountsDir:'/qa/accounts',workspace:'/qa/workspace'});
 assert.deepEqual(resolveAppLocations({...options,env:{EXOMINA_DATA_DIR:'/qa/data'}}),{dataDir:'/qa/data',accountsDir:'/qa/data',workspace:'/qa/data/workspace'});
 assert.equal(resolveAppLocations({...options,env:{},home:'/install'}).dataDir,'/install/Private/data');
 assert.equal(resolveAppLocations({...options,env:{},packaged:false}).dataDir,'/app/data');
});

test('default Windows discovery retains existing profile migration decisions',()=>{
 const probes=[];const folders={documents:'C:\\Docs',appData:'C:\\Roaming',exe:'C:\\Programs\\Exomina\\Exomina.exe'};
 const options={packaged:true,root:'C:\\Programs\\Exomina',platform:'win32',pathApi:path.win32,env:{LOCALAPPDATA:'C:\\Local'},
  distribution:{profile:'beta',manualUpdates:true},getPath:name=>folders[name],exists:file=>{probes.push(file);return file==='C:\\Docs\\Exomina\\Private\\data\\state.json';}};
 assert.equal(resolveAppLocations(options).dataDir,'C:\\Docs\\Exomina\\Private\\data');
 assert.deepEqual(probes,['C:\\Programs\\Exomina\\data\\state.json','C:\\Docs\\Exomina\\Private\\data\\state.json','C:\\Local\\Exomina\\Private\\data\\state.json']);
});
test('parallel runtime requests wait for the same complete audit',async()=>{
  let complete,calls=0;const statuses=[];
  const gate=privateGate({verify:()=>{calls++;return new Promise(resolve=>{complete=resolve;});},onStatus:value=>statuses.push(value)});
  let authorized=0;const a=gate().then(()=>authorized++),b=gate().then(()=>authorized++);
  await Promise.resolve();assert.equal(calls,1);assert.equal(authorized,0);
  complete({encrypted:true,restrictedAccess:true});await Promise.all([a,b]);assert.equal(authorized,2);assert.equal(statuses.at(-1).ready,true);
});
test('an existing portable installation keeps its data until verified relocation',()=>{
  const options={platform:'win32',packaged:true,root:'C:\\build',localAppData:'C:\\Local',documents:'C:\\Docs',legacyDataDir:'C:\\Old\\data',legacyDataExists:true,env:{},pathApi:path.win32};
  assert.equal(appPaths(options).dataDir,'C:\\Old\\data');assert.equal(appPaths({...options,ownDataExists:true}).dataDir,'C:\\Docs\\Exomina\\Private\\data');
});
test('fresh beta installs keep private stores local while the project folder may be redirected',()=>{
  const options={platform:'win32',packaged:true,root:'C:\\Programs\\Exomina',localAppData:'C:\\Users\\test\\AppData\\Local',documents:'C:\\Users\\test\\OneDrive\\Documents',distribution:{profile:'beta',manualUpdates:true},env:{},pathApi:path.win32};
  assert.deepEqual(appPaths(options),{dataDir:'C:\\Users\\test\\AppData\\Local\\Exomina\\Private\\data',accountsDir:'C:\\Users\\test\\AppData\\Local\\Exomina\\Private\\accounts',workspace:'C:\\Users\\test\\OneDrive\\Documents\\Exomina\\Workspace'});
  assert.equal(appPaths({...options,distribution:undefined}).dataDir,'C:\\Users\\test\\OneDrive\\Documents\\Exomina\\Private\\data');
  assert.equal(appPaths({...options,distribution:{profile:'beta',manualUpdates:false}}).dataDir,'C:\\Users\\test\\OneDrive\\Documents\\Exomina\\Private\\data');
});
test('beta metadata preserves existing profiles and explicit location choices',()=>{
  const options={platform:'win32',packaged:true,root:'C:\\Programs\\Exomina',localAppData:'C:\\Local',documents:'C:\\Docs',distribution:{profile:'beta',manualUpdates:true},env:{},pathApi:path.win32};
  assert.equal(appPaths({...options,ownDataExists:true}).dataDir,'C:\\Docs\\Exomina\\Private\\data');
  assert.equal(appPaths({...options,ownDataExists:true,betaDataExists:true}).dataDir,'C:\\Local\\Exomina\\Private\\data');
  const portable={...options,legacyDataDir:'C:\\Portable\\data',legacyDataExists:true};
  assert.equal(appPaths(portable).dataDir,'C:\\Portable\\data');
  assert.equal(appPaths({...portable,betaDataExists:true}).dataDir,'C:\\Local\\Exomina\\Private\\data');
  assert.equal(appPaths({...options,home:'C:\\Installed'}).dataDir,'C:\\Installed\\Private\\data');
  assert.equal(appPaths({...options,env:{EXOMINA_DATA_DIR:'C:\\Synthetic\\profile'}}).dataDir,'C:\\Synthetic\\profile');
  assert.equal(appPaths({...options,packaged:false}).dataDir,'C:\\Programs\\Exomina\\data');
});
test('installed beta metadata is bounded, fixed in scope and distinct from the legacy home marker',()=>{
  const marker='C:\\Programs\\Exomina\\exomina.distribution.json';
  const files=new Map([[marker,'\uFEFF{"profile":"beta","manualUpdates":true,"home":"C:\\\\ignored"}']]);
  const read=file=>{if(!files.has(file))throw Object.assign(Error('missing'),{code:'ENOENT'});return files.get(file);};
  assert.deepEqual(installDistribution('C:\\Programs\\Exomina',{read,pathApi:path.win32}),{profile:'beta',manualUpdates:true});
  assert.equal(installDistribution('C:\\Other',{read,pathApi:path.win32}),undefined);
  for(const text of ['no JSON','{"profile":"beta","manualUpdates":false}','{"profile":"unknown","manualUpdates":true}', 'x'.repeat(4097)]){
    files.set(marker,text);assert.throws(()=>installDistribution('C:\\Programs\\Exomina',{read,pathApi:path.win32}),/exomina\.distribution\.json/);
  }
  assert.throws(()=>installDistribution('C:\\Programs\\Exomina',{read:()=>{throw Object.assign(Error('denied'),{code:'EACCES'});},pathApi:path.win32}),/denied/);
});

test('macOS beta metadata belongs in signed Resources while Windows and Linux stay beside the executable',()=>{
 const exeDir='/applications/Exomina Beta.app/Contents/MacOS';
 const options={platform:'darwin',pathApi:path.posix};
 const resources='/applications/Exomina Beta.app/Contents/Resources';
 assert.equal(distributionMetadataDirectory(exeDir,options),resources);
 const read=file=>{assert.equal(file,path.posix.join(resources,'exomina.distribution.json'));return '{"profile":"beta","manualUpdates":true}';};
 assert.deepEqual(installDistribution(exeDir,{...options,read}),{profile:'beta',manualUpdates:true});
 assert.throws(()=>installDistribution(exeDir,{...options,read:()=>'{"profile":"beta","manualUpdates":false}'}),/manual updates/);
 assert.equal(distributionMetadataDirectory('C:\\Programs\\Exomina',{platform:'win32',pathApi:path.win32}),'C:\\Programs\\Exomina');
 assert.equal(distributionMetadataDirectory('/opt/Exomina Beta',{platform:'linux',pathApi:path.posix}),'/opt/Exomina Beta');
});
test('failed or partial protection never opens the gate',async()=>{
  for(const result of [{encrypted:true},{restrictedAccess:true},{encrypted:false,restrictedAccess:true}]){
    let calls=0;const gate=privateGate({verify:async()=>{calls++;return result;}});
    await assert.rejects(gate(),/protection/);await assert.rejects(gate(),/protection/);assert.equal(calls,1);
  }
  const gate=privateGate({verify:async()=>{throw Error('unsafe file');}});await assert.rejects(gate(),/unsafe file/);
});

test('an installation can keep its data beside the program', async () => {
  const { appPaths, installHome } = await import('../desktop/app-paths.mjs');
  const p = (await import('node:path')).win32;
  const files = { [String.raw`C:\Program Files\Exomina\App\exomina.paths.json`]: '\uFEFF{"home":".."}' };
  const read = file => { if (!(file in files)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return files[file]; };
  const home = installHome(String.raw`C:\Program Files\Exomina\App`, { read, pathApi: p });
  assert.equal(home, String.raw`C:\Program Files\Exomina`);
  assert.deepEqual(appPaths({ platform: 'win32', packaged: true, root: 'x', home, env: {}, pathApi: p }), { dataDir: String.raw`C:\Program Files\Exomina\Private\data`, accountsDir: String.raw`C:\Program Files\Exomina\Private\accounts`, workspace: String.raw`C:\Program Files\Exomina\Workspace`, home });
  assert.equal(installHome(String.raw`C:\Other`, { read, pathApi: p }), undefined);
  files[String.raw`C:\Bad\App\exomina.paths.json`] = String.raw`{"home":"..\\.."}`;
  assert.throws(() => installHome(String.raw`C:\Bad\App`, { read, pathApi: p }), /drive root/);
  files[String.raw`C:\Broken\exomina.paths.json`] = 'nope';
  assert.throws(() => installHome(String.raw`C:\Broken`, { read, pathApi: p }), /valid JSON/);
});

test('a missing installer marker recovers the adjacent profile instead of opening an old one',async()=>{
  const {installHome}=await import('../desktop/app-paths.mjs');
  const p=path.win32,exeDir='C:\\Installed\\App';
  const files=new Set(['Private','Private/data/state.json','Private/accounts','Workspace'].map(relative=>p.join('C:\\Installed',...relative.split('/'))));
  const read=()=>{throw Object.assign(Error('missing'),{code:'ENOENT'});};
  const options={read,exists:file=>files.has(file),pathApi:p};
  assert.equal(installHome(exeDir,options),'C:\\Installed');
  files.delete(p.join('C:\\Installed','Private','accounts'));
  assert.throws(()=>installHome(exeDir,options),/profile location is missing/);
  assert.throws(()=>installHome(exeDir,{...options,read:()=>{throw Object.assign(Error('denied'),{code:'EACCES'});}}),/denied/);
  assert.equal(installHome('C:\\Portable',options),undefined);
});
