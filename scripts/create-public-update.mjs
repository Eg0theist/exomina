// Creates authenticated uploadable update artifacts. Never publishes or prints keys.
import {mkdir,readFile,writeFile,stat,lstat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash,createPrivateKey} from 'node:crypto';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {extractFile} from '@electron/asar';
import {updateUrl,normalizeRelease} from '../desktop/public-updates.mjs';
import {signReleaseEnvelope,verifyReleaseEnvelope,normalizeUpdateTrust} from '../desktop/update-auth.mjs';
import {verifyPackageInventory,UPDATE_INVENTORY} from '../desktop/update-package.mjs';
import {verifyPublicSignatures} from './release-windows.mjs';
import {verifyVendorBinaries} from './verify-vendor-binaries.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

export function createSignedRelease({stamp,url,size,sha256,inventorySha256,notes='',channel,trust,keyId,privateKey,now=Date.now(),expiresDays=30}){
 if(stamp?.customized||stamp?.officialId)throw Error('A customized package cannot be published as an official release.');
 if(!Number.isInteger(expiresDays)||expiresDays<1||expiresDays>90)throw Error('Release metadata must expire within 1 to 90 days.');
 const payload={format:2,channel,id:stamp.id,version:stamp.version,builtAt:stamp.builtAt,publishedAt:new Date(now).toISOString(),expiresAt:new Date(now+expiresDays*86400000).toISOString(),notes:String(notes).slice(0,10000),windows:{x64:{url:updateUrl(url),size,sha256,inventorySha256}}};
 normalizeRelease(payload,url);
 const envelope=signReleaseEnvelope(payload,{keyId,privateKey});
 verifyReleaseEnvelope(envelope,{...trust,channel,now});
 return{payload,envelope};
}
async function runArchive(build,archive){
 await new Promise((resolve,reject)=>{const child=spawn(path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-File',path.join(root,'scripts/create-update.ps1')],{windowsHide:true,env:{...process.env,EXOMINA_RELEASE_BUILD:build,EXOMINA_RELEASE_ZIP:archive},stdio:['ignore','ignore','pipe']});let error='';child.stderr.on('data',chunk=>{error=(error+chunk).slice(-2000);});child.once('error',reject);child.once('close',code=>code===0?resolve():reject(Error('Release archive failed: '+error)));});
}
export async function main(args=process.argv.slice(2),env=process.env){
 const option=name=>{const at=args.indexOf(name);return at<0?null:args[at+1];};
 if(args.includes('--help')){console.log('node scripts/create-public-update.mjs --base-url https://github.com/OWNER/REPO/releases/download/TAG/ [--build FOLDER] [--output FOLDER] [--notes-file FILE] [--expires-days 30]\nRequires the packaged publisher pins, EXOMINA_UPDATE_KEY_ID and EXOMINA_UPDATE_PRIVATE_KEY_FILE. Signing keys are never printed.');return;}
 if(!option('--base-url'))throw Error('Choose the immutable HTTPS release base with --base-url.');
 if(!env.EXOMINA_UPDATE_KEY_ID||!env.EXOMINA_UPDATE_PRIVATE_KEY_FILE)throw Error('Configure EXOMINA_UPDATE_KEY_ID and EXOMINA_UPDATE_PRIVATE_KEY_FILE before creating update metadata.');
 const keyFile=path.resolve(env.EXOMINA_UPDATE_PRIVATE_KEY_FILE),keyInfo=await lstat(keyFile);
 if(!keyInfo.isFile()||keyInfo.isSymbolicLink()||keyInfo.nlink!==1||keyInfo.size>16384)throw Error('The update signing key must be a bounded independent regular file.');
 const privateKey=createPrivateKey({key:await readFile(keyFile),format:'pem',passphrase:env.EXOMINA_UPDATE_PRIVATE_KEY_PASSPHRASE});
 if(privateKey.asymmetricKeyType!=='ed25519')throw Error('Update metadata signing requires an Ed25519 key.');
 const build=path.resolve(option('--build')||path.join(root,'release/win-unpacked')),stamp=JSON.parse(await readFile(path.join(build,'exomina.build.json'),'utf8'));
 const trust=JSON.parse(extractFile(path.join(build,'resources','app.asar'),'build/update-channel.json').toString('utf8'));
 if(trust.format!==2||!normalizeUpdateTrust(trust))throw Error('The packaged application has no valid publisher trust configuration.');
 await verifyPublicSignatures(build);await verifyVendorBinaries(build,root);
 const inventorySha256=hash(await readFile(path.join(build,UPDATE_INVENTORY)));
 await verifyPackageInventory(build,{inventorySha256,buildId:stamp.id});
 const base=updateUrl(option('--base-url')),filename=`Exomina-${stamp.version}-${stamp.id.slice(0,8)}-windows-x64.zip`,output=path.resolve(option('--output')||path.join(root,'release/public')),archive=path.join(output,filename);
 const url=new URL(filename,base.endsWith('/')?base:base+'/').href;
 // Validate key/pins and publication data before writing expensive artifacts.
 createSignedRelease({stamp,url,size:1,sha256:'0'.repeat(64),inventorySha256,channel:trust.channel,trust,keyId:env.EXOMINA_UPDATE_KEY_ID,privateKey});
 await mkdir(output,{recursive:true});await runArchive(build,archive);
 const archiveHash=createHash('sha256');for await(const chunk of createReadStream(archive))archiveHash.update(chunk);
 const {payload,envelope}=createSignedRelease({stamp,url,size:(await stat(archive)).size,sha256:archiveHash.digest('hex'),inventorySha256,notes:option('--notes-file')?await readFile(path.resolve(option('--notes-file')),'utf8'):'',channel:trust.channel,trust,keyId:env.EXOMINA_UPDATE_KEY_ID,privateKey,expiresDays:option('--expires-days')?Number(option('--expires-days')):30});
 const feed=path.join(output,'latest.json');await writeFile(feed,JSON.stringify(envelope,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({archive,feed,version:stamp.version,buildId:stamp.id,keyId:env.EXOMINA_UPDATE_KEY_ID,expiresAt:payload.expiresAt,bytes:payload.windows.x64.size,sha256:payload.windows.x64.sha256,inventorySha256},null,2));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
