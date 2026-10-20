import {readFile,mkdir,mkdtemp,copyFile,cp,writeFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url)),workspace=path.resolve(root,'../Workspace');
const {version}=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
const output=await mkdtemp(path.join(workspace,'phone-relay-'+version+'-'));
await mkdir(path.join(output,'cloud'));
for(const file of ['accounts.mjs','accounts-server.mjs','accounts-start.mjs','accounts-cli.mjs','relay.mjs','phone-static.mjs','PHONE-DEPLOYMENT.md'])await copyFile(path.join(root,'cloud',file),path.join(output,'cloud',file));
await cp(path.join(root,'dist'),path.join(output,'dist'),{recursive:true});
await mkdir(path.join(output,'licenses'));
for(const name of ['react','react-dom','lucide-react'])await copyFile(path.join(root,'node_modules',name,'LICENSE'),path.join(output,'licenses',name+'.txt'));
await copyFile(path.join(root,'THIRD-PARTY-NOTICES.txt'),path.join(output,'THIRD-PARTY-NOTICES.txt'));
const files=[];
async function walk(directory){for(const entry of await readdir(path.join(output,directory),{withFileTypes:true})){const relative=path.join(directory,entry.name);if(entry.isDirectory())await walk(relative);else files.push({path:relative.replaceAll('\\','/'),sha256:createHash('sha256').update(await readFile(path.join(output,relative))).digest('hex')});}}
await walk('cloud');await walk('dist');await walk('licenses');
await writeFile(path.join(output,'bundle.json'),JSON.stringify({version,purpose:'Owner-hosted private phone relay; contains code and public assets only. No accounts, device keys, provider credentials or user data.',files},null,2)+'\n','utf8');
console.log(JSON.stringify({output,version,files:files.length}));
