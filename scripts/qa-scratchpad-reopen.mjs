// Reopen an existing protected synthetic scratchpad QA profile; no account access.
import {_electron as electron} from 'playwright';
import {readdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=process.cwd(),workspaceRoot=path.resolve(root,'../Workspace'),output=path.resolve(process.argv[2]||'');
assert.equal(path.dirname(output),workspaceRoot);assert.match(path.basename(output),/^qa-scratchpad-/);
assert.ok((await readdir(output)).includes('launcher.cjs'));const profile=path.join(output,'data');
assert.ok((await readdir(profile)).includes('synthetic-profile.txt'));assert.match(await readFile(path.join(profile,'synthetic-profile.txt'),'utf8'),/Synthetic Exomina QA/);
const env={...process.env,EXOMINA_DATA_DIR:profile,EXOMINA_ACCOUNTS_DIR:path.join(profile,'accounts'),EXOMINA_WORKSPACE_DIR:path.join(profile,'workspace'),TEMP:output,TMP:output,TMPDIR:output};delete env.ELECTRON_RUN_AS_NODE;
for(const key of Object.keys(env))if(/token|secret|password|api_?key|credential|authorization/i.test(key))delete env[key];
const report={scope:'Reopen the protected synthetic profile in the real desktop host; cross-chat note access and saved work status. No network or live model requests.',checks:{},errors:[]};let app;
try{
 app=await electron.launch({args:[path.join(output,'launcher.cjs')],cwd:root,env,timeout:30000});const page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',error=>report.errors.push(error.message));await page.getByRole('button',{name:'Exomina home',exact:true}).waitFor();
 const view=await page.evaluate(()=>window.studio.invoke('notes.view'));assert.equal(view.notes.length,2);assert.equal(view.jobs.filter(job=>job.status==='complete').length,3);assert.equal(view.jobs.filter(job=>job.status==='blocked').length,1);assert.equal(view.jobs.filter(job=>job.status==='paused').length,1);assert.equal(view.settings.enabled,false);
 const note=view.notes.find(note=>note.title==='A private draft');assert.ok(note.text.includes('PRIVATE_NOT_FOR_PLANNER'));assert.equal(note.allowAI,false);report.checks.hostRestoredNoteTextConsentAndTaskProgress=true;
 await page.locator('[data-chat-id="notes-qa"] .chat-open').click();await page.getByRole('button',{name:'Notes',exact:true}).click();const panel=page.getByRole('dialog',{name:'Notes',exact:true});
 await panel.getByRole('combobox',{name:'Choose note',exact:true}).selectOption(note.id);await page.waitForFunction(text=>document.querySelector('[aria-label="Note text"]')?.value===text,note.text);
 await page.getByRole('button',{name:'New chat',exact:true}).click();
 if(!await panel.isVisible())await page.getByRole('button',{name:'Notes',exact:true}).click();
 await panel.getByRole('combobox',{name:'Choose note',exact:true}).selectOption(note.id);await page.waitForFunction(text=>document.querySelector('[aria-label="Note text"]')?.value===text,note.text);
 assert.equal(await page.getByRole('textbox',{name:'Message',exact:true}).inputValue(),'');assert.equal(await app.evaluate(()=>qa.requests.length),0);assert.deepEqual(report.errors,[]);report.checks.notesAvailableAcrossChatsWithoutSendingOrInference=true;report.passed=true;
}catch(error){report.passed=false;report.error=error.stack;process.exitCode=1;}
finally{await app?.close();await writeFile(path.join(output,'reopen-report.json'),JSON.stringify(report,null,2),'utf8');}
console.log(JSON.stringify({output,...report},null,2));
