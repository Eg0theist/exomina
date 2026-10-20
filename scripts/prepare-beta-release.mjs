// Produces an independently buildable, allowlisted share copy. Never copies user data.
import {cp,mkdir,readFile,writeFile,readdir,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2),arg=name=>args[args.indexOf(name)+1];
const output=path.resolve(args.includes('--output')?arg('--output'):path.join(root,'..','Workspace','exomina-beta'));
if(output===root||root.startsWith(output+path.sep)||output.startsWith(root+path.sep))throw Error('The share copy must be outside the personal source tree.');
try {if((await readdir(output)).length)throw Error('Choose an empty output folder. Existing share copies are never overwritten.');}catch(e){if(e.code!=='ENOENT')throw e;}
const repository=args.includes('--repository')?arg('--repository'):'https://github.com/Eg0theist/exomina';
if(!/^https:\/\/github\.com\/[\w-]+\/[\w.-]+$/.test(repository))throw Error('Use a plain GitHub repository URL.');
await mkdir(output,{recursive:true});
const excluded=relative=>/(^|\/)(?:data|Private|accounts|\.git|\.verification|node_modules|dist|release|output|__pycache__)(\/|$)/i.test(relative)||
 /(?:^|\/)theme-art(?:\/|$)/.test(relative)||/src\/assets\/(?:voice-previews|voice-previews-clear|claude-voice-previews)(?:\/|$)/.test(relative)||
 /(?:theme-catalog-full\.mjs|voice-preview-clips-personal\.js)$/.test(relative)||/\.(?:log|sqlite(?:3)?|db|pfx|p12|key|pyc|pyo)$/i.test(relative)||
 (path.basename(relative).startsWith('.env')&&!relative.endsWith('.example'));
async function copy(relative){await cp(path.join(root,relative),path.join(output,relative),{recursive:true,filter:source=>!excluded(path.relative(root,source).replaceAll(path.sep,'/'))});}
for(const relative of ['desktop','src','test','cloud','public'])await copy(relative);
await mkdir(path.join(output,'scripts'));await mkdir(path.join(output,'build'));
const scripts=['prepare-version.mjs','prepare-beta-release.mjs','prepare-beta-vendor.mjs','prepare-taskbar-icon.mjs','prepare-grok-runtime.mjs','prepare-analysis-node.mjs','prepare-windows-interop.mjs','release-windows.mjs','verify-windows-signatures.ps1','verify-vendor-binaries.mjs','beta-installer-config.mjs','beta-installer-path-limits.mjs','beta-installer-path-limits.nsh','beta-installer.nsh','verify-beta-update.ps1','qa-beta-installer.mjs','qa-profile.mjs','qa-packaged.mjs','qa-grok-native.mjs','qa-grok-connection.mjs','install-windows.ps1','create-public-update.mjs','create-update.ps1'];
for(const file of scripts){try{await copy('scripts/'+file);}catch(e){if(e.code!=='ENOENT')throw e;}}
for(const relative of ['index.html','vite.config.mjs','build/icon.ico','build/icon.png'])await copy(relative);
for(const file of ['README.md','BETA.md','FEEDBACK.md','LICENSE','NOTICE','THIRD-PARTY-NOTICES.txt','SECURITY-AUDIT.txt','VALIDATION.txt'])await copy(file);
await copy('.github');
await writeFile(path.join(output,'build/update-channel.json'),'{"feedUrl":""}\n');
await writeFile(path.join(output,'desktop/theme-catalog.mjs'),"export {THEMES,THEME_PROFILE} from './theme-catalog-standard.mjs';\n");
await writeFile(path.join(output,'desktop/distribution.mjs'),`export const DISTRIBUTION_PROFILE='beta';\nexport const DISTRIBUTION_REPOSITORY=${JSON.stringify(repository)};\n`);
await writeFile(path.join(output,'src/voice-preview-clips.js'),"export {VOICE_PREVIEW_CLIPS,VOICE_CLEAR_PREVIEW_CLIPS} from './voice-preview-clips-beta.js';\n");
// Generic synthetic fixture text, not anyone's profile or writing samples.
// This checkout already uses synthetic fixtures; release copies preserve them.
const pkg=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
pkg.version='0.5.0-beta.1';pkg.description='Exomina Windows beta';pkg.author='Exomina';pkg.homepage=repository;
delete pkg.dependencies['@anthropic-ai/claude-code-win32-x64'];
pkg.scripts={prepackage:'node scripts/prepare-version.mjs --advance',prebuild:'node scripts/prepare-version.mjs',build:'vite build',start:'electron .',test:'node --test test/*.test.mjs','version:sync':'node scripts/prepare-version.mjs',
 'prepare:runtimes':'node scripts/prepare-beta-vendor.mjs && node scripts/prepare-grok-runtime.mjs',
 package:'node scripts/release-windows.mjs',
 'qa:package':'node scripts/qa-packaged.mjs','qa:installer':'node scripts/qa-beta-installer.mjs'};
await writeFile(path.join(output,'package.json'),JSON.stringify(pkg,null,2)+'\n');
const lock=JSON.parse(await readFile(path.join(root,'package-lock.json'),'utf8'));lock.version=pkg.version;lock.packages[''].version=pkg.version;lock.packages[''].dependencies=pkg.dependencies;delete lock.packages['node_modules/@anthropic-ai/claude-code-win32-x64'];
await writeFile(path.join(output,'package-lock.json'),JSON.stringify(lock,null,2)+'\n');
await writeFile(path.join(output,'.gitignore'),`node_modules/\ndist/\nrelease/\ndata/\nPrivate/\naccounts/\nWorkspace/\noutput/\n.verification/\n.exomina*/\n__pycache__/\n*.pyc\n*.pyo\n*.log\n.env\n.env.*\n!.env.example\n!server.env.example\n*.sqlite*\n*.db\n*.pfx\n*.p12\n*.key\n*.pem\nvendor/**/*.exe\nvendor/**/*.dll\nvendor/**/*.node\nvendor/**/*.pyd\nvendor/**/*.zip\nvendor/**/*.cat\n`);
// Build inputs with redistribution notices; executable bytes stay outside Git.
if(args.includes('--with-local-runtime-assets'))for(const relative of ['vendor/python','vendor/cua-driver','vendor/licenses','vendor/grok'])await copy(relative);
else {
 await mkdir(path.join(output,'vendor/cua-driver'),{recursive:true});
 await copy('vendor/cua-driver/skills');await copy('vendor/cua-driver/LICENSE.md');await copy('vendor/cua-driver/provenance.json');await copy('vendor/licenses');
}
try{const p=path.join(output,'vendor/cua-driver/provenance.json'),provenance=JSON.parse(await readFile(p,'utf8'));delete provenance.validation;delete provenance.authenticode;await writeFile(p,JSON.stringify(provenance,null,2)+'\n');}catch{}
console.log(JSON.stringify({output,repository,version:pkg.version,profile:'beta',personalDataCopied:false,claudeCodeBundled:false},null,2));
