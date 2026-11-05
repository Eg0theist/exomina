import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {appPaths,installDistribution} from '../desktop/app-paths.mjs';
import {privateGate} from '../desktop/private-gate.mjs';

test('packaged paths belong to Exomina, independently of its build directory',()=>{
  const result=appPaths({packaged:true,root:'C:\\build\\app',localAppData:'C:\\Users\\test\\AppData\\Local',documents:'D:\\Documents',env:{},platform:'win32',pathApi:path.win32});
  assert.deepEqual(result,{dataDir:'D:\\Documents\\Exomina\\Private\\data',accountsDir:'D:\\Documents\\Exomina\\Private\\accounts',workspace:'D:\\Documents\\Exomina\\Workspace'});
});
test('explicit profiles stay isolated and can exercise separated account storage',()=>{
  const base={packaged:true,root:'C:\\build',env:{EXOMINA_DATA_DIR:'C:\\qa\\data'},pathApi:path.win32};
  assert.deepEqual(appPaths(base),{dataDir:'C:\\qa\\data',accountsDir:'C:\\qa\\data',workspace:'C:\\qa\\data\\workspace'});
  assert.equal(appPaths({...base,env:{...base.env,EXOMINA_ACCOUNTS_DIR:'C:\\qa\\accounts'}}).accountsDir,'C:\\qa\\accounts');
});
test('parallel runtime requests wait for the same complete audit',async()=>{
  let complete,calls=0;const statuses=[];
  const gate=privateGate({verify:()=>{calls++;return new Promise(resolve=>{complete=resolve;});},onStatus:value=>statuses.push(value)});
  let authorized=0;const a=gate().then(()=>authorized++),b=gate().then(()=>authorized++);
  await Promise.resolve();assert.equal(calls,1);assert.equal(authorized,0);
  complete({encrypted:true,restrictedAccess:true});await Promise.all([a,b]);assert.equal(authorized,2);assert.equal(statuses.at(-1).ready,true);
});
test('an existing portable installation keeps its data until verified relocation',()=>{
  const options={packaged:true,root:'C:\\build',localAppData:'C:\\Local',documents:'C:\\Docs',legacyDataDir:'C:\\Old\\data',legacyDataExists:true,env:{},platform:'win32',pathApi:path.win32};
  assert.equal(appPaths(options).dataDir,'C:\\Old\\data');assert.equal(appPaths({...options,ownDataExists:true}).dataDir,'C:\\Docs\\Exomina\\Private\\data');
});
test('fresh beta installs keep private stores local while the project folder may be redirected',()=>{
  const options={packaged:true,root:'C:\\Programs\\Exomina',localAppData:'C:\\Users\\test\\AppData\\Local',documents:'C:\\Users\\test\\OneDrive\\Documents',distribution:{profile:'beta',manualUpdates:true},env:{},platform:'win32',pathApi:path.win32};
  assert.deepEqual(appPaths(options),{dataDir:'C:\\Users\\test\\AppData\\Local\\Exomina\\Private\\data',accountsDir:'C:\\Users\\test\\AppData\\Local\\Exomina\\Private\\accounts',workspace:'C:\\Users\\test\\OneDrive\\Documents\\Exomina\\Workspace'});
  assert.equal(appPaths({...options,distribution:undefined}).dataDir,'C:\\Users\\test\\OneDrive\\Documents\\Exomina\\Private\\data');
  assert.equal(appPaths({...options,distribution:{profile:'beta',manualUpdates:false}}).dataDir,'C:\\Users\\test\\OneDrive\\Documents\\Exomina\\Private\\data');
});
test('beta metadata preserves existing profiles and explicit location choices',()=>{
  const options={packaged:true,root:'C:\\Programs\\Exomina',localAppData:'C:\\Local',documents:'C:\\Docs',distribution:{profile:'beta',manualUpdates:true},env:{},platform:'win32',pathApi:path.win32};
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
test('failed or partial protection never opens the gate',async()=>{
  for(const result of [{encrypted:true},{restrictedAccess:true},{encrypted:false,restrictedAccess:true}]){
    let calls=0;const gate=privateGate({verify:async()=>{calls++;return result;}});
    await assert.rejects(gate(),/protection/);await assert.rejects(gate(),/protection/);assert.equal(calls,1);
  }
  const gate=privateGate({verify:async()=>{throw Error('unsafe file');}});await assert.rejects(gate(),/unsafe file/);
});

test('public distribution metadata cannot redirect profiles or bypass installation',()=>{
  const read=()=>JSON.stringify({profile:'public',manualUpdates:false,repositoryUrl:'https://github.com/example/exomina/',home:'C:\\ignored'});
  const distribution=installDistribution('C:\\Build',{read,pathApi:path.win32});
  assert.deepEqual(distribution,{profile:'public',manualUpdates:false,repositoryUrl:'https://github.com/example/exomina'});
  const options={packaged:true,root:'C:\\Build',distribution,localAppData:'C:\\Local',documents:'C:\\Docs',env:{},pathApi:path.win32};
  assert.throws(()=>appPaths(options),/must be installed/);
  assert.equal(appPaths({...options,home:'C:\\Program Files\\Exomina'}).dataDir,'C:\\Program Files\\Exomina\\Private\\data');
  for(const repositoryUrl of ['https://github.com.evil.test/a/b','https://github.com/a/b/tree/main','file:///a','https://user@github.com/a/b'])assert.throws(()=>installDistribution('C:\\Build',{read:()=>JSON.stringify({profile:'public',manualUpdates:false,repositoryUrl}),pathApi:path.win32}),/public GitHub/);
});

test('an installation can keep its data beside the program', async () => {
  const { appPaths, installHome } = await import('../desktop/app-paths.mjs');
  const p = (await import('node:path')).win32;
  const files = { [String.raw`C:\Program Files\Exomina\App\exomina.paths.json`]: '\uFEFF{"home":".."}' };
  const read = file => { if (!(file in files)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return files[file]; };
  const home = installHome(String.raw`C:\Program Files\Exomina\App`, { read, pathApi: p });
  assert.equal(home, String.raw`C:\Program Files\Exomina`);
  assert.deepEqual(appPaths({ packaged: true, root: 'x', home, env: {}, pathApi: p }), { dataDir: String.raw`C:\Program Files\Exomina\Private\data`, accountsDir: String.raw`C:\Program Files\Exomina\Private\accounts`, workspace: String.raw`C:\Program Files\Exomina\Workspace`, home });
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

test('a beta install never opens an older library unasked and remembers the answer',async()=>{
  const {resolveAppLocations,betaProfileChoiceFile,parseBetaProfileChoice}=await import('../desktop/app-paths.mjs');
  const p=path.win32,LOCAL='C:\\Local',DOCS='C:\\Docs',own=p.join(DOCS,'Exomina','Private','data','state.json'),own2=p.join(LOCAL,'Exomina','Private','data','state.json');
  const file=betaProfileChoiceFile(LOCAL,{pathApi:p}),saved=(choice,offer)=>({[file]:JSON.stringify({choice,...(offer?{offer}:{})})});
  const run=({files=[own],answers={},dist={profile:'beta',manualUpdates:true},env={LOCALAPPDATA:LOCAL},home}={})=>{const written=[];const result=resolveAppLocations({packaged:true,root:'C:\\Build',home,distribution:dist,env,platform:'win32',pathApi:p,
    getPath:name=>({documents:DOCS,appData:'C:\\Roaming',exe:'D:\\Exomina Public Test\\Exomina.exe'})[name],exists:name=>files.includes(name),readChoice:name=>answers[name]||'',saveChoice:(name,value)=>written.push([name,value])});return {result,written};};
  const separate={dataDir:p.join(LOCAL,'Exomina','Private','data'),accountsDir:p.join(LOCAL,'Exomina','Private','accounts'),workspace:p.join(DOCS,'Exomina Beta','Workspace')};
  const older={file,folder:p.join(DOCS,'Exomina','Private')};
  // First launch: own library and projects, with the older one offered and the offer saved.
  const first=run();assert.deepEqual(first.result,{...separate,olderLibrary:older});assert.deepEqual(first.written,[[file,{choice:'new',offer:true}]]);
  // The offer and separate folders persist until answered, also once the new library exists.
  const pending=run({files:[own,own2],answers:saved('new',true)});assert.deepEqual(pending.result,{...separate,olderLibrary:older});assert.deepEqual(pending.written,[]);
  // Keeping this one ends the offer; opening the older one uses the established location.
  assert.deepEqual(run({files:[own,own2],answers:saved('new')}).result,separate);
  const existing=run({answers:saved('existing')}).result;
  assert.equal(existing.dataDir,p.join(DOCS,'Exomina','Private','data'));assert.equal(existing.workspace,p.join(DOCS,'Exomina','Workspace'));assert.equal(existing.olderLibrary,undefined);
  assert.equal(run({files:[own,own2],answers:saved('existing')}).result.dataDir,p.join(DOCS,'Exomina','Private','data'));
  // A corrupt answer is treated as unanswered, never as permission to open the older library.
  assert.equal(parseBetaProfileChoice('nonsense'),undefined);assert.equal(parseBetaProfileChoice('{"choice":"elsewhere"}'),undefined);assert.deepEqual(parseBetaProfileChoice('\uFEFF{"choice":"new"}'),{choice:'new',offer:false});
  assert.deepEqual(run({answers:{[file]:'nonsense'}}).result,{...separate,olderLibrary:older});
  // No offer without an older library, with an established beta library, or outside the beta.
  for(const scenario of [{files:[]},{files:[own,own2]},{dist:null},{dist:{profile:'beta',manualUpdates:false}},{home:'C:\\Installed'},{env:{LOCALAPPDATA:LOCAL,EXOMINA_DATA_DIR:'C:\\QA'}}]){const {result,written}=run(scenario);assert.equal(result.olderLibrary,undefined);assert.deepEqual(written,[]);}
  assert.equal(run({files:[]}).result.dataDir,p.join(LOCAL,'Exomina','Private','data'));
  assert.equal(run({files:[]}).result.workspace,p.join(DOCS,'Exomina','Workspace'));
});
