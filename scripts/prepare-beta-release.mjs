// Produces an independently buildable, allowlisted share copy. Never copies user data.
import {cp,mkdir,readFile,writeFile,readdir,lstat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {applyPublicTemplate,applyPublicRuntimeScope,reconcilePublicBase,privatePublicPath,inspectPublicTree} from './public-export.mjs';

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
const excluded=privatePublicPath;
async function copy(relative){await cp(path.join(root,relative),path.join(output,relative),{recursive:true,filter:async source=>{
 if(excluded(path.relative(root,source).replaceAll(path.sep,'/')))return false;
 if((await lstat(source)).isSymbolicLink())throw Error('Public source links are not allowed: '+path.relative(root,source));return true;
}});}
for(const relative of ['desktop','src','test','cloud','public'])await copy(relative);
await mkdir(path.join(output,'scripts'));await mkdir(path.join(output,'build'));
if(!publicContents)await copy('scripts/beta-docs');
await copy('scripts/public-template');
const scripts=['prepare-version.mjs','prepare-beta-release.mjs','public-export.mjs','check-changes.mjs','prepare-beta-vendor.mjs','prepare-taskbar-icon.mjs','prepare-grok-runtime.mjs','prepare-analysis-node.mjs','prepare-windows-interop.mjs','release-windows.mjs','verify-windows-signatures.ps1','verify-vendor-binaries.mjs','beta-installer-config.mjs','beta-installer-path-limits.mjs','beta-installer-path-limits.nsh','beta-installer.nsh','verify-beta-update.ps1','qa-beta-installer.mjs','qa-profile.mjs','qa-packaged.mjs','qa-grok-native.mjs','qa-grok-connection.mjs','install-windows.ps1','create-public-update.mjs','create-update.ps1'];
scripts.push('public-installer-config.mjs','public-installer.nsh','install-public.ps1','public-readiness.mjs','decrypt-package.ps1','security-maintenance.mjs','refresh-update-metadata.mjs','package-local.mjs','package-official.mjs','stamp-build.mjs','stage-build.mjs','stage-build-idle.ps1','prepare-muse-runtime.mjs');
scripts.push('qa-profile-owner.mjs');
scripts.push('package-dependencies.mjs','package-dependencies-before.mjs','package-dependencies-after.mjs');
scripts.push('package-version.mjs','qa-tool-update-archive.ps1','qa-installer-locks.ps1');
scripts.push('prepare-dependency-compat.mjs');
scripts.push('qa-update-candidate.mjs','qa-update-handoff.mjs');
scripts.push('qa-update-recovery.ps1','dictation-evaluation.mjs','evaluate-dictation.mjs','evaluate-dictation-local.mjs','evaluate-dictation-windows.ps1','crosscheck-protocols.mjs','check-protocols.mjs','evaluate-memory-blind.mjs','qa-report-workflow.mjs','qa-report-workflow-permissions.mjs');
scripts.push('prepare-report-model-evaluation.mjs','score-report-model-evaluation.mjs');
scripts.push('evaluate-dictation-local.mjs');
for(const file of scripts){try{await copy('scripts/'+file);}catch(e){if(e.code!=='ENOENT')throw e;}}
for(const relative of ['index.html','remote.html','vite.config.mjs','build/icon.ico','build/icon.png','build/release-notes.txt'])await copy(relative);
if(!publicContents)for(const file of ['README.md','PRIVATE-BETA.md','FEEDBACK.md','LICENSE','THIRD-PARTY-NOTICES.txt','SECURITY-AUDIT.txt','VALIDATION.txt'])await cp(path.join(root,'scripts/beta-docs',file),path.join(output,file));
for(const file of ['PROVIDER-TOOLS.md','PUBLIC-UPDATES.md','TERMINAL.md','WORKFLOWS.txt'])await copy(file);
let publicOverlay;
if(publicContents){
 publicOverlay=await applyPublicTemplate(root,output);
 // Public CI must exercise the same maintained startup and upgrade gates as
 // the local source. Older templates must not replace these current scripts.
 for(const file of ['package-dependencies.mjs','qa-native-install.mjs','qa-connector-forms.mjs','qa-connection-signin.mjs','qa-startup-protection-failure.mjs','qa-public-upgrade.mjs','qa-efs-upgrade-compat.mjs'])await copy('scripts/'+file);
 if(publicSource)await copy('.github');
 // Re-exporting a reconciled public tree retains its documentation and website.
 // The selected release's own docs take precedence over default templates.
 if(publicSource)for(const relative of ['README.md','LICENSE','NOTICE','BETA.md','BUILDING.md','BUILD-WINDOWS.md','CHAT-MEMORY.md','FEEDBACK.md','START-HERE.txt','SUPPORT.md','THIRD-PARTY-NOTICES.txt','SECURITY-AUDIT.txt','VALIDATION.txt','docs','scripts'])await copy(relative);
}else await cp(path.join(root,'scripts/beta-docs/.github'),path.join(output,'.github'),{recursive:true});
await writeFile(path.join(output,'build/update-channel.json'),publicRelease?await readFile(path.join(root,'build/update-channel.json'),'utf8'):'{"feedUrl":""}\n');
await writeFile(path.join(output,'desktop/theme-catalog.mjs'),"export {THEMES,THEME_PROFILE} from './theme-catalog-standard.mjs';\n");
await writeFile(path.join(output,'desktop/distribution.mjs'),`export const DISTRIBUTION_PROFILE=${JSON.stringify(publicRelease?'public':'beta')};\nexport const DISTRIBUTION_REPOSITORY=${JSON.stringify(repository)};\n`);
await writeFile(path.join(output,'src/voice-preview-clips.js'),"export {VOICE_PREVIEW_CLIPS,VOICE_CLEAR_PREVIEW_CLIPS} from './voice-preview-clips-beta.js';\n");
// Keep case pairs and token counts consistent in synthetic test/evaluation text.
// This modifies only the exported copy, never the frozen source/audio corpus.
async function fixtureTexts(relative='test'){
 const files=[];for(const entry of await readdir(path.join(output,relative),{withFileTypes:true})){
  const file=relative+'/'+entry.name;if(entry.isDirectory())files.push(...await fixtureTexts(file));else if(/\.(?:[mc]?js|json|txt|md|html|ps1|tla|cfg)$/i.test(file))files.push(file);
 }return files;
}
for(const file of [...await fixtureTexts(),'scripts/prepare-beta-release.mjs','scripts/evaluate-dictation.mjs','scripts/evaluate-dictation-local.mjs','src/theme-materials.css']){const target=path.join(output,file),text=await readFile(target,'utf8');await writeFile(target,text.replaceAll('Alex Example','Alex Example').replaceAll('Alex','Alex').replaceAll('alex','alex').replaceAll('Hamburg','Hamburg').replaceAll('hamburg','hamburg').replaceAll('ExampleCo','ExampleCo').replaceAll('exampleco','exampleco').replaceAll('SampleCo','SampleCo').replaceAll('sampleco','sampleco').replaceAll('Fantasy','Fantasy').replaceAll('fantasy','fantasy').replaceAll('Fantasy City','Fantasy City').replaceAll('fantasy-city','fantasy-city'),'utf8');}
const pkg=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
pkg.description=publicRelease?'Exomina desktop workspace for AI, memory and tools':publicSource?'Exomina cross-platform beta':'Exomina private Windows beta';pkg.author='Exomina';pkg.homepage=repository;
delete pkg.dependencies['@anthropic-ai/claude-code-win32-x64'];
pkg.scripts={...(publicContents?pkg.scripts:{}),prebuild:'node scripts/prepare-version.mjs',build:'vite build',start:'electron .',test:'node --test --test-concurrency=8 test/*.test.mjs','version:sync':'node scripts/prepare-version.mjs',
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
const inspection=await inspectPublicTree(output);
console.log(JSON.stringify({output,repository,version:pkg.version,profile:publicRelease?'public':'beta',inspection,claudeCodeBundled:false,reconciliation},null,2));
