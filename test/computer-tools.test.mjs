import test from 'node:test';
import assert from 'node:assert/strict';
import { ComputerTools, isPublicAddress, validateBrowserUrl, validateToolArgs } from '../desktop/computer-tools.mjs';

function createTools(settings = {}, approve = async () => false) {
  return new ComputerTools({ dataDir: '/unused', approve, getSettings: () => settings, emit: () => {} });
}

test('browser URL validation blocks unsafe schemes, credentials, and private address spellings', () => {
  for (const url of ['file:///C:/secret', 'javascript:alert(1)', 'data:text/html,hello', 'ftp://example.com', 'https://user:pass@example.com', 'http://localhost', 'http://localhost.', 'http://app.local', 'http://printer', 'http://127.1', 'http://2130706433', 'http://0x7f000001', 'http://10.0.0.1', 'http://172.16.0.1', 'http://192.168.1.1', 'http://169.254.169.254', 'http://[::1]', 'http://[::ffff:127.0.0.1]', 'http://[fc00::1]', 'http://[2001:db8::1]']) {
    assert.throws(() => validateBrowserUrl(url), undefined, url);
  }
  assert.equal(validateBrowserUrl('https://example.com/path?q=1').hostname, 'example.com');
  assert.equal(validateBrowserUrl('https://8.8.8.8').hostname, '8.8.8.8');
});

test('public address checks exclude multicast, link local, carrier NAT, and documentation ranges', () => {
  for (const ip of ['0.0.0.0', '100.64.0.1', '198.18.0.1', '192.0.2.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255', 'fe80::1', '2002:7f00:1::', '2001::1', '2001:0000:0000:0000:0000:0000:0000:1', '2001:0db8::1', 'not-an-ip']) assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of ['1.1.1.1', '8.8.8.8', '172.32.0.1', '2001:4860:4860::8888', '2606:4700:4700::1111']) assert.equal(isPublicAddress(ip), true, ip);
});

test('argument validation rejects unbounded selectors, unknown shortcuts, and malformed coordinates', () => {
  for (const [name, args] of [
    ['desktop_click', { x: -1, y: 0 }], ['desktop_click', { x: 1.5, y: 0 }], ['desktop_click', { x: '1', y: 0 }],
    ['desktop_key', { key: 'Win+R' }], ['browser_key', { key: 'Control+Alt+Delete' }], ['browser_click', { selector: '' }],
    ['browser_click', { selector: 'a'.repeat(2001) }], ['desktop_type', { text: '\u0000' }],
    ['desktop_type', { text: 'a'.repeat(20001) }], ['browser_snapshot', { secret: true }], ['unknown_tool', {}],
  ]) assert.throws(() => validateToolArgs(name, args));
  assert.doesNotThrow(() => validateToolArgs('desktop_type', { text: 'Text +^%~(){}[] ä 中文\nsecond line\tend' }));
  assert.doesNotThrow(() => validateToolArgs('desktop_click', { x: 0, y: 0 }));
});

test('tools are opt in and disabled tools never request approval or touch browser/desktop', async () => {
  let approvals = 0;
  const computer = createTools({}, async () => { approvals++; return true; });
  for (const [name, args] of [['browser_open', { url: 'https://example.com' }], ['browser_snapshot', {}], ['desktop_screenshot', {}], ['desktop_click', { x: 0, y: 0 }]]) {
    const result = await computer.call(name, args, 'conversation-1');
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /disabled/);
  }
  assert.equal(approvals, 0);
  assert.equal(computer.context, null);
});

test('declining browser navigation stops before DNS resolution or browser launch', async () => {
  const approvals = [];
  const computer = createTools({ browserEnabled: true }, async (request) => { approvals.push(request); return false; });
  computer.assertPublicUrl = () => { throw new Error('DNS must not run'); };
  computer.startBrowser = () => { throw new Error('Browser must not launch'); };
  const result = await computer.call('browser_open', { url: 'https://example.com' }, 'conversation-2');
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /did not approve/);
  assert.equal(approvals[0].conversationId, 'conversation-2');
  assert.match(approvals[0].detail, /example\.com/);
});

test('browser snapshots use the isolated page and label its content untrusted', async () => {
  const computer = createTools({ browserEnabled: true });
  computer.context = {};
  computer.page = {
    isClosed: () => false, url: () => 'https://example.com', title: async () => 'Fixture',
    locator: () => ({ ariaSnapshot: async () => '- heading "Synthetic fixture"' }),
    screenshot: async () => Buffer.from('synthetic-image'),
  };
  const result = await computer.call('browser_snapshot', { screenshot: true }, 'fixture');
  assert.equal(result.isError, undefined);
  assert.equal(JSON.parse(result.content[0].text).untrusted, true);
  assert.equal(result.content[1].type, 'image');
  assert.equal(Buffer.from(result.content[1].data, 'base64').toString(), 'synthetic-image');
});

test('approved browser inputs run on the selected page and declined inputs never execute', async () => {
  const executed = [], approvals = [];
  let accept = true;
  const computer = createTools({ browserEnabled: true }, async (request) => { approvals.push(request); return accept; });
  computer.context = {};
  computer.page = {
    isClosed: () => false, url: () => 'https://example.com',
    locator: (selector) => ({ click: async () => executed.push(['click', selector]), fill: async (text) => executed.push(['fill', selector, text]) }),
    keyboard: { press: async (key) => executed.push(['key', key]) },
  };
  assert.equal((await computer.call('browser_click', { selector: '#button' }, 'fixture')).isError, undefined);
  assert.equal((await computer.call('browser_type', { selector: '#field', text: 'literal {ENTER}' }, 'fixture')).isError, undefined);
  assert.equal((await computer.call('browser_key', { key: 'Tab' }, 'fixture')).isError, undefined);
  accept = false;
  assert.equal((await computer.call('browser_click', { selector: '#button' }, 'fixture')).isError, true);
  assert.deepEqual(executed, [['click', '#button'], ['fill', '#field', 'literal {ENTER}'], ['key', 'Tab']]);
  assert.match(approvals[1].detail, /literal \{ENTER\}/);
});

test('desktop input requires a fresh screenshot and checks bounds before requesting approval', async () => {
  let approvals = 0;
  const computer = createTools({ desktopEnabled: true }, async () => { approvals++; return false; });
  const result = await computer.call('desktop_click', { x: 10, y: 10 });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, process.platform === 'win32' ? /fresh desktop_screenshot/ : /Windows only/);
  if (process.platform === 'win32') {
    computer.lastScreen = { width: 100, height: 100, left: 0, top: 0, at: Date.now() };
    const outside = await computer.call('desktop_click', { x: 100, y: 0 });
    assert.match(outside.content[0].text, /outside/);
  }
  assert.equal(approvals, 0);
});

test('desktop screenshots disclose all monitors and send nothing when declined', async () => {
  const approvals = [];
  const computer = createTools({ desktopEnabled: true }, async (request) => { approvals.push(request); return false; });
  const result = await computer.call('desktop_screenshot', {}, 'desktop-fixture');
  assert.equal(result.isError, true);
  if (process.platform === 'win32') {
    assert.match(approvals[0].detail, /COMPLETE Windows desktop/);
    assert.match(approvals[0].detail, /sent to the selected assistant/);
  }
  assert.equal(computer.lastScreen, null);
});
