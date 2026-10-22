import {readFileSync} from 'node:fs';
import verifiedBeta,{configureBetaArchiveCompression} from './beta-installer-config.mjs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
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
  beforePack:configureBetaArchiveCompression,
  // Manual installers need the same source snapshot and post-edit inventory
  // as signed betas so an unchanged installation can pass the update guard.
  afterPack:verifiedBeta.afterPack,
  async afterSign(context){
    await verifiedBeta.afterSign(context);
    // Check the final edited program before spending time compressing NSIS.
    const powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    const env={...process.env};delete env.PSModulePath;
    await promisify(execFile)(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(project,'scripts','verify-beta-update.ps1'),'-App',context.appOutDir],{windowsHide:true,encoding:'utf8',timeout:180000,env});
  },
};
