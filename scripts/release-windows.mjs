// Public Windows releases fail closed without signing. Local customization uses `package`.
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,readdir,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export function signingPreflight(env=process.env){
 const configured=Boolean(env.WIN_CSC_LINK||env.CSC_LINK),pinned=/^[a-f0-9]{40}$/i.test(String(env.EXOMINA_PUBLISHER_THUMBPRINT||'').replaceAll(' ',''));
 return {ready:configured&&pinned,signingIdentityConfigured:configured,publisherIdentityPinned:pinned,publicSigningRequired:true,reason:configured&&pinned?'Signing input and expected publisher configured; actual signatures must still validate.':'A trusted publisher signing identity and EXOMINA_PUBLISHER_THUMBPRINT are required. Configure signing credentials through the build environment. No unsigned public installer will be produced.'};
}
export async function verifyPublicSignatures(build,installer=''){
 const executable=path.join(process.env.SystemRoot||'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
 const args=['-NoProfile','-NonInteractive','-File',path.join(project,'scripts/verify-windows-signatures.ps1'),'-Root',build,...(installer?['-Installer',installer]:[])];
 const {stdout}=await promisify(execFile)(executable,args,{windowsHide:true,encoding:'utf8',timeout:60000});return JSON.parse(stdout.trim());
}
async function run(file,args){return new Promise((resolve,reject)=>{const child=spawn(file,args,{cwd:project,windowsHide:true,shell:false,stdio:'inherit'});child.once('error',reject);child.once('close',code=>code===0?resolve():reject(Error(path.basename(file)+' failed ('+code+').')));});}
async function main(){
 const args=process.argv.slice(2);if(args.some(arg=>!['--beta','--check'].includes(arg)))throw Error('Use release-windows.mjs [--beta] [--check].');
 const beta=args.includes('--beta');
 const check=signingPreflight();console.log(JSON.stringify(check,null,2));
 if(!check.ready){process.exitCode=1;return;}if(process.argv.includes('--check'))return;
 const node=process.execPath;
 await run(node,['node_modules/vite/bin/vite.js','build']);
 for(const script of ['prepare-beta-vendor.mjs','prepare-grok-runtime.mjs','prepare-analysis-node.mjs','prepare-taskbar-icon.mjs','prepare-windows-interop.mjs'])await run(node,['scripts/'+script]);
 const {version}=JSON.parse(await readFile(path.join(project,'package.json'),'utf8'));
 const release=path.join(project,'release','public-build-'+version+'-'+randomUUID());
 await run(node,['node_modules/electron-builder/cli.js','--config',beta?'scripts/beta-installer-config.mjs':'scripts/public-installer-config.mjs','--config.directories.output='+release,'--win','nsis','--x64']);
 const installers=(await readdir(release)).filter(name=>/-windows-x64-Setup\.exe$/.test(name));
 const expected=(beta?'Exomina-Beta-':'Exomina-')+version+'-windows-x64-Setup.exe';if(!installers.includes(expected))throw Error('The expected installer is absent.');
 const signatures=await verifyPublicSignatures(path.join(release,'win-unpacked'),path.join(release,expected));
 const uninstaller=JSON.parse(await readFile(path.join(release,'review','uninstaller-signature.json'),'utf8'));
 const build=JSON.parse(await readFile(path.join(release,'win-unpacked','exomina.build.json'),'utf8'));
 const inventorySha256=createHash('sha256').update(await readFile(path.join(release,'win-unpacked','exomina.release-integrity.json'))).digest('hex');
 const evidence={version,buildId:build.id,installer:expected,signaturesVerified:true,signatures,uninstaller,inventorySha256,antivirusCompatibility:'Unverified. Run clean-VM install/start/use/update/uninstall checks with stock AV and submit exact-hash samples for vendor review before public release.',bitdefenderReport:'https://www.bitdefender.com/consumer/support/answer/29358/'};
 await mkdir(path.join(release,'review'),{recursive:true});await writeFile(path.join(release,'review','release-readiness.json'),JSON.stringify(evidence,null,2)+'\n','utf8');
 console.log(JSON.stringify({release,buildId:build.id,installer:expected,signaturesVerified:true,antivirusClearance:false},null,2));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
