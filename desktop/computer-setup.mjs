import {cp,mkdir,readFile,writeFile,rm,stat} from 'node:fs/promises';
import path from 'node:path';

/** Cua Driver's agent skill ships with Exomina (vendor/cua-driver/skills). Its own
 * `cua-driver skills install` downloads the pack and links it into ~/.claude and
 * ~/.agents, folders Exomina's runtimes never read, so Exomina copies the bundled
 * pack into its private Claude and Codex homes instead.
 */
export const SKILL_NAME='cua-driver';
const NOTE=`
> **In Exomina:** the Cua Driver is already connected as an MCP server. Use its tools (named \`external_cua_…\` or \`mcp__exomina__external_cua_…\`) rather than the \`cua-driver\` command line, which is not on PATH here. Each desktop action goes through Exomina's approvals, and the user sees what you do.
`;
const exists=file=>stat(file).then(()=>true,()=>false);
export function skillTargets(accountsDir){return [path.join(accountsDir,'claude-home','skills',SKILL_NAME),path.join(accountsDir,'codex-home','skills',SKILL_NAME)];}
export async function skillVersion(dir){
  try{const text=await readFile(path.join(dir,'SKILL.md'),'utf8');return /^version:\s*([^\s#]+)/m.exec(text)?.[1]||'unknown';}catch{return null;}
}
export async function skillStatus({source,accountsDir}){
  const bundled=await skillVersion(source);
  const installed=await Promise.all(skillTargets(accountsDir).map(skillVersion));
  return {bundled,installed:installed.every(Boolean),current:!!bundled&&installed.every(version=>version===bundled)};
}
export async function installSkill({source,accountsDir}){
  if(!await exists(path.join(source,'SKILL.md')))throw Error('The computer-use skill is missing from this Exomina build.');
  for(const target of skillTargets(accountsDir)){
    await rm(target,{recursive:true,force:true});await mkdir(path.dirname(target),{recursive:true});
    await cp(source,target,{recursive:true});
    // The note goes right after the front matter, where the agent reads first.
    const file=path.join(target,'SKILL.md'),text=await readFile(file,'utf8');
    const end=text.startsWith('---')?text.indexOf('\n---',3):-1;
    await writeFile(file,end>0?text.slice(0,end+4)+'\n'+NOTE+text.slice(end+4):NOTE+text);
  }
  return skillStatus({source,accountsDir});
}
