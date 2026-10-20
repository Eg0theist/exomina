import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute=promisify(execFile);
export async function workspaceContext(workspace,{run=execute}={}){
  try{const result=await run('git',['-C',workspace,'rev-parse','--is-inside-work-tree'],{windowsHide:true,timeout:5000,maxBuffer:4096});return {workspace,gitRepository:result.stdout.trim()==='true'};}
  catch(error){return {workspace,gitRepository:error.code===128?false:null,detail:error.code===128?'Git reports that this folder is outside a repository.':'Git status could not be verified.'};}
}
