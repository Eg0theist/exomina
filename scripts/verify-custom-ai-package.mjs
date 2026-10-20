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
assert.equal(digest(extractFile(archive,'README.md')),digest(await readFile(path.join(root,'README.md'))));
const source=JSON.parse(await readFile(path.join(root,'package.json'),'utf8')),packed=JSON.parse(extractFile(archive,'package.json'));
for(const field of ['name','version','type','main','dependencies'])assert.deepEqual(packed[field],source[field]);
const stamp=JSON.parse(await readFile(path.join(build,'exomina.build.json'),'utf8'));assert.equal(stamp.version,source.version);
for(const file of listPackage(archive))assert.ok(!/\/(?:accounts|synthetic-helper-profile|qa-[^/]+)(?:\/|$)/i.test(file.replaceAll('\\','/')),'Unexpected profile in package: '+file);
const catalog=await readFile(path.join(unpacked,'desktop/provider-catalog.mjs'),'utf8'),endpoint=await readFile(path.join(unpacked,'desktop/api-endpoint.mjs'),'utf8');
assert.ok(catalog.includes("id: 'custom-api'"));assert.ok(endpoint.includes('provider.configurableEndpoint'));
const report={passed:true,version:source.version,buildId:stamp.id,desktopAndRendererFiles:checked.length,files:checked};
await writeFile(path.resolve('../Workspace/custom-ai-20261016/package-verification.json'),JSON.stringify(report,null,2),'utf8');
console.log(JSON.stringify({...report,files:undefined}));
