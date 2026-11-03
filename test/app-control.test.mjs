import test from 'node:test';
import assert from 'node:assert/strict';
import {AppControl,APP_CONTROL_TOOL} from '../desktop/app-control.mjs';
import {prepareAppOperation} from '../desktop/app-control-contract.mjs';
import {PermissionPolicy,hostAction} from '../desktop/permissions.mjs';
import {validateAppearance} from '../desktop/themes.mjs';
import {Workbench} from '../desktop/workbench.mjs';

const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function fixture(){
  const state={settings:{permissionMode:'full',appearance:validateAppearance({},{}),sounds:{enabled:true,volume:.5},quickAccess:false},conversations:[{id:'chat'},{id:'other'},{id:'private',private:true}],projects:[],prompts:[]};
  const scope={active:true},navigation={conversationId:'chat',page:'chat',settingsSection:'general'},calls=[],checks=[];
  let time=1000,approval=async()=>true;
  const policy=new PermissionPolicy({getSettings:()=>state.settings});
  const store={state,save:async()=>calls.push('saved')},workbench=new Workbench({store});
  const service=new AppControl({getState:()=>state,getScope:()=>scope,getNavigation:()=>navigation,check:(action,id)=>{checks.push(action);const verdict=policy.evaluate(action,id);if(verdict.decision==='deny')throw Error(verdict.reason);},authorize:request=>approval(request),execute:async(method,payload)=>{
    calls.push({method,payload});
    if(method==='settings.save'){for(const [key,value]of Object.entries(payload))state.settings[key]=key==='appearance'?validateAppearance(value,state.settings.appearance):value;return state.settings;}
    if(method==='prompts.save')return workbench.savePrompt(payload);
    if(method==='projects.save')return workbench.saveProject(payload);
    throw Error('Unknown route');
  },navigate:async(payload,id)=>{calls.push({navigation:payload,conversationId:id});return {confirmed:true,destination:payload.destination};},now:()=>time});
  return {state,scope,navigation,calls,checks,service,setTime:value=>time=value,setApproval:fn=>approval=fn};
}
const preview=(f,operation,input)=>f.service.call({action:'preview',operation,input},'chat');
const apply=(f,previewId)=>f.service.call({action:'apply',previewId},'chat');

test('catalog is bounded, searchable, and excludes arbitrary code/account/security mutation',async()=>{
  const f=fixture(),catalog=await f.service.call({action:'catalog',query:'reusable prompt'},'chat');
  assert.deepEqual(catalog.operations.map(item=>item.id),['prompt.save']);
  assert.ok(JSON.stringify(catalog).length<12000);assert.equal(APP_CONTROL_TOOL.inputSchema.additionalProperties,false);
  assert.equal(hostAction('app_control',{action:'apply'}).kind,'write');assert.equal(hostAction('app_control',{action:'preview'}).kind,'read');
  for(const input of [{permissionMode:'full'},{externalMcpServers:[]},{appearance:{customCSS:'body{}'}},{appearance:{companionArtwork:{id:'x'}}},{voice:{apiKey:'secret'}},{__proto__:null}])assert.throws(()=>prepareAppOperation('settings.patch',input,f.state),/Unsupported|object/);
});

test('live settings preview is inert, applies only allowed fields, verifies value and replays without another write',async()=>{
  const f=fixture(),p=await preview(f,'settings.patch',{appearance:{textSize:'large',motion:'reduced'},quickAccess:true});
  assert.equal(f.calls.length,0);assert.equal(f.state.settings.appearance.textSize,'default');
  const result=await apply(f,p.previewId);assert.equal(result.status,'applied');assert.equal(result.restartRequired,false);assert.equal(result.observed.appearance.textSize,'large');
  const count=f.calls.length,replay=await apply(f,p.previewId);assert.equal(replay.replayed,true);assert.equal(f.calls.length,count);
  assert.equal((await f.service.call({action:'receipt',previewId:p.previewId},'chat')).status,'applied');
  assert.equal(f.state.settings.permissionMode,'full');
});

test('previews and receipts cannot cross chat scope, private/scoped/stopped callers are refused',async()=>{
  const f=fixture(),p=await preview(f,'settings.patch',{quickAccess:true});
  await assert.rejects(f.service.call({action:'apply',previewId:p.previewId},'other'),/another chat/);
  await assert.rejects(f.service.call({action:'catalog'},'private'),/saved chat/);
  for(const key of ['noteWork','discovery','followup']){f.scope[key]=true;await assert.rejects(apply(f,p.previewId),/scoped/);delete f.scope[key];}
  f.scope.cancelled=true;await assert.rejects(apply(f,p.previewId),/stopped/);assert.equal(f.calls.length,0);
});

test('read-only, explicit action denials and app inspection denials are enforced',async()=>{
  const f=fixture(),p=await preview(f,'settings.patch',{quickAccess:true});f.state.settings.permissionMode='read-only';
  await assert.rejects(apply(f,p.previewId),/Read only/);
  f.state.settings.permissionMode='full';f.state.settings.permissionRules=[{effect:'deny',tool:'app_control',match:'settings.patch'}];
  await assert.rejects(apply(f,p.previewId),/Blocked by your rule/);
  f.state.settings.permissionRules=[{effect:'deny',tool:'app_inspect',match:'settings'}];
  await assert.rejects(preview(f,'settings.patch',{quickAccess:true}),/Blocked by your rule/);assert.equal(f.calls.length,0);
});

test('approval refusal and permission revocation during approval never mutate settings',async()=>{
  const f=fixture(),p=await preview(f,'settings.patch',{quickAccess:true});f.setApproval(async()=>false);
  await assert.rejects(apply(f,p.previewId),/declined/);assert.equal(f.calls.length,0);
  f.setApproval(async()=>{f.state.settings.permissionMode='read-only';return true;});
  await assert.rejects(apply(f,p.previewId),/Read only/);assert.equal(f.calls.length,0);
});

test('concurrent duplicate applies share one approval and one commit',async()=>{
  const f=fixture(),p=await preview(f,'settings.patch',{quickAccess:true}),gate=deferred();let approvals=0;f.setApproval(async()=>{approvals++;await gate.promise;return true;});
  const first=apply(f,p.previewId),second=apply(f,p.previewId);gate.resolve();
  assert.deepEqual(await first,await second);assert.equal(approvals,1);assert.equal(f.calls.filter(item=>item.method).length,1);
});

test('conflicting previews and user edits during approval fail without overwriting the later value',async()=>{
  const f=fixture(),p=await preview(f,'settings.patch',{appearance:{textSize:'large'}}),other=await preview(f,'settings.patch',{appearance:{textSize:'xl'}});
  await apply(f,p.previewId);await assert.rejects(apply(f,other.previewId),/changed after preview/);
  const next=await preview(f,'settings.patch',{appearance:{textSize:'small'}});f.setApproval(async()=>{f.state.settings.appearance.textSize='default';return true;});
  await assert.rejects(apply(f,next.previewId),/changed after preview/);assert.equal(f.state.settings.appearance.textSize,'default');
});

test('unrelated appearance edits survive an allowed patch and same-value settings avoid writes',async()=>{
  const f=fixture(),p=await preview(f,'settings.patch',{appearance:{textSize:'large'}});f.state.settings.appearance.companionLabel='User choice';await apply(f,p.previewId);
  assert.equal(f.state.settings.appearance.companionLabel,'User choice');
  const unchanged=await preview(f,'settings.patch',{appearance:{textSize:'large'}}),count=f.calls.length;assert.equal((await apply(f,unchanged.previewId)).status,'unchanged');assert.equal(f.calls.length,count);
});

test('sound patches preserve other sound events and reject out-of-range volume',async()=>{
  const f=fixture();f.state.settings.sounds={enabled:true,volume:.2,onlyWhenAway:true,events:{done:'bell',attention:'chime',error:'hum',followup:'none'}};
  const p=await preview(f,'settings.patch',{sounds:{volume:.75,events:{done:'glass'}}});await apply(f,p.previewId);
  assert.equal(f.state.settings.sounds.events.attention,'chime');assert.equal(f.state.settings.sounds.onlyWhenAway,true);
  for(const volume of [-1,2,'0.5',NaN])await assert.rejects(preview(f,'settings.patch',{sounds:{volume}}),/volume/);
});

test('prompt and project operations use existing Workbench validation and preserve file scope',async()=>{
  const f=fixture(),approvals=[];f.setApproval(async request=>{approvals.push(request);return true;});f.state.projects=[{id:'project',name:'Before',instructions:'Old',folder:'C:/approved',files:['existing']}];
  const p=await preview(f,'project.save',{id:'project',name:'After',instructions:'New'}),result=await apply(f,p.previewId);
  assert.equal(result.observed.name,'After');assert.equal(f.state.projects[0].folder,'C:/approved');assert.deepEqual(f.state.projects[0].files,['existing']);
  const q=await preview(f,'prompt.save',{name:'Rewrite',shortcut:'/rewrite',text:'Review this.'});await apply(f,q.previewId);assert.equal(f.state.prompts.length,1);
  assert.ok(approvals.every(request=>request.requireConfirmation===true));assert.equal(JSON.parse(approvals[0].detail).after.instructions,'New');
  await assert.rejects(preview(f,'prompt.save',{name:'Duplicate',shortcut:'rewrite',text:'Another'}),/already in use/);
  await assert.rejects(preview(f,'project.save',{id:'missing',name:'New',instructions:''}),/no longer exists/);
});

test('an uncertain commit is not automatically executed again and records uncertainty',async()=>{
  const f=fixture(),p=await preview(f,'settings.patch',{quickAccess:true});let calls=0;
  f.service.execute=async()=>{calls++;f.state.settings.quickAccess=true;throw Error('save failed after mutation');};
  await assert.rejects(apply(f,p.previewId),/save failed/);
  const receipt=await apply(f,p.previewId);assert.equal(receipt.status,'unverified');assert.equal(calls,1);assert.match(receipt.error,/save failed/);
});

test('persistent edits exceeding the complete approval display limit fail closed before approval or mutation',async()=>{
 const f=fixture();let approvals=0;f.setApproval(async()=>{approvals++;return true;});
 const p=await preview(f,'prompt.save',{name:'Large ordinary prompt',shortcut:'large',text:'x'.repeat(25000)});
 await assert.rejects(apply(f,p.previewId),/complete before\/after change exceeds the approval display limit/);
 assert.equal(approvals,0);assert.equal(f.calls.length,0);assert.equal(f.state.prompts.length,0);
});

test('navigation requires current originating chat, unchanged page and renderer acknowledgment',async()=>{
  const f=fixture(),p=await preview(f,'navigate',{destination:'settings:appearance'});f.navigation.page='tools';
  await assert.rejects(apply(f,p.previewId),/changed after preview/);
  f.navigation.conversationId='other';await assert.rejects(preview(f,'navigate',{destination:'chat'}),/originating/);
  f.navigation.conversationId='chat';const q=await preview(f,'navigate',{destination:'settings:appearance'});assert.equal((await apply(f,q.previewId)).observed.destination,'settings:appearance');
  const next=await preview(f,'navigate',{destination:'chat'});f.service.navigate=async()=>({confirmed:false});await assert.rejects(apply(f,next.previewId),/did not confirm/);
});

test('expired previews are refused; read results redact credential-shaped text',async()=>{
  const f=fixture(),p=await preview(f,'prompt.save',{name:'fixture',shortcut:'fixture',text:'password=do-not-echo'});assert.doesNotMatch(JSON.stringify(p),/do-not-echo/);
  f.setTime(400000);await assert.rejects(apply(f,p.previewId),/expired/);assert.equal(f.calls.length,0);
});

test('headless custom palette is described, reviewed and applied through the same strict settings route',async()=>{
 const f=fixture(),palette={baseTheme:'verdigris',colors:{accent:'#bceacf'}};
 const catalog=await f.service.call({action:'catalog',operation:'settings.patch'},'chat');
 assert.ok(catalog.operations[0].fields.appearance.includes('customPalette'));
 assert.equal(catalog.operations[0].appearanceValues.customPalette.anyOf[1].additionalProperties,false);
 const p=await preview(f,'settings.patch',{appearance:{customPalette:palette}});
 assert.equal(p.before.appearance.customPalette,null);assert.deepEqual(p.after.appearance.customPalette,palette);assert.equal(f.calls.length,0);
 const result=await apply(f,p.previewId);assert.equal(result.status,'applied');assert.deepEqual(result.observed.appearance.customPalette,palette);
 const cleared=await preview(f,'settings.patch',{appearance:{customPalette:null}});await apply(f,cleared.previewId);assert.equal(f.state.settings.appearance.customPalette,null);
});

test('headless custom palette rejects arbitrary fields and bad contrast without mutation',async()=>{
 const f=fixture();
 for(const customPalette of [{baseTheme:'verdigris',colors:{css:'body{}'}},{baseTheme:'verdigris',colors:{accent:'url(https://example.invalid)'}},{baseTheme:'verdigris',colors:{ground:'#ffffff',ink:'#ffffff'}},{baseTheme:'paper',colors:{accent:'#bceacf'}}])await assert.rejects(preview(f,'settings.patch',{appearance:{customPalette}}),/palette|contrast/i);
 assert.equal(f.calls.length,0);
});

test('headless live settings reject restart-required window style changes',async()=>{
 const f=fixture();await assert.rejects(preview(f,'settings.patch',{appearance:{borderless:false}}),/Unsupported appearance field: borderless/);assert.equal(f.calls.length,0);
});

test('headless theme previews show palette clearing and reject a concurrently changed palette',async()=>{
 const f=fixture(),palette={baseTheme:'verdigris',colors:{accent:'#bceacf'}};
 f.state.settings.appearance=validateAppearance({customPalette:palette},f.state.settings.appearance);
 const p=await preview(f,'settings.patch',{appearance:{theme:'paper'}});
 assert.deepEqual(p.before.appearance.customPalette,palette);assert.equal(p.after.appearance.customPalette,null);
 f.state.settings.appearance=validateAppearance({customPalette:{baseTheme:'verdigris',colors:{accent:'#bdebcf'}}},f.state.settings.appearance);
 await assert.rejects(apply(f,p.previewId),/changed after preview/);assert.equal(f.calls.length,0);
 const q=await preview(f,'settings.patch',{appearance:{theme:'paper'}});await apply(f,q.previewId);assert.equal(f.state.settings.appearance.customPalette,null);
});
