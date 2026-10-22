// Resolve the same package.json/config merge used by the locked builder.
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {crossPlatformConfig} from './cross-platform-config.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export async function validateNativeConfig(platform,arch,{ciOnly=false}={}){
 const require=createRequire(import.meta.url);
 const builderRoot=path.dirname(require.resolve('app-builder-lib/package.json'));
 const {getConfig,validateConfiguration}=require(path.join(builderRoot,'out','util','config','config.js'));
 const config=await getConfig(root,undefined,crossPlatformConfig(platform,{arch,ciOnly}));
 await validateConfiguration(config,{isEnabled:false});
 return {platform,arch,ciOnly,formats:(platform==='darwin'?config.mac:config.linux).target.map(target=>target.target),electronDist:config.electronDist,win:config.win,nsis:config.nsis,debPackageName:config.deb?.packageName,macIdentity:config.mac?.identity};
}
if(path.resolve(process.argv[1]||'')===fileURLToPath(import.meta.url)){
 const results=[];
 for(const platform of ['darwin','linux'])for(const arch of ['x64','arm64'])for(const ciOnly of [false,true])results.push(await validateNativeConfig(platform,arch,{ciOnly}));
 console.log(JSON.stringify(results));
}
