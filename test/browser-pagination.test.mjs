import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {snapshotOptions, snapshotSource} from '../desktop/browser-extension/page-source.js';
import {ConnectedBrowser} from '../desktop/browser-choice.mjs';

function readPage(text, options = {}) {
  const context = { document: { title: 'Long fixture', readyState: 'complete',
    querySelector: () => ({innerText:text}), querySelectorAll: () => [], body:{innerText:text} },
    location: {href:'https://example.test/paper'} };
  return vm.runInNewContext(snapshotSource('fixture', options), context);
}

test('long page is fully recoverable through bounded UTF-16 continuation pages', () => {
  const original = 'Start ' + '🧭 scientific text\n'.repeat(4200) + 'End';
  const pages = []; let offset = 0;
  do {
    const result = readPage(original, {offset, limit:7000});
    assert.equal(result.textOffset, offset);
    assert.equal(result.totalTextLength, original.length);
    assert.ok(result.text.length <= 7000);
    assert.equal(result.textTruncated, result.nextOffset !== null);
    pages.push(result.text); offset = result.nextOffset;
  } while (offset !== null);
  assert.equal(pages.join(''), original);
  assert.ok(pages.length > 2);
});

test('default snapshot declares truncation and continuation, end offsets are bounded', () => {
  const first = readPage('x'.repeat(30000));
  assert.equal(first.text.length,24000); assert.equal(first.nextOffset,24000);
  assert.equal(first.textTruncated,true);
  const beyond = readPage('short', {offset:100});
  assert.equal(beyond.text,''); assert.equal(beyond.textOffset,5); assert.equal(beyond.nextOffset,null);
  assert.equal(readPage('').nextOffset,null);
});

test('malformed snapshot inputs fail before browser code or approval dispatch', async () => {
  for (const input of [{offset:-1},{offset:0.5},{offset:'1'},{limit:0},{limit:24001},{limit:Infinity},{include_screenshot:'false'}]) {
    assert.throws(() => snapshotOptions(input), /Snapshot/);
  }
  let dispatched = 0, approved = 0;
  const browser = new ConnectedBrowser({bridge:{status:()=>({connected:true}),pages:new Map(),request:async()=>{dispatched++;return {content:[]};}},
    getSettings:()=>({browserEnabled:true}), isActive:()=>true, approve:async()=>{approved++;return true;}, emit:()=>{}});
  await assert.rejects(browser.call('browser_snapshot',{offset:-1},'chat'),/Snapshot/);
  assert.equal(dispatched,0);assert.equal(approved,0);
});

test('connected browser passes paging and text-only options through the approved route', async () => {
  const calls = [];
  const browser = new ConnectedBrowser({bridge:{status:()=>({connected:true}),pages:new Map(),request:async(...args)=>{calls.push(args);return {content:[]};}},
    getSettings:()=>({browserEnabled:true}), isActive:()=>true, approve:async()=>true, emit:()=>{}});
  await browser.call('browser_snapshot',{offset:24000,limit:6000,include_screenshot:false},'chat');
  assert.deepEqual(calls[0].slice(0,3),['snapshot',{offset:24000,limit:6000,include_screenshot:false},'chat']);
});
