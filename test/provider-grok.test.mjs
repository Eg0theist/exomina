import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, rm, access, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { ProviderManager, subscriptionEnvironment } from '../desktop/providers.mjs';
import { officialLoginUrl } from '../desktop/provider-auth.mjs';

class Child extends EventEmitter {
  constructor() { super(); this.stdin = new PassThrough(); this.stdout = new PassThrough(); this.stderr = new PassThrough(); this.killed = false; }
  kill() { if (!this.killed) { this.killed = true; this.emit('exit', null); } }
  json(value) { this.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n'); }
}
const modelState = { currentModelId: 'grok-4.6', availableModels: [
  { modelId: 'grok-4.6', name: 'Grok 4.6', _meta: { reasoningEffort: 'high', reasoningEfforts: [{ id: 'high', label: 'High' }, { id: 'low', label: 'Low' }] } },
  { modelId: 'grok-4.5', name: 'Grok 4.5', _meta: { reasoningEffort: 'high', reasoningEfforts: [{ id: 'high', label: 'High' }] } },
  { modelId: 'custom/paid-api', name: 'Must not appear' },
] };
async function fixture(t, overrides = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'exomina-grok-'));
  const requests = [], calls = [], events = []; let behavior = () => {}, auth = 'grok.com';
  const manager = new ProviderManager({ dataDir, workspace: path.join(dataDir, 'user-workspace'), grokPath: process.execPath,
    gateway: { url: 'http://127.0.0.1:1', token: 'synthetic', script: path.join(dataDir, 'trusted-gateway.mjs') },
    emit: event => events.push(event),
    spawnImpl: (exe, args, options) => {
      const child = new Child(); calls.push({ exe, args, options, child });
      if (args.includes('login')) return child;
      let buffer = '';
      child.stdin.on('data', chunk => {
        buffer += chunk; let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const request = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1); requests.push(request);
          queueMicrotask(() => {
            if (behavior(request, child) === true) return;
            if (request.id === undefined || !request.method) return;
            if (request.method === 'initialize') child.json({ id: request.id, result: { protocolVersion: 1, authMethods: [{ id: 'grok.com' }], _meta: { defaultAuthMethodId: auth, modelState } } });
            else if (['session/new', 'session/load'].includes(request.method)) child.json({ id: request.id, result: { sessionId: 'native-session' } });
            else if (request.method === 'session/prompt') child.json({ id: request.id, result: { stopReason: 'end_turn' } });
            else child.json({ id: request.id, result: {} });
          });
        }
      });
      return child;
    }, ...overrides });
  t.after(async () => { manager.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { manager, dataDir, requests, calls, events, behavior: fn => { behavior = fn; }, auth: value => { auth = value; } };
}

test('Grok environment strips inherited API, auth, network, hooks and profile switches', () => {
  const env = subscriptionEnvironment('grok', 'protected', { PATH: 'path', HOME: 'external', USERPROFILE: 'external', XAI_API_KEY: 'synthetic', GROK_AUTH: 'synthetic', GROK_CONFIG: 'hostile', GROK_CONFIG_PATH: 'hostile', GROK_HOME: 'external', GROK_WS_URL: 'hostile', GROK_OAUTH2_ISSUER: 'hostile', GROK_AUTH_PROVIDER_COMMAND: 'hostile', GROK_DEFAULT_SELECTED_PERMISSION: 'bypassPermissions', GROK_CLAUDE_HOOKS_ENABLED: '1', EXOMINA_SECRET: 'synthetic', NODE_OPTIONS: '--require hostile' });
  for (const key of ['XAI_API_KEY', 'GROK_AUTH', 'GROK_CONFIG', 'GROK_CONFIG_PATH', 'GROK_WS_URL', 'GROK_OAUTH2_ISSUER', 'GROK_AUTH_PROVIDER_COMMAND', 'GROK_DEFAULT_SELECTED_PERMISSION', 'EXOMINA_SECRET', 'NODE_OPTIONS']) assert.equal(env[key], undefined);
  assert.equal(env.HOME, path.join('protected', 'grok-home')); assert.equal(env.USERPROFILE, env.HOME);
  assert.equal(env.GROK_HOME, path.join(env.HOME, '.grok')); assert.equal(env.GROK_DISABLE_API_KEY_AUTH, '1');
  assert.equal(env.GROK_DISABLE_AUTOUPDATER, '1'); assert.equal(env.GROK_CLAUDE_HOOKS_ENABLED, '0'); assert.equal(env.GROK_TELEMETRY_TRACE_UPLOAD, '0');
});

test('Grok metadata status checks neither initiate login nor read credential files', async t => {
  const f = await fixture(t); f.auth(null);
  const status = await f.manager.adapters.get('grok').status();
  assert.equal(status.connected, false); assert.equal(status.installed, true);
  assert.deepEqual(f.requests.map(request => request.method), ['initialize']);
  assert.ok(f.calls.every(call => !call.args.includes('login')));
  await assert.rejects(access(path.join(f.dataDir, 'grok-home', '.grok', 'auth.json')));
  assert.deepEqual(await f.manager.modelsFor('grok'), []);
  await assert.rejects(f.manager.run({ provider: 'grok', conversationId: 'c', prompt: 'Never sent' }), /Connect your Grok account/);
  assert.equal(f.requests.some(request => request.method === 'authenticate' || request.method === 'session/prompt'), false);
  f.auth('xai.api_key'); assert.equal((await f.manager.adapters.get('grok').status()).connected, false);
});

test('Grok config and session isolate project discovery and permit only the exact host bridge', async t => {
  const f = await fixture(t);
  await f.manager.run({ provider: 'grok', conversationId: 'chat', prompt: 'Synthetic', model: 'grok-4.6', effort: 'low' });
  const call = f.calls[0], params = f.requests.find(request => request.method === 'session/new').params;
  const cwd = path.join(f.dataDir, 'runtime-workspaces', 'grok');
  assert.equal(call.options.cwd, cwd); assert.equal(params.cwd, cwd); assert.notEqual(cwd, f.manager.workspace);
  assert.equal(call.options.shell, false); assert.equal(call.options.windowsHide, true);
  assert.ok(call.args.includes('--no-auto-update')); assert.ok(call.args.includes('--no-leader')); assert.equal(call.args.includes('--always-approve'), false);
  assert.equal(params._meta.yoloMode, false); assert.equal(params._meta.autoMode, false);
  assert.deepEqual(params._meta.agentProfile.tools, ['search_tool', 'use_tool','image_gen','image_edit','image_to_video','reference_to_video']); assert.match(params._meta.rules, /user-workspace/);
  assert.equal(params.mcpServers[0].env.find(item => item.name === 'EXOMINA_TOOL_CONVERSATION').value, 'chat');
  for (const file of ['config.toml', 'requirements.toml', 'managed_config.toml']) {
    const config = parseToml(await readFile(path.join(f.dataDir, 'grok-home', '.grok', file), 'utf8'));
    assert.equal(config.auth.disable_api_key_auth, true); assert.equal(config.ui.disable_bypass_permissions_mode, true);
    assert.equal(config.allow_managed_hooks_only, true); assert.equal(config.allow_managed_mcp_servers_only, true);
    assert.equal(config.enable_all_project_mcp_servers, false); assert.deepEqual(config.strict_known_marketplaces, []);
    assert.deepEqual(config.allowed_mcp_servers.map(server => server.server_command), [[process.execPath, f.manager.gateway.script]]);
    assert.deepEqual(config.permission.deny, ['Bash', 'Read', 'Grep', 'Edit', 'WebFetch', 'WebSearch']);
    assert.deepEqual(config.permission.ask,['ImageGen','ImageEdit','ImageToVideo','ReferenceToVideo']);
    assert.equal(config.features.image_gen,true);assert.equal(config.features.image_edit,true);assert.equal(config.features.video_gen,true);
    assert.equal(config.subagents.enabled, false); assert.equal(config.workflows.enabled, false);
    assert.equal(config.telemetry.trace_upload, false); assert.equal(config.model, undefined); assert.equal(config.model_providers, undefined);
  }
  assert.deepEqual(f.requests.filter(request => request.method === 'session/set_config_option').map(request => request.params), [
    { sessionId: 'native-session', configId: 'model', value: { value: 'grok-4.6' } },
    { sessionId: 'native-session', configId: 'reasoning_effort', value: { value: 'low' } },
  ]);
});

test('Grok models, image rejection and noTools runs stay within native advertised capabilities', async t => {
  const f = await fixture(t);
  const models = await f.manager.modelsFor('grok');
  assert.deepEqual(models.map(model => model.id), ['grok-4.6', 'grok-4.5']); assert.equal(models[0].isDefault, true);
  await assert.rejects(f.manager.run({ provider: 'grok', conversationId: 'c', prompt: 'Synthetic', noTools: true, images: [{ mimeType: 'image/png', dataBase64: 'synthetic' }] }), /cannot read attached images/);
  assert.equal(f.requests.some(request => request.method === 'session/prompt'), false);
  await assert.rejects(f.manager.run({ provider: 'grok', conversationId: 'c', prompt: 'Synthetic', model: 'custom/paid-api' }), /available through your Grok connection/);
  await assert.rejects(f.manager.run({ provider: 'grok', conversationId: 'c', prompt: 'Synthetic', model: 'grok-4.5', effort: 'low' }), /reasoning setting/);
  await f.manager.run({ provider: 'grok', conversationId: 'c', prompt: 'Synthetic', noTools: true });
  const params = f.requests.find(request => request.method === 'session/new').params;
  assert.deepEqual(params.mcpServers, []); assert.deepEqual(params._meta.agentProfile.tools, []);
});

test('Grok resume suppresses replay and refuses native permission or unknown reverse requests', async t => {
  const f = await fixture(t); let promptId;
  f.behavior((request, child) => {
    if (request.method === 'session/load') child.json({ method: 'session/update', params: { sessionId: 'native-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Historical' } } } });
    if (request.method === 'session/prompt') {
      promptId = request.id;
      child.json({ id: 'permission', method: 'session/request_permission', params: { sessionId: 'native-session', options: [{ kind: 'allow_always', optionId: 'forever' }], toolCall: { kind: 'execute', title: 'Native shell' } } }); return true;
    }
    if (request.id === 'permission' && request.result) { child.json({ id: 'unknown', method: 'x.ai/fs/write_file', params: {} }); return true; }
    if (request.id === 'unknown' && request.error) {
      child.json({ method: 'session/update', params: { sessionId: 'native-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Current' } } } });
      child.json({ id: promptId, result: { stopReason: 'end_turn' } }); return true;
    }
  });
  const result = await f.manager.run({ provider: 'grok', conversationId: 'chat', prompt: 'Synthetic', sessionId: 'native-session' });
  assert.equal(result.text, 'Current'); assert.deepEqual(f.requests.find(request => request.id === 'permission').result, { outcome: { outcome: 'cancelled' } });
  assert.equal(f.requests.find(request => request.id === 'unknown').error.code, -32601);
});

test('Grok Connect captures official device URL without opening a browser and ends its native process', async t => {
  const f = await fixture(t);
  const connecting = f.manager.connect('grok');
  for (let attempt = 0; !f.calls.length && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.calls.length, 1);
  const child = f.calls[0].child;
  child.stderr.write('Ignore https://accounts.x.ai.evil.example/device\nOpen https://accounts.x.ai/oauth2/device?user_');
  child.stderr.write('code=SYNTH-TEST\nConfirm this code.\n');
  const result = await connecting;
  assert.equal(result.url, 'https://accounts.x.ai/oauth2/device?user_code=SYNTH-TEST'); assert.equal(result.userCode, 'SYNTH-TEST'); assert.equal(result.browserOpened, false);
  assert.deepEqual(f.calls[0].args, ['--no-auto-update', 'login', '--device-auth']);
  assert.equal(f.events.filter(event => event.type === 'auth.url').length, 1);
  assert.match((await f.manager.connect('grok')).message, /already waiting/);
  child.emit('exit', 0); await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.events.some(event => event.type === 'auth.completed'), true);
  assert.equal(f.manager.adapters.get('grok').login, null);
  assert.equal(officialLoginUrl('http://accounts.x.ai/device', 'grok'), null); assert.equal(officialLoginUrl('https://accounts.x.ai:444/device', 'grok'), null);
});

test('Grok initialization and startup remain behind the vault preparation gate', async t => {
  const f = await fixture(t, { beforePrepare: async () => { throw new Error('Vault rejected'); } });
  for (const operation of [() => f.manager.adapters.get('grok').status(), () => f.manager.connect('grok'), () => f.manager.modelsFor('grok'), () => f.manager.run({ provider: 'grok', conversationId: 'c', prompt: 'Synthetic' })]) await assert.rejects(operation(), /Vault rejected/);
  assert.equal(f.calls.length, 0); await assert.rejects(access(path.join(f.dataDir, 'grok-home')));
});

test('Grok Imagine bridges exact prompts through host approval and waits for validated file output',async t=>{
 const approvals=[],f=await fixture(t,{approveDetailed:async request=>{approvals.push(request);return {approved:true,scope:'chat'};}});
 const adapter=f.manager.adapters.get('grok');await adapter.prepare();
 const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1cAAAAASUVORK5CYII=';
 const file=path.join(adapter.runtimeCwd,'generated.png');await writeFile(file,Buffer.from(png,'base64'));let promptId;
 f.behavior((request,child)=>{
  if(request.method==='session/prompt'){promptId=request.id;child.json({id:'imagine-permission',method:'session/request_permission',params:{sessionId:'native-session',toolCall:{toolCallId:'imagine',title:'ImageGen',rawInput:{prompt:'A synthetic square',aspect_ratio:'1:1'}},options:[{kind:'allow_once',optionId:'once'},{kind:'allow_always',optionId:'forever'}]}});return true;}
  if(request.id==='imagine-permission'&&request.result){assert.equal(request.result.outcome.optionId,'once');for(let i=0;i<2;i++)child.json({method:'session/update',params:{sessionId:'native-session',update:{sessionUpdate:'tool_call_update',toolCallId:'imagine',status:'completed',rawOutput:{files:[file]},content:[{type:'content',content:{type:'image',mimeType:'image/png',data:png}}]}}});child.json({id:promptId,result:{stopReason:'end_turn'}});return true;}
 });
 await f.manager.run({provider:'grok',conversationId:'imagine-chat',prompt:'Create a synthetic square'});
 assert.equal(approvals.length,1);assert.equal(approvals[0].action.kind,'image');assert.match(approvals[0].detail,/A synthetic square/);assert.equal(f.events.filter(e=>e.type==='chat.media.generated').length,1);
});

test('Grok media refusal, wrong sessions, noTools and external image references never receive a grant',async t=>{
 const approvals=[],f=await fixture(t,{approveDetailed:async request=>{approvals.push(request);return {approved:false};}}),adapter=f.manager.adapters.get('grok');await adapter.prepare();
 const state={conversationId:'c',sessionId:'s',noTools:false},params={sessionId:'s',toolCall:{toolCallId:'media',title:'ImageEdit',rawInput:{prompt:'Edit',images:['https://example.com/image.png']}},options:[{kind:'allow_once',optionId:'once'},{kind:'reject_once',optionId:'reject'}]};
 assert.equal((await adapter.reverse('session/request_permission',params,state)).outcome.outcome,'cancelled');assert.equal(approvals.length,0);
 const clean={...params,toolCall:{...params.toolCall,title:'ImageGen',rawInput:{prompt:'Declined'}}};assert.equal((await adapter.reverse('session/request_permission',clean,state)).outcome.optionId,'reject');assert.equal(approvals.length,1);
 assert.equal((await adapter.reverse('session/request_permission',clean,{...state,noTools:true})).outcome.outcome,'cancelled');assert.equal((await adapter.reverse('session/request_permission',{...clean,sessionId:'foreign'},state)).outcome.outcome,'cancelled');assert.equal((await adapter.reverse('session/request_permission',clean,{...state,cancelled:true})).outcome.outcome,'cancelled');assert.equal(approvals.length,1);
 adapter.update('session/update',{sessionId:'s',update:{sessionUpdate:'tool_call_update',toolCallId:'media',status:'completed',content:[{content:{type:'image',mimeType:'image/png',data:'invalid'}}]}},state);assert.equal(f.events.some(e=>e.type==='chat.media.generated'),false);
});

test('Grok forwards image attachments only when its initialize response advertises them',async t=>{
 const f=await fixture(t);f.behavior((request,child)=>{if(request.method!=='initialize')return;child.json({id:request.id,result:{protocolVersion:1,agentCapabilities:{promptCapabilities:{image:true}},authMethods:[{id:'grok.com'}],_meta:{defaultAuthMethodId:'grok.com',modelState}}});return true;});
 const image={mimeType:'image/png',dataBase64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1cAAAAASUVORK5CYII='};await f.manager.run({provider:'grok',conversationId:'attached',prompt:'Edit this image',images:[image]});assert.deepEqual(f.requests.find(r=>r.method==='session/prompt').params.prompt[1],{type:'image',mimeType:image.mimeType,data:image.dataBase64});assert.equal((await f.manager.modelsFor('grok'))[0].supportsImages,true);
});

test('Grok Imagine receives validated attachment files when native ACP does not advertise inline images', async t => {
  const f = await fixture(t), png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1cAAAAASUVORK5CYII=';
  await f.manager.run({ provider: 'grok', conversationId: 'file-reference', prompt: 'Edit this image', images: [{ mimeType: 'image/png', dataBase64: png }] });
  const rules = f.requests.find(r => r.method === 'session/new').params._meta.rules;
  const references = JSON.parse(rules.match(/User-provided Imagine reference images: (\[.*?\])\./)[1]);
  assert.equal(references.length, 1);
  assert.ok(references[0].path.startsWith(path.join(f.dataDir, 'runtime-workspaces', 'grok', 'imagine-inputs') + path.sep));
  assert.deepEqual(await readFile(references[0].path), Buffer.from(png, 'base64'));
  assert.deepEqual(f.requests.find(r => r.method === 'session/prompt').params.prompt, [{ type: 'text', text: 'Edit this image' }]);
  assert.equal((await f.manager.modelsFor('grok'))[0].supportsImages, false);
});

test('Grok Stop cancels the ACP prompt and stops its owned runtime', async t => {
  const f = await fixture(t); let began; const ready = new Promise(resolve => { began = resolve; });
  f.behavior(request => { if (request.method === 'session/prompt') { began(); return true; } });
  const running = f.manager.run({ provider: 'grok', conversationId: 'chat', prompt: 'Synthetic' }); running.catch(() => {});
  await ready; f.manager.cancel('chat');
  await assert.rejects(running, /closed|Stopped/); assert.equal(f.calls[0].child.killed, true);
  assert.ok(f.requests.some(request => request.method === 'session/cancel' && request.params.sessionId === 'native-session'));
});

test('overlapping Grok metadata requests serialize profile writes and simultaneous Connect starts one login', async t => {
  const f = await fixture(t), adapter = f.manager.adapters.get('grok');
  await Promise.all([adapter.status(), adapter.modelOptions(), adapter.status(), adapter.modelOptions()]);
  const config = parseToml(await readFile(path.join(f.dataDir, 'grok-home', '.grok', 'requirements.toml'), 'utf8'));
  assert.equal(config.auth.disable_api_key_auth, true); assert.equal(config.allow_managed_hooks_only, true);
  const start = f.calls.length;
  const first = adapter.connect(), second = adapter.connect();
  for (let attempt = 0; f.calls.length === start && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.calls.length, start + 1);
  f.calls[start].child.stderr.write('Open https://accounts.x.ai/oauth2/device?user_code=SYNTH-TEST\n');
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.url, b.url); assert.equal(f.calls.filter(call => call.args.includes('login')).length, 1);
  f.calls[start].child.emit('exit', 0);
});
