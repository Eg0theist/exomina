// Recompile the reconstructed pre-edit UI in a separate output directory and
// compare its complete production JS against the independently frozen package.
import {build} from 'vite';
import {readFile,mkdtemp,writeFile} from 'node:fs/promises';
import path from 'node:path';

import {createHash} from 'node:crypto';
const root=process.cwd(),output=await mkdtemp(path.resolve('../Workspace/qa-app-encoding-proof-'));
let original=await readFile('src/App.jsx','utf8');
original=original.replace("import {mergeHelperActivity} from '../desktop/helper-activity.mjs';\n",'').replace("import {mergeHelperActivity} from '../desktop/helper-activity.mjs';\r\n",'');
const start=original.indexOf("      else if(event.type==='chat.helper')patchChat(id,chat=>{"),end=original.indexOf('\n      ',start+8);
const blockEnd=original.indexOf('\n      else ',start+1);
if(start<0||blockEnd<0)throw Error('Known helper patch cannot be reconstructed.');
original=original.slice(0,start)+"      else if(event.type==='chat.helper'){patchReply(id,m=>({...m,helpers:[...(m.helpers||[]).filter(h=>h.id!==event.helper.id),event.helper]}));}"+original.slice(blockEnd);
original=original.replace("{message.helpersOmitted>0&&<p className=\"helper-history-note\">{message.helpersOmitted} earlier helper cards were omitted to keep this task's saved history bounded.</p>}",'');
// Restore these two source literals from the independent earlier source backup.
original=original.replace(' E{title} E ${displayError(event.error)}','“${title}”: ${displayError(event.error)}').replace(' E{title} Efinished.','“${title}” finished.');
const helper=`import React from 'react';
import Markdown from './Markdown.jsx';

export default function HelperContribution({ helper, providerName, onLink }) {
  const effort = helper.effectiveEffort || helper.effort;
  return <details className="helper-contribution" open={helper.status === 'running'}>
    <summary>{providerName || helper.provider} · {helper.effectiveModel || helper.model}{effort ? \` · \${effort} effort\` : helper.effortSource ? ' · Runtime default' : ''} · {helper.status === 'running' ? 'Helping…' : helper.status === 'failed' ? 'Helper failed' : 'Contribution'}</summary>
    {(helper.difficulty || helper.effortSource) && <p className="helper-configuration"><small>{helper.difficulty ? \`\${helper.difficulty.charAt(0).toUpperCase() + helper.difficulty.slice(1)} task · \` : ''}{helper.effectiveEffort ? 'Effort reported by runtime' : helper.effort ? 'Requested effort' : 'Effort not reported'}{helper.images?.length ? \` · \${helper.images.length} image\${helper.images.length === 1 ? '' : 's'} shared\` : ''}</small></p>}
    {helper.rationale && <p><small>{helper.rationale}</small></p>}
    <small>{helper.task}</small>
    {helper.text && <div className="message-content"><Markdown text={helper.text} onLink={onLink} /></div>}
    {helper.error && <p className="inline-error">{helper.error}</p>}
  </details>;
}
`;
await writeFile(path.join(output,'pre-edit-App.jsx'),original);
await build({root,logLevel:'error',plugins:[{name:'reconstructed-pre-edit-source',enforce:'pre',transform(_code,id){if(id.endsWith('/src/App.jsx'))return original;if(id.endsWith('/src/HelperContribution.jsx'))return helper;}}],build:{outDir:output,emptyOutDir:false}});
const html=await readFile('dist/index.html','utf8'),entry=/<script\b[^>]*src="\.\/([^" ]+\.js)"/.exec(html)[1];
const reproducedHtml=await readFile(path.join(output,'index.html'),'utf8'),reproducedEntry=/<script\b[^>]*src="\.\/([^" ]+\.js)"/.exec(reproducedHtml)[1];
const expected=await readFile(path.resolve('dist',entry)),actual=await readFile(path.join(output,reproducedEntry));
if(createHash('sha256').update(expected).digest('hex')!=='a5fbe3ef4e2c1fee4416772ddf7c72b9a522dba1d64f3d02ec0379b09648d2c3')throw Error('Independent frozen renderer changed.');
const result={output,expectedEntry:entry,reproducedEntry,expectedSha256:createHash('sha256').update(expected).digest('hex'),actualSha256:createHash('sha256').update(actual).digest('hex'),fullProductionJavascriptByteIdentical:expected.equals(actual),sourceAccountsAccessed:false};
await writeFile(path.join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));if(!result.fullProductionJavascriptByteIdentical)process.exitCode=1;
