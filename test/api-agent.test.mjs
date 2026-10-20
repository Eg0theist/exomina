import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiAgent } from '../desktop/api-agent.mjs';

const key = 'synthetic-secret-do-not-log';
const tool = { name: 'echo', description: 'Synthetic tool', inputSchema: { type: 'object', properties: { value: { type: 'string', minLength: 1 } }, required: ['value'], additionalProperties: false } };
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8QsAAAAASUVORK5CYII=';
const open = (delta, finish_reason = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
function sse(items) {
  const bytes = Buffer.from(items.map(item => `data: ${typeof item === 'string' ? item : JSON.stringify(item)}\r\n\r\n`).join(''));
  return new Response(new ReadableStream({ start(controller) { for (let index = 0; index < bytes.length; index += 7) controller.enqueue(bytes.subarray(index, index + 7)); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
}
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
function setup({ protocol = 'openai', responses = [], connection = {}, definitions = [tool], callTool, fetchImpl, ...options } = {}) {
  const requests = [], emitted = [], executed = [];
  const agent = new ApiAgent({
    getConnection: async () => ({ provider: 'test', protocol, baseUrl: protocol === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://api.example.com/v1', apiKey: key, model: 'synthetic-model', ...connection }),
    getTools: () => definitions,
    emit: event => emitted.push(event),
    callTool: async (...args) => { executed.push(args); return callTool ? callTool(...args) : { content: [{ type: 'text', text: 'Synthetic tool result' }] }; },
    fetchImpl: async (url, init) => { requests.push({ url, ...init, body: JSON.parse(init.body) }); return fetchImpl ? fetchImpl(url, init) : responses.shift(); },
    ...options,
  });
  return { agent, requests, emitted, executed, run: extra => agent.run({ provider: 'test', conversationId: 'synthetic', prompt: 'Synthetic request', ...extra }) };
}

test('uploaded screenshots enter both API protocols as image input', async () => {
  const image = { mimeType: 'image/png', dataBase64: png };
  const openai = setup({ responses: [json({ choices: [{ message: { role: 'assistant', content: 'Inspected' }, finish_reason: 'stop' }] })] });
  await openai.run({ images: [image] });
  assert.equal(openai.requests[0].body.messages[0].content[1].image_url.url, `data:image/png;base64,${png}`);
  const anthropic = setup({ protocol: 'anthropic', responses: [json({ content: [{ type: 'text', text: 'Inspected' }], stop_reason: 'end_turn' })] });
  await anthropic.run({ images: [image] });
  assert.deepEqual(anthropic.requests[0].body.messages[0].content[1].source, { type: 'base64', media_type: 'image/png', data: png });
});

test('OpenAI streams UTF-8, preserves reasoning/signature metadata and sends tool images on the next round', async () => {
  const qa = setup({ responses: [
    sse([open({ role: 'assistant', content: 'Checking. ', reasoning_content: 'private ', reasoning_details: [{ index: 0, type: 'reasoning.text', text: 'first ' }], tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'ec', arguments: '{"value":' }, extra_content: { google: { thought_signature: 'opaque-signature' } } }] }),
      open({ reasoning_content: 'plan', reasoning_details: [{ index: 0, text: 'second', signature: 'opaque-reasoning' }], tool_calls: [{ index: 0, function: { name: 'ho', arguments: '"ä 中文"}' } }] }, 'tool_calls'), '[DONE]']),
    sse([open({ content: 'Done — 中文.' }, 'stop'), '[DONE]']),
  ], callTool: () => ({ content: [{ type: 'text', text: 'Synthetic visible text' }, { type: 'image', mimeType: 'image/png', data: png }], structuredContent: { found: true } }) });
  const result = await qa.run();
  assert.equal(result.text, 'Checking. \n\nDone — 中文.');
  assert.equal(result.sessionId, undefined);
  assert.deepEqual(qa.executed, [['echo', { value: 'ä 中文' }, 'synthetic']]);
  assert.equal(qa.requests[0].url, 'https://api.example.com/v1/chat/completions');
  assert.equal(qa.requests[0].redirect, 'error');
  assert.equal(qa.requests[0].headers.Authorization, `Bearer ${key}`);
  const messages = qa.requests[1].body.messages;
  assert.equal(messages[1].reasoning_content, 'private plan');
  assert.deepEqual(messages[1].reasoning_details, [{ type: 'reasoning.text', text: 'first second', signature: 'opaque-reasoning' }]);
  assert.equal(messages[1].tool_calls[0].function.name, 'echo');
  assert.equal(messages[1].tool_calls[0].extra_content.google.thought_signature, 'opaque-signature');
  assert.equal(messages[2].role, 'tool'); assert.equal(messages[2].tool_call_id, 'call_1');
  assert.ok(messages[2].content.includes('"found":true'));
  assert.equal(messages[3].content[1].image_url.url, `data:image/png;base64,${png}`);
  assert.equal(qa.emitted.filter(event => event.type === 'chat.delta').some(event => event.text.includes('private plan')), false);
});

test('Anthropic preserves thinking/signatures and nests image output in the matching tool_result', async () => {
  const qa = setup({ protocol: 'anthropic', responses: [sse([
    { type: 'message_start', message: { role: 'assistant', content: [] } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'private reasoning' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signed-' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'opaque' } },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'use1', name: 'echo', input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"value":"Synthetic"}' } },
    { type: 'message_stop' },
  ]), sse([{ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Done: ' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ä 中文' } }, { type: 'message_stop' }])], callTool: () => ({ content: [{ type: 'image', data: png, mimeType: 'image/png' }] }) });
  assert.equal((await qa.run()).text, 'Done: ä 中文');
  assert.equal(qa.requests[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(qa.requests[0].headers['x-api-key'], key);
  const messages = qa.requests[1].body.messages;
  assert.deepEqual(messages[1].content[0], { type: 'thinking', thinking: 'private reasoning', signature: 'signed-opaque' });
  assert.deepEqual(messages[1].content[1].input, { value: 'Synthetic' });
  assert.equal(messages[2].content[0].tool_use_id, 'use1');
  assert.equal(messages[2].content[0].content[1].source.data, png);
});

test('unknown or malformed tool batches execute nothing and optional schema unions work', async () => {
  for (const calls of [
    [{ id: 'a', type: 'function', function: { name: 'echo', arguments: '{"value":"valid"}' } }, { id: 'b', type: 'function', function: { name: 'not_listed', arguments: '{}' } }],
    [{ id: 'a', type: 'function', function: { name: 'echo', arguments: '{"value":12}' } }],
    [{ id: 'a', type: 'function', function: { name: 'echo', arguments: '{"value":"valid","extra":true}' } }],
  ]) {
    const qa = setup({ responses: [json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: calls } }] })] });
    await assert.rejects(qa.run(), /unknown tool|wrong data type|Unknown tool argument/);
    assert.equal(qa.executed.length, 0); assert.equal(qa.requests.length, 1);
  }
  const qa = setup({ definitions: [{ ...tool, inputSchema: { type: 'object', properties: { value: { anyOf: [{ type: 'null' }, { type: 'string' }] } } } }], responses: [json({ choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'a', function: { name: 'echo', arguments: '{}' } }] } }] }), json({ choices: [{ message: { role: 'assistant', content: 'Done' } }] })] });
  await qa.run(); assert.equal(qa.executed.length, 1);
});

test('OpenRouter disables fallbacks, local servers can omit keys, and full assistant metadata survives JSON responses', async () => {
  const qa = setup({ connection: { baseUrl: 'https://openrouter.ai/api/v1' }, responses: [json({ choices: [{ message: { role: 'assistant', content: '<think>Preserved model text</think>', reasoning_details: [{ type: 'reasoning.encrypted', data: 'opaque' }], custom_metadata: { intact: true }, tool_calls: [{ id: 'one', type: 'function', function: { name: 'echo', arguments: '{"value":"test"}' }, signature: 'full' }] } }] }), json({ choices: [{ message: { role: 'assistant', content: 'Done' } }] })] });
  await qa.run();
  assert.deepEqual(qa.requests[0].body.provider, { allow_fallbacks: false, require_parameters: true });
  assert.deepEqual(qa.requests[1].body.messages[1].custom_metadata, { intact: true });
  assert.equal(qa.requests[1].body.messages[1].tool_calls[0].signature, 'full');
  const local = setup({ connection: { baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '' }, definitions: [], responses: [json({ choices: [{ message: { role: 'assistant', content: 'Local' } }] })] });
  assert.equal((await local.run()).text, 'Local'); assert.equal(local.requests[0].headers.Authorization, undefined);
  for (const baseUrl of ['http://remote.example/v1', 'https://username:password@api.example/v1', 'https://api.example/v1?key=value']) {
    const rejected = setup({ connection: { baseUrl } }); await assert.rejects(rejected.run(), /HTTPS|without credentials/); assert.equal(rejected.requests.length, 0);
  }
});

test('API failures redact the exact saved key and never retry or follow redirects', async () => {
  const qa = setup({ fetchImpl: async () => new Response(JSON.stringify({ error: { message: `Rejected ${key}` } }), { status: 401 }) });
  await assert.rejects(qa.run(), error => error.message.includes('401') && !error.message.includes(key));
  assert.equal(qa.requests.length, 1); assert.equal(qa.requests[0].redirect, 'error');
  const redirect = setup({ fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  await assert.rejects(redirect.run(), /fetch failed/); assert.equal(redirect.requests.length, 1);
});

test('cancellation and per-request timeouts abort fetch without a retry and release the conversation', async () => {
  const waitingFetch = (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  const timed = setup({ fetchImpl: waitingFetch, requestTimeoutMs: 10 });
  await assert.rejects(timed.run(), /timed out/); assert.equal(timed.requests.length, 1); assert.equal(timed.agent.active.size, 0);
  const cancelled = setup({ fetchImpl: waitingFetch });
  const pending = cancelled.run();
  while (!cancelled.requests.length) await new Promise(resolve => setTimeout(resolve, 1));
  cancelled.agent.cancel('synthetic');
  await assert.rejects(pending, /Stopped/); assert.equal(cancelled.agent.active.size, 0);
  cancelled.agent.close(); await assert.rejects(cancelled.run(), /closed/);
});

test('incomplete streams fail and the 16-request loop bound prevents further tool effects', async () => {
  const incomplete = setup({ responses: [sse([open({ content: 'Incomplete' })])] });
  await assert.rejects(incomplete.run(), /before confirming completion/);
  const bounded = setup({ fetchImpl: async () => json({ choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'repeat', type: 'function', function: { name: 'echo', arguments: '{"value":"bounded"}' } }] } }] }) });
  await assert.rejects(bounded.run(), /16-round/); assert.equal(bounded.requests.length, 16); assert.equal(bounded.executed.length, 15);
});

test('tool errors are reported to the model with their matching id and unsafe stream metadata is refused', async () => {
  const qa = setup({ responses: [json({ choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'err1', type: 'function', function: { name: 'echo', arguments: '{"value":"test"}' } }] } }] }), json({ choices: [{ message: { role: 'assistant', content: 'Tool was declined.' } }] })], callTool: async () => { throw new Error(`Synthetic tool error ${key}`); } });
  await qa.run(); assert.equal(qa.requests[1].body.messages[2].tool_call_id, 'err1'); assert.match(qa.requests[1].body.messages[2].content, /Tool error/); assert.equal(qa.requests[1].body.messages[2].content.includes(key), false);
  const unsafe = setup({ responses: [sse([JSON.parse('{"choices":[{"index":0,"delta":{"__proto__":{"polluted":true}},"finish_reason":"stop"}]}'), '[DONE]'])] });
  await assert.rejects(unsafe.run(), /unsafe metadata/); assert.equal({}.polluted, undefined);
});

test('output-limit stops and unsafe image results fail without a second billed request', async () => {
  const limited = setup({ responses: [sse([open({ content: 'Partial' }, 'length'), '[DONE]'])] });
  await assert.rejects(limited.run(), /output limit/); assert.equal(limited.requests.length, 1);
  const anthropic = setup({ protocol: 'anthropic', responses: [sse([{ type: 'message_delta', delta: { stop_reason: 'max_tokens' } }, { type: 'message_stop' }])] });
  await assert.rejects(anthropic.run(), /output limit/); assert.equal(anthropic.requests.length, 1);
  const image = setup({ responses: [json({ choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'image', type: 'function', function: { name: 'echo', arguments: '{"value":"test"}' } }] } }] })], callTool: () => ({ content: [{ type: 'image', mimeType: 'image/svg+xml', data: 'PHN2Zz4=' }] }) });
  await assert.rejects(image.run(), /unsupported format/); assert.equal(image.requests.length, 1);
});

test('cancelling while a tool awaits host approval prevents the follow-up API request', async () => {
  let finishTool;
  const qa = setup({ responses: [json({ choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'pending', type: 'function', function: { name: 'echo', arguments: '{"value":"test"}' } }] } }] })], callTool: () => new Promise(resolve => { finishTool = resolve; }) });
  const running = qa.run();
  while (!finishTool) await new Promise(resolve => setTimeout(resolve, 1));
  qa.agent.cancel('synthetic');
  finishTool({ isError: true, content: [{ type: 'text', text: 'User cancelled approval.' }] });
  await assert.rejects(running, /Stopped/); assert.equal(qa.requests.length, 1); assert.equal(qa.agent.active.size, 0);
});

test('Anthropic keeps ordered prompt blocks and two ephemeral cache marks before images across tool rounds', async () => {
  const promptBlocks = [
    { text: 'Stable instructions.\n', cache: true },
    { text: '0+8 Historical summary with exact IDs.\n', cache: true },
    { text: '8+1 Recent source: café 😀\n', cache: false },
    { text: '\nCurrent request: inspect the image.' },
  ];
  const originalBlocks = structuredClone(promptBlocks), prompt = promptBlocks.map(block => block.text).join('');
  const qa = setup({ protocol: 'anthropic', responses: [
    json({ content: [{ type: 'tool_use', id: 'ordered-block-tool', name: 'echo', input: { value: 'synthetic' } }], stop_reason: 'tool_use' }),
    json({ content: [{ type: 'text', text: 'Complete.' }], stop_reason: 'end_turn' }),
  ] });
  assert.equal((await qa.run({ prompt, promptBlocks, images: [{ mimeType: 'image/png', dataBase64: png }] })).text, 'Complete.');
  const expectedBlocks = promptBlocks.map(block => ({ type: 'text', text: block.text, ...(block.cache ? { cache_control: { type: 'ephemeral' } } : {}) }));
  for (const request of qa.requests) {
    const initial = request.body.messages[0];
    assert.equal(initial.role, 'user');
    assert.deepEqual(initial.content.slice(0, promptBlocks.length), expectedBlocks);
    assert.equal(initial.content.filter(block => block.type === 'text').map(block => block.text).join(''), prompt);
    assert.deepEqual(initial.content[promptBlocks.length], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } });
    assert.equal(initial.content.filter(block => block.cache_control).length, 2);
  }
  assert.equal(qa.requests[1].body.messages[1].content[0].id, 'ordered-block-tool');
  assert.equal(qa.requests[1].body.messages[2].content[0].tool_use_id, 'ordered-block-tool');
  assert.deepEqual(promptBlocks, originalBlocks);
});

test('exact prompt concatenation supports zero through two cache marks without inventing separators', async () => {
  for (const marks of [0, 1, 2]) {
    const promptBlocks = [{ text: 'prefix\n', cache: marks >= 1 }, { text: 'summary 😀', cache: marks >= 2 }, { text: '' }, { text: '\nsuffix', cache: false }];
    const prompt = promptBlocks.map(block => block.text).join('');
    const qa = setup({ protocol: 'anthropic', responses: [json({ content: [{ type: 'text', text: 'Accepted.' }], stop_reason: 'end_turn' })] });
    await qa.run({ prompt, promptBlocks });
    const content = qa.requests[0].body.messages[0].content;
    assert.equal(content.map(block => block.text).join(''), prompt);
    assert.equal(content.length, 3);
    assert.equal(content.filter(block => block.cache_control).length, marks);
    assert.equal(content.every(block => !block.cache_control || block.cache_control.type === 'ephemeral'), true);
  }
});

test('invalid ordered prompt blocks fail before either API protocol sends a request or executes tools', async () => {
  const prompt = 'firstsecondthird';
  const invalid = [
    null,
    {},
    [],
    [null],
    [{ cache: true }],
    [{ text: 123 }],
    [{ text: prompt, cache: 'true' }],
    [{ text: prompt, cache: null }],
    [{ text: 'first' }, { text: 'third' }, { text: 'second' }],
    [{ text: 'first\n' }, { text: 'secondthird' }],
    [{ text: 'first', cache: true }, { text: 'second', cache: true }, { text: 'third', cache: true }],
    Array.from({ length: 4097 }, (_, index) => ({ text: index ? '' : prompt })),
  ];
  for (const protocol of ['openai', 'anthropic']) for (const promptBlocks of invalid) {
    const qa = setup({ protocol });
    await assert.rejects(qa.run({ prompt, promptBlocks }), /exactly preserve the request.*at most two cache marks/);
    assert.equal(qa.requests.length, 0);
    assert.equal(qa.executed.length, 0);
    assert.equal(qa.agent.active.size, 0);
  }
});

test('OpenAI receives the complete prompt with images and ignores validated cache marks', async () => {
  const promptBlocks = [{ text: 'Policy\n', cache: true }, { text: 'Stable history 😀\n', cache: true }, { text: 'Current request.' }];
  const prompt = promptBlocks.map(block => block.text).join('');
  for (const images of [[], [{ mimeType: 'image/png', dataBase64: png }]]) {
    const qa = setup({ responses: [json({ choices: [{ message: { role: 'assistant', content: 'Accepted.' }, finish_reason: 'stop' }] })] });
    await qa.run({ prompt, promptBlocks, images });
    const message = qa.requests[0].body.messages[0];
    if (images.length) assert.deepEqual(message.content, [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } }]);
    else assert.equal(message.content, prompt);
    assert.equal(JSON.stringify(qa.requests[0].body).includes('cache_control'), false);
  }
});

test('each API turn starts a fresh request using its supplied compacted prompt without retaining previous turn messages', async () => {
  for (const protocol of ['openai', 'anthropic']) {
    const answer = text => protocol === 'anthropic' ? json({ content: [{ type: 'text', text }], stop_reason: 'end_turn' }) : json({ choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }] });
    const qa = setup({ protocol, responses: [answer('First answer.'), answer('Second answer.')] });
    assert.equal((await qa.run({ prompt: 'First source prompt.' })).text, 'First answer.');
    const promptBlocks = [{ text: '0+2 Compacted first turn.\n', cache: true }, { text: 'Second user request.' }];
    const prompt = promptBlocks.map(block => block.text).join('');
    const result = await qa.run({ prompt, promptBlocks });
    assert.equal(result.text, 'Second answer.');
    assert.equal(result.sessionId, undefined);
    assert.equal(qa.requests[1].body.messages.length, 1);
    const content = qa.requests[1].body.messages[0].content;
    assert.equal(typeof content === 'string' ? content : content.map(block => block.text).join(''), prompt);
    assert.equal(JSON.stringify(qa.requests[1].body).includes('First source prompt.'), false);
    assert.equal(JSON.stringify(qa.requests[1].body).includes('First answer.'), false);
  }
});
