import {readFileSync} from 'node:fs';
import {writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const metadata=JSON.parse(readFileSync(path.join(root,'package.json'),'utf8'));

// electron-builder's default AppRun silently disables Chromium's sandbox when
// user namespaces are unavailable. Keep startup failure explicit instead.
export const sandboxedAppRun=`#!/usr/bin/env bash
set -euo pipefail
app_dir="\${APPDIR:-$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)}"
for argument in "$@"; do
  case "$argument" in
    --no-sandbox|--no-sandbox=*|--disable-setuid-sandbox|--disable-setuid-sandbox=*)
      printf '%s\\n' 'Exomina requires the Chromium sandbox. Install the DEB package if this system does not support sandboxed AppImages.' >&2
      exit 1
      ;;
  esac
done
export PATH="$app_dir:$app_dir/usr/sbin\${PATH:+:$PATH}"
export XDG_DATA_DIRS="$app_dir/usr/share\${XDG_DATA_DIRS:+:$XDG_DATA_DIRS}:/usr/share"
export LD_LIBRARY_PATH="$app_dir/usr/lib\${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
exec "$app_dir/exomina-beta" "$@"
`;

export function nativeMarkerDirectories(context) {
  if(context.electronPlatformName==='darwin') {
    const bundle=path.join(context.appOutDir,`${context.packager.appInfo.productFilename}.app`,'Contents');
    return [path.join(bundle,'Resources')];
  }
  if(context.electronPlatformName==='linux')return [context.appOutDir];
  throw Error('Native distribution markers require a macOS or Linux bundle.');
}

export async function markNativeDistribution(context) {
  const marker={profile:'beta',manualUpdates:true};
  if(typeof metadata.homepage==='string'&&/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(metadata.homepage))marker.repositoryUrl=metadata.homepage.replace(/\/$/,'');
  const stamp={id:randomUUID(),version:context.packager.appInfo.version,builtAt:new Date().toISOString(),platform:context.electronPlatformName};
  for(const directory of nativeMarkerDirectories(context)){
    await writeFile(path.join(directory,'exomina.distribution.json'),JSON.stringify(marker,null,2)+'\n');
    await writeFile(path.join(directory,'exomina.build.json'),JSON.stringify(stamp,null,2)+'\n');
  }
  if(context.electronPlatformName==='linux'){
    // AppImageTarget copies appOutDir over its generated launcher before
    // creating squashfs. Native QA checks the resulting launcher byte-for-byte.
    await writeFile(path.join(context.appOutDir,'AppRun'),sandboxedAppRun,{mode:0o755});
  }
}

// Package formats and native architectures are prepared independently of NSIS.
// Packaging alone does not make a working app: package-cross-platform.mjs keeps
// this configuration behind the outstanding storage/runtime verification gate.
export function nativePackageFormats(platform,{ciOnly=false}={}){
  if(platform==='darwin')return ciOnly?['dmg']:['dmg','zip'];
  if(platform==='linux')return ciOnly?['deb']:['AppImage','deb'];
  throw Error('Native installer formats require macOS or Linux.');
}

export function crossPlatformConfig(platform,{arch=process.arch,ciOnly=false}={}){
  if(!['darwin','linux'].includes(platform))throw Error('Use the Windows beta installer configuration for Windows.');
  if(!['x64','arm64'].includes(arch))throw Error('There is no verified native package architecture for this target.');
  const base=metadata.build||{};
  return {
    ...base,appId:'local.exomina.beta.desktop',productName:'Exomina Beta',
    compression:'normal',publish:null,npmRebuild:true,
    afterPack:markNativeDistribution,
    directories:{...base.directories,output:`release-${platform}`},
    files:[...(base.files||[]),'LICENSE','BETA.md','FEEDBACK.md','SUPPORT.md',
      '!**/__pycache__/**','!**/*.pyc','!**/*.pyo',
      '!vendor/analysis-node/**','!vendor/muse/**','!desktop/windows-interop/*.dll','!vendor/python/**/*.exe','!vendor/python/**/*.dll','!vendor/python/**/*.pyd','!vendor/python/*._pth',
      '!vendor/cua-driver/**/*.exe','!vendor/cua-driver/**/*.dll','!vendor/grok/*.exe',
      '!node_modules/@xai-official/**',
      '!node_modules/@anthropic-ai/claude-code-win32-x64/**',
      '!scripts/install-windows.ps1','!build/shell-icons/**','!build/taskbar-icon.json'],
    // Never reuse the Windows Electron distribution for a native build.
    electronDist:null,win:null,nsis:null,
    mac:platform==='darwin'?{target:nativePackageFormats(platform,{ciOnly}).map(target=>({target,arch:[arch]})),
      icon:'build/icon.png',artifactName:'Exomina-Beta-${version}-macos-${arch}.${ext}',
      identity:'-',hardenedRuntime:true,entitlements:'build/entitlements.mac.plist',entitlementsInherit:'build/entitlements.mac.plist',
      extendInfo:{NSMicrophoneUsageDescription:'Exomina uses your microphone only when you start an approved voice conversation.'}}:undefined,
    linux:platform==='linux'?{target:nativePackageFormats(platform,{ciOnly}).map(target=>({target,arch:[arch]})),
      icon:'build/icon.png',category:'Utility',executableName:'exomina-beta',
      maintainer:'Exomina <beta@exomina.local>',artifactName:'Exomina-Beta-${version}-linux-${arch}.${ext}'}:undefined,
    appImage:platform==='linux'?{executableArgs:[]}:undefined,
    deb:platform==='linux'?{packageName:'exomina-beta'}:undefined,
  };
}

export const CROSS_PLATFORM_BLOCKERS=Object.freeze([
  'Standard per-user profile storage must be integrated into startup while preserving existing EFS profiles.',
  'Pinned native Grok, Python importer and Cua Driver artifacts must be prepared and verified for each target.',
  'Native startup, account sign-in, permissions, microphone, updater and install/uninstall checks must pass on each target.',
]);
