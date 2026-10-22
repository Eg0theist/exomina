import {readFileSync} from 'node:fs';
import {writeBetaInstallerPathLimits} from './beta-installer-path-limits.mjs';
import {writeFile,rm,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {snapshotSource} from '../desktop/update-source.mjs';
import {UpdateMerge} from '../desktop/update-merge.mjs';
import {prepareWindowsInterop} from './prepare-windows-interop.mjs';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {verifyVendorBinaries} from './verify-vendor-binaries.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const metadata=JSON.parse(readFileSync(path.join(project,'package.json'),'utf8'));
const base=metadata.build||{};
export const BETA_APP_ID='local.exomina.beta.desktop';
export const BETA_INSTALLER_GUID='d17f0bea-3625-4b86-a9c6-8b9d8a7c99ea';

// This configuration is for the clean beta checkout. It deliberately keeps the
// official runtime trees intact and does not use the personal Program Files
// updater or data-home marker.
export default {
  ...base,
  appId:BETA_APP_ID,
  productName:'Exomina Beta',
  executableName:'Exomina',
  compression:'maximum',
  forceCodeSigning:true,
  publish:null,
  directories:{...base.directories,output:'release'},
  files:[
    ...(base.files||['dist/**','desktop/**','vendor/**','package.json']),
    'LICENSE','PRIVATE-BETA.md','FEEDBACK.md',
    '!**/__pycache__/**','!**/*.pyc','!**/*.pyo',
    '!node_modules/@xai-official/grok-win32-x64/**',
    '!node_modules/@anthropic-ai/claude-code-win32-x64/**',
  ],
  win:{
    ...base.win,
    target:[{target:'nsis',arch:['x64']}],
    executableName:'Exomina',
    artifactName:'Exomina-Beta-${version}-windows-${arch}-Setup.${ext}',
    signExecutable:true,
    // Vendor executables keep their upstream bytes, signatures and pinned hashes.
    // The installer and its temporary uninstaller are signed under our identity.
    signExts:['Exomina.exe','-Setup.exe','__uninstaller.exe','!exe'],
  },
  nsis:{
    guid:BETA_INSTALLER_GUID,
    oneClick:false,
    perMachine:false,
    allowElevation:false,
    allowToChangeInstallationDirectory:true,
    createDesktopShortcut:false,
    createStartMenuShortcut:true,
    shortcutName:'Exomina Beta',
    uninstallDisplayName:'Exomina Beta',
    deleteAppDataOnUninstall:false,
    runAfterFinish:false,
    packElevateHelper:false,
    // Manual whole-installer updates do not need block maps. Disabling the
    // differential layout allows the embedded 7z package to use solid LZMA.
    differentialPackage:false,
    include:'scripts/beta-installer.nsh',
    installerLanguages:['en_US'],
    warningsAsErrors:true,
  },
  npmRebuild:false,
  async beforePack(context){
    // Verify the exact temporary uninstaller before NSIS embeds and removes it.
    if(!context.packager.exominaSignerVerified){
      const sign=context.packager.signIf.bind(context.packager);
      context.packager.signIf=async file=>{
        const signed=await sign(file);
        if(path.basename(file).endsWith('__uninstaller.exe')){
          if(!signed)throw Error('Uninstaller signing was skipped.');
          const powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
          const {stdout}=await promisify(execFile)(powershell,['-NoProfile','-NonInteractive','-File',path.join(project,'scripts/verify-windows-signatures.ps1'),'-SingleFile',file],{windowsHide:true,encoding:'utf8',timeout:60000});
          const directory=path.join(path.dirname(file),'review');await mkdir(directory,{recursive:true});await writeFile(path.join(directory,'uninstaller-signature.json'),stdout,'utf8');
        }
        return signed;
      };context.packager.exominaSignerVerified=true;
    }
    const manifest=await prepareWindowsInterop();
    for(const entry of manifest.files){
      const file=path.join(project,'desktop','windows-interop',entry.file);
      if(!await context.packager.signIf(file))throw Error('A first-party Windows helper was not signed.');
      entry.sha256=createHash('sha256').update(await readFile(file)).digest('hex');
    }
    await writeFile(path.join(project,'desktop','windows-interop','manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  },
  async afterPack(context){
    await writeBetaInstallerPathLimits(context.appOutDir,path.join(project,'scripts','beta-installer-path-limits.nsh'));
    const marker={profile:'beta',manualUpdates:true};
    if(typeof metadata.homepage==='string'&&/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(metadata.homepage))marker.repositoryUrl=metadata.homepage.replace(/\/$/,'');
    const stamp={id:randomUUID(),version:context.packager.appInfo.version,builtAt:new Date().toISOString()};
    for(const name of ['exomina-source','exomina.release-integrity.json']){const target=path.resolve(context.appOutDir,name);if(path.dirname(target)!==path.resolve(context.appOutDir))throw Error('Invalid beta baseline destination.');await rm(target,{recursive:true,force:true});}
    await writeFile(path.join(context.appOutDir,'exomina.distribution.json'),JSON.stringify(marker,null,2)+'\n');
    await writeFile(path.join(context.appOutDir,'exomina.build.json'),JSON.stringify(stamp,null,2)+'\n');
    await snapshotSource(project,path.join(context.appOutDir,'exomina-source'),stamp);
  },
  async afterSign(context){
    const vendor=await verifyVendorBinaries(context.appOutDir,project);
    await writeFile(path.join(context.appOutDir,'exomina.vendor-integrity.json'),JSON.stringify(vendor,null,2)+'\n');
    const stamp=JSON.parse(await readFile(path.join(context.appOutDir,'exomina.build.json'),'utf8'));
    const inventory=await new UpdateMerge({}).programTree(context.appOutDir);
    await writeFile(path.join(context.appOutDir,'exomina.release-integrity.json'),JSON.stringify({format:1,buildId:stamp.id,files:inventory},null,2)+'\n');
  },
};
