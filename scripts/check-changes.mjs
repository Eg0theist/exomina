import {readdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';

const slash=value=>value.split(path.sep).join('/');
async function filesUnder(root,folder){
  const result=[];
  for(const entry of await readdir(path.join(root,folder),{withFileTypes:true})){const file=path.join(folder,entry.name);if(entry.isDirectory())result.push(...await filesUnder(root,file));else if(entry.isFile())result.push(slash(file));}
  return result;
}
export async function sourceManifest(root){
  const folders=['desktop','src','test','scripts','public','cloud'],files=(await Promise.all(folders.map(folder=>filesUnder(root,folder)))).flat();
  files.push(...(await readdir(root,{withFileTypes:true})).filter(entry=>entry.isFile()).map(entry=>entry.name));
  return Object.fromEntries(await Promise.all(files.sort().map(async file=>[file,createHash('sha256').update(await readFile(path.join(root,file))).digest('hex')])));
}
/** Dependency selection is a local development aid. Release verification stays full. */
export async function verificationPlan(root,changed){
  const paths=[...new Set(changed.map(file=>slash(path.relative(root,path.resolve(root,file)))))];
  if(!paths.length)throw Error('Supply changed paths or --from a saved manifest.');
  if(paths.some(file=>file.startsWith('../')||path.isAbsolute(file)))throw Error('Changed paths must stay inside Source.');
  const tests=(await filesUnder(root,'test')).filter(file=>/\.test\.(?:mjs|cjs|js)$/.test(file)).sort(),code=(await Promise.all(['desktop','src','test','scripts'].map(async folder=>{try{return await filesUnder(root,folder);}catch(error){if(error.code==='ENOENT')return [];throw error;}}))).flat();
  const reverse=new Map(),known=new Set(code);
  for(const file of code){
    if(!/\.(?:mjs|cjs|js|jsx)$/.test(file))continue;
    const text=await readFile(path.join(root,file),'utf8');
    // Literal imports/re-exports/require and new URL resource reads. Computed runtime
    // dependencies still need manual workflow coverage; main/runtime edits fall back.
    const pattern=/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*|\bnew\s+URL\s*\(\s*)['"](\.[^'"\r\n]+)['"]/g;
    for(const match of text.matchAll(pattern)){
      const base=slash(path.normalize(path.join(path.dirname(file),match[1]))),dependency=[base,base+'.mjs',base+'.cjs',base+'.js',base+'.jsx',...['mjs','cjs','js','jsx'].map(ext=>base+'/index.'+ext)].find(candidate=>known.has(candidate))||base;
      if(!reverse.has(dependency))reverse.set(dependency,new Set());reverse.get(dependency).add(file);
    }
    if(tests.includes(file))for(const dependency of paths){
      const basename=path.basename(dependency);
      if(text.includes(dependency)||text.includes("'"+basename+"'")||text.includes('"'+basename+'"')){if(!reverse.has(dependency))reverse.set(dependency,new Set());reverse.get(dependency).add(file);}
    }
  }
  const closure=file=>{const visited=new Set([file]),queue=[file];while(queue.length)for(const importer of reverse.get(queue.shift())||[])if(!visited.has(importer)){visited.add(importer);queue.push(importer);}return visited;};
  const closures=new Map(paths.map(file=>[file,closure(file)])),visited=new Set([...closures.values()].flatMap(set=>[...set]));
  let selected=tests.filter(file=>visited.has(file));
  const reasons=[];
  if(paths.some(file=>/^(package(?:-lock)?\.json|vite\.config\.mjs|desktop\/(main|providers|permissions|store|context|preload|provider-catalog)\.[mc]?js)$/.test(file)))reasons.push('Shared host, provider, policy or build configuration changed.');
  if(paths.some(file=>!known.has(file)&&!file.startsWith('scripts/')))reasons.push('A changed path is outside the dependency graph.');
  if(paths.some(file=>file.startsWith('desktop/')&&/\.[mc]?js$/.test(file)&&!tests.some(test=>closures.get(file).has(test))))reasons.push('A host module has no known dependent tests.');
  if(reasons.length)selected=tests;
  return {changed:paths,mode:reasons.length?'full':'targeted',reasons,tests:selected,build:paths.some(file=>/^(src\/|desktop\/|package|vite)/.test(file)),limitations:['Static dependency selection cannot prove GUI, runtime or external-service behavior. Run the relevant workflow checks separately.','Use the full suite once at the end of a batch that changes shared code, and for every release.']};
}
async function run(command,args,root){return new Promise((resolve,reject)=>{const child=spawn(command,args,{cwd:root,stdio:'inherit',shell:false,windowsHide:true});child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error('Check exited with '+code)));});}
async function main(){
  const args=process.argv.slice(2),root=process.cwd(),take=flag=>{const i=args.indexOf(flag);if(i<0)return null;const value=args[i+1];if(!value||value.startsWith('--'))throw Error('Supply a path after '+flag);args.splice(i,2);return value;},snapshot=take('--snapshot'),from=take('--from');
  if(snapshot){await writeFile(snapshot,JSON.stringify(await sourceManifest(root),null,2),'utf8');console.log('Source manifest saved: '+snapshot);return;}
  const execute=args.includes('--run');if(execute)args.splice(args.indexOf('--run'),1);
  let changed=args;
  if(from){const previous=JSON.parse(await readFile(from,'utf8')),current=await sourceManifest(root);changed=[...new Set([...Object.keys(previous),...Object.keys(current)])].filter(file=>previous[file]!==current[file]);}
  if(!changed.length){console.log('No source changes found. No checks run.');return;}
  const plan=await verificationPlan(root,changed);console.log(JSON.stringify(plan,null,2));
  if(!execute)return;
  if(!plan.tests.length&&!plan.build){console.log('No automated checks selected. Choose a workflow check for these changes.');return;}
  if(plan.tests.length)await run(process.execPath,['--test',...plan.tests],root);
  if(plan.build)await run(process.execPath,['node_modules/vite/bin/vite.js','build'],root);
  console.log('Selected checks passed. Workflow checks and listed limitations remain.');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
