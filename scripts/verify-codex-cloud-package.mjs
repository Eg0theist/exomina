import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { extractFile } from '@electron/asar';
import assert from 'node:assert/strict';
const root=process.cwd(), packageDir=path.join(root,'release','win-unpacked'), archive=path.join(packageDir,'resources','app.asar'), output=path.resolve('../Workspace/codex-cloud-audit-20261012/package-parity.json');
async function files(relative){const result=[];for(const item of await readdir(path.join(root,relative),{withFileTypes:true})){if(item.name==='__pycache__'||item.name.endsWith('.pyc'))continue;const value=path.join(relative,item.name);if(item.isDirectory())result.push(...await files(value));else if(item.isFile())result.push(value);else throw Error('Unexpected nonregular source path.');}return result;}
const expected=[...await files('desktop'),...await files('dist'),'README.md','PROVIDER-TOOLS.md'];
const checked=[];
for(const file of expected){const source=await readFile(path.join(root,file)),shipped=extractFile(archive,file);assert.ok(source.equals(shipped),`${file} differs from package`);if(file.startsWith('desktop'+path.sep))assert.ok(source.equals(await readFile(path.join(packageDir,'resources','app.asar.unpacked',file))));checked.push({file,bytes:source.length,sha256:createHash('sha256').update(source).digest('hex')});}
const main=extractFile(archive,'desktop/main.mjs').toString('utf8');for(const fragment of ["import {CodexCloud}","case 'codexCloud.submit'",'codexCloud.call(name,args,conversationId)','validatePath:file=>workspaceTools.target(file,true)','codexCloud?.close()'])assert.ok(main.includes(fragment),fragment);
const stamp=JSON.parse(await readFile(path.join(packageDir,'exomina.build.json'),'utf8')),manifest=JSON.parse(extractFile(archive,'package.json').toString('utf8')),sourceManifest=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));assert.equal(stamp.version,manifest.version);for(const key of ['name','version','main','type','dependencies'])assert.deepEqual(manifest[key],sourceManifest[key]);
await writeFile(output,JSON.stringify({passed:true,build:stamp,filesVerified:checked.length,files:checked,hostWiringVerified:true,privateStoresRead:false},null,2));console.log(JSON.stringify({passed:true,build:stamp,filesVerified:checked.length,report:output}));
