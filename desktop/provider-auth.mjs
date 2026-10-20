// Shared by host and renderer. Login links never authorize token extraction or
// direct API requests; the official provider runtime owns the OAuth exchange.
const hosts={
  codex:['auth.openai.com','chatgpt.com'],
  claude:['claude.ai','console.anthropic.com','platform.claude.com'],
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
