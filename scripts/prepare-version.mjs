// Release versions are deliberate. Local packaging keeps the version and the
// package stamp supplies a unique build identity for each attempt.
import {readFile,writeFile,rename,unlink,open} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';

export function nextBuildVersion(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(version || '');
  if (!match || match.slice(1,4).some(item => !Number.isSafeInteger(Number(item))) || match[4]?.split('.').some(item => /^\d+$/.test(item) && item.length > 1 && item.startsWith('0'))) throw Error('Use a valid semantic version before packaging.');
  const increment = value => { const next = Number(value) + 1; if (!Number.isSafeInteger(next)) throw Error('The version counter is too large.'); return String(next); };
  if (!match[4]) return `${match[1]}.${match[2]}.${increment(match[3])}`;
  const parts = match[4].split('.');
  if (/^\d+$/.test(parts.at(-1))) parts[parts.length-1] = increment(parts.at(-1));
  else parts.push('1');
  return `${match[1]}.${match[2]}.${match[3]}-${parts.join('.')}`;
}

export function nextReleaseVersion(version,kind='patch') {
  nextBuildVersion(version);
  if(!['patch','minor','major'].includes(kind))throw Error('Choose patch, minor or major for a release.');
  const [base,preview]=version.split('-',2),parts=base.split('.').map(Number);
  const index={major:0,minor:1,patch:2}[kind];
  if(!(kind==='patch'&&preview)){parts[index]++;if(!Number.isSafeInteger(parts[index]))throw Error('The version counter is too large.');}
  for(let i=index+1;i<3;i++)parts[i]=0;
  return parts.join('.');
}

async function replaceFile(target, text) {
  const temporary = target + '.version-' + randomUUID();
  try { await writeFile(temporary, text); await rename(temporary, target); }
  finally { await unlink(temporary).catch(() => {}); }
}

export async function prepareVersion(root, {advance = false,release=null,setVersion=null} = {}) {
  if([Boolean(advance),Boolean(release),Boolean(setVersion)].filter(Boolean).length>1)throw Error('Choose one version operation.');
  if(setVersion!==null)nextBuildVersion(setVersion);
  root = path.resolve(root);
  let lock;
  const lockPath = path.join(root, '.exomina-version.lock');
  try {
    try { lock = await open(lockPath, 'wx'); }
    catch (error) { if (error.code === 'EEXIST') throw Error('A version update is already running, or an interrupted version update left .exomina-version.lock. Check the other build before retrying.'); throw error; }
    await lock.writeFile(JSON.stringify({pid: process.pid, startedAt: new Date().toISOString()}));
    const manifestPath = path.join(root, 'package.json'), manifestText = await readFile(manifestPath, 'utf8'), manifest = JSON.parse(manifestText);
    nextBuildVersion(manifest.version); // Validate even a non-release asset build.
    const version = setVersion|| (release?nextReleaseVersion(manifest.version,release):advance?nextBuildVersion(manifest.version):manifest.version);
    const changes = [];
    if (advance||release||setVersion) {
      const lockfilePath = path.join(root, 'package-lock.json'), lockfileText = await readFile(lockfilePath, 'utf8'), lockfile = JSON.parse(lockfileText);
      if (!lockfile.packages?.['']) throw Error('The package lock is missing its root package. Repair it before packaging.');
      manifest.version = version; lockfile.version = version; lockfile.packages[''].version = version;
      changes.push({path: manifestPath, before: manifestText, after: JSON.stringify(manifest,null,2)+'\n'}, {path: lockfilePath, before: lockfileText, after: JSON.stringify(lockfile,null,2)+'\n'});
    }
    const metadataPath = path.join(root, 'desktop', 'app-version.json');
    let metadataBefore;
    try { metadataBefore = await readFile(metadataPath, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    changes.push({path: metadataPath, before: metadataBefore, after: JSON.stringify({version},null,2)+'\n'});
    const written = [];
    try {
      for (const change of changes) { if (change.before !== change.after) { await replaceFile(change.path, change.after); written.push(change); } }
    } catch (error) {
      for (const change of written.reverse()) { if (change.before === undefined) await unlink(change.path); else await replaceFile(change.path, change.before); }
      throw error;
    }
    return version;
  } finally { if (lock) { await lock.close(); await unlink(lockPath); } }
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const valid=!args.length||args.length===1&&args[0]==='--advance'||args.length===2&&['--release','--set'].includes(args[0]);
  if(!valid)throw Error('Use prepare-version.mjs [--release patch|minor|major | --set VERSION].');
  const options=args[0]==='--release'?{release:args[1]}:args[0]==='--set'?{setVersion:args[1]}:{advance:args.includes('--advance')};
  const version = await prepareVersion(fileURLToPath(new URL('..',import.meta.url)),options);
  if(args.length)console.log(`Selected Exomina release ${version}`);
}
