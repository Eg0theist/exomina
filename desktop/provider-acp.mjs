import path from 'node:path';
import { acpAction } from './permissions.mjs';
import { clipToolHistory } from './chat-memory-records.mjs';
import {inlineProviderMedia} from './provider-media.mjs';
import {createHash} from 'node:crypto';

const MAX_LINE = 32 * 1024 * 1024;
const ACP_STEP = { read: 'Read', edit: 'Edit', delete: 'Edit', move: 'Edit', search: 'Grep', execute: 'Bash', fetch: 'WebFetch' };
export const runtimeError = value => String(value?.message || value || 'Provider request failed.').replace(/https?:\/\/\S+/g, '[provider URL]').replace(/\b(?:sk-[\w-]+|eyJ[\w.-]{30,}|gh[o_pusr]_[\w]+)\b/g, '[redacted]').replace(/(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token)(["\s:=]+)[^\s,}"]+/gi, '$1$2[redacted]').slice(0, 2000);

export function unpackedPath(p) { return p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`); }

/** ACP is newline-delimited JSON-RPC 2.0, with reverse permission requests. */
export class AcpTransport {
  constructor(child, { request, notification, stderr, stop = child => child.kill() } = {}) {
    Object.assign(this, { child, requestHandler: request, notification, stderrHandler: stderr, stop });
    this.pending = new Map(); this.nextId = 1; this.closed = false; this.buffer = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => this.read(chunk));
    child.stderr.on('data', chunk => this.stderrHandler?.(chunk));
    // These pipes can fail without a process error or exit notification.
    // Retain listeners after close to contain late native pipe failures too.
    for (const stream of [child.stdout, child.stderr]) stream.on('error', error => this.fail(new Error(`Provider output pipe failed: ${error.code || 'stream error'}. Its effect may be incomplete; inspect the target before retrying.`)));
    child.stdin.on('error', error => this.fail(error));
    child.on('error', error => this.fail(error));
    child.on('exit', (code, signal) => this.fail(new Error(`Official runtime exited (${signal || code}).`)));
  }
  read(chunk) {
    if (this.closed) return;
    this.buffer += chunk;
    let i;
    while ((i = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, i); this.buffer = this.buffer.slice(i + 1);
      if (!line.trim()) continue;
      if (line.length > MAX_LINE) return this.fail(new Error('Provider protocol message is too large.'));
      let value; try { value = JSON.parse(line); } catch { return this.fail(new Error('Provider returned invalid protocol JSON.')); }
      if (value.jsonrpc !== '2.0') return this.fail(new Error('Provider returned an invalid ACP response.'));
      if (typeof value.method === 'string') {
        if (value.id !== undefined) {
          Promise.resolve().then(() => this.requestHandler?.(value.method, value.params || {})).then(result => {
            if (result === undefined) this.send({ id: value.id, error: { code: -32601, message: 'This client capability is not available.' } });
            else this.send({ id: value.id, result });
          }, () => this.send({ id: value.id, error: { code: -32603, message: 'The requested action was refused.' } }));
        } else { try { this.notification?.(value.method, value.params || {}); } catch (error) { this.fail(error); } }
      } else if (value.id !== undefined) {
        const p = this.pending.get(value.id); if (!p) continue;
        this.pending.delete(value.id); clearTimeout(p.timer);
        if (value.error) { const error = new Error(runtimeError(value.error.message)); error.code = value.error.code; p.reject(error); }
        else p.resolve(value.result ?? {});
      }
    }
    if (this.buffer.length > MAX_LINE) this.fail(new Error('Provider protocol buffer exceeded its limit.'));
  }
  send(value) { if (!this.closed && this.child.stdin.writable) this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n'); }
  // A timeout of 0 waits until the reply arrives or the runtime closes.
  request(method, params = {}, timeout = 60000) {
    if (this.closed) return Promise.reject(new Error('Provider runtime is closed.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeout ? setTimeout(() => { this.pending.delete(id); reject(new Error(`Provider ${method} timed out.`)); }, timeout) : null;
      this.pending.set(id, { resolve, reject, timer }); this.send({ id, method, params });
    });
  }
  notify(method, params) { this.send({ method, params }); }
  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear(); this.stop(this.child);
  }
  close() { this.fail(new Error('Provider runtime closed.')); }
}

export function acpModelOptions(response) {
  const options = Array.isArray(response?.configOptions) ? response.configOptions : [];
  const modelConfig = options.find(option => option.category === 'model' || option.id === 'model');
  const thinking = options.find(option => option.category === 'thought_level' || option.id === 'thinking');
  const flatten = entries => (entries || []).flatMap(entry => Array.isArray(entry.options) ? entry.options : [entry]);
  const efforts = flatten(thinking?.options).filter(option => typeof option.value === 'string').map(option => ({ id: option.value, label: option.name || option.value }));
  if (modelConfig) return flatten(modelConfig.options).filter(option => typeof option.value === 'string').map(option => ({ id: option.value, label: option.name || option.value, efforts: modelConfig.currentValue === option.value ? efforts : [], defaultEffort: modelConfig.currentValue === option.value ? thinking?.currentValue || '' : '', isDefault: modelConfig.currentValue === option.value }));
  return (response?.models?.availableModels || []).filter(model => typeof model.modelId === 'string').map(model => ({ id: model.modelId, label: model.name || model.modelId, efforts: [], defaultEffort: '', isDefault: model.modelId === response.models.currentModelId }));
}

export class AcpProvider {
  constructor(manager, id, { script } = {}) { this.manager = manager; this.id = id; this.name = id; this.script = script; this.processes = new Set(); this.login = null; this.models = []; }
  async reverse(method, params, state) {
    if (method === 'session/request_permission' && state?.noTools) return { outcome: { outcome: 'cancelled' } };
    if (method !== 'session/request_permission' || !state || state.cancelled || state.loading || params.sessionId !== state.sessionId) return undefined;
    const once = params.options?.find(option => option.kind === 'allow_once');
    if (!once || typeof once.optionId !== 'string') return { outcome: { outcome: 'cancelled' } };
    const call = params.toolCall || {};
    const name = String(call.title || call.toolCallId || 'Provider tool').slice(0, 180);
    // Built-in question tools cannot be answered by a yes/no permission prompt.
    if (/ask.?user|question|clarif/i.test(call.kind || '') || /ask.?user|question/i.test(name)) return { outcome: { outcome: 'cancelled' } };
    const detail = JSON.stringify(call.rawInput ?? call.content ?? {}).slice(0, 8000);
    const result = await this.manager.approveDetailed({ title: `${this.name}: ${name}`, detail, conversationId: state.conversationId, action: acpAction(this.id, call) });
    if (result.approved && !state.cancelled) {
      // "Allow for this chat" uses the runtime's own always-allow option when offered.
      const always = (result.scope === 'chat' || result.scope === 'always') && params.options.find(option => option.kind === 'allow_always');
      return { outcome: { outcome: 'selected', optionId: (always || once).optionId } };
    }
    // Declining one call lets the agent continue; cancelling would end the turn.
    const reject = !state.cancelled && params.options.find(option => option.kind === 'reject_once');
    return reject ? { outcome: { outcome: 'selected', optionId: reject.optionId } } : { outcome: { outcome: 'cancelled' } };
  }
  update(method, params, state) {
    if (method !== 'session/update' || !state || state.loading || state.cancelled || params.sessionId !== state.sessionId) return;
    const value = params.update || {};
    if(value.sessionUpdate==='agent_message_chunk')this.deliverMedia(state,value.content);
    if(['tool_call','tool_call_update'].includes(value.sessionUpdate)&&value.status==='completed')for(const part of value.content||[])this.deliverMedia(state,part.content??part);
    if (value.sessionUpdate === 'agent_message_chunk' && value.content?.type === 'text') this.manager.delta(state, value.content.text);
    else if (value.sessionUpdate === 'agent_thought_chunk' && value.content?.type === 'text') this.manager.thinking(state, 'thought', value.content.text);
    else if (value.sessionUpdate === 'tool_call' || value.sessionUpdate === 'tool_call_update') {
      // ACP kinds (read, edit, execute…) map onto Exomina's step names; the agent's own title stays as the target.
      const status = value.status === 'completed' ? 'done' : value.status === 'failed' ? 'error' : value.sessionUpdate === 'tool_call' ? 'running' : undefined;
      const output = (value.content || []).map(part => part?.content?.text || part?.text || '').filter(Boolean).join('\n');
      const input = { ...(value.rawInput && typeof value.rawInput === 'object' ? value.rawInput : {}), ...(value.locations?.[0]?.path ? { path: value.locations[0].path } : {}) };
      this.manager.emit({ type: 'chat.tool', conversationId: state.conversationId, id: value.toolCallId, executionContext: {provider: this.id, threadId: state.sessionId, workspace: state.workspace || this.manager.workspace}, ...(value.sessionUpdate === 'tool_call' ? { name: ACP_STEP[value.kind] || String(value.title || 'Provider tool').slice(0, 180), input, ...(ACP_STEP[value.kind] && value.title ? { detail: String(value.title).slice(0, 300) } : {}) } : {}), ...(status ? { status, outcomeConfirmed: value.status === 'completed' } : {}), ...(output ? { output: output.slice(0, 4000), historyOutput: clipToolHistory(output) } : {}) });
    }
  }
  deliverMedia(state,content){
    if(state.cancelled||state.noTools)return;
    try{const media=inlineProviderMedia(content);if(media)this.publishMedia(state,media);}catch{state.mediaFailure='The provider returned invalid or oversized media. It was not saved.';}
  }
  publishMedia(state,media){
    if(state.cancelled)return;
    const key=createHash('sha256').update(media.dataBase64).digest('hex');state.mediaSeen??=new Set();if(state.mediaSeen.has(key))return;state.mediaSeen.add(key);
    this.manager.emit({type:'chat.media.generated',provider:this.id,conversationId:state.conversationId,...media});
  }
  async finishMedia(state){await Promise.all(state.mediaJobs||[]);if(state.mediaFailure)throw Error(state.mediaFailure);}
  mcp(conversationId) {
    const gateway = this.manager.gateway;
    if (!gateway?.script || !gateway?.url || !gateway?.token) return [];
    return [{ name: 'exomina', command: process.execPath, args: [gateway.script], env: [
      { name: 'ELECTRON_RUN_AS_NODE', value: '1' }, { name: 'EXOMINA_TOOL_GATEWAY', value: gateway.url },
      { name: 'EXOMINA_TOOL_TOKEN', value: gateway.token }, { name: 'EXOMINA_TOOL_CONVERSATION', value: conversationId },
    ] }];
  }
  close() { for (const child of this.processes) this.manager.stopChild(child); this.processes.clear(); }
}
