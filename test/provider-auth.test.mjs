import test from 'node:test';
import assert from 'node:assert/strict';
import {officialLoginUrl} from '../desktop/provider-auth.mjs';
test('sign-in links are exact HTTPS provider hosts without embedded credentials',()=>{
  assert.ok(officialLoginUrl('https://accounts.x.ai/oauth2/device?user_code=ABCD-1234','grok'));
  assert.ok(officialLoginUrl('https://auth.openai.com/authorize','codex'));
  for(const value of ['http://accounts.x.ai/oauth2/device','https://accounts.x.ai.evil.example/','https://user:pass@accounts.x.ai/oauth2/device','https://accounts.x.ai:8080/oauth2/device','javascript:alert(1)'])assert.equal(officialLoginUrl(value,'grok'),null);
  assert.equal(officialLoginUrl('https://accounts.x.ai/oauth2/device','codex'),null);
  assert.equal(officialLoginUrl('https://github.com/login/device','copilot'),null);
  assert.equal(officialLoginUrl('https://github.com/login/device','unknown'),null);
});
