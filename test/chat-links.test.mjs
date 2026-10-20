import test from 'node:test';
import assert from 'node:assert/strict';
import { parseChatLink } from '../desktop/chat-links.mjs';

test('chat links handle web addresses and local paths with spaces, parentheses and line suffixes',()=>{
  assert.deepEqual(parseChatLink('https://example.com/a(b)?q=x'),{kind:'web',url:'https://example.com/a(b)?q=x'});
  assert.deepEqual(parseChatLink('<C:/Program Files/Exomina/icon (2).png>'),{kind:'file',path:'C:/Program Files/Exomina/icon (2).png'});
  assert.deepEqual(parseChatLink('C:\\Project\\app.py:12:3'),{kind:'file',path:'C:\\Project\\app.py',line:12,column:3});
  assert.deepEqual(parseChatLink('file:///C:/My%20Files/report.pdf'),{kind:'file',path:'C:/My Files/report.pdf'});
  assert.deepEqual(parseChatLink('/tmp/report.pdf:7'),{kind:'file',path:'/tmp/report.pdf',line:7});
});
test('unsafe schemes, embedded credentials, device paths and alternate streams are not links',()=>{
  for(const input of ['javascript:alert(1)','data:text/html,test','https://user:pass@example.com','\\\\.\\PhysicalDrive0','C:/image.png:stream','file://remotehost/share/report.pdf','C:/foo\nbar'])assert.equal(parseChatLink(input),null,input);
});
