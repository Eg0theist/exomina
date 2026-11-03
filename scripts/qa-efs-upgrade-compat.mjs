// Reproduce the legacy EFS/standard-inspector incompatibility with native
// Windows helpers and a disposable profile. No real account store is opened.
import {createProtectedQaProfile} from './qa-profile.mjs';
import {ProfileStorage} from '../desktop/profile-storage.mjs';
import {WindowsVault} from '../desktop/vault.mjs';
import {WindowsProfileAccess} from '../desktop/profile-access.mjs';
import {mkdir,readFile,writeFile,symlink} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
const {profile,output}=await createProtectedQaProfile('efs-upgrade-compat');
const runtime=path.join(output,'synthetic-runtime'),workspace=path.join(output,'project'),cache=path.join(output,'synthetic-cache');
for(const directory of [runtime,workspace,cache])await mkdir(directory);
const recovery=await readFile(profile+'.setup/recovery-backup.json','utf8'),proof={recoveryThumbprint:JSON.parse(recovery).thumbprint};
const vault=new WindowsVault(),access=new WindowsProfileAccess(),report={scope:'Native EFS/profile helpers in new disposable folders, with a synthetic legacy runtime junction. No personal data or real account store access.',passed:false};
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
try{
  await vault.protect(runtime,proof);
  await writeFile(path.join(cache,'synthetic.txt'),'Synthetic external cache sentinel');
  await symlink(cache,path.join(runtime,'legacy-cache'),'junction');
  await assert.rejects(access.inspect(runtime),/symbolic link|junction|placeholder/);
  report.legacyStandardWalkerRejectionReproduced=true;
  const before=digest(await readFile(path.join(profile,'synthetic-profile.txt')));
  const storage=new ProfileStorage({dataDir:profile,accountsDir:runtime,workspace,vault,access});
  try{
    const status=await storage.initialize();assert.equal(status.ready,true,status.message);assert.equal(status.mode,'efs');assert.equal(status.protected,true);
    assert.equal((await storage.verifyPrivate(runtime)).encrypted,true);
    assert.equal(digest(await readFile(path.join(profile,'synthetic-profile.txt'))),before);
    assert.equal(await readFile(profile+'.setup/recovery-backup.json','utf8'),recovery);
    assert.equal(await readFile(path.join(cache,'synthetic.txt'),'utf8'),'Synthetic external cache sentinel');
    await assert.rejects(storage.selectStandard(),/cannot be downgraded/);
    report.legacyEfsReadinessPreserved=true;report.dataAndRecoveryBytesPreserved=true;report.status={ready:status.ready,mode:status.mode,protected:status.protected};report.passed=true;
  }finally{storage.close();}
}catch(error){report.error=error.message;}finally{vault.close();access.close();}
await writeFile(path.join(output,'result.json'),JSON.stringify(report,null,2),'utf8');console.log(JSON.stringify({output,...report}));if(!report.passed)process.exitCode=1;
