import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
const [root,desktop]=process.argv.slice(2);
const {ExecutionClient}=await import(pathToFileURL(path.join(desktop,'execution-client.mjs')));
const client=new ExecutionClient({root});
try{
  await client.init();
  const binding={id:'pty:'+randomUUID(),conversationId:'synthetic-crash',owner:'agent',workspace:root,startDirectory:root,title:'Isolated crash recovery',cols:80,rows:24};
  const pty=await client.native.spawn(null,null,{exomina:binding});
  const marker='CRASH-GRACE-'+randomUUID();
  await pty.write(process.platform==='win32'?"Write-Output '"+marker+"'\r":"printf '%s\\n' '"+marker+"'\n");
  const end=Date.now()+15_000;let text='';
  while(!text.includes(marker)){
    if(Date.now()>end)throw Error('Native terminal did not print its marker.');
    text=(await client.request('read',{id:binding.id,conversationId:binding.conversationId,owner:binding.owner})).text;
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  process.send({ready:true,id:binding.id,pid:pty.pid,marker});
  // The QA parent force-kills this desktop-like owner. The host and shell run
  // independently, so their connection recovery can be observed after death.
}catch(error){process.send?.({error:error.message});client.close();process.exitCode=1;}
