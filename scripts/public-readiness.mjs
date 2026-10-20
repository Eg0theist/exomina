import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {signingPreflight} from './release-windows.mjs';

/** Evidence must name the candidate, never infer release readiness from a
 * developer machine's installed version or a successful source-only check. */
export function publicReadiness({feedUrl='',signing={},licensePublished=false,evidence={},buildId}={}){
 let feed=false;try{const u=new URL(feedUrl);feed=u.protocol==='https:'&&!u.username&&!u.password&&!u.hostname.endsWith('.invalid');}catch{}
 const bound=!!buildId&&evidence.buildId===buildId;
 const checks={publicFeedConfigured:feed,publisherSigningConfigured:signing.ready===true,openSourceLicensePublished:licensePublished===true,exactBuildSignatures:bound&&evidence.signaturesVerified===true,cleanInstallAndUpdate:bound&&evidence.cleanUpdate===true,customizedMergeAndUpdate:bound&&evidence.customizedUpdate===true,rollbackAndDataRecovery:bound&&evidence.recovery===true,stockAntivirusQualification:bound&&evidence.stockAntivirus===true};
 return {ready:Object.values(checks).every(Boolean),checks,blockers:Object.entries(checks).filter(([,v])=>!v).map(([k])=>k),buildId:buildId||null,notice:'Readiness concerns the named public candidate only. Source tests and synthetic fixtures do not establish signed clean-machine compatibility.'};
}
async function main(){const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),args=process.argv.slice(2),option=k=>{const i=args.indexOf(k);return i<0?null:args[i+1];};const channel=JSON.parse(await readFile(path.join(root,'build/update-channel.json'),'utf8')),license=await readFile(path.join(root,'scripts/beta-docs/LICENSE'),'utf8');const evidence=option('--evidence')?JSON.parse(await readFile(path.resolve(option('--evidence')),'utf8')):{};
 const result=publicReadiness({feedUrl:channel.feedUrl,signing:signingPreflight(),licensePublished:/Apache License[\s\S]*Version 2\.0/.test(license),evidence,buildId:option('--build-id')});console.log(JSON.stringify(result,null,2));if(args.includes('--strict')&&!result.ready)process.exitCode=1;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
