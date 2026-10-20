// Execute the installed detector with a synthetic executor. Native commands,
// machine identifiers, provider accounts and network requests are not used.
import cp from 'node:child_process';
import util from 'node:util';
import {syncBuiltinESMExports} from 'node:module';

const calls=[];
const stub=command=>{throw Error('Unexpected command: '+command);};
stub[util.promisify.custom]=async(command,options)=>{
  calls.push({command,windowsHide:options?.windowsHide===true});
  return {stdout:'REG_SZ synthetic-machine-id',stderr:''};
};
cp.exec=stub;
for(const name of ['spawn','spawnSync','execSync','execFile','execFileSync','fork'])cp[name]=()=>{throw Error('No native processes are permitted in this probe.');};
syncBuiltinESMExports();
const bundle=new URL('../../node_modules/@google/gemini-cli/bundle/',import.meta.url);
const helper=await import(new URL('getMachineId-win-6KLLGOI4.js',bundle));
const syntheticId=await helper.default.getMachineId();
const detector=calls.splice(0);

process.env.GEMINI_TELEMETRY_ENABLED='false';
process.env.OTEL_SDK_DISABLED='true';
process.env.OTEL_NODE_RESOURCE_DETECTORS='none';
const core=await import(new URL('core-4NPF436I.js',bundle));
const resolved=await core.resolveTelemetrySettings({env:process.env,settings:{enabled:true}});
// The actual initializer must return before accessing account/installation
// attributes or constructing a resource detector when this resolves to false.
await core.initializeTelemetry({getTelemetryEnabled:()=>resolved.enabled});
await new Promise(resolve=>setImmediate(resolve));
process.stdout.write(JSON.stringify({syntheticId,detector,telemetryEnabled:resolved.enabled,afterDisabledTelemetry:calls})+'\n');
process.exit(0);
