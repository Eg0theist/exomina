const MAX_ROUNDS = 16;
const MAX_OUTPUT_TOKENS = 8192;
const MAX_TEXT = 8 * 1024 * 1024;
const MAX_EVENT = 1024 * 1024;
const MAX_WIRE = 32 * 1024 * 1024;
const MAX_ARGUMENTS = 1024 * 1024;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

function redact(error, secret = '') {
  let text = String(error?.message || error || 'API request failed.');
  if (secret) text = text.split(secret).join('[redacted]');
  return text.replace(/\b(?:sk-[\w-]+|eyJ[\w.-]{30,})\b/g, '[redacted]').replace(/((?:authorization|api[_-]?key|access[_-]?token)["\s:=]+)[^\s,}"]+/gi, '$1[redacted]').slice(0, 4000);
}

function endpoint(connection) {
  if (!['openai', 'anthropic'].includes(connection.protocol)) throw new Error('Unsupported API protocol.');
  const url = new URL(connection.baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Use an HTTP(S) API base address without credentials, query parameters, or a fragment.');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Remote API connections require HTTPS. HTTP is allowed only for a local server.');
  let pathname = url.pathname.replace(/\/+$/, '');
  const suffix = connection.protocol === 'anthropic' ? '/messages' : '/chat/completions';
  if (!pathname.endsWith(suffix)) pathname = (pathname || '/v1') + suffix;
  url.pathname = pathname;
  return url.href;
}

function mergeDelta(target, source) {
  for (const [key, value] of Object.entries(source || {})) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('The API returned unsafe metadata keys.');
    if (key === 'index') continue;
    if (typeof value === 'string') {
      if (['role', 'type', 'id'].includes(key) && target[key] === value) continue;
      target[key] = (typeof target[key] === 'string' ? target[key] : '') + value;
    } else if (Array.isArray(value)) {
      const array = Array.isArray(target[key]) ? target[key] : (target[key] = []);
      for (const item of value) {
        const index = Number.isInteger(item?.index) ? item.index : typeof item?.id === 'string' ? array.findIndex(old => old?.id === item.id) : -1;
        if (index >= 0 && index < 1000) { array[index] ??= {}; mergeDelta(array[index], item); }
        else array.push(structuredClone(item));
      }
    } else if (value && typeof value === 'object') {
      if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) target[key] = {};
      mergeDelta(target[key], value);
    } else if (value !== undefined) target[key] = value;
  }
  return target;
}

function validate(value, schema = {}, root = schema, depth = 0) {
  if (depth > 40) throw new Error('Tool arguments are nested too deeply.');
  if (schema === true) return;
  if (schema === false) throw new Error('Tool arguments are not permitted by their schema.');
  if (!schema || typeof schema !== 'object') throw new Error('The tool has an invalid argument schema.');
  if (schema.$ref) {
    if (!schema.$ref.startsWith('#/')) throw new Error('Remote schema references are unsupported.');
    const referenced = schema.$ref.slice(2).split('/').reduce((item, key) => item?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], root);
    if (!referenced) throw new Error('The tool schema reference could not be resolved.');
    validate(value, referenced, root, depth + 1);
  }
  for (const child of schema.allOf || []) validate(value, child, root, depth + 1);
  for (const keyword of ['anyOf', 'oneOf']) if (schema[keyword]) {
    const successes = schema[keyword].filter(child => { try { validate(value, child, root, depth + 1); return true; } catch { return false; } }).length;
    if (keyword === 'oneOf' ? successes !== 1 : !successes) throw new Error('Tool arguments do not match the required schema alternative.');
  }
  if (schema.enum && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) throw new Error('A tool argument is outside its permitted values.');
  if ('const' in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) throw new Error('A tool argument does not match its required constant.');
  const types = schema.type ? Array.isArray(schema.type) ? schema.type : [schema.type] : [];
  const matches = type => type === 'null' ? value === null : type === 'array' ? Array.isArray(value) : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value) : type === 'integer' ? Number.isSafeInteger(value) : type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === type;
  if (types.length && !types.some(matches)) throw new Error('A tool argument has the wrong data type.');
  if (typeof value === 'string') {
    if (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? MAX_ARGUMENTS)) throw new Error('A tool argument has an invalid text length.');
    if (schema.pattern && (schema.pattern.length > 512 || !new RegExp(schema.pattern, 'u').test(value))) throw new Error('A tool argument does not match its required text pattern.');
  }
  if (typeof value === 'number' && (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity) || value <= (schema.exclusiveMinimum ?? -Infinity) || value >= (schema.exclusiveMaximum ?? Infinity))) throw new Error('A tool argument is outside its numeric bounds.');
  if (Array.isArray(value)) {
    if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? 10000)) throw new Error('A tool argument has an invalid array length.');
    value.forEach((item, index) => validate(item, schema.prefixItems?.[index] ?? schema.items ?? {}, root, depth + 1));
  } else if (value && typeof value === 'object') {
    if (Object.keys(value).length > 1000) throw new Error('Tool arguments contain too many properties.');
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) throw new Error(`Missing required tool argument: ${key}.`);
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(schema.properties || {}, key)) validate(item, schema.properties[key], root, depth + 1);
      else if (schema.additionalProperties === false) throw new Error(`Unknown tool argument: ${key}.`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') validate(item, schema.additionalProperties, root, depth + 1);
    }
  }
}

async function* events(response) {
  if (!response.body) throw new Error('The API returned an empty response stream.');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', data = [], type = '', bytes = 0, eventSize = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > MAX_WIRE) throw new Error('The API response exceeded its size limit.');
    buffer += decoder.decode(chunk, { stream: true });
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at).replace(/\r$/, ''); buffer = buffer.slice(at + 1);
      if (!line) {
        if (data.length) yield { type, data: data.join('\n') };
        data = []; type = ''; eventSize = 0;
      } else if (line.startsWith('data:')) { const value = line.slice(5).replace(/^ /, ''); data.push(value); eventSize += value.length; }
      else if (line.startsWith('event:')) type = line.slice(6).trim();
      if (eventSize > MAX_EVENT) throw new Error('The API emitted an oversized stream event.');
    }
    if (buffer.length > MAX_EVENT) throw new Error('The API emitted an oversized stream event.');
  }
  buffer += decoder.decode();
  if (buffer.startsWith('data:')) data.push(buffer.slice(5).trim());
  if (data.length) yield { type, data: data.join('\n') };
}

async function boundedText(response, maximum) {
  const decoder = new TextDecoder(); let text = '', bytes = 0;
  if (!response.body) return '';
  for await (const chunk of response.body) { bytes += chunk.length; if (bytes > maximum) throw new Error('The API response exceeded its size limit.'); text += decoder.decode(chunk, { stream: true }); }
  return text + decoder.decode();
}

function toolContent(result) {
  const text = [], images = [];
  for (const item of result?.content || []) {
    if (item.type === 'text') text.push(String(item.text || ''));
    else if (item.type === 'image') {
      if (!IMAGE_TYPES.has(item.mimeType) || typeof item.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(item.data) || item.data.length > 4 * Math.ceil(5 * 1024 * 1024 / 3)) throw new Error('Tool image has an unsupported format or exceeds the 5 MiB image limit.');
      images.push(item);
    } else text.push(`[Unsupported tool content: ${String(item.type || 'unknown')}]`);
  }
  if (result?.structuredContent) text.push(JSON.stringify(result.structuredContent));
  const joined = text.join('\n');
  if (joined.length > MAX_TEXT || images.length > 12) throw new Error('The tool result is too large to send to the API.');
  return { text: joined || (images.length ? 'Tool image output follows.' : '(No text output.)'), images, error: Boolean(result?.isError) };
}

export class ApiAgent {
  /** beforeRequest counts one request per reply; meter (the request guard) caps the estimated tokens each round sends and receives. */
  constructor({ getConnection, emit = () => {}, callTool, getTools = () => [], fetchImpl = globalThis.fetch, requestTimeoutMs = 120000, beforeRequest = () => {}, meter = null }) {
    Object.assign(this, { getConnection, emit, callTool, getTools, fetchImpl, requestTimeoutMs, beforeRequest, meter });
    this.active = new Map(); this.closed = false;
  }
  check(state) { if (state.controller.signal.aborted) throw new Error('Stopped.'); }
  delta(state, text) {
    if (!text) return;
    this.check(state);
    if (state.text.length + text.length > MAX_TEXT) throw new Error('The API response exceeded its display limit.');
    state.text += text; this.emit({ type: 'chat.delta', conversationId: state.conversationId, text });
  }
  async request(connection, body, state, consume) {
    this.check(state);
    const controller = new AbortController();
    const stopped = () => controller.abort();
    state.controller.signal.addEventListener('abort', stopped, { once: true });
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const serialized = JSON.stringify(body);
      // A tool loop resends the whole conversation every round, so the cost is checked per round, not per reply.
      if (Buffer.byteLength(serialized) > MAX_WIRE) throw new Error('The API conversation exceeded its 32 MiB request limit. Start a new chat or request smaller tool results.');
      if(state.rounds++)await this.beforeRequest({provider:state.provider,kind:state.kind,conversationId:state.conversationId});
      const reservation = Math.ceil(Buffer.byteLength(serialized) / 3) + (connection.maxOutputTokens || MAX_OUTPUT_TOKENS);
      if(this.meter?.reserveTokens)await this.meter.reserveTokens(state.provider,reservation);
      else this.meter?.checkTokens(state.provider);
      const response = await this.fetchImpl(endpoint(connection), {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...(connection.protocol === 'anthropic' ? { ...(connection.apiKey ? { 'x-api-key': connection.apiKey } : {}), 'anthropic-version': '2023-06-01' } : connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {}) },
        body: serialized,
      });
      // The timeout covers connecting only; a streaming answer may take as long as it needs.
      clearTimeout(timer);
      if (!response.ok) {
        const raw = await boundedText(response, 65536);
        let message;
        try { const parsed = JSON.parse(raw); message = parsed.error?.message || parsed.message; } catch {}
        throw new Error(`API request failed (${response.status})${message ? ': ' + message : '.'}`);
      }
      if(!this.meter?.reserveTokens)this.meter?.addTokens(state.provider, serialized.length / 4);
      const textBefore = state.text.length;
      try { const result = await consume(response); if(!this.meter?.reserveTokens)this.meter?.addTokens(state.provider, JSON.stringify(result ?? '').length / 4); return result; }
      catch (error) { if(!this.meter?.reserveTokens)this.meter?.addTokens(state.provider, (state.text.length - textBefore) / 4); throw error; }
    } catch (error) {
      if (state.controller.signal.aborted) throw new Error('Stopped.');
      if (controller.signal.aborted) throw new Error('The API request timed out. No automatic retry was made.');
      throw error;
    } finally { clearTimeout(timer); state.controller.signal.removeEventListener('abort', stopped); }
  }
  async openai(connection, messages, tools, state, model) {
    return this.request(connection, { model, messages, stream: true, ...(new URL(connection.baseUrl).hostname==='openrouter.ai'?{provider:{allow_fallbacks:false,require_parameters:true}}:{}), ...(state.provider==='openai-api'?{max_completion_tokens:MAX_OUTPUT_TOKENS,...(state.noPersistence?{store:false}:{})}:{max_tokens:connection.maxOutputTokens||MAX_OUTPUT_TOKENS}), ...(tools.length ? { tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })) } : {}) }, state, async response => {
      if (!(response.headers.get('content-type') || '').includes('text/event-stream')) {
        const json = JSON.parse(await boundedText(response, MAX_WIRE));
        if (json.error) throw new Error(json.error.message || 'The API returned an error.');
        const message = json.choices?.[0]?.message;
        if (!message) throw new Error('The API response did not include an assistant message.');
        this.delta(state, typeof message.content === 'string' ? message.content : typeof message.refusal === 'string' ? message.refusal : '');
        if (['length', 'content_filter'].includes(json.choices?.[0]?.finish_reason)) throw new Error('The API stopped before a complete answer (output limit or content filter). No automatic retry was made.');
        return message;
      }
      const message = { role: 'assistant' }; let completed = false, finishReason;
      for await (const event of events(response)) {
        if (event.data === '[DONE]') { completed = true; break; }
        const json = JSON.parse(event.data);
        if (json.error) throw new Error(json.error.message || 'The API stream failed.');
        const choice = json.choices?.find(choice => (choice.index ?? 0) === 0);
        if (!choice) continue;
        if (choice.finish_reason) { completed = true; finishReason = choice.finish_reason; }
        const delta = choice.delta || {};
        this.delta(state, typeof delta.content === 'string' ? delta.content : '');
        if (typeof delta.refusal === 'string') this.delta(state, delta.refusal);
        mergeDelta(message, delta);
      }
      if (!completed) throw new Error('The API stream ended before confirming completion.');
      if (['length', 'content_filter'].includes(finishReason)) throw new Error('The API stopped before a complete answer (output limit or content filter). No automatic retry was made.');
      message.role = 'assistant'; message.content ??= null;
      if (message.tool_calls) message.tool_calls = message.tool_calls.filter(Boolean);
      return message;
    });
  }
  async anthropic(connection, messages, tools, state, model) {
    return this.request(connection, { model, messages, max_tokens: 8192, stream: true, ...(tools.length ? { tools: tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema })) } : {}) }, state, async response => {
      if (!(response.headers.get('content-type') || '').includes('text/event-stream')) {
        const json = JSON.parse(await boundedText(response, MAX_WIRE));
        if (json.error) throw new Error(json.error.message || 'The API returned an error.');
        if (!Array.isArray(json.content)) throw new Error('The API response did not include assistant content.');
        for (const block of json.content) if (block.type === 'text') this.delta(state, block.text);
        if (json.stop_reason === 'max_tokens') throw new Error('The API reached its output limit before completing. No automatic retry was made.');
        return { role: 'assistant', content: json.content };
      }
      const blocks = [], partial = new Map(); let completed = false, stopReason;
      for await (const event of events(response)) {
        const json = JSON.parse(event.data);
        if (json.type === 'error') throw new Error(json.error?.message || 'The API stream failed.');
        if (json.type === 'content_block_start') {
          if (!Number.isInteger(json.index) || json.index < 0 || json.index > 1000) throw new Error('The API returned an invalid content-block index.');
          blocks[json.index] = structuredClone(json.content_block);
          if (json.content_block.type === 'text') this.delta(state, json.content_block.text);
        } else if (json.type === 'content_block_delta') {
          const block = blocks[json.index], delta = json.delta || {};
          if (!block) throw new Error('The API returned a content delta without a block.');
          if (delta.type === 'input_json_delta') partial.set(json.index, (partial.get(json.index) || '') + delta.partial_json);
          else if (delta.type === 'text_delta') { block.text = (block.text || '') + delta.text; this.delta(state, delta.text); }
          else if (delta.type === 'thinking_delta') block.thinking = (block.thinking || '') + delta.thinking;
          else if (delta.type === 'signature_delta') block.signature = (block.signature || '') + delta.signature;
          else if (delta.type === 'citations_delta') (block.citations ??= []).push(delta.citation);
          else mergeDelta(block, Object.fromEntries(Object.entries(delta).filter(([key]) => key !== 'type')));
        } else if (json.type === 'message_delta') stopReason = json.delta?.stop_reason;
        else if (json.type === 'message_stop') completed = true;
      }
      if (!completed) throw new Error('The API stream ended before confirming completion.');
      if (stopReason === 'max_tokens') throw new Error('The API reached its output limit before completing. No automatic retry was made.');
      for (const [index, value] of partial) blocks[index].input = JSON.parse(value);
      return { role: 'assistant', content: blocks.filter(Boolean) };
    });
  }
  async run({ provider, conversationId, prompt, promptBlocks, model, workspace = '', images = [], toolDefinitions, ephemeral = false, noPersistence = false }) {
    if (this.closed) throw new Error('The API runner is closed.');
    if (!conversationId || typeof prompt !== 'string' || !prompt.trim() || prompt.length > 2 * 1024 * 1024) throw new Error('Provide a conversation and a nonempty prompt within the size limit.');
    if (this.active.has(conversationId)) throw new Error('This conversation already has a running API request.');
    const state = { conversationId, provider, noPersistence, kind:ephemeral?'background':'reply', rounds:0, controller: new AbortController(), text: '' };
    this.active.set(conversationId, state);
    let connection;
    try {
      await this.beforeRequest({ provider, kind: ephemeral ? 'background' : 'reply', conversationId });
      connection = await this.getConnection(provider); this.check(state);
      if (!connection) throw new Error('Connect an API provider before sending a request.');
      endpoint(connection);
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(connection.baseUrl).hostname);
      if ((!connection.apiKey || !String(connection.apiKey).trim()) && !local && !connection.optionalKey) throw new Error('Connect an API key before sending a request.');
      if (connection.apiKey && typeof connection.apiKey !== 'string') throw new Error('The saved API key is invalid.');
      const chosenModel = typeof model === 'string' && !['', 'auto', 'default'].includes(model.trim().toLowerCase()) ? model.trim() : connection.model;
      if (typeof chosenModel !== 'string' || !chosenModel.trim() || chosenModel.length > 200) throw new Error('Choose a model for this API connection.');
      if (connection.supportsImages === false && images.length) throw new Error('Image input is off for this connection. Enable it in Connections only if the model supports images, or send a text message.');
      const definitions = connection.supportsTools === false ? [] : toolDefinitions ?? await this.getTools({provider,model:chosenModel,connection});
      if (!Array.isArray(definitions) || definitions.length > 128) throw new Error('An API run supports at most 128 connected tools. Disable unneeded MCP tools first.');
      const tools = structuredClone(definitions), names = new Map();
      for (const tool of tools) {
        if (typeof tool.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(tool.name) || names.has(tool.name) || !tool.inputSchema || typeof tool.inputSchema !== 'object') throw new Error('Connected tools contain an invalid or duplicate definition.');
        names.set(tool.name, tool);
      }
      if (promptBlocks !== undefined && (!Array.isArray(promptBlocks) || promptBlocks.length > 4096 || promptBlocks.some(block => !block || typeof block.text !== 'string' || block.cache !== undefined && typeof block.cache !== 'boolean') || promptBlocks.map(block => block.text).join('') !== prompt || promptBlocks.filter(block => block.cache).length > 2)) throw Error('Ordered prompt blocks must exactly preserve the request and use at most two cache marks.');
      const textBlocks = connection.protocol === 'anthropic' && promptBlocks ? promptBlocks.filter(block => block.text).map(block => ({ type: 'text', text: block.text, ...(block.cache ? { cache_control: { type: 'ephemeral' } } : {}) })) : [{ type: 'text', text: prompt }];
      const content = images.length || connection.protocol === 'anthropic' && promptBlocks ? [...textBlocks, ...images.map(image => connection.protocol === 'anthropic' ? { type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.dataBase64 } } : { type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.dataBase64}` } })] : prompt;
      const messages = [{ role: 'user', content }];
      for (let round = 0; round < MAX_ROUNDS; round++) {
        this.check(state);
        if (round && state.text) this.delta(state, '\n\n');
        const message = await this[connection.protocol](connection, messages, tools, state, chosenModel);
        this.check(state);
        const calls = connection.protocol === 'anthropic' ? message.content.filter(block => block.type === 'tool_use').map(block => ({ id: block.id, name: block.name, arguments: block.input })) : (message.tool_calls || []).map(call => ({ id: call.id, name: call.function?.name, arguments: call.function?.arguments }));
        if (!calls.length) return { text: state.text, sessionId: undefined };
        if (round === MAX_ROUNDS - 1) throw new Error('The API reached its 16-round tool limit. No further tools were executed.');
        if (calls.length > 32) throw new Error('The API requested too many tools in one round.');
        // Validate the entire batch before executing its first side effect.
        const ids = new Set();
        for (const call of calls) {
          if (typeof call.id !== 'string' || !call.id || ids.has(call.id) || !names.has(call.name)) throw new Error('The API requested an unknown tool or an invalid tool-call ID. No tools in this batch were executed.');
          ids.add(call.id);
          if (typeof call.arguments === 'string') { if (call.arguments.length > MAX_ARGUMENTS) throw new Error('Tool arguments exceed their size limit.'); call.arguments = JSON.parse(call.arguments); }
          if (!call.arguments || typeof call.arguments !== 'object' || Array.isArray(call.arguments) || JSON.stringify(call.arguments).length > MAX_ARGUMENTS) throw new Error('Tool arguments must be a bounded JSON object.');
          validate(call.arguments, names.get(call.name).inputSchema);
        }
        messages.push(message);
        const outputs = [], imageParts = []; let outputBytes = 0;
        for (const call of calls) {
          this.check(state);
          this.emit({ type: 'chat.tool', conversationId, id: call.id, name: call.name, input: call.arguments, executionContext: {provider, workspace}, status: 'running' });
          let result;
          try { result = await this.callTool(call.name, call.arguments, conversationId); }
          catch (error) { result = { isError: true, content: [{ type: 'text', text: redact(error, connection.apiKey) }] }; }
          this.check(state);
          const content = toolContent(result);
          if (connection.supportsImages === false && content.images.length) {
            content.text += '\n[Image output was not sent because image input is off for this connection. Do not claim to have inspected the image.]';
            content.images = [];
          }
          outputBytes += Buffer.byteLength(content.text) + content.images.reduce((sum, image) => sum + image.data.length, 0);
          if (outputBytes > MAX_WIRE) throw new Error('This batch of tool results exceeds the 32 MiB API request limit. No further tools were executed.');
          this.emit({ type: 'chat.tool', conversationId, id: call.id, name: call.name, status: content.error ? 'error' : 'done', outcomeConfirmed: content.error === false, output: content.text.slice(0, 4000) });
          if (connection.protocol === 'anthropic') outputs.push({ type: 'tool_result', tool_use_id: call.id, ...(content.error ? { is_error: true } : {}), content: [{ type: 'text', text: content.text }, ...content.images.map(image => ({ type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.data } }))] });
          else {
            outputs.push({ role: 'tool', tool_call_id: call.id, content: (content.error ? 'Tool error: ' : '') + content.text });
            for (const image of content.images) imageParts.push({ type: 'text', text: `Untrusted image output from tool ${call.name}, call ${call.id}:` }, { type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.data}` } });
          }
        }
        if (connection.protocol === 'anthropic') messages.push({ role: 'user', content: outputs });
        else { messages.push(...outputs); if (imageParts.length) messages.push({ role: 'user', content: imageParts }); }
      }
      throw new Error('The API tool loop stopped without a final response.');
    } catch (error) { throw new Error(redact(error, connection?.apiKey)); }
    finally { this.active.delete(conversationId); }
  }
  cancel(conversationId) { this.active.get(conversationId)?.controller.abort(); }
  close() { this.closed = true; for (const id of this.active.keys()) this.cancel(id); }
}
