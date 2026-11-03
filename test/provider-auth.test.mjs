import test from 'node:test';
import assert from 'node:assert/strict';
import {officialLoginUrl,loginOutput,loginCode} from '../desktop/provider-auth.mjs';
test('sign-in links are exact HTTPS provider hosts without embedded credentials',()=>{
  assert.ok(officialLoginUrl('https://accounts.x.ai/oauth2/device?user_code=ABCD-1234','grok'));
  assert.ok(officialLoginUrl('https://auth.openai.com/authorize','codex'));
  for(const value of ['http://accounts.x.ai/oauth2/device','https://accounts.x.ai.evil.example/','https://user:pass@accounts.x.ai/oauth2/device','https://accounts.x.ai:8080/oauth2/device','javascript:alert(1)'])assert.equal(officialLoginUrl(value,'grok'),null);
  assert.equal(officialLoginUrl('https://accounts.x.ai/oauth2/device','codex'),null);
  assert.equal(officialLoginUrl('https://github.com/login/device','copilot'),null);
  assert.equal(officialLoginUrl('https://github.com/login/device','unknown'),null);
});

test('Claude current official domain and split terminal output preserve only approved URLs',()=>{
 const url='https://claude.com/cai/oauth/authorize?state=synthetic';
 assert.equal(officialLoginUrl(url,'claude'),url);
 assert.deepEqual(loginOutput('\x1b[32mOpening '+url+'\x1b[0m\r\nPaste code here if prompted >','claude'),{url,codeRequested:true});
 for(const bad of ['https://claude.com.evil.example/authorize','https://evil.example/claude.com','https://user:pass@claude.com/authorize'])assert.equal(loginOutput(bad+'\n','claude').url,null);
 assert.equal(loginOutput('Paste code here if prompted >','codex').codeRequested,false);
 assert.equal(loginCode(' synthetic-code#synthetic-state '),'synthetic-code#synthetic-state');
 for(const bad of ['code\rlogout','code\nlogout','x','https://example.org/callback?code=value','x'.repeat(4097)])assert.throws(()=>loginCode(bad),/authorization code/);
});

test('login URLs wait for complete chunks and survive OSC hyperlinks without consuming the prompt',()=>{
 const url='https://claude.com/cai/oauth/authorize?state=synthetic-state&code_challenge=synthetic-challenge',plain=url+'\r\nPaste code here if prompted >';
 for(let i=1;i<url.length;i++)assert.equal(loginOutput(plain.slice(0,i),'claude').url,null);
 const osc='\x1b]8;;'+url+'\x1b\\'+url+'\x1b]8;;\x1b\\\r\nPaste\x1b[1Ccode here if prompted >';
 assert.deepEqual(loginOutput(osc,'claude'),{url,codeRequested:true});
 assert.equal(loginOutput('https://claude.com/docs\n'+plain,'claude').url,url);
});
