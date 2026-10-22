// The existing manual beta channel is separate from authenticated automatic updates.
// Only the five installers qualified in this same trusted workflow may be published.
import {readFile,writeFile,readdir,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const digest=async file=>{const h=createHash('sha256');for await(const chunk of createReadStream(file))h.update(chunk);return h.digest('hex');};
async function filesIn(directory){
 const result=[];
 for(const item of await readdir(directory,{withFileTypes:true})){
  const file=path.join(directory,item.name);
  if(item.isSymbolicLink())throw Error('Release inputs cannot contain links.');
  if(item.isDirectory())result.push(...await filesIn(file));else if(item.isFile())result.push(file);
 }
 return result;
}
export async function qualifyManualBeta(directory,version){
 if(!/^\d+\.\d+\.\d+$/.test(version))throw Error('Use the exact stable-format package version.');
 const files=await filesIn(path.resolve(directory));
 const one=name=>{const matches=files.filter(file=>path.basename(file)===name);if(matches.length!==1)throw Error('Expected exactly one '+name);return matches[0];};
 const read=async name=>JSON.parse(await readFile(one(name),'utf8'));
 const expected=[['windows','x64','windows-x64-Setup.exe'],['darwin','arm64','macos-arm64.dmg'],['darwin','x64','macos-x64.dmg'],['linux','x64','linux-amd64.deb'],['linux','arm64','linux-arm64.deb']];
 const installers=[];
 for(const [platform,arch,suffix]of expected){
  const name=`Exomina-Beta-${version}-${suffix}`,file=one(name);installers.push({platform,arch,name,file,sha256:await digest(file)});
 }
 const install=await read('windows-install.json'),startup=await read('windows-startup.json'),connector=await read('windows-connector.json'),windows=installers[0];
 if(install.ok!==true||startup.ok!==true||connector.passed!==true||install.installerSha256!==windows.sha256||startup.installerSha256!==windows.sha256||install.build?.version!==version||startup.buildStamp?.version!==version)throw Error('Windows qualification does not match the exact installer and version.');
 const native=[];
 for(const file of files.filter(file=>path.basename(file)==='native-install-report.json'))native.push(JSON.parse(await readFile(file,'utf8')));
 for(const item of installers.slice(1)){
  const reports=native.filter(report=>report.platform===item.platform&&report.arch===item.arch);
  if(reports.length!==1||reports[0].passed!==true||reports[0].installer!==item.name||reports[0].sha256!==item.sha256)throw Error('Native qualification does not match '+item.name);
 }
 return {version,installers,qualification:{windowsInstall:true,windowsInstalledStartup:true,windowsConnectorInput:true,nativeInstallers:4},distribution:{profile:'beta',manualUpdates:true,windowsPublisherSignature:false,macosNotarized:false,automaticDelivery:false}};
}
async function main(){
 const args=process.argv.slice(2),option=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
 const directory=option('--artifacts'),version=option('--version');if(!directory||!version)throw Error('Pass --artifacts and --version.');
 const qualified=await qualifyManualBeta(directory,version);
 if(!args.includes('--publish')){console.log(JSON.stringify(qualified,null,2));return;}
 const commit=option('--commit'),repository=option('--repository');
 if(!/^[a-f0-9]{40}$/.test(commit||'')||!/^[-\w.]+\/[-\w.]+$/.test(repository||''))throw Error('Publication requires an exact trusted source commit and repository.');
 const run=promisify(execFile),gh=(...values)=>run('gh',values,{encoding:'utf8',maxBuffer:1048576});
 const tag='v'+version;
 try{await gh('api',`repos/${repository}/releases/tags/${tag}`);throw Error('This release already exists. Inspect it before publishing.');}
 catch(error){if(!String(error.stderr||'').includes('(HTTP 404)'))throw error;}
 const output=path.resolve('.verification','manual-beta-publication');await mkdir(output,{recursive:true});
 const receipt=path.join(output,'QUALIFICATION.json'),checksums=path.join(output,'SHA256SUMS.txt'),notes=path.join(output,'RELEASE-NOTES.md');
 const summary={...qualified,sourceRevision:commit,workflowRun:process.env.GITHUB_RUN_ID,installers:qualified.installers.map(({file,...item})=>item)};
 await writeFile(receipt,JSON.stringify(summary,null,2)+'\n','utf8');
 await writeFile(checksums,qualified.installers.map(item=>item.sha256+'  '+item.name).join('\n')+'\n','utf8');
 await writeFile(notes,`# Exomina ${version} public beta\n\nA desktop workspace for AI models, continuing memory and tools.\n\n## Changes\n\n- Shared versioned skills, Docker and SSH workers, filtered tool pipelines, and context/cache metrics.\n- Updated runtimes and stronger permission checks.\n- Improved pending connector requests in no-HUD mode, with explicit cancellation and notifications.\n\n## Downloads\n\n${qualified.installers.map(item=>`- [${item.platform} ${item.arch}](${`https://github.com/${repository}/releases/download/${tag}/${item.name}`})`).join('\n')}\n\nSee SHA256SUMS.txt and QUALIFICATION.json for exact installer hashes and automated checks.\n\n## Beta status\n\nWindows installers are unsigned. Mac installers are ad-hoc signed and are not notarized. The automated checks cover fresh installation, packaged startup and removal; Windows also checks reinstallation and no-HUD connector input. Physical devices, live provider sign-in, microphone use, third-party antivirus acceptance and upgrades of customized installations remain unverified.\n\nUpdates are manual. Back up your library before upgrading. Signed automatic delivery remains disabled in this beta.\n`,'utf8');
 try{
  await gh('release','create',tag,...qualified.installers.map(item=>item.file),checksums,receipt,'--repo',repository,'--target',commit,'--title',`Exomina ${version} public beta`,'--notes-file',notes,'--draft','--prerelease');
  await gh('release','edit',tag,'--repo',repository,'--draft=false','--prerelease','--latest=false');
 }catch(error){throw Error('Release publication did not finish. Inspect the existing tag and draft before any retry: '+error.message);}
 console.log(JSON.stringify({published:true,tag,url:`https://github.com/${repository}/releases/tag/${tag}`,sourceRevision:commit,installers:summary.installers},null,2));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
