import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnLogin} from '../desktop/provider-login.mjs';

test('interactive login has its own terminal, retains private environment and never launches a shell',async()=>{
 let received,output,exit;const writes=[],disposed=[];
 const terminal={pid:123,write:value=>writes.push(value),kill(){this.killed=true;},onData:listener=>(output=listener,{dispose:()=>disposed.push('data')}),onExit:listener=>(exit=listener,{dispose:()=>disposed.push('exit')})};
 const child=await spawnLogin('/synthetic/claude',['auth','login'],{cwd:'/synthetic/work',env:{CLAUDE_CONFIG_DIR:'/synthetic/accounts/claude-home'}},async()=>({spawn:(...args)=>(received=args,terminal)}),async()=>{});
 assert.equal(received[0],'/synthetic/claude');assert.deepEqual(received[1],['auth','login']);assert.equal(received[2].env.CLAUDE_CONFIG_DIR,'/synthetic/accounts/claude-home');assert.equal(received[2].shell,undefined);
 let text='';child.stdout.on('data',value=>text+=value);output('Paste code here if prompted >');
 await new Promise((resolve,reject)=>child.stdin.write('synthetic-code\r',error=>error?reject(error):resolve()));assert.deepEqual(writes,['synthetic-code\r']);
 const closed=new Promise(resolve=>child.once('close',resolve));exit({exitCode:0});assert.equal(await closed,0);assert.equal(child.exitCode,0);assert.match(text,/Paste code/);assert.deepEqual(disposed,['data','exit']);
});

test('real private terminal delivers pasted code followed by a separate Enter to a raw-mode program',{timeout:20000},async t=>{
 const program="if(!process.stdin.isTTY)process.exit(2);process.stdin.setRawMode(true);let text='';process.stdin.on('data',chunk=>{text+=chunk.toString();if(text.endsWith('\\r')){console.log(text==='SYNTHETIC_CODE\\r'?'ACCEPTED':'REJECTED');process.exit(text==='SYNTHETIC_CODE\\r'?0:3);}});console.log('READY');";
 const child=await spawnLogin(process.execPath,['-e',program],{cwd:process.cwd(),env:{...process.env,NODE_OPTIONS:'',BUN_OPTIONS:''}});t.after(()=>{if(child.exitCode==null)child.kill();});
 let text='',sent=false;const exited=new Promise((resolve,reject)=>{child.once('close',resolve);child.stdout.on('data',chunk=>{text+=chunk.toString();if(!sent&&text.includes('READY')){sent=true;child.stdin.write('SYNTHETIC_CODE');setTimeout(()=>child.stdin.write('\r'),40);}});child.once('error',reject);});
 assert.equal(await exited,0);assert.match(text,/ACCEPTED/);
});
