import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { extractFile, listPackage } from '@electron/asar';
const root=process.cwd(), build=path.join(root,'release','win-unpacked'), archive=path.join(build,'resources','app.asar'), unpacked=archive+'.unpacked';
const report={build:JSON.parse(await readFile(path.join(build,'exomina.build.json'),'utf8')), files:[], removedGemini: false, scrollFixRetained:false};
async function compare(relative){
  const bytes=await readFile(path.join(root,relative));
  const shipped=relative.startsWith('desktop/')||relative.startsWith('vendor/')||relative==='scripts/install-windows.ps1'?await readFile(path.join(unpacked,relative)):extractFile(archive,path.normalize(relative));
  assert.ok(bytes.equals(shipped),relative+' differs from package');
  report.files.push({path:relative,sha256:createHash('sha256').update(bytes).digest('hex')});
}
async function walk(relative){for(const entry of await readdir(path.join(root,relative),{withFileTypes:true})){if(entry.name==='__pycache__'||entry.name.endsWith('.pyc'))continue;const file=relative+'/'+entry.name;if(entry.isDirectory())await walk(file);else if(entry.isFile())await compare(file);}}
await walk('desktop');await walk('dist');
for(const relative of ['README.md','PROVIDER-TOOLS.md','THIRD-PARTY-NOTICES.txt','scripts/install-windows.ps1','vendor/licenses/APACHE-2.0.txt'])await compare(relative);
const sourcePackage=JSON.parse(await readFile(path.join(root,'package.json'),'utf8')),shippedPackage=JSON.parse(extractFile(archive,'package.json').toString('utf8'));
assert.equal(shippedPackage.version,sourcePackage.version);assert.deepEqual(shippedPackage.dependencies,sourcePackage.dependencies);report.packageMetadata={versionAndRuntimeDependenciesMatch:true};
assert.ok(!listPackage(archive).some(file=>/node_modules[\\/]@google[\\/]gemini-cli(?:-core)?(?:[\\/]|$)/.test(file)));
report.removedGemini=true;
assert.ok((await readFile(path.join(root,'src','useChatScroll.js'))).equals(await readFile(path.resolve(root,'../Workspace/chat-scroll-anchor-20261011/useChatScroll.after.js'))));report.scrollFixRetained=true;
report.passed=true;
await writeFile(path.resolve(root,'../Workspace/gemini-removal-20261011/package-file-audit.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({passed:true,files:report.files.length,build:report.build.id,removedGemini:true,scrollFixRetained:true}));
