import path from 'node:path';
import {permissionRuleMatches} from './permissions.mjs';

export const normalized=value=>path.resolve(value).replaceAll('\\','/').toLowerCase().replace(/\/+$/,'');
export const within=(root,file)=>{const a=normalized(root),b=normalized(file);return b===a||b.startsWith(a+'/');};
const deniedPath=(file,rules)=>rules.some(rule=>typeof rule==='string'?permissionRuleMatches({tool:'disk_*',match:rule},{tool:'disk_read',target:file}):['disk_scan','disk_read'].some(tool=>permissionRuleMatches(rule,{tool,target:file})));

// One list drives both the JavaScript walker and the native scanner, so they cannot drift apart.
export const EXCLUDED_PATTERNS=[
 /(?:^|\/)(?:accounts|credentials|vault|keychains|\.ssh|\.aws|\.azure|\.gnupg)(?:\/|$)/i,
 /\/(?:google\/chrome|microsoft\/edge|bravesoftware\/brave-browser)\/user data(?:\/|$)/,
 /\/mozilla\/firefox\/profiles(?:\/|$)/,
 /\/exomina\/private(?:\/|$)/,
 /(?:^|\/)(?:system volume information|\$recycle\.bin)(?:\/|$)/,
 /(?:^|\/)(?:\.kube|\.docker|\.git-credentials|\.netrc|\.npmrc|\.pypirc|\.env(?:\.[^/]*)?)(?:\/|$)/,
 /\.(?:kdbx|pst|ost|pfx|p12|pem|key)$/,
 /\/(?:microsoft\/(?:protect|crypto|credentials|outlook)|signal|telegram desktop\/tdata|1password|bitwarden|thunderbird\/profiles)(?:\/|$)/,
 /\/(?:google\/(?:chrome|chrome sxs)|chromium|vivaldi|opera software|the browser company)(?:\/|$)/,
 /\/(?:\.config\/(?:gcloud|google-chrome|chromium|brave|microsoft-edge)|\.mozilla\/firefox|application support\/(?:google\/chrome|firefox|bravesoftware|microsoft edge))(?:\/|$)/
];
export function excludedDiskPath(file,privateDirs=[],denied=[]){
 if(privateDirs.some(dir=>within(dir,file)))return true;
 if(deniedPath(file,denied))return true;
 const p=normalized(file);
 return EXCLUDED_PATTERNS.some(pattern=>pattern.test(p));
}
/** Deny rules that apply to storage tools, as the match strings the native scanner evaluates itself. */
export function nativeDenyMatches(denied=[]){
 const out=[];
 for(const rule of denied){
  if(typeof rule==='string'){if(rule)out.push(rule);continue;}
  if(!['disk_scan','disk_read'].some(tool=>permissionRuleMatches({tool:rule.tool,match:''},{tool,target:''})))continue;
  out.push(rule.match||'*');
 }
 return [...new Set(out)];
}

export const FILE_CATEGORIES=['video','audio','images','archives','documents','code','apps','disks','data','logs','other'];
export const CATEGORY_LABELS={video:'Videos',audio:'Music & audio',images:'Pictures',archives:'Archives',documents:'Documents',code:'Code & build files',apps:'Programs & system files',disks:'Disk images & backups',data:'Databases & game data',logs:'Logs & temporary files',other:'Everything else'};
export const AGE_LABELS=['Under 1 month','1 to 3 months','3 to 6 months','6 to 12 months','1 to 2 years','Over 2 years'];

export function diskAdvice(file,{appRoots=[]}={}){
 const p=String(file).replaceAll('\\','/').toLowerCase();
 if(/^[a-z]:\/(?:windows|recovery|efi|boot|\$windows\.~bt|system volume information)(?:\/|$)/.test(p)||/\/(?:pagefile|hiberfil|swapfile)\.sys$/.test(p)||/\/(?:bootmgr|bootnxt|ntldr|ntdetect\.com)$/.test(p))
  return {kind:'keep',label:'System managed',reason:'Windows components, servicing or recovery data. Keep these files; use Windows Storage cleanup for supported temporary-file categories.',method:'Windows Settings → System → Storage → Temporary files'};
 if(/^[a-z]:\/windows\.old(?:\/|$)/.test(p))return {kind:'keep',label:'Previous Windows installation',reason:'System rollback data. Manual deletion is inappropriate; removing it may prevent returning to the previous installation.',method:'Windows Storage → Temporary files → Previous Windows installation, after reviewing rollback needs'};
 if(appRoots.some(root=>within(root,file)))
  return {kind:'review',label:'Exomina files',reason:'May include the active app, source, saved work or update backups. Keep the active installation and private data; verify old builds and backups individually.',method:'Review the active build and backup purpose before removing anything'};
 if(/^[a-z]:\/(?:program files(?: \(x86\))?|programdata)(?:\/|$)/.test(p)||/\/(?:applications|windowsapps)(?:\/|$)/.test(p))
  return {kind:'keep',label:'Installed application',reason:'Application components or shared data. Removing folders can break software. Decide whether the app is still needed, then use its uninstaller.',method:'Windows Settings → Apps → Installed apps'};
 if(/\/(?:appdata\/local\/(?:temp|[^/]+\/(?:cache|gpucache|code cache))|\.cache)(?:\/|$)/.test(p))
  return {kind:'candidate',label:'Cache or temporary data',reason:'May be regenerable, but names alone do not prove safety. Close the owning app and verify contents, age and active use before cleanup.',method:'Use the owning application’s cache controls or Windows Storage cleanup'};
 if(/(?:^|\/)node_modules(?:\/|$)/.test(p))
  return {kind:'review',label:'Project dependencies',reason:'Often reproducible from a lockfile, but may be needed by active projects, offline work or packaged apps. Verify ownership and reproducibility.',method:'Review the project and reinstall procedure'};
 return {kind:'review',label:'Needs review',reason:'Personal files, archives and unknown folders can be valuable. Size is not evidence that they are disposable.',method:'Review ownership, purpose and backups; ask before deleting'};
}

// Folder names that commonly hold regenerable data. Totals count the outermost match only, so
// nested copies are not counted twice. These are leads to verify, never deletion advice.
export const SPACE_HOG_NAMES={
 'node_modules':{label:'Project dependencies (node_modules)',reason:'Usually reinstallable from each project’s lockfile. Confirm which projects are still active.',method:'Delete inside finished projects, then run the package manager again when needed'},
 '__pycache__':{label:'Python bytecode caches',reason:'Rebuilt automatically the next time the code runs.',method:'Safe to clear when no Python program is running'},
 '.gradle':{label:'Gradle caches',reason:'Downloaded build dependencies; Gradle fetches them again when needed.',method:'Use Gradle’s own cleanup or delete when builds are not running'},
 '.nuget':{label:'NuGet packages',reason:'Package cache that restores on demand.',method:'dotnet nuget locals all --clear'},
 'npm-cache':{label:'npm cache',reason:'Downloaded package archives that npm can fetch again.',method:'npm cache clean --force'},
 '_cacache':{label:'npm download cache',reason:'Downloaded package archives that npm can fetch again.',method:'npm cache clean --force'},
 'gpucache':{label:'Graphics shader caches',reason:'Rebuilt by the owning app. Close the app first.',method:'Clear from the owning application or leave it'},
 'code cache':{label:'App code caches',reason:'Rebuilt by the owning app. Close the app first.',method:'Clear from the owning application'},
 'crashdumps':{label:'Crash dumps',reason:'Diagnostic memory dumps. Only useful if you are investigating a crash.',method:'Windows Settings → System → Storage → Temporary files'},
 'temp':{label:'Temporary folders',reason:'Scratch space for running programs. Verify contents, age and active use first.',method:'Windows Settings → System → Storage → Temporary files'},
 'shadercache':{label:'Shader caches',reason:'Rebuilt by games and graphics drivers.',method:'Clear from the graphics driver or game launcher'},
 'downloads':{label:'Downloads folders',reason:'Often holds installers and archives that were used once. Contents are personal, so review each item.',method:'Review by size and date before removing anything'}
};
