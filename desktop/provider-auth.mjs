// Shared by host and renderer. Login links never authorize token extraction or
// direct API requests; the official provider runtime owns the OAuth exchange.
const hosts={
  codex:['auth.openai.com','chatgpt.com'],
  claude:['claude.ai','claude.com','console.anthropic.com','platform.claude.com'],
  grok:['accounts.x.ai','auth.x.ai'],
  'muse-code':['auth.meta.com','dev.meta.ai','accountscenter.meta.com'],
};
export function officialLoginUrl(value,provider){
  try{
    const url=new URL(value);
    const allowed=provider?hosts[provider]:Object.values(hosts).flat();
    return url.protocol==='https:'&&!url.username&&!url.password&&(!url.port||url.port==='443')&&allowed?.includes(url.hostname)?url.href:null;
  }catch{return null;}
}

/** Terminal output is untrusted. Only exact, approved provider hosts become links. */
export function loginOutput(value,provider){
  const text=String(value).replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g,'').replace(/\x1b\][\s\S]*$/,'').replace(/\x1b\[\d*C/g,' ').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'');
  // A URL at the end of an incomplete terminal chunk is not a complete link.
  const urls=[...text.matchAll(/https:\/\/[^\s\x00-\x1f<>"']+(?=[\s\x00-\x1f<>"'])/g)].map(match=>officialLoginUrl(match[0],provider)).filter(Boolean);
  const url=urls.find(value=>provider!=='claude'||['/oauth/authorize','/cai/oauth/authorize'].includes(new URL(value).pathname))||null;
  return {url,codeRequested:provider==='claude'&&/paste\s+(?:the\s+)?(?:authentication\s+|authorization\s+)?code\s+(?:here|below)|enter\s+(?:the\s+)?(?:authentication|authorization)\s+code/i.test(text)};
}

export function loginCode(value){
  if(typeof value!=='string'||!/^[A-Za-z0-9._~+/=#-]{4,4096}$/.test(value.trim()))throw Error('Paste the authorization code from the official sign-in page.');
  return value.trim();
}
