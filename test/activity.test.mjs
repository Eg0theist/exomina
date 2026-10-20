import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {RunActivity} from '../desktop/activity.mjs';
import {describeTool,explainAction,formatDuration,activitySummary} from '../desktop/describe.mjs';
import {normalizeSounds,DEFAULT_SOUNDS} from '../desktop/sound-settings.mjs';
import {normalizeAppearance,validateAppearance,contrastRatio} from '../desktop/themes.mjs';
import {installSkill,skillStatus} from '../desktop/computer-setup.mjs';

function run(){
  let clock=Date.parse('2026-10-06T10:00:00Z');const events=[];
  const message={role:'assistant',content:''};
  const activity=new RunActivity(message,{conversationId:'c1',emit:event=>events.push(event),now:()=>clock});
  return {message,activity,events,tick:ms=>{clock+=ms;}};
}

test('text before a tool call becomes narration, the rest is the answer', ()=>{
  const {message,activity,events}=run();
  activity.delta('Let me look at the theme code.','m1');
  activity.tool({id:'t1',name:'Read',input:{file_path:'C:\\src\\theme.css'},status:'running'});
  activity.tool({id:'t1',status:'done',output:'…'});
  activity.delta('The composer chip switches the global level.','m2');
  activity.finish('The composer chip switches the global level.');
  assert.equal(message.content,'The composer chip switches the global level.');
  assert.deepEqual(message.activity.map(step=>step.kind),['note','tool']);
  assert.equal(message.activity[0].text,'Let me look at the theme code.');
  assert.equal(message.activity[1].title,'Reading a file');assert.equal(message.activity[1].doneTitle,'Read a file');assert.equal(message.activity[1].target,'theme.css');
  assert.equal(message.activity[1].status,'done');
  assert.ok(events.some(event=>event.type==='chat.segment'));
});

test('consecutive text blocks get a paragraph break instead of running together', ()=>{
  const {message,activity}=run();
  activity.delta('First part ends here.','a');activity.delta('Second','b');activity.delta(' block.','b');
  assert.equal(message.content,'First part ends here.\n\nSecond block.');
});

test('thinking blocks record their duration and close when other work starts', ()=>{
  const {message,activity,tick}=run();
  activity.thinking({id:'r1',start:true});tick(4200);activity.thinking({id:'r1',text:'Weighing options'});tick(800);
  activity.tool({id:'t',name:'Bash',input:{command:'npm test'},status:'running'});tick(3000);
  activity.tool({id:'t',status:'error',output:'1 failing'});
  activity.finish('Done.');
  const [thinking,tool]=message.activity;
  assert.equal(thinking.kind,'thinking');assert.equal(thinking.text,'Weighing options');assert.equal(thinking.status,'done');
  assert.equal(Date.parse(thinking.endedAt)-Date.parse(thinking.startedAt),5000);
  assert.equal(tool.status,'error');assert.equal(tool.target,'npm test');
  const summary=activitySummary(message);assert.equal(summary.thinkingMs,5000);assert.equal(summary.tools,1);assert.equal(summary.totalMs,8000);
});

test('permission outcomes attach to the step they belong to', ()=>{
  const {message,activity}=run();
  activity.tool({id:'t',name:'mcp__exomina__browser_open',input:{url:'https://example.com'},status:'running'});
  activity.permission('You allowed this for the rest of this chat.');
  activity.tool({id:'t2',name:'Bash',input:{command:'rm -rf x'},status:'running'});
  activity.permission('You declined this.',{denied:true});
  activity.finish('');
  assert.equal(message.activity[0].permission,'You allowed this for the rest of this chat.');
  assert.equal(message.activity[1].status,'denied');
});

test('narration that turns out to be the last text becomes the answer, not a duplicate', ()=>{
  const {message,activity}=run();
  activity.tool({id:'t',name:'Read',status:'running'});activity.tool({id:'t',status:'done'});
  activity.delta('All checks pass.','m');activity.tool({name:'TodoWrite',status:'running'});
  activity.finish('All checks pass.');
  assert.equal(message.content,'All checks pass.');
  assert.ok(!message.activity.some(step=>step.kind==='note'));
});

test('legacy tool events without an ID still complete their step', ()=>{
  const {message,activity}=run();
  activity.tool({name:'workspace_shell',detail:'Working…'});activity.tool({name:'workspace_shell',detail:'Completed'});
  assert.equal(message.activity[0].status,'done');assert.equal(message.activity[0].detail,undefined);
});

test('plain-language descriptions cover the main tools of every provider', ()=>{
  assert.equal(describeTool('Bash',{command:'npm test'}).active,'Running a command');
  assert.equal(describeTool('commandExecution',{command:['git','status']}).target,'git status');
  assert.equal(describeTool('codex.command').kind,'execute');
  assert.equal(describeTool('kimi.execute').kind,'execute');
  assert.equal(describeTool('mcp__exomina__memory_note',{text:'x'}).done,'Saved a memory');
  assert.match(describeTool('external_cua_click_ab12cd34').active,/computer control/);
  assert.equal(describeTool('SomethingNew').active,'Using something new');
  const card=explainAction({kind:'execute',tool:'claude.Bash',target:'npm test',input:{command:'npm test',description:'Run the test suite'},agent:'Claude'});
  assert.equal(card.headline,'Claude wants to run a command on your computer');
  assert.equal(card.action,'Running a command');assert.equal(card.reason,'Run the test suite');assert.equal(card.risk,'high');
  assert.equal(formatDuration(65000),'1m 05s');assert.equal(formatDuration(12400),'12s');
});

test('sound settings are clamped and unknown sounds fall back', ()=>{
  assert.deepEqual(normalizeSounds({}),DEFAULT_SOUNDS);
  const value=normalizeSounds({volume:7,events:{done:'bell',error:'kazoo'},onlyWhenAway:true});
  assert.equal(value.volume,1);assert.equal(value.events.done,'bell');assert.equal(value.events.error,'hum');assert.equal(value.onlyWhenAway,true);
});

test('a custom text colour is a #rrggbb override that can be cleared', ()=>{
  assert.equal(normalizeAppearance({}).textColor,'');
  assert.equal(validateAppearance({textColor:'#ffdcae'},{}).textColor,'#ffdcae');
  assert.equal(validateAppearance({textColor:''},{textColor:'#ffdcae'}).textColor,'');
  assert.throws(()=>validateAppearance({textColor:'red'},{}));
  assert.ok(contrastRatio('#ffffff','#000000')>20);assert.ok(contrastRatio('#777777','#808080')<1.2);
});

test('the computer-use skill installs into both runtime homes with the Exomina note', async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'exomina-skill-'));
  try{
    const source=path.join(root,'pack'),accountsDir=path.join(root,'accounts');
    await mkdir(source,{recursive:true});
    await writeFile(path.join(source,'SKILL.md'),'---\nname: cua-driver\nversion: 0.33.4 # x\n---\n\n# Cua Driver\n');await writeFile(path.join(source,'WINDOWS.md'),'w');
    assert.equal((await skillStatus({source,accountsDir})).installed,false);
    const status=await installSkill({source,accountsDir});
    assert.deepEqual(status,{bundled:'0.33.4',installed:true,current:true});
    for(const home of ['claude-home','codex-home']){
      const text=await readFile(path.join(accountsDir,home,'skills','cua-driver','SKILL.md'),'utf8');
      assert.match(text,/^---\nname: cua-driver/);assert.match(text,/In Exomina:/);assert.ok(text.indexOf('In Exomina')>text.indexOf('\n---',3));
      assert.equal(await readFile(path.join(accountsDir,home,'skills','cua-driver','WINDOWS.md'),'utf8'),'w');
    }
  }finally{await rm(root,{recursive:true,force:true});}
});
