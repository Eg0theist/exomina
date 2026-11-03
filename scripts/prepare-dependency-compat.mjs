// dir-compare 4 expects a callable CommonJS default; minimatch 11 exports named
// functions. Adapt that import only, retaining the patched upstream matcher.
import {readFile,writeFile,lstat,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const originalSha='6b753f018576fc270dc93e2be35d98a50431bd7f1e373b98acbec5e7acf381d2';
const from='const minimatch_1 = __importDefault(require("minimatch"));';
const to='const minimatch_1 = { default: require("minimatch").minimatch };';
export async function prepareDependencyCompatibility(root){
 const modules=path.join(root,'node_modules'),copies=new Set();
 try{const lock=JSON.parse(await readFile(path.join(modules,'.package-lock.json'),'utf8'));for(const name of Object.keys(lock.packages||{}))if(/(?:^|\/)node_modules\/dir-compare$/.test(name)||name==='node_modules/dir-compare')copies.add(path.resolve(root,name));}catch(e){if(e.code!=='ENOENT')throw e;}
 try{await lstat(path.join(modules,'dir-compare','package.json'));copies.add(path.join(modules,'dir-compare'));}catch(e){if(e.code!=='ENOENT')throw e;}
 const results=[];
 for(const directory of copies){
 const actual=await realpath(directory),boundary=path.relative(await realpath(root),actual);
 if(!boundary||boundary.startsWith('..')||path.isAbsolute(boundary))throw Error('Dependency adapter path leaves the checkout.');
 const manifest=JSON.parse(await readFile(path.join(directory,'package.json'),'utf8'));
 if(manifest.version!=='4.2.0')throw Error('Review dir-compare compatibility before using a new version.');
 const file=path.join(directory,'build','src','FilterHandler','defaultFilterHandler.js'),info=await lstat(file);
 if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1)throw Error('Refusing to adapt a linked dependency file.');
 const bytes=await readFile(file),text=bytes.toString('utf8');
 const original=text.includes(to)?text.replace(to,from):text;
 if(createHash('sha256').update(original).digest('hex')!==originalSha)throw Error('The pinned dir-compare source changed; compatibility needs review.');
 if(text===original)await writeFile(file,text.replace(from,to),'utf8');
 results.push({version:manifest.version,matcher:'minimatch 11',adapted:true});
 }
 return {needed:results.length>0,copies:results};
}
if(process.argv[1]&&await realpath(process.argv[1])===await realpath(fileURLToPath(import.meta.url)))console.log(await prepareDependencyCompatibility(path.resolve(import.meta.dirname,'..')));
