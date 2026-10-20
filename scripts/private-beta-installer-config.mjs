import {readFileSync} from 'node:fs';
import {writeBetaInstallerPathLimits} from './beta-installer-path-limits.mjs';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';

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
  compression:'normal',
  publish:null,
  directories:{...base.directories,output:'release'},
  files:[
    ...(base.files||['dist/**','desktop/**','vendor/**','package.json']),
    'LICENSE','BETA.md','FEEDBACK.md',
    '!**/__pycache__/**','!**/*.pyc','!**/*.pyo',
    '!node_modules/@xai-official/grok-win32-x64/**',
    '!node_modules/@anthropic-ai/claude-code-win32-x64/**',
  ],
  win:{
    ...base.win,
    target:[{target:'nsis',arch:['x64']}],
    executableName:'Exomina',
    artifactName:'Exomina-Beta-${version}-windows-${arch}-Setup.${ext}',
    signExecutable:false,
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
  async afterPack(context){
    await writeBetaInstallerPathLimits(context.appOutDir,path.join(project,'scripts','beta-installer-path-limits.nsh'));
    const marker={profile:'beta',manualUpdates:true};
    if(typeof metadata.homepage==='string'&&/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(metadata.homepage))marker.repositoryUrl=metadata.homepage.replace(/\/$/,'');
    const stamp={id:randomUUID(),version:context.packager.appInfo.version,builtAt:new Date().toISOString()};
    await writeFile(path.join(context.appOutDir,'exomina.distribution.json'),JSON.stringify(marker,null,2)+'\n');
    await writeFile(path.join(context.appOutDir,'exomina.build.json'),JSON.stringify(stamp,null,2)+'\n');
  },
};
