import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,readFile,writeFile,copyFile,stat,readdir,realpath} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {BETA_INSTALLER_GUID,BETA_APP_ID} from './beta-installer-config.mjs';
import {shippingInstallerPathLimits} from './beta-installer-path-limits.mjs';

const nativeRun=promisify(execFile);
const run=(file,values,options={})=>nativeRun(file,values,{...options,env:{...process.env,...options.env,TEMP:qaBase,TMP:qaBase,TMPDIR:qaBase}});
const here=path.dirname(fileURLToPath(import.meta.url)),project=path.resolve(here,'..');
const args=process.argv.slice(2),option=name=>{const index=args.indexOf(name);return index<0?undefined:args[index+1];};
if(process.platform!=='win32')throw Error('Installer QA requires Windows.');
const metadata=JSON.parse(await readFile(path.join(project,'package.json'),'utf8'));
const installer=path.resolve(option('--installer')||path.join(project,'release','Exomina-Beta-'+metadata.version+'-windows-x64-Setup.exe'));
const build=path.resolve(option('--build')||path.join(project,'release','win-unpacked'));
const workspace=path.resolve(option('--workspace')||path.join(project,'..'));
const qaBase=path.join(workspace,'.exomina-qa-temp');
await mkdir(qaBase,{recursive:true});
// Keep synthetic install paths representative of the default per-user folder.
// NSIS's legacy remove/rename functions can fail beyond Win32 MAX_PATH even
// though its archive extractor successfully creates the same long filenames.
const limits=await shippingInstallerPathLimits(build);
const output=await mkdtemp(path.join(qaBase,'i'));
const boundaryPadding=limits.maxInstallRootChars-path.join(output,'Exomina Beta').length;
assert.ok(boundaryPadding>=0,'The explicit QA root must allow a representative per-user program path.');
const installDir=path.join(output,'Exomina Beta'+'x'.repeat(boundaryPadding));
const privateFixture=path.join(output,'untouched-personal-data'),sentinel=path.join(privateFixture,'sentinel.json');
const sentinelValue=JSON.stringify({synthetic:true,value:randomUUID()});
await mkdir(privateFixture,{recursive:true});await writeFile(sentinel,sentinelValue);
const exists=async value=>{try{await stat(value);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}};
const within=(root,value)=>{const relative=path.relative(root,value);return relative!==''&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);};
assert.ok(within(qaBase,output)&&within(output,installDir),'The installer target must remain inside the explicit synthetic QA root.');
assert.ok(await exists(installer)&&await exists(path.join(build,'Exomina.exe')),'Build the beta installer before running installer QA.');
const installedExe=path.join(installDir,'Exomina.exe'),uninstaller=path.join(installDir,'Uninstall Exomina.exe');
const report={scope:'Actual silent NSIS install/reinstall/uninstall in an explicit synthetic target; no user sign-in, model request, private store or normal app launch.',installer,build,output,appId:BETA_APP_ID,installerGuid:BETA_INSTALLER_GUID,checks:{},errors:[]};
async function hash(file){const digest=createHash('sha256');for await(const bytes of createReadStream(file))digest.update(bytes);return digest.digest('hex');}
function execution(file,values,{timeoutMs=600000,tempRoot=qaBase,...options}={}){
  return new Promise((resolve,reject)=>{
    const started=Date.now();
    const child=spawn(file,values,{cwd:output,windowsHide:true,windowsVerbatimArguments:true,shell:false,stdio:['ignore','pipe','pipe'],...options,env:{...process.env,...options.env,TEMP:tempRoot,TMP:tempRoot,TMPDIR:tempRoot}});
    let stdout='',stderr='',settled=false;
    const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(result);};
    const timer=setTimeout(()=>{child.kill();finish(Error('The synthetic installer process timed out.'));},timeoutMs);
    child.stdout.on('data',bytes=>{stdout=(stdout+bytes).slice(-4000);});child.stderr.on('data',bytes=>{stderr=(stderr+bytes).slice(-4000);});
    child.on('error',error=>finish(error));child.on('close',code=>finish(null,{code,stdout,stderr,durationMs:Date.now()-started}));
  });
}
async function registration(hive='HKCU'){
  try{
    const key=hive+'\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\'+BETA_INSTALLER_GUID;
    const {stdout}=await run(path.join(process.env.SystemRoot,'System32','reg.exe'),['query',key,'/reg:64'],{windowsHide:true,timeout:10000});
    const fields={};for(const line of stdout.split(/\r?\n/)){const match=line.match(/^\s+(\S+)\s+REG_\w+\s+(.*)$/);if(match)fields[match[1]]=match[2].trim();}
    // NSIS stores InstallLocation/shortcut ownership in its distinct install
    // key; the Add/Remove Programs entry contains display/uninstall metadata.
    const installKey=hive+'\\Software\\'+BETA_INSTALLER_GUID;
    const installed=await run(path.join(process.env.SystemRoot,'System32','reg.exe'),['query',installKey,'/reg:64'],{windowsHide:true,timeout:10000});
    for(const line of installed.stdout.split(/\r?\n/)){const match=line.match(/^\s+(\S+)\s+REG_\w+\s+(.*)$/);if(match)fields[match[1]]=match[2].trim();}
    return fields;
  }catch(error){if(error.code===1)return null;throw error;}
}
async function waitUntil(probe,predicate,timeoutMs=10000){
  const deadline=Date.now()+timeoutMs;while(Date.now()<deadline){const result=await probe();if(predicate(result))return result;await new Promise(resolve=>setTimeout(resolve,100));}
  throw Error('The synthetic installer outcome did not become ready.');
}
async function powershellHelper(name,source,input){
  const script=path.join(output,name+'.ps1');await writeFile(script,source);
  return new Promise((resolve,reject)=>{
    const child=spawn(path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script],{windowsHide:true,shell:false,stdio:['pipe','pipe','pipe'],env:{...process.env,TEMP:qaBase,TMP:qaBase,TMPDIR:qaBase}});let text='',error='';
    const timer=setTimeout(()=>{child.kill();reject(Error('The synthetic PowerShell helper timed out.'));},30000);
    child.stdout.on('data',bytes=>text+=bytes);child.stderr.on('data',bytes=>error=(error+bytes).slice(-4000));child.on('error',failure=>{clearTimeout(timer);reject(failure);});child.on('close',code=>{clearTimeout(timer);try{if(code!==0)throw Error(error||'The synthetic helper failed.');resolve(JSON.parse(text));}catch(failure){reject(failure);}});child.stdin.end(JSON.stringify(input));
  });
}
async function boundaryTempFolders(){
  const result=await powershellHelper('read-public-short-temp-root',`$ErrorActionPreference = 'Stop'
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System.Text;using System.Runtime.InteropServices;
public static class ExominaShortProgramPathQA {
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern uint GetShortPathName(string input,StringBuilder output,uint capacity);
}
'@
$text = New-Object Text.StringBuilder 32768
$count = [ExominaShortProgramPathQA]::GetShortPathName($request.path,$text,[uint32]$text.Capacity)
if ($count -eq 0) { throw 'The public QA folder short path could not be read' }
@{ path = $text.ToString() } | ConvertTo-Json -Compress
`,{path:qaBase});
  assert.equal((await realpath(result.path)).toLowerCase(),(await realpath(qaBase)).toLowerCase(),'The short alias must reference only the chosen public QA root.');
  async function atLength(chars){
    const size=chars-result.path.length-1;
    assert.ok(size>=4,'This workspace cannot represent the requested native TEMP boundary without leaving its QA root.');
    const name=randomUUID().replaceAll('-','').padEnd(size,'t').slice(0,size),folder=path.join(result.path,name);
    await mkdir(folder);
    assert.equal(folder.length,chars);assert.ok(within(await realpath(qaBase),await realpath(folder)));
    return folder;
  }
  return {accepted:await atLength(limits.maxTempRootChars),rejected:await atLength(limits.maxTempRootChars+1)};
}
async function programManifest(){
  const files=[];async function walk(relative=''){for(const entry of await readdir(path.join(installDir,relative),{withFileTypes:true})){const child=relative?path.join(relative,entry.name):entry.name;if(entry.isDirectory())await walk(child);else if(entry.isFile()){const item=await stat(path.join(installDir,child));files.push([child,item.size,item.mtimeMs]);}else throw Error('Unexpected link in the synthetic installed program.');}}
  await walk();files.sort((left,right)=>left[0].localeCompare(right[0]));return JSON.stringify(files);
}
async function recordReinstallRefusal(result,baseline){
  const expected=new Map(baseline.files.map(file=>[file.path.replaceAll('\\','/').toLowerCase(),file]));
  const diagnostic={installerExitCode:result.code,added:[],changed:[],missing:[]};
  async function visit(relative=''){
    for(const entry of await readdir(path.join(installDir,relative),{withFileTypes:true})){
      const child=relative?relative+'/'+entry.name:entry.name;
      if(entry.isDirectory())await visit(child);
      else if(entry.isFile()){
        const item=expected.get(child.toLowerCase());
        if(!item)diagnostic.added.push(child);
        else{
          expected.delete(child.toLowerCase());
          const actual=await stat(path.join(installDir,child));
          if(actual.size!==item.size||await hash(path.join(installDir,child))!==item.sha256)diagnostic.changed.push(child);
        }
      }else diagnostic.added.push(child+' [unexpected filesystem entry]');
    }
  }
  await visit();diagnostic.missing=[...expected.values()].map(file=>file.path);
  const host=path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
  const env={...process.env,TEMP:qaBase,TMP:qaBase,TMPDIR:qaBase};delete env.PSModulePath;
  try{
    const output=await nativeRun(host,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',path.join(project,'scripts','verify-beta-update.ps1'),'-App',installDir],{windowsHide:true,encoding:'utf8',timeout:600000,env});
    diagnostic.guard={code:0,stdout:output.stdout,stderr:output.stderr};
  }catch(error){diagnostic.guard={code:error.code,stdout:error.stdout||'',stderr:error.stderr||'',message:error.message};}
  report.checks.reinstallRefusal=diagnostic;
  console.log('Installed baseline diagnostic: '+JSON.stringify(diagnostic));
}
async function prepareProgramFolder(){
  await mkdir(installDir);
  // Workspace fixtures may inherit EFS. Clear it only on this empty, dedicated
  // program destination, matching the normal Local AppData Programs install.
  // The external synthetic private-data sentinel keeps its existing protection.
  const script=path.join(output,'prepare-empty-program-folder.ps1');
  await writeFile(script, "$ErrorActionPreference = 'Stop'\n$request = [Console]::In.ReadToEnd() | ConvertFrom-Json\n$root = [IO.Path]::GetFullPath($request.root).TrimEnd('\\')\n$target = [IO.Path]::GetFullPath($request.path).TrimEnd('\\')\nif (-not $target.StartsWith($root + '\\', [StringComparison]::OrdinalIgnoreCase)) { throw 'The program fixture is outside its dedicated root' }\n$item = Get-Item -LiteralPath $target -Force\nif (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or (Get-ChildItem -LiteralPath $target -Force | Select-Object -First 1)) { throw 'The program fixture must be an empty real directory' }\n[IO.File]::Decrypt($target)\n$item = Get-Item -LiteralPath $target -Force\nif (($item.Attributes -band [IO.FileAttributes]::Encrypted) -ne 0) { throw 'The empty public program fixture still inherits encryption' }\n@{ emptyProgramDirectory = $true; encrypted = $false } | ConvertTo-Json -Compress\n");
  const result=await new Promise((resolve,reject)=>{
    const child=spawn(path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script],{windowsHide:true,shell:false,stdio:['pipe','pipe','pipe'],env:{...process.env,TEMP:qaBase,TMP:qaBase,TMPDIR:qaBase}});let text='';
    const timer=setTimeout(()=>{child.kill();reject(Error('The empty program fixture preparation timed out.'));},10000);
    child.stdout.on('data',bytes=>{text+=bytes;});child.stderr.resume();child.on('error',error=>{clearTimeout(timer);reject(error);});child.on('close',code=>{clearTimeout(timer);try{if(code!==0)throw Error('The empty program fixture preparation failed.');resolve(JSON.parse(text));}catch(error){reject(error);}});child.stdin.end(JSON.stringify({root:output,path:installDir}));
  });
  assert.equal(result.emptyProgramDirectory,true);assert.equal(result.encrypted,false);
  report.programDirectory={matchesDefaultProgramEncryption:true,externalDataProtectionUnchanged:true};
}
const programs=path.join(process.env.APPDATA,'Microsoft','Windows','Start Menu','Programs'),shortcut=path.join(programs,'Exomina Beta.lnk');
let lockedProcess,ownedRegistration=false,uninstalled=false;
async function stopOwnedLock(){
  if(!lockedProcess)return;
  const child=lockedProcess;lockedProcess=null;
  if(child.exitCode===null){const closed=new Promise(resolve=>child.once('close',resolve));child.kill();await closed;}
}
async function uninstallOwned(){
  const registered=await registration();
  if(!registered||path.resolve(registered.InstallLocation)!==installDir)return;
  assert.ok(await exists(uninstaller),'Only the matching synthetic installation may be uninstalled.');
  const helper=path.join(output,'synthetic-uninstaller.exe');await copyFile(uninstaller,helper);
  assert.equal(await hash(helper),await hash(uninstaller));
  report.uninstallerSha256=await hash(helper);
  // The copied executable may remove the app folder completely. _?= must be the
  // final unquoted NSIS argument and is constrained to the verified fixture.
  const result=await execution(helper,['/S','/currentuser','_?='+installDir]);
  report.timings||={};report.timings.uninstallMs=result.durationMs;
  assert.equal(result.code,0,'The synthetic uninstaller must succeed.');
  await waitUntil(()=>registration(),value=>value===null);
  assert.equal(await exists(installDir),false,'The entire owned program folder must be removed, including long nested files.');
  uninstalled=true;
}
try{
  assert.equal(await registration(),null,'Existing beta registration must not be modified by QA.');
  assert.equal(await registration('HKLM'),null,'Existing machine beta registration must not be modified by QA.');
  assert.equal(await exists(shortcut),false,'An existing beta shortcut must not be modified by QA.');
  report.installerSha256=await hash(installer);
  report.pathLimits=limits;
  const boundaryTemps=await boundaryTempFolders();
  report.nativeBoundaryPaths={installRootChars:installDir.length,tempAcceptedChars:boundaryTemps.accepted.length,tempRejectedChars:boundaryTemps.rejected.length};
  const marker=JSON.parse(await readFile(path.join(build,'exomina.distribution.json'),'utf8'));
  assert.equal(marker.profile,'beta');assert.equal(marker.manualUpdates,true);assert.equal(marker.home,undefined);
  const sourceStamp=JSON.parse(await readFile(path.join(build,'exomina.build.json'),'utf8'));
  const baseline=JSON.parse(await readFile(path.join(build,'exomina.release-integrity.json'),'utf8'));
  assert.equal(baseline.format,1);assert.equal(baseline.buildId,sourceStamp.id);
  assert.ok(baseline.files.some(file=>file.path==='Exomina.exe'),'The manual installer needs its program baseline.');
  await prepareProgramFolder();
  const existingProject=path.join(output,'Exomina Beta P'),projectFile=path.join(existingProject,'preserve.txt');
  assert.ok(existingProject.length<=limits.maxInstallRootChars,'Nonempty-folder refusal must exercise ownership rather than the long-path guard.');
  await mkdir(existingProject);await writeFile(projectFile,sentinelValue);
  console.log('Checking refusal of a nonempty unrelated destination before copying app files.');
  const refused=await execution(installer,['/S','/currentuser','/D='+existingProject]);
  assert.notEqual(refused.code,0,'A first install must refuse a nonempty unrelated folder.');
  assert.equal(await readFile(projectFile,'utf8'),sentinelValue);
  assert.deepEqual(await readdir(existingProject),['preserve.txt']);
  assert.equal(await registration(),null);assert.equal(await exists(shortcut),false);
  report.checks.unrelatedDestination={refused:true,existingFilesUnchanged:true,noFilesCopied:true,noRegistrationOrShortcutCreated:true};
  const longDestination=path.join(output,'Exomina Beta'+'y'.repeat(boundaryPadding+1)),longSentinel=path.join(longDestination,'preserve.txt');
  assert.equal(longDestination.length,limits.maxInstallRootChars+1);
  await mkdir(longDestination);await writeFile(longSentinel,sentinelValue);
  console.log('Checking rejection of an installation root one character beyond its safe boundary.');
  let result=await execution(installer,['/S','/currentuser','/D='+longDestination],{tempRoot:boundaryTemps.accepted});
  assert.equal(result.code,10);assert.equal(await readFile(longSentinel,'utf8'),sentinelValue);assert.deepEqual(await readdir(longDestination),['preserve.txt']);
  assert.equal(await registration(),null);assert.equal(await exists(shortcut),false);
  report.checks.longInstallRoot={durationMs:result.durationMs,chars:longDestination.length,refusedBeforeCopy:true,existingDataPreserved:true};
  console.log('Checking rejection of a TEMP root one character beyond its safe boundary.');
  result=await execution(installer,['/S','/currentuser','/D='+installDir],{tempRoot:boundaryTemps.rejected});
  assert.equal(result.code,10);assert.deepEqual(await readdir(installDir),[]);assert.equal(await registration(),null);assert.equal(await exists(shortcut),false);
  report.checks.longTempRoot={durationMs:result.durationMs,chars:boundaryTemps.rejected.length,refusedBeforeCopy:true};
  console.log('Checking actual silent first installation in the synthetic target.');
  result=await execution(installer,['/S','/currentuser','/D='+installDir],{tempRoot:boundaryTemps.accepted});
  report.timings={firstInstallMs:result.durationMs};
  assert.equal(result.code,0,'The silent synthetic install must succeed.');
  const registered=await registration();
  assert.equal(path.resolve(registered.InstallLocation),installDir);ownedRegistration=true;
  assert.equal(registered.DisplayName,'Exomina Beta');
  assert.equal(await hash(installedExe),await hash(path.join(build,'Exomina.exe')));
  assert.deepEqual(JSON.parse(await readFile(path.join(installDir,'exomina.distribution.json'),'utf8')),marker);
  assert.deepEqual(JSON.parse(await readFile(path.join(installDir,'exomina.build.json'),'utf8')),sourceStamp);
  assert.equal(await exists(path.join(installDir,'exomina.paths.json')),false);
  assert.ok(await exists(shortcut)&&await exists(uninstaller));
  const shortcutScript=path.join(output,'read-shortcut.ps1');
  await writeFile(shortcutScript, "$ErrorActionPreference = 'Stop'\n$request = [Console]::In.ReadToEnd() | ConvertFrom-Json\nif (-not (Test-Path -LiteralPath $request.path -PathType Leaf)) { throw 'Missing synthetic shortcut' }\n$shell = New-Object -ComObject WScript.Shell\n$link = $shell.CreateShortcut($request.path)\n@{ target = $link.TargetPath; workingDirectory = $link.WorkingDirectory } | ConvertTo-Json -Compress\n");
  const shortcutData=await new Promise((resolve,reject)=>{
    const child=spawn(path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',shortcutScript],{windowsHide:true,shell:false,stdio:['pipe','pipe','pipe'],env:{...process.env,TEMP:qaBase,TMP:qaBase,TMPDIR:qaBase}});let text='';
    child.stdout.on('data',bytes=>{text+=bytes;});child.stderr.resume();child.on('error',reject);child.on('close',code=>{try{if(code!==0)throw Error('Synthetic shortcut readback failed.');resolve(JSON.parse(text));}catch(error){reject(error);}});child.stdin.end(JSON.stringify({path:shortcut}));
  });
  assert.equal(path.resolve(shortcutData.target),installedExe);
  report.checks.freshInstall={durationMs:result.durationMs,exeMatchesBuild:true,markerMatchesBuild:true,stampMatchesBuild:true,separatePerUserRegistration:true,shortcutTargetsOwnExe:true,noPersonalHomeMarker:true};
  assert.equal(await readFile(sentinel,'utf8'),sentinelValue);
  console.log('Checking actual silent reinstall and preservation of the external synthetic data.');
  result=await execution(installer,['/S','/currentuser','/D='+installDir],{tempRoot:boundaryTemps.accepted});
  if(result.code!==0)await recordReinstallRefusal(result,baseline);
  assert.equal(result.code,0,'The silent synthetic reinstall must succeed.');
  assert.equal(await hash(installedExe),await hash(path.join(build,'Exomina.exe')));
  assert.equal(await readFile(sentinel,'utf8'),sentinelValue);
  report.checks.reinstall={durationMs:result.durationMs,successful:true,exeMatchesBuild:true,externalPersonalDataPreserved:true};
  console.log('Checking update-mode TEMP refusal preserves every owned program file.');
  const manifestBefore=await programManifest(),registrationBefore=await registration();
  const updateHelper=path.join(output,'synthetic-update-uninstaller.exe');await copyFile(uninstaller,updateHelper);
  result=await execution(updateHelper,['/S','/KEEP_APP_DATA','/currentuser','--updated','_?='+installDir],{tempRoot:boundaryTemps.rejected});
  assert.equal(result.code,10);assert.equal(await programManifest(),manifestBefore);assert.deepEqual(await registration(),registrationBefore);assert.equal(await readFile(sentinel,'utf8'),sentinelValue);
  report.checks.longUpdateTemp={durationMs:result.durationMs,refusedBeforeRemoval:true,everyProgramFilePreserved:true,ownRegistrationPreserved:true};
  console.log('Checking a failing previous-version uninstaller returns a silent failure instead of hanging.');
  const originalUninstaller=path.join(output,'original-owned-uninstaller.exe'),failingUninstaller=path.join(output,'failing-owned-uninstaller.exe');
  await copyFile(uninstaller,originalUninstaller);
  await powershellHelper('compile-failing-own-uninstaller',`$ErrorActionPreference = 'Stop'
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$root = [IO.Path]::GetFullPath($request.root).TrimEnd('\\')
$target = [IO.Path]::GetFullPath($request.path)
if (-not $target.StartsWith($root + '\\', [StringComparison]::OrdinalIgnoreCase)) { throw 'The synthetic stub target is outside its own fixture' }
Add-Type -TypeDefinition 'public static class ExominaFailingOwnedUninstallerQA { public static int Main(string[] args) { return 2; } }' -OutputAssembly $target -OutputType ConsoleApplication
@{ created = $true } | ConvertTo-Json -Compress
`,{root:output,path:failingUninstaller});
  try{
    await copyFile(failingUninstaller,uninstaller);
    const failedManifest=await programManifest();
    result=await execution(installer,['/S','/currentuser','/D='+installDir],{tempRoot:boundaryTemps.accepted,timeoutMs:30000});
    assert.equal(result.code,10);assert.equal(await programManifest(),failedManifest);assert.deepEqual(await registration(),registrationBefore);
    report.checks.oldUninstallerFailure={durationMs:result.durationMs,returnedSilently:true,programFilesPreserved:true,ownRegistrationPreserved:true};
  }finally{await copyFile(originalUninstaller,uninstaller);}
  lockedProcess=spawn(installedExe,['--input-type=module','-e','process.stdout.write("QA_LOCK_READY");setInterval(()=>{},1000)'],{cwd:output,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe'],env:{...process.env,ELECTRON_RUN_AS_NODE:'1',TEMP:output,TMP:output,TMPDIR:output}});
  await new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(Error('Synthetic destination-lock process failed to start.')),10000);lockedProcess.stdout.on('data',bytes=>{text+=bytes;if(text.includes('QA_LOCK_READY')){clearTimeout(timer);resolve();}});lockedProcess.on('error',error=>{clearTimeout(timer);reject(error);});lockedProcess.on('exit',code=>{clearTimeout(timer);reject(Error('Synthetic destination-lock process exited: '+code));});lockedProcess.stderr.resume();});
  console.log('Checking refusal of a busy synthetic destination without closing its process.');
  result=await execution(installer,['/S','/currentuser','/D='+installDir]);
  assert.notEqual(result.code,0,'A busy destination must be refused.');
  assert.equal(lockedProcess.exitCode,null,'The installer must not close even its own busy synthetic destination.');
  assert.equal(await hash(installedExe),await hash(path.join(build,'Exomina.exe')));
  report.checks.busyDestination={durationMs:result.durationMs,refused:true,ownProcessNotTerminated:true,installedExeUnchanged:true};
  await stopOwnedLock();
  console.log('Checking actual silent uninstall and preservation of the external synthetic data.');
  await uninstallOwned();
  assert.equal(await exists(installedExe),false);assert.equal(await exists(shortcut),false);
  assert.equal(await readFile(sentinel,'utf8'),sentinelValue);
  assert.equal(await registration(),null);
  report.checks.uninstall={entireProgramDirectoryRemoved:true,programRemoved:true,ownShortcutRemoved:true,ownRegistrationRemoved:true,externalPersonalDataPreserved:true};
  report.build=sourceStamp;report.ok=true;
}catch(error){report.ok=false;report.errors.push(error.message);process.exitCode=1;}
finally{
  await stopOwnedLock();
  if(ownedRegistration&&!uninstalled){try{await uninstallOwned();report.cleanup={ownInstallationRemoved:true};}catch(error){report.cleanup={ownInstallationRemoved:false,message:error.message};}}
  await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({ok:report.ok,report:path.join(output,'report.json'),checks:report.checks,errors:report.errors},null,2));
}
