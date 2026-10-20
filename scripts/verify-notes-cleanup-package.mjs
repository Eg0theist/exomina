import {readFile,readdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {extractFile,listPackage} from '@electron/asar';
import assert from 'node:assert/strict';

const root=process.cwd(),build=path.join(root,'release/win-unpacked'),archive=path.join(build,'resources/app.asar'),unpacked=archive+'.unpacked';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex'),checked=[];
async function compare(relative){
 for(const entry of await readdir(path.join(root,relative),{withFileTypes:true})){
  if(entry.name==='__pycache__'||entry.name.endsWith('.pyc'))continue;
  const file=path.join(relative,entry.name);if(file.replaceAll('\\','/').startsWith('desktop/antigravity-browser'))continue;
  if(entry.isDirectory()){await compare(file);continue;}
  assert.ok(entry.isFile());const source=await readFile(path.join(root,file)),packed=file.startsWith('desktop')?await readFile(path.join(unpacked,file)):extractFile(archive,file);
  assert.equal(digest(packed),digest(source),file+' differs in package');checked.push(file);
 }
}
await compare('desktop');await compare('dist');
assert.equal(digest(extractFile(archive,'README.md')),digest(await readFile(path.join(root,'README.md'))),'README.md differs in package');
// electron-builder rewrites the manifest and strips development/build metadata.
const sourceManifest=JSON.parse(await readFile(path.join(root,'package.json'),'utf8')),packedManifest=JSON.parse(extractFile(archive,'package.json'));
for(const field of ['name','version','type','main','dependencies'])assert.deepEqual(packedManifest[field],sourceManifest[field],'Packaged manifest differs: '+field);
const version=sourceManifest.version,stamp=JSON.parse(await readFile(path.join(build,'exomina.build.json'),'utf8'));assert.equal(stamp.version,version);
for(const file of listPackage(archive))assert.ok(!/\/(?:accounts|synthetic-helper-profile|qa-[^/]+)(?:\/|$)/i.test(file.replaceAll('\\','/')),'Unexpected profile in package: '+file);
const scratch=await readFile(path.join(unpacked,'desktop/scratchpad.mjs'),'utf8'),main=await readFile(path.join(unpacked,'desktop/main.mjs'),'utf8');
assert.ok(scratch.includes("name:'notes_remove_completed'"));assert.ok(main.includes("if(name==='notes_remove_completed')"));assert.ok(main.includes("case 'notes.cleanup.restore'"));
const report={passed:true,version,buildId:stamp.id,desktopAndRendererFiles:checked.length,notesCleanupToolAndRecoveryRoutesPresent:true,files:checked};
await writeFile(path.resolve('../Workspace/notes-cleanup-package-verification-20261016.json'),JSON.stringify(report,null,2),'utf8');
console.log(JSON.stringify({...report,files:undefined}));
