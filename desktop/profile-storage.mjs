import path from 'node:path';
import {mkdir,readFile,writeFile,rename,lstat,realpath} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {WindowsVault} from './vault.mjs';
import {WindowsProfileAccess,prepareUnixProfile} from './profile-access.mjs';
import {pathsEqual} from './path-policy.mjs';

const blocked=message=>Object.assign(new Error(message),{code:'PROFILE_STORAGE_UNAVAILABLE'});
const baseStatus=()=>({ready:false,mode:'standard',folderEncrypted:false,protected:false,restrictedAccess:false,supported:false,encryptionAvailable:false,needsRecovery:false,pendingEncryption:false,canUseStandard:false,message:'Checking local app storage…'});
const metadataNames={policy:'storage-policy.json',recovery:'recovery-backup.json'};

export class ProfileStorage {
  constructor({dataDir,accountsDir=dataDir,workspace=path.join(dataDir,'workspace'),setupDir=dataDir+'.setup',platform=process.platform,vault=new WindowsVault({platform}),access,fs={mkdir,readFile,writeFile,rename,lstat,realpath}}={}){
    Object.assign(this,{dataDir,accountsDir,workspace,setupDir,platform,vault,fs});
    const allowedLinks=[dataDir,path.join(dataDir,'browser-data'),path.join(setupDir,'public-profile')].flatMap(root=>['SingletonLock','SingletonCookie','SingletonSocket'].map(name=>path.join(root,name)));
    this.access=access||(platform==='win32'?new WindowsProfileAccess():{inspect:directory=>prepareUnixProfile(directory,{prepare:false,allowedLinks}),prepare:directory=>prepareUnixProfile(directory,{allowedLinks}),verify:directory=>prepareUnixProfile(directory,{prepare:false,verify:true,allowedLinks}),close(){}});
    this.policyFile=path.join(setupDir,metadataNames.policy);this.recoveryFile=path.join(setupDir,metadataNames.recovery);this.probeDir=path.join(setupDir,'recovery-probe');
    this.status={...baseStatus(),dataPath:dataDir};this.recoveryRecord=null;this.recoveryPresent=false;this.policy=null;this.privateChecks=new Map();this.anyEncrypted=false;
  }
  async exists(location){try{await this.fs.lstat(location);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
  async readMetadata(file){
    let info;try{info=await this.fs.lstat(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}
    if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>4096)throw blocked('App storage setup metadata is invalid. Preserve existing files before repairing it.');
    let value;try{value=JSON.parse(await this.fs.readFile(file,'utf8'));}catch{throw blocked('App storage setup metadata could not be read. Preserve existing files before repairing it.');}
    if(value===null||typeof value!=='object'||Array.isArray(value))throw blocked('App storage setup metadata is invalid. Preserve existing files before repairing it.');
    return value;
  }
  async savePolicy(policy){
    await this.fs.mkdir(this.setupDir,{recursive:true,mode:0o700});
    const temp=this.policyFile+'.'+randomUUID()+'.tmp';await this.fs.writeFile(temp,JSON.stringify(policy),{mode:0o600});await this.fs.rename(temp,this.policyFile);this.policy=policy;
  }
  async initialize(){
    this.status={...baseStatus(),dataPath:this.dataDir};this.privateChecks.clear();this.anyEncrypted=false;this.recoveryRecord=null;this.recoveryPresent=false;
    try{
      if(await this.exists(this.setupDir))await this.access.inspect(this.setupDir);
      this.policy=await this.readMetadata(this.policyFile);
      if(this.policy&&(this.policy.version!==1||!['standard','efs'].includes(this.policy.mode)||(this.policy.pending!==undefined&&typeof this.policy.pending!=='boolean')))throw blocked('App storage policy is invalid. Preserve existing files before repairing it.');
      if(this.policy?.mode==='efs'){this.status.mode='efs';this.status.needsRecovery=true;}
      this.recoveryPresent=await this.exists(this.recoveryFile);
      if(this.recoveryPresent){this.status.mode='efs';this.status.needsRecovery=true;}
      const recovery=await this.readMetadata(this.recoveryFile);
      if(recovery&&!/^[A-Fa-f0-9]{40}$/.test(recovery.thumbprint||''))throw blocked('The saved EFS recovery record is invalid. Preserve it and verify your existing recovery backup.');
      this.recoveryRecord=recovery;
      const roots=[...new Set([this.dataDir,this.accountsDir])];
      for(const root of roots){if(!await this.exists(root))continue;const check=await this.access.inspect(root);this.anyEncrypted||=check.anyEncrypted===true;this.status.encryptionAvailable||=check.efsAvailable===true;}
      if(this.anyEncrypted)this.status.mode='efs';
      if(this.status.mode==='efs'){
        this.status.needsRecovery=!this.recoveryRecord;this.status.pendingEncryption=this.policy?.mode==='efs'&&this.policy.pending===true;
        this.status.canUseStandard=this.status.pendingEncryption&&!this.recoveryPresent&&!this.anyEncrypted;
        if(this.platform!=='win32')throw blocked('This existing EFS profile requires Windows and its recovery certificate. It has not been converted or replaced.');
        const checks=[];
        for(const root of [...new Set([...roots,this.workspace])]){
          if(root!==this.dataDir&&!await this.exists(root))continue;
          checks.push(this.recoveryRecord?await this.vault.verifyStartup(root,{recoveryThumbprint:this.recoveryRecord.thumbprint}):await this.vault.preflight(root));
        }
        const check={encrypted:checks.every(value=>value.encrypted===true),restrictedAccess:checks.every(value=>value.restrictedAccess===true)};
        const ready=check.encrypted===true&&check.restrictedAccess===true&&!!this.recoveryRecord;
        this.status={...this.status,ready,folderEncrypted:ready,protected:ready,restrictedAccess:check.restrictedAccess===true,supported:true,pendingEncryption:this.status.pendingEncryption&&!ready,message:ready?'App folders use Windows EFS encryption.':'Save or verify your EFS recovery key, then enable full-folder encryption.'};
        if(ready)this.privateChecks.set(this.dataDir,{ready:true,mode:'efs',encrypted:true,folderEncrypted:true,restrictedAccess:true});
      }else{
        for(const root of roots){await this.fs.mkdir(root,{recursive:true,mode:0o700});const check=await this.access.prepare(root);if(check.restrictedAccess!==true||check.anyEncrypted===true)throw blocked('Private app access permissions could not be confirmed. Existing data was preserved.');this.status.encryptionAvailable||=check.efsAvailable===true;this.privateChecks.set(root,{ready:true,mode:'standard',folderEncrypted:false,restrictedAccess:true});}
        await this.fs.mkdir(this.setupDir,{recursive:true,mode:0o700});
        const setup=await this.access.inspect(this.setupDir);if(setup.anyEncrypted)await this.access.verify(this.setupDir);else await this.access.prepare(this.setupDir);
        if(!this.policy)await this.savePolicy({version:1,mode:'standard'});
        this.status={...this.status,ready:true,mode:'standard',folderEncrypted:false,protected:false,restrictedAccess:true,supported:true,needsRecovery:false,pendingEncryption:false,canUseStandard:false,message:'App files use private access permissions. Keys added in Connections require available protected operating-system storage; chats and some provider sign-in files are not encrypted by Exomina.'};
      }
    }catch(error){this.status={...this.status,ready:false,protected:false,folderEncrypted:false,supported:false,needsRecovery:this.status.mode==='efs',message:error.message||'App storage could not be verified. Preserve existing data before retrying.'};}
    return this.status;
  }
  async verifyPrivate(directory){
    if(!this.status.ready)throw blocked(this.status.message);
    for(const [root,check]of this.privateChecks)if(pathsEqual(root,directory,{platform:this.platform}))return check;
    if(this.status.mode==='efs')return this.vault.verifyStartup(directory,{recoveryThumbprint:this.recoveryRecord?.thumbprint});
    const checked=await this.access.verify(directory);if(checked.anyEncrypted)throw blocked('An encrypted profile needs the EFS recovery workflow. It was not changed.');
    return {ready:true,mode:'standard',folderEncrypted:false,restrictedAccess:checked.restrictedAccess===true};
  }
  async verifyWorkspace(){
    if(this.status.mode==='efs')return this.vault.verifyStartup(this.workspace,{recoveryThumbprint:this.recoveryRecord?.thumbprint});
    if(!this.status.ready)throw blocked(this.status.message);
    await this.fs.mkdir(this.workspace,{recursive:true,mode:0o700});const entry=await this.fs.lstat(this.workspace);
    if(!entry.isDirectory()||entry.isSymbolicLink())throw blocked('The default project folder is not a regular directory. Choose a project folder in Settings.');
    return {ready:true,mode:'standard',projectDirectory:true,folderEncrypted:false};
  }
  async setupProfile(){
    await this.fs.mkdir(this.setupDir,{recursive:true,mode:0o700});
    const setup=await this.access.inspect(this.setupDir);if(setup.anyEncrypted)await this.access.verify(this.setupDir);else await this.access.prepare(this.setupDir);
    const publicProfile=path.join(this.setupDir,'public-profile');await this.fs.mkdir(publicProfile,{recursive:true,mode:0o700});
    if(this.status.mode!=='efs'||this.platform!=='win32')return publicProfile;
    await this.fs.mkdir(this.probeDir,{recursive:true,mode:0o700});
    try{
      try{await this.vault.verify(this.probeDir);}catch{await this.vault.prepareRecoveryProbe(this.probeDir);}
      const probe=await this.vault.preflight(this.probeDir);if(!probe.encrypted||!probe.restrictedAccess)throw blocked('The EFS setup folder could not be verified.');
      const encryptedProfile=path.join(this.probeDir,'setup-profile');await this.fs.mkdir(encryptedProfile,{recursive:true,mode:0o700});await this.vault.verify(this.probeDir);
      this.status.supported=true;this.status.encryptionAvailable=true;return encryptedProfile;
    }catch(error){this.status.supported=false;this.status.encryptionAvailable=false;this.status.message=error.message;return publicProfile;}
  }
  async selectEncrypted({confirm=false}={}){
    if(confirm!==true)throw blocked('Confirm that you want full-folder EFS encryption and a recovery backup.');
    if(!this.status.ready||this.status.mode!=='standard'||!this.status.encryptionAvailable||this.platform!=='win32')throw blocked('Optional Windows EFS encryption is unavailable for this profile or Windows configuration.');
    await this.savePolicy({version:1,mode:'efs',pending:true});return {restarting:true};
  }
  async selectStandard(){
    if(!this.status.canUseStandard||this.recoveryPresent||this.recoveryRecord||this.anyEncrypted)throw blocked('Existing EFS data or recovery records cannot be downgraded to standard storage.');
    if(await this.exists(this.recoveryFile))throw blocked('An existing EFS recovery record cannot be downgraded to standard storage.');
    for(const root of [...new Set([this.dataDir,this.accountsDir])])if(await this.exists(root)&&(await this.access.inspect(root)).anyEncrypted)throw blocked('Existing EFS data cannot be downgraded to standard storage.');
    await this.savePolicy({version:1,mode:'standard'});return {restarting:true};
  }
  async saveRecovery(record){
    if(this.status.mode!=='efs'||!/^[A-Fa-f0-9]{40}$/.test(record?.thumbprint||''))throw blocked('A valid EFS recovery backup is required.');
    const temp=this.recoveryFile+'.'+randomUUID()+'.tmp';await this.fs.writeFile(temp,JSON.stringify(record),{mode:0o600});await this.fs.rename(temp,this.recoveryFile);
    this.recoveryRecord=record;this.recoveryPresent=true;this.status.needsRecovery=false;this.status.canUseStandard=false;
  }
  close(){this.access.close?.();}
}

export async function initializeProfileStorage(options){const profile=new ProfileStorage(options);await profile.initialize();return profile;}
