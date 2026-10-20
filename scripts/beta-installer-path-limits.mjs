import {readdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Legacy NSIS file operations use Win32 MAX_PATH. Reserve four characters
// below its 260-character buffer, plus the separator before shipped paths.
export const BETA_NATIVE_PATH_CHARS=255;
// GetTempFileName's nsiFFFF.tmp and the builder's old-install directory.
export const BETA_ATOMIC_TEMP_SUFFIX_CHARS=24;

export function betaInstallerPathLimits(entries,{nativePathChars=BETA_NATIVE_PATH_CHARS,tempSuffixChars=BETA_ATOMIC_TEMP_SUFFIX_CHARS}={}){
  if(!Array.isArray(entries)||entries.length===0)throw Error('The shipping tree must contain public program files.');
  let longestRelativePath='',longestRelativePathChars=0;
  for(const entry of entries){
    const relative=typeof entry==='string'?entry:entry.relative;
    if(typeof relative!=='string'||relative.length===0||path.win32.isAbsolute(relative)||relative.split(/[\\/]/).some(part=>part==='..'))throw Error('Shipping entries must be relative program paths.');
    const normalized=relative.replaceAll('/','\\');
    // Directory enumeration uses a trailing \*.* in the standard uninstaller.
    const chars=normalized.length+(entry?.type==='directory'?4:0);
    if(chars>longestRelativePathChars){longestRelativePath=normalized+(entry?.type==='directory'?'\\*.*':'');longestRelativePathChars=chars;}
  }
  const maxInstallRootChars=nativePathChars-1-longestRelativePathChars;
  const maxTempRootChars=maxInstallRootChars-tempSuffixChars;
  if(!Number.isSafeInteger(maxTempRootChars)||maxTempRootChars<1)throw Error('The shipping tree leaves no safe legacy NSIS temporary path.');
  return {nativePathChars,longestRelativePath,longestRelativePathChars,tempSuffixChars,maxInstallRootChars,maxTempRootChars,maxAtomicTempRootChars:maxInstallRootChars};
}

export function betaInstallerPathRejections({installRoot,tempRoot,atomicTempRoot},limits){
  const rejected=[];
  if(installRoot?.length>limits.maxInstallRootChars)rejected.push('installRoot');
  if(tempRoot?.length>limits.maxTempRootChars)rejected.push('tempRoot');
  if(atomicTempRoot?.length>limits.maxAtomicTempRootChars)rejected.push('atomicTempRoot');
  return rejected;
}

export async function shippingInstallerPathLimits(appDir){
  const entries=[];
  async function visit(relative=''){
    for(const entry of await readdir(path.join(appDir,relative),{withFileTypes:true})){
      const child=relative?path.join(relative,entry.name):entry.name;
      if(entry.isSymbolicLink())throw Error('A beta shipping tree must not contain filesystem links.');
      if(entry.isDirectory()){entries.push({relative:child,type:'directory'});await visit(child);}
      else if(entry.isFile())entries.push({relative:child,type:'file'});
    }
  }
  await visit();return betaInstallerPathLimits(entries);
}

export function betaInstallerPathInclude(limits){
  const publicPath=limits.longestRelativePath.replace(/[\r\n\0]/g,' ').slice(0,1024);
  return `; Generated from the public shipping tree. Regenerate before NSIS compilation.\n; Longest relative path: ${publicPath}\n!define BETA_MAX_INSTALL_ROOT_CHARS ${limits.maxInstallRootChars}\n!define BETA_MAX_TEMP_ROOT_CHARS ${limits.maxTempRootChars}\n!define BETA_MAX_ATOMIC_TEMP_ROOT_CHARS ${limits.maxAtomicTempRootChars}\n!define BETA_SHIPPING_MAX_RELATIVE_CHARS ${limits.longestRelativePathChars}\n`;
}

export async function writeBetaInstallerPathLimits(appDir,includeFile){
  const limits=await shippingInstallerPathLimits(appDir);
  await writeFile(includeFile,betaInstallerPathInclude(limits));return limits;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  const options=process.argv.slice(2),argument=name=>{const index=options.indexOf(name);return index<0?undefined:options[index+1];};
  const appDir=path.resolve(argument('--app')||path.join(project,'release','win-unpacked'));
  const includeFile=path.resolve(argument('--include')||path.join(project,'scripts','beta-installer-path-limits.nsh'));
  console.log(JSON.stringify(await writeBetaInstallerPathLimits(appDir,includeFile),null,2));
}
