import path from 'node:path';
import {existsSync} from 'node:fs';
import {pathsEqual} from './path-policy.mjs';

/** App-owned locations are independent of the checkout and packaged executable.
 * Explicit data overrides keep development and synthetic QA profiles isolated.
 */
export function appPaths({packaged,root,localAppData,appData,documents,legacyDataDir,legacyDataExists=false,ownDataExists=false,betaDataExists=false,distribution,home,platform=process.platform,env=process.env,pathApi=path}) {
  const p=pathApi;
  if(env.EXOMINA_DATA_DIR||!packaged){
    const dataDir=p.resolve(env.EXOMINA_DATA_DIR||p.join(root,'data'));
    return {dataDir,accountsDir:p.resolve(env.EXOMINA_ACCOUNTS_DIR||dataDir),workspace:p.resolve(env.EXOMINA_WORKSPACE_DIR||p.join(dataDir,'workspace'))};
  }
  // An installation can keep its data beside the program (for example
  // C:\Program Files\Exomina\{App,Private,Workspace}) via exomina.paths.json.
  if(home)return {dataDir:p.join(home,'Private','data'),accountsDir:p.join(home,'Private','accounts'),workspace:p.join(home,'Workspace'),home};
  if(distribution?.profile==='public')throw Error('This public package must be installed into its protected App folder before opening it. Run the signed Exomina installer.');
  if(!documents||(platform==='win32'?!localAppData:!appData))throw Error('The operating system could not locate your Exomina folders.');
  // Existing portable previews must keep their chats when upgraded. Relocation
  // is a separate verified migration; never silently initialize an empty store.
  const beta=distribution?.profile==='beta'&&distribution.manualUpdates===true;
  if(legacyDataExists&&!ownDataExists&&(!beta||!betaDataExists)&&legacyDataDir)return {dataDir:legacyDataDir,accountsDir:legacyDataDir,workspace:p.join(legacyDataDir,'workspace'),legacy:true};
  // New beta installers keep private data outside redirected Documents. Existing
  // profiles keep their current location; relocation still requires migration.
  const privateRoot=p.join(platform!=='win32'?appData:beta&&(!ownDataExists||betaDataExists)?localAppData:documents,'Exomina','Private');
  return {dataDir:p.join(privateRoot,'data'),accountsDir:p.join(privateRoot,'accounts'),workspace:p.join(documents,'Exomina','Workspace')};
}

/** Resolve legacy/default folders only when explicit isolated paths do not win. */
export function resolveAppLocations({packaged,root,home,distribution,env=process.env,platform=process.platform,pathApi=path,getPath,exists}) {
 const options={packaged,root,home,distribution,env,platform,pathApi};
 if(env.EXOMINA_DATA_DIR||!packaged||home)return appPaths(options);
 const documents=getPath('documents'),appData=getPath('appData');
 const legacyDataDir=pathApi.join(pathApi.dirname(getPath('exe')),'data');
 return appPaths({...options,documents,appData,localAppData:env.LOCALAPPDATA,legacyDataDir,
  legacyDataExists:exists(pathApi.join(legacyDataDir,'state.json')),
  ownDataExists:platform==='win32'&&exists(pathApi.join(documents,'Exomina','Private','data','state.json')),
  betaDataExists:platform==='win32'&&Boolean(env.LOCALAPPDATA)&&exists(pathApi.join(env.LOCALAPPDATA,'Exomina','Private','data','state.json'))});
}

/** Installed distribution metadata never supplies data paths or credentials. */
export function distributionMetadataDirectory(exeDir,{platform=process.platform,pathApi=path}={}) {
  if(platform==='darwin'&&pathApi.basename(exeDir)==='MacOS'&&pathApi.basename(pathApi.dirname(exeDir))==='Contents')return pathApi.resolve(exeDir,'..','Resources');
  return exeDir;
}

export function installDistribution(exeDir,{read,pathApi=path,platform=process.platform}={}) {
  const metadataDir=distributionMetadataDirectory(exeDir,{pathApi,platform});
  let text;try{text=read(pathApi.join(metadataDir,'exomina.distribution.json'));}catch(error){if(error?.code==='ENOENT')return undefined;throw error;}
  const source=String(text).trimStart();
  if(source.length>4096)throw Error('Installed exomina.distribution.json exceeds its size limit.');
  let value;try{value=JSON.parse(source);}catch{throw Error('Installed exomina.distribution.json is not valid JSON.');}
  if(value?.profile==='beta'&&value.manualUpdates===true)return {profile:'beta',manualUpdates:true};
  if(value?.profile==='public'&&value.manualUpdates===false){
    const repositoryUrl=value.repositoryUrl;
    if(typeof repositoryUrl!=='string'||!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(repositoryUrl))throw Error('exomina.distribution.json must identify a public GitHub repository.');
    return {profile:'public',manualUpdates:false,repositoryUrl:repositoryUrl.replace(/\/$/,'')};
  }
  throw Error('exomina.distribution.json must identify a supported public or beta distribution.');
}

/** Reads <exe folder>\exomina.paths.json: {"home": "..\\"} (relative to that folder) or an absolute path. */
export function installHome(exeDir,{read,exists=existsSync,pathApi=path}={}) {
  let text;try{text=read(pathApi.join(exeDir,'exomina.paths.json'));}catch(error){
    if(error?.code!=='ENOENT')throw error;
    // Older in-place installers could delete the marker before a failed copy.
    // Recover only the complete dedicated layout beside this executable.
    const parent=pathApi.dirname(exeDir);
    if(pathApi.basename(exeDir).toLowerCase()==='app'&&exists(pathApi.join(parent,'Private'))){
      if(['Private/data/state.json','Private/accounts','Workspace'].every(relative=>exists(pathApi.join(parent,...relative.split('/')))))return parent;
      throw Error('The installed Exomina profile location is missing. Repair this installation before opening another profile.');
    }
    return undefined;
  }
  let value;try{value=JSON.parse(String(text).trimStart());}catch{throw Error('exomina.paths.json next to Exomina.exe is not valid JSON.');}
  if(typeof value?.home!=='string'||!value.home.trim()||/[\x00-\x1f*?"<>|]/.test(value.home))throw Error('exomina.paths.json must name a "home" folder.');
  const home=pathApi.resolve(exeDir,value.home.trim());
  if(home.split(/[\\/]/).filter(Boolean).length<2)throw Error('exomina.paths.json cannot use a drive root as Exomina’s home.');
  return home;
}

export function samePath(a,b,options){return pathsEqual(a,b,options);}
