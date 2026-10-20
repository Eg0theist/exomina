// Publishing a new baseline is explicit. Ordinary customization builds retain the installed baseline.
import {spawn} from 'node:child_process';
const env={...process.env,EXOMINA_PUBLISHER_BUILD:'1'};delete env.EXOMINA_OFFICIAL_SOURCE;
const child=spawn(process.execPath,['scripts/release-windows.mjs'],{env,stdio:'inherit',windowsHide:true,shell:false});
child.once('error',error=>{console.error(error.message);process.exitCode=1;});child.once('close',code=>{process.exitCode=code??1;});
