import {writeFile} from 'node:fs/promises';
import {ensureWindowsAppIndependence} from '../desktop/app-lifetime.mjs';
const [exe,script,report,ready]=process.argv.slice(2);
const result=await ensureWindowsAppIndependence({packaged:true,exePath:exe,scriptPath:script,args:['sentinel',report,'A "quoted" argument','C:\\folder with space\\','literal $() & >'],env:{...process.env,EXOMINA_DATA_DIR:'C:\\Synthetic Exomina Lifetime Profile'},timeoutMs:10000});
await writeFile(ready,JSON.stringify({...result,originalPid:process.pid}));
// The original intentionally remains alive until the synthetic parent job ends.
setInterval(()=>{},1000);
