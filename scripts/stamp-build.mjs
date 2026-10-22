// Marks a packaged build with a unique ID so an installed Exomina can tell that
// release\win-unpacked holds a newer build. Runs after electron-builder.
import {writeFile,readFile,stat,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {extractFile,listPackage} from '@electron/asar';
import {snapshotSource,readSnapshot,writeTree,SOURCE_FOLDER} from '../desktop/update-source.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
if(args.length&&(args.length!==2||args[0]!=='--build-dir'||!args[1]))throw Error('Use stamp-build.mjs [--build-dir <packaged directory>].');
const build=args.length?path.resolve(args[1]):path.join(root,'release','win-unpacked');
await stat(path.join(build,'Exomina.exe'));
const {version}=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
const packaged=JSON.parse(extractFile(path.join(build,'resources','app.asar'),'package.json'));
const metadata=JSON.parse(await readFile(path.join(build,'resources','app.asar.unpacked','desktop','app-version.json'),'utf8'));
if(packaged.version!==version||metadata.version!==version)throw Error('The packaged version differs from its source or desktop metadata. Run npm run package again before stamping this update.');
// Never publish the abandoned browser-launch experiment. This is independent
// of the packaging exclusion and also catches accidental helper reintroduction.
const abandonedBrowserFiles=listPackage(path.join(build,'resources','app.asar')).filter(entry=>{
  const relative=entry.replaceAll('\\','/').replace(/^\/+/, '');
  return relative==='desktop/antigravity-browser.mjs'||relative==='scripts/prepare-antigravity-browser.mjs'||relative==='desktop/antigravity-browser'||relative.startsWith('desktop/antigravity-browser/');
});
if(abandonedBrowserFiles.length)throw Error('The abandoned browser-launch helper is present in this package. No update was stamped.');
const stamp={id:randomUUID(),version,builtAt:new Date().toISOString()};
const snapshot=path.join(build,SOURCE_FOLDER);
let officialSource=process.env.EXOMINA_OFFICIAL_SOURCE;
if(!officialSource&&process.env.EXOMINA_PUBLISHER_BUILD!=='1'){
  const installedBaseline=path.join(root,'..','App',SOURCE_FOLDER);
  if((await stat(path.join(installedBaseline,'manifest.json')).catch(()=>null))?.isFile())officialSource=installedBaseline;
}
// electron-builder preserves extra files between directory builds; refresh this exact child only.
if(path.dirname(snapshot)!==build)throw Error('Invalid release source destination.');
await rm(snapshot,{recursive:true,force:true});
if(officialSource){
  const official=path.resolve(officialSource),manifestBytes=await readFile(path.join(official,'manifest.json')),verified=await readSnapshot(official);
  stamp.officialId=verified.manifest.release.id;stamp.officialVersion=verified.manifest.release.version;stamp.customized=true;
  // Write fresh files instead of copying: a copy keeps EFS encryption from the
  // Workspace or an installed snapshot, and program files must stay plain.
  await writeTree(path.join(snapshot,'files'),verified.files);
  await writeFile(path.join(snapshot,'manifest.json'),manifestBytes,{flag:'wx'});
  const written=await readSnapshot(snapshot);
  if(written.manifest.treeHash!==verified.manifest.treeHash||written.manifest.release.id!==verified.manifest.release.id)throw Error('The release source snapshot changed while it was written.');
}else await snapshotSource(root,snapshot,stamp);
await writeFile(path.join(build,'exomina.build.json'),JSON.stringify(stamp,null,2)+'\n');
if(process.platform==='win32'){
  // A build made inside an encrypted folder inherits EFS on every file.
  const {stdout}=await promisify(execFile)(path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),[
    '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts','decrypt-package.ps1'),'-Directory',build
  ],{windowsHide:true,encoding:'utf8',timeout:600000}).catch(error=>{throw Error('Program files could not be decrypted: '+String(error.stdout||error.message).trim());});
  if(JSON.parse(stdout).remaining!==0)throw Error('Program files remain EFS-encrypted.');
  console.log('EFS check: '+stdout.trim());
}
console.log(`Stamped build ${stamp.id} (${version})`);
