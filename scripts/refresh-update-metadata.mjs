// Renews dates on an authenticated unchanged release. It never uploads anything.
import {readFile,writeFile,lstat} from 'node:fs/promises';
import {createHash,createPrivateKey} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyReleaseEnvelope,signReleaseEnvelope} from '../desktop/update-auth.mjs';
import {normalizeRelease} from '../desktop/public-updates.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

export function renewReleaseMetadata({bytes,expectedSha256,expectedVersion,expectedBaseUrl,trust,keyId,privateKey,now=Date.now(),expiresDays=30,withinDays=7}){
 if(!Buffer.isBuffer(bytes)||bytes.length>256*1024||! /^[a-f0-9]{64}$/.test(expectedSha256||'')||hash(bytes)!==expectedSha256)throw Error('The original signed metadata differs from its exact expected hash.');
 if(!Number.isInteger(expiresDays)||expiresDays<1||expiresDays>90||!Number.isInteger(withinDays)||withinDays<0||withinDays>=expiresDays)throw Error('Choose a bounded metadata renewal interval.');
 const original=JSON.parse(bytes.toString('utf8')),payload=verifyReleaseEnvelope(original,{...trust,now}),release=normalizeRelease(payload,payload.windows?.x64?.url);
 if(typeof expectedVersion!=='string'||payload.version!==expectedVersion||typeof expectedBaseUrl!=='string'||!expectedBaseUrl.endsWith('/')||!release.asset.url.startsWith(expectedBaseUrl))throw Error('The signed metadata does not belong to the selected immutable release.');
 if(original.keyId!==keyId)throw Error('Renewal requires the same trusted publisher key as the current release.');
 if(Date.parse(payload.expiresAt)-now>withinDays*86400000)return{changed:false,originalSha256:expectedSha256,expiresAt:payload.expiresAt};
 const renewed={...payload,publishedAt:new Date(now).toISOString(),expiresAt:new Date(now+expiresDays*86400000).toISOString()},envelope=signReleaseEnvelope(renewed,{keyId,privateKey});
 verifyReleaseEnvelope(envelope,{...trust,now});
 const output=Buffer.from(JSON.stringify(envelope,null,2)+'\n','utf8');return{changed:true,originalSha256:expectedSha256,sha256:hash(output),expiresAt:renewed.expiresAt,keyId,payload:renewed,bytes:output};
}
async function bounded(file,maximum){const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>maximum)throw Error('Metadata renewal requires bounded independent regular files.');return readFile(file);}
export async function main(args=process.argv.slice(2),env=process.env){
 const option=name=>{const at=args.indexOf(name);return at<0?null:args[at+1];};
 if(args.includes('--help')){console.log('node scripts/refresh-update-metadata.mjs --input FILE --output FILE --trust-file FILE --expected-sha256 HASH --expected-version VERSION --expected-base-url HTTPS_RELEASE_DIRECTORY/\nOnly unexpired verified metadata within7days of expiry is renewed. Configure the matching signing key through EXOMINA_UPDATE_KEY_ID and EXOMINA_UPDATE_PRIVATE_KEY_FILE. No upload occurs.');return;}
 if(!option('--input')||!option('--output')||!option('--trust-file')||!option('--expected-version')||!option('--expected-base-url')||!env.EXOMINA_UPDATE_KEY_ID)throw Error('Choose metadata input/output, exact immutable release identity, trusted bundled configuration and publisher key ID.');
 const bytes=await bounded(path.resolve(option('--input')),256*1024),trust=JSON.parse((await bounded(path.resolve(option('--trust-file')),65536)).toString('utf8'));
 // Prove authenticity, expiry and the immutable input hash before opening a key.
 const current=JSON.parse(bytes.toString('utf8'));verifyReleaseEnvelope(current,trust);if(hash(bytes)!==option('--expected-sha256'))throw Error('The original metadata hash changed.');
 let privateKey;if(Date.parse(verifyReleaseEnvelope(current,trust).expiresAt)-Date.now()<=7*86400000){if(!env.EXOMINA_UPDATE_PRIVATE_KEY_FILE)throw Error('A matching publisher signing key is required for renewal.');privateKey=createPrivateKey({key:await bounded(path.resolve(env.EXOMINA_UPDATE_PRIVATE_KEY_FILE),16384),format:'pem',passphrase:env.EXOMINA_UPDATE_PRIVATE_KEY_PASSPHRASE});}
 const result=renewReleaseMetadata({bytes,expectedSha256:option('--expected-sha256'),expectedVersion:option('--expected-version'),expectedBaseUrl:option('--expected-base-url'),trust,keyId:env.EXOMINA_UPDATE_KEY_ID,privateKey});if(result.changed)await writeFile(path.resolve(option('--output')),result.bytes,{flag:'wx'});
 const{bytes:ignored,payload,...receipt}=result;console.log(JSON.stringify(receipt,null,2));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
