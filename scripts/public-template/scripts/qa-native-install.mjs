// Disposable native CI only. Installs this build, never an existing user app.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,readdir,stat,readFile,writeFile,access,rm,chmod} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {sandboxedAppRun} from './cross-platform-config.mjs';

if(process.env.GITHUB_ACTIONS!=='true'||process.env.CI!=='true')throw Error('Native install/remove QA is restricted to a disposable GitHub Actions runner.');
if(!['darwin','linux'].includes(process.platform))throw Error('Native installer QA requires macOS or Linux.');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const option=name=>{const index=process.argv.indexOf(name);return index<0?undefined:process.argv[index+1];};
if(!option('--installer')||!option('--output'))throw Error('Pass --installer and a report-only --output directory.');
const asset=path.resolve(option('--installer')),output=path.resolve(option('--output'));
await mkdir(output,{recursive:true});
const work=path.join(root,'.runtime-work');await mkdir(work,{recursive:true,mode:0o700});
const stage=await mkdtemp(path.join(work,'native-install-'));await chmod(stage,0o700);
const run=async(command,args,options={})=>promisify(execFile)(command,args,{cwd:stage,env:process.env,timeout:120000,maxBuffer:65536,...options});
const hash=async file=>createHash('sha256').update(await readFile(file)).digest('hex');
const exists=async file=>{try{await access(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}};
function owned(target){const relative=path.relative(stage,path.resolve(target));if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw Error('Install fixture operation must stay inside its exact disposable directory.');}
const report={platform:process.platform,arch:process.arch,installer:path.basename(asset),sha256:await hash(asset),startedAt:new Date().toISOString(),
 scope:'Disposable native runner; exact installer program files and fresh synthetic profile. No account login, inference, microphone, desktop capture/input or real-user profile access.',checks:{},limitations:[],passed:false};
let mount,installedDeb=false,installedApp;
async function desktop(executable,kind){
 const destination=path.join(output,kind);await mkdir(destination,{recursive:true});
 const result=await run(process.execPath,[path.join(root,'scripts','qa-native-desktop.mjs'),'--executable',executable,'--output',destination],{timeout:180000,maxBuffer:65536});
 const summary=JSON.parse(await readFile(path.join(destination,'native-desktop-report.json'),'utf8'));
 assert.equal(summary.passed,true);report.checks[kind]={startupPassed:true,mode:summary.checks.standardFirstRun.mode,version:summary.version,buildId:summary.buildId};
 // The report and app-only screenshot are the only outputs selected for upload.
 return result;
}
try{
 if(process.platform==='darwin'){
  assert.equal(path.extname(asset),'.dmg');
  mount=path.join(stage,'mounted');owned(mount);await mkdir(mount);
  await run('hdiutil',['attach',asset,'-readonly','-nobrowse','-mountpoint',mount]);
  const apps=(await readdir(mount,{withFileTypes:true})).filter(entry=>entry.isDirectory()&&entry.name.endsWith('.app'));
  assert.equal(apps.length,1);
  const original=path.join(mount,apps[0].name);
  const userApplications=path.join(stage,'Applications');owned(userApplications);await mkdir(userApplications);
  installedApp=path.join(userApplications,apps[0].name);owned(installedApp);
  await run('ditto',[original,installedApp]);
  const originalResources=path.join(original,'Contents','Resources'),resources=path.join(installedApp,'Contents','Resources');
  assert.equal(await hash(path.join(originalResources,'app.asar')),await hash(path.join(resources,'app.asar')));
  const info=await run('/usr/libexec/PlistBuddy',['-c','Print :CFBundleExecutable',path.join(installedApp,'Contents','Info.plist')]);
  const name=info.stdout.trim();assert.ok(name&&!name.includes('/')&&!name.includes('\\'));
  const executable=path.join(installedApp,'Contents','MacOS',name);
  assert.equal(await hash(executable),await hash(path.join(original,'Contents','MacOS',name)));
  await run('codesign',['--verify','--deep','--strict','--verbose=2',installedApp]);
  const signing=await run('codesign',['--display','--verbose=4',installedApp]);
  assert.match(signing.stdout+signing.stderr,/Signature=adhoc/);
  report.checks.adHocSignatureVerified=true;
  report.checks.mountedReadOnlyAndCopiedExactApp=true;
  await run('hdiutil',['detach',mount]);mount=null;
  await desktop(executable,'macos-installed-copy');
  await rm(installedApp,{recursive:true,force:false});assert.equal(await exists(installedApp),false);installedApp=null;
  report.checks.perUserCopyRemoval=true;
  report.limitations=['Ad-hoc signed beta: Developer ID notarization and Gatekeeper download/quarantine behavior are not verified.','Copied into a disposable per-user Applications fixture; global /Applications integration and physical hardware are not tested.'];
 }else if(asset.endsWith('.deb')){
  const fields=await run('dpkg-deb',['--field',asset,'Package']);assert.equal(fields.stdout.trim(),'exomina-beta');
  let previous=false;try{await run('dpkg-query',['--show','--showformat=${Status}','exomina-beta']);previous=true;}catch(error){if(error.code!==1)throw error;}
  assert.equal(previous,false,'Do not replace or uninstall a pre-existing beta package.');
  await run('sudo',['-n','apt-get','install','-y',asset],{timeout:180000});installedDeb=true;
  const executable='/opt/Exomina Beta/exomina-beta';
  // Verify exact package ownership without buffering the entire bundled runtime
  // file inventory (which legitimately exceeds the bounded subprocess output).
  const ownership=await run('dpkg-query',['--search',executable]);
  assert.equal(ownership.stdout.trim(),'exomina-beta: '+executable);
  const installedResources=path.join(path.dirname(executable),'resources');
  assert.ok(await exists(path.join(installedResources,'app.asar')));
  report.checks.debSystemInstall=true;
  await desktop(executable,'linux-deb-installed');
  await run('sudo',['-n','dpkg','--remove','exomina-beta']);installedDeb=false;
  assert.equal(await exists(executable),false);report.checks.debRemoval=true;
  report.limitations=['Disposable Ubuntu runner with Xvfb; other distributions, real desktop sessions and physical hardware remain unverified.'];
 }else if(asset.endsWith('.AppImage')){
  await chmod(asset,0o755);
  await run(asset,['--appimage-extract'],{timeout:120000,maxBuffer:16384*1024});
  const extracted=path.join(stage,'squashfs-root');owned(extracted);
  const appRun=path.join(extracted,'AppRun');assert.ok((await stat(appRun)).isFile());
  assert.equal(await readFile(appRun,'utf8'),sandboxedAppRun,'AppImage must use the fail-closed sandbox launcher.');
  for(const entry of await readdir(extracted))if(entry.endsWith('.desktop')){
   assert.ok(!/--(?:no-sandbox|disable-setuid-sandbox)(?:[\s=]|$)/.test(await readFile(path.join(extracted,entry),'utf8')),'AppImage desktop entry must not disable the sandbox.');
  }
  report.checks.appImageExtraction=true;
  await desktop(appRun,'linux-appimage-extracted');
  await rm(extracted,{recursive:true,force:false});assert.equal(await exists(extracted),false);
  report.checks.extractedProgramRemoval=true;
  report.limitations=['Exact extracted AppImage startup; FUSE mounting and desktop shortcut integration are not tested.','Normal Chromium sandbox is retained; no --no-sandbox bypass is used.'];
 }else throw Error('Select the native DMG, DEB or AppImage installer.');
 report.passed=true;
}catch(error){report.failure=String(error.message).slice(0,2000);throw error;}
finally{
 if(mount)await run('hdiutil',['detach',mount]).catch(()=>{});
 if(installedDeb)await run('sudo',['-n','dpkg','--remove','exomina-beta']).catch(()=>{});
 report.finishedAt=new Date().toISOString();await writeFile(path.join(output,'native-install-report.json'),JSON.stringify(report,null,2)+'\n');
}
console.log(JSON.stringify(report,null,2));
