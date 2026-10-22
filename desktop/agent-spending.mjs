import {randomUUID,createHash} from 'node:crypto';
const money=(n,label)=>{if(!Number.isSafeInteger(n)||n<0||n>100000000)throw Error(label+' must be a non-negative amount in minor currency units.');return n;};
const host=value=>{const url=new URL(value.includes('://')?value:'https://'+value);if(url.protocol!=='https:'||url.username||url.password||url.port||url.hostname==='localhost'||!url.hostname.includes('.'))throw Error('Use an HTTPS merchant domain.');return url.hostname.toLowerCase();};
export function spendingPolicy(input={}){
 const allowedMerchants=input.allowedMerchants||[],allowedCategories=input.allowedCategories||[];
 if(!Array.isArray(allowedMerchants)||allowedMerchants.length>100||!Array.isArray(allowedCategories)||allowedCategories.length>30)throw Error('Choose up to 100 merchants and 30 categories.');
 return {enabled:input.enabled===true,currency:['EUR','USD','GBP','CAD'].includes(input.currency)?input.currency:'EUR',totalLimit:money(input.totalLimit??0,'Total limit'),monthlyLimit:money(input.monthlyLimit??0,'Monthly limit'),perPurchaseLimit:money(input.perPurchaseLimit??0,'Per-purchase limit'),reviewAbove:money(input.reviewAbove??0,'Review threshold'),allowedMerchants:[...new Set(allowedMerchants.map(host))],allowedCategories:[...new Set(allowedCategories.map(c=>{if(typeof c!=='string'||!c.trim()||c.length>60)throw Error('Use short category names.');return c.trim().toLowerCase();}))],region:typeof input.region==='string'&&/^[A-Z]{2}$/.test(input.region)?input.region:'DE',provider:['link','paypal'].includes(input.provider)?input.provider:'link'};
}
export function evaluateSpend(policy,ledger,quote,now=new Date()){
 const p=spendingPolicy(policy),amount=money(quote.amount,'Purchase amount');if(!amount)throw Error('Enter a positive amount.');
 const merchant=host(String(quote.merchant||'')),category=String(quote.category||'').trim().toLowerCase(),currency=String(quote.currency||p.currency).toUpperCase();
 const counted=ledger.filter(r=>r.currency===p.currency&&['reserved','succeeded','unknown'].includes(r.status)),used=counted.reduce((n,r)=>n+r.amount,0),month=now.toISOString().slice(0,7),monthly=counted.filter(r=>r.createdAt.startsWith(month)).reduce((n,r)=>n+r.amount,0);
 const reasons=[];if(!p.enabled)reasons.push('Spending policy is off.');if(currency!==p.currency)reasons.push('Currency is outside this budget.');if(!p.allowedMerchants.includes(merchant))reasons.push('Merchant is outside the exact allowed-domain list.');if(!p.allowedCategories.includes(category))reasons.push('Category is outside the allowed list.');
 if(amount>p.perPurchaseLimit)reasons.push('Per-purchase limit exceeded.');if(used+amount>p.totalLimit)reasons.push('Total budget exceeded.');if(monthly+amount>p.monthlyLimit)reasons.push('Monthly budget exceeded.');
 return {decision:reasons.length?'blocked':amount>p.reviewAbove?'review':'within-budget',reasons,amount,currency,merchant,category,remaining:{total:Math.max(0,p.totalLimit-used),month:Math.max(0,p.monthlyLimit-monthly)},notice:'This is a policy assessment. No payment has been made.'};
}
export class AgentSpending{
 constructor({store,now=()=>new Date()}){Object.assign(this,{store,now});this.queue=Promise.resolve();}
 view(){const data=this.store.state.agentSpending||{};return {policy:spendingPolicy(data.policy),trials:data.trials||[],liveProviderConnected:false,capability:{link:'US/Canadian customers; each purchase requires Link approval. Not currently available for German customers.',paypal:'No discretionary buyer-wallet adapter is connected. A merchant checkout integration does not grant a buyer spending account.'},notice:'Trial ledger only. No payment account or payment credentials are connected.'};}
 configure(input){const policy=spendingPolicy(input),task=this.queue.catch(()=>{}).then(async()=>{const previous=this.store.state.agentSpending;this.store.state.agentSpending={...previous,policy};try{await this.store.save();}catch(e){this.store.state.agentSpending=previous;throw e;}return this.view();});this.queue=task;return task;}
 quote(input){return evaluateSpend(this.view().policy,this.view().trials,input,this.now());}
 trial(input){const task=this.queue.catch(()=>{}).then(async()=>{
  if(typeof input.requestId!=='string'||!/^[-\w]{1,100}$/.test(input.requestId))throw Error('Use a stable request ID for this trial.');
  const view=this.view(),value=this.quote(input),digest=createHash('sha256').update(JSON.stringify({amount:value.amount,currency:value.currency,merchant:value.merchant,category:value.category})).digest('hex'),earlier=view.trials.find(t=>t.requestId===input.requestId);
  if(earlier){if(earlier.digest!==digest)throw Error('This request ID already names a different purchase.');return {...earlier,duplicate:true};}
  const record={id:randomUUID(),requestId:input.requestId,digest,...value,status:value.decision==='within-budget'?'reserved':value.decision==='review'?'needs-review':'blocked',createdAt:this.now().toISOString(),trial:true};
  const previous=this.store.state.agentSpending;this.store.state.agentSpending={...previous,trials:[...view.trials,record]};try{await this.store.save();}catch(e){this.store.state.agentSpending=previous;throw e;}return record;
 });this.queue=task;return task;}
 resolve({id,decision}){const task=this.queue.catch(()=>{}).then(async()=>{if(!['complete','cancel'].includes(decision))throw Error('Choose complete or cancel.');const previous=this.store.state.agentSpending,record=previous?.trials?.find(t=>t.id===id);if(!record||!['reserved','needs-review'].includes(record.status))throw Error('No pending trial found.');
  if(decision==='complete'&&record.status==='needs-review'){
   const value=this.quote(record);if(value.decision==='blocked')throw Error(value.reasons.join(' '));
  }
  this.store.state.agentSpending={...previous,trials:previous.trials.map(t=>t.id===id?{...t,status:decision==='complete'?'succeeded':'cancelled',finishedAt:this.now().toISOString()}:t)};try{await this.store.save();}catch(e){this.store.state.agentSpending=previous;throw e;}return this.view();});this.queue=task;return task;}
}
export const SPENDING_TOOLS=[{name:'spending_preview',description:'Assess a proposed purchase against the owner-configured budget, currency, exact merchant domains and categories. Read-only. Reports policy status and live-wallet availability. Does not reserve funds, approve a purchase or make a payment.',inputSchema:{type:'object',properties:{amount:{type:'integer',minimum:1,description:'Total including taxes/fees, in minor currency units.'},currency:{type:'string'},merchant:{type:'string'},category:{type:'string'}},required:['amount','currency','merchant','category'],additionalProperties:false}}];
