import beta from './beta-installer-config.mjs';
import path from 'node:path';
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {normalizeUpdateTrust} from '../desktop/update-auth.mjs';
import {updateUrl} from '../desktop/public-updates.mjs';

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export function publicDistribution(metadata,channel){
  const repositoryUrl=metadata.homepage;
  if(typeof repositoryUrl!=='string'||!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(repositoryUrl))throw Error('Public packaging requires a GitHub repository in package.json homepage.');
  const trust=normalizeUpdateTrust(channel);
  if(!trust||typeof channel.feedUrl!=='string'||!/^https:\/\//.test(channel.feedUrl))throw Error('Public packaging requires a signed update feed and bundled publisher keys.');
  updateUrl(channel.feedUrl);
  return {profile:'public',manualUpdates:false,repositoryUrl:repositoryUrl.replace(/\/$/,'')};
}
export default {
  ...beta,
  appId:'local.exomina.desktop',productName:'Exomina',
  files:[...beta.files,'scripts/install-public.ps1'],
  asarUnpack:[...beta.asarUnpack,'scripts/install-public.ps1'],
  win:{...beta.win,artifactName:'Exomina-${version}-windows-${arch}-Setup.${ext}'},
  nsis:{...beta.nsis,guid:'6370e7c1-1e46-4c42-a1e0-660b64b97ded',perMachine:true,allowElevation:true,allowToChangeInstallationDirectory:false,shortcutName:'Exomina',uninstallDisplayName:'Exomina',include:'scripts/public-installer.nsh',packElevateHelper:false},
  async afterPack(context){
    const metadata=JSON.parse(await readFile(path.join(project,'package.json'),'utf8'));
    const channel=JSON.parse(await readFile(path.join(project,'build/update-channel.json'),'utf8'));
    const marker=publicDistribution(metadata,channel);
    await beta.afterPack(context);
    await writeFile(path.join(context.appOutDir,'exomina.distribution.json'),JSON.stringify(marker,null,2)+'\n','utf8');
    await writeFile(path.join(context.appOutDir,'exomina.paths.json'),JSON.stringify({home:'..'})+'\n','utf8');
  },
  async afterSign(context){
    await beta.afterSign(context);
    const powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
    const {stdout}=await promisify(execFile)(powershell,['-NoProfile','-NonInteractive','-File',path.join(project,'scripts/decrypt-package.ps1'),'-Directory',context.appOutDir],{encoding:'utf8',windowsHide:true,timeout:600000});
    if(JSON.parse(stdout).remaining!==0)throw Error('Public program files remain EFS encrypted.');
  },
};
