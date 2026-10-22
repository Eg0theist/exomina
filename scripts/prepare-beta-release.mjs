// Produces an independently buildable, allowlisted share copy. Never copies user data.
import {cp,mkdir,readFile,writeFile,readdir,lstat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {applyPublicTemplate,applyPublicRuntimeScope,reconcilePublicBase} from './public-export.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2),arg=name=>args[args.indexOf(name)+1];
const publicRelease=args.includes('--public');
const sourcePackage=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
const publicSource=sourcePackage.license==='Apache-2.0';
const publicContents=publicRelease||publicSource;
const publicBase=args.includes('--public-base')?path.resolve(arg('--public-base')):undefined;
const publicAncestor=args.includes('--public-base-ancestor')?path.resolve(arg('--public-base-ancestor')):undefined;
if((publicBase||publicAncestor)&&(!publicRelease||!publicBase||!publicAncestor))throw Error('Use --public with both --public-base and --public-base-ancestor.');
const output=path.resolve(args.includes('--output')?arg('--output'):path.join(root,'..','Workspace',publicRelease?'exomina-public':publicSource?'exomina-beta':'exomina-private-beta'));
const inside=(parent,child)=>{const relative=path.relative(parent,child);return !relative||(!relative.startsWith(`..${path.sep}`)&&relative!=='..'&&!path.isAbsolute(relative));};
if(inside(root,output)||inside(output,root))throw Error('The share copy must be outside the source tree.');
try {if((await readdir(output)).length)throw Error('Choose an empty output folder. Existing share copies are never overwritten.');}catch(e){if(e.code!=='ENOENT')throw e;}
const repository=args.includes('--repository')?arg('--repository'):'https://github.com/Eg0theist/exomina';
if(!/^https:\/\/github\.com\/[\w-]+\/[\w.-]+$/.test(repository))throw Error('Use a plain GitHub repository URL.');
await mkdir(output,{recursive:true});
const excluded=relative=>/(^|\/)(?:data|Private|accounts|\.git|\.verification|node_modules|dist|release|output|__pycache__)(\/|$)/i.test(relative)||
 /(?:^|\/)theme-art(?:\/|$)/.test(relative)||/src\/assets\/(?:voice-previews|voice-previews-clear|claude-voice-previews)(?:\/|$)/.test(relative)||
 /(?:theme-catalog-full\.mjs|voice-preview-clips-personal\.js)$/.test(relative)||/\.(?:log|sqlite(?:3)?|db|pfx|p12|key|pem|pyc|pyo)$/i.test(relative)||
 (path.basename(relative).startsWith('.env')&&!relative.endsWith('.example'));
async function copy(relative){await cp(path.join(root,relative),path.join(output,relative),{recursive:true,filter:async source=>!excluded(path.relative(root,source).replaceAll(path.sep,'/'))&&!(await lstat(source)).isSymbolicLink()});}
for(const relative of ['desktop','src','test','cloud','public'])await copy(relative);
await mkdir(path.join(output,'scripts'));await mkdir(path.join(output,'build'));
if(!publicContents)await copy('scripts/beta-docs');
await copy('scripts/public-template');
const scripts=['prepare-version.mjs','prepare-beta-release.mjs','public-export.mjs','check-changes.mjs','prepare-beta-vendor.mjs','prepare-taskbar-icon.mjs','prepare-grok-runtime.mjs','prepare-analysis-node.mjs','prepare-windows-interop.mjs','release-windows.mjs','verify-windows-signatures.ps1','verify-vendor-binaries.mjs','beta-installer-config.mjs','beta-installer-path-limits.mjs','beta-installer-path-limits.nsh','beta-installer.nsh','verify-beta-update.ps1','qa-beta-installer.mjs','qa-profile.mjs','qa-packaged.mjs','qa-grok-native.mjs','qa-grok-connection.mjs','install-windows.ps1','create-public-update.mjs','create-update.ps1'];
scripts.push('public-installer-config.mjs','public-installer.nsh','install-public.ps1','public-readiness.mjs','decrypt-package.ps1','security-maintenance.mjs','refresh-update-metadata.mjs','package-local.mjs','package-official.mjs','stamp-build.mjs','stage-build.mjs','stage-build-idle.ps1','prepare-muse-runtime.mjs');
for(const file of scripts){try{await copy('scripts/'+file);}catch(e){if(e.code!=='ENOENT')throw e;}}
for(const relative of ['index.html','remote.html','vite.config.mjs','build/icon.ico','build/icon.png'])await copy(relative);
if(!publicContents)for(const file of ['README.md','PRIVATE-BETA.md','FEEDBACK.md','LICENSE','THIRD-PARTY-NOTICES.txt','SECURITY-AUDIT.txt','VALIDATION.txt'])await cp(path.join(root,'scripts/beta-docs',file),path.join(output,file));
for(const file of ['PROVIDER-TOOLS.md','PUBLIC-UPDATES.md','TERMINAL.md'])await copy(file);
let publicOverlay;
if(publicContents){
 publicOverlay=await applyPublicTemplate(root,output);
 if(publicSource)await cp(path.join(root,'.github'),path.join(output,'.github'),{recursive:true});
 // Re-exporting a reconciled public tree retains its documentation and website.
 // The selected release's own docs take precedence over default templates.
 if(publicSource)for(const relative of ['README.md','LICENSE','NOTICE','BETA.md','BUILDING.md','BUILD-WINDOWS.md','CHAT-MEMORY.md','FEEDBACK.md','START-HERE.txt','SUPPORT.md','THIRD-PARTY-NOTICES.txt','SECURITY-AUDIT.txt','VALIDATION.txt','docs','scripts'])await copy(relative);
}else await cp(path.join(root,'scripts/beta-docs/.github'),path.join(output,'.github'),{recursive:true});
await writeFile(path.join(output,'build/update-channel.json'),publicRelease?await readFile(path.join(root,'build/update-channel.json'),'utf8'):'{"feedUrl":""}\n');
await writeFile(path.join(output,'desktop/theme-catalog.mjs'),"export {THEMES,THEME_PROFILE} from './theme-catalog-standard.mjs';\n");
await writeFile(path.join(output,'desktop/distribution.mjs'),`export const DISTRIBUTION_PROFILE=${JSON.stringify(publicRelease?'public':'beta')};\nexport const DISTRIBUTION_REPOSITORY=${JSON.stringify(repository)};\n`);
await writeFile(path.join(output,'src/voice-preview-clips.js'),"export {VOICE_PREVIEW_CLIPS,VOICE_CLEAR_PREVIEW_CLIPS} from './voice-preview-clips-beta.js';\n");
// Generic synthetic fixture text, not anyone's profile or writing samples.
for(const file of await readdir(path.join(output,'test'))){if(!file.endsWith('.mjs'))continue;const target=path.join(output,'test',file),text=await readFile(target,'utf8');await writeFile(target,text.replaceAll('Nathan Reed','Alex Example').replaceAll('Nathan','Alex').replaceAll('nathan','alex').replaceAll('Dresden','Example City'));}
const pkg=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
pkg.description=publicRelease?'Exomina desktop workspace for AI, memory and tools':publicSource?'Exomina cross-platform beta':'Exomina private Windows beta';pkg.author='Exomina';pkg.homepage=repository;
delete pkg.dependencies['@anthropic-ai/claude-code-win32-x64'];
pkg.scripts={...(publicContents?pkg.scripts:{}),prebuild:'node scripts/prepare-version.mjs',build:'vite build',start:'electron .',test:'node --test test/*.test.mjs','version:sync':'node scripts/prepare-version.mjs',
 'prepare:runtimes':'node scripts/prepare-beta-vendor.mjs && node scripts/prepare-grok-runtime.mjs && node scripts/prepare-analysis-node.mjs',
 package:publicRelease?'node scripts/package-local.mjs':'node scripts/release-windows.mjs --beta',
 'package:public':'node scripts/release-windows.mjs','package:official':'node scripts/package-official.mjs','release:update':'node scripts/create-public-update.mjs','security:check':'node scripts/security-maintenance.mjs --check','security:prepare':'node scripts/security-maintenance.mjs --prepare',
 'qa:package':'node scripts/qa-packaged.mjs','qa:installer':'node scripts/qa-beta-installer.mjs'};
if(publicContents){
 pkg.license='Apache-2.0';
 pkg.scripts={...pkg.scripts,...publicOverlay.scripts};
 const grokVersion=pkg.dependencies['@xai-official/grok-win32-x64']||pkg.optionalDependencies?.['@xai-official/grok-win32-x64'];
 if(grokVersion&&Object.values(publicOverlay.optionalDependencies).some(version=>version!==grokVersion))throw Error('Public runtime templates need the selected Grok version and verified lock entries.');
 delete pkg.dependencies['@xai-official/grok-win32-x64'];
 pkg.optionalDependencies={...pkg.optionalDependencies,...publicOverlay.optionalDependencies};
 pkg.build.files=[...new Set([...pkg.build.files,'LICENSE','NOTICE'])];
}
await writeFile(path.join(output,'package.json'),JSON.stringify(pkg,null,2)+'\n');
const lock=JSON.parse(await readFile(path.join(root,'package-lock.json'),'utf8'));lock.version=pkg.version;lock.packages[''].version=pkg.version;lock.packages[''].dependencies=pkg.dependencies;delete lock.packages['node_modules/@anthropic-ai/claude-code-win32-x64'];
if(publicContents){lock.packages[''].license=pkg.license;lock.packages[''].optionalDependencies=pkg.optionalDependencies;Object.assign(lock.packages,publicOverlay.runtimeLocks);}
await writeFile(path.join(output,'package-lock.json'),JSON.stringify(lock,null,2)+'\n');
await writeFile(path.join(output,'.gitignore'),`node_modules/\ndist/\nrelease/\ndata/\nPrivate/\naccounts/\nWorkspace/\noutput/\n.verification/\n.exomina*/\n__pycache__/\n*.pyc\n*.pyo\n*.log\n.env\n.env.*\n!.env.example\n!server.env.example\n*.sqlite*\n*.db\n*.pfx\n*.p12\n*.key\n*.pem\nvendor/**/*.exe\nvendor/**/*.dll\nvendor/**/*.node\nvendor/**/*.pyd\nvendor/**/*.zip\nvendor/**/*.cat\n`);
if(publicContents)await cp(path.join(root,'scripts/public-template/.gitignore'),path.join(output,'.gitignore'));
// Build inputs with redistribution notices; executable bytes stay outside Git.
if(args.includes('--with-local-runtime-assets'))for(const relative of ['vendor/python','vendor/cua-driver','vendor/licenses','vendor/grok'])await copy(relative);
else {
 await mkdir(path.join(output,'vendor/cua-driver'),{recursive:true});
 await copy('vendor/cua-driver/skills');await copy('vendor/cua-driver/LICENSE.md');await copy('vendor/cua-driver/provenance.json');await copy('vendor/licenses');
}
try{const p=path.join(output,'vendor/cua-driver/provenance.json'),provenance=JSON.parse(await readFile(p,'utf8'));delete provenance.validation;delete provenance.authenticode;await writeFile(p,JSON.stringify(provenance,null,2)+'\n');}catch{}
const reconciliation=publicBase?await reconcilePublicBase(output,publicBase,publicAncestor):undefined;
if(publicContents)await applyPublicRuntimeScope(output);
console.log(JSON.stringify({output,repository,version:pkg.version,profile:publicRelease?'public':'beta',personalDataCopied:false,claudeCodeBundled:false,reconciliation},null,2));
