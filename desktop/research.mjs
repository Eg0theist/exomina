import {randomUUID} from 'node:crypto';
import {researchSpec,researchPrompt} from './research-guide.mjs';
export {RESEARCH_BUDGETS,researchSpec,researchPrompt} from './research-guide.mjs';

/** Explicit one-run public research. Claims are persisted before inference; no scheduler. */
export class Research {
  constructor({store,execute,available=()=>true,cancel=()=>{},emit=()=>{},now=()=>new Date()}) { Object.assign(this,{store,execute,available,cancel,emit,now}); }
  view() { return {runs:this.store.state.researchRuns||[],busy:!!this.pending,browserEnabled:this.store.state.settings.browserEnabled===true}; }
  async save() { await this.store.save(); this.emit({type:'research.changed'}); }
  async start(input) {
    const spec=researchSpec(input);
    if(this.closed)throw Error('Exomina is closing.');
    if(this.pending)throw Error('A research run is already active.');
    if(!this.store.state.settings.browserEnabled)throw Error('Browser tools are off. Enable them in Tools first.');
    if(!this.available(spec))throw Error('Choose a connected AI with available usage and a free chat slot.');
    const run={...spec,id:randomUUID(),status:'running',startedAt:this.now().toISOString()};
    this.store.state.researchRuns=[run,...(this.store.state.researchRuns||[])].slice(0,30);
    // Lock synchronously, including the durable-write interval.
    this.pending=Promise.resolve();
    try { await this.save(); } catch(error) {Object.assign(run,{status:'failed',error:String(error?.message??error).slice(0,600),finishedAt:this.now().toISOString()});delete this.pending;this.emit({type:'research.changed'});throw error;}
    this.pending=this.complete(run).finally(()=>{delete this.pending;this.emit({type:'research.changed'});});
    this.pending.catch(()=>{});
    return this.view();
  }
  async complete(run) {
    try {
      if(run.status!=='running'||this.closed)return;
      const result=await this.execute({...run,prompt:researchPrompt(run),research:true,onStarted:async id=>{
        run.conversationId=id;
        if(run.status!=='running'||this.closed)this.cancel(id);
        await this.save();
      }});
      if(run.status!=='running')return;
      const noSources=!result.error&&!result.budgetReached&&!result.sources?.length;
      Object.assign(run,{status:result.budgetReached?'limited':result.error?'failed':noSources?'inconclusive':'complete',error:result.budgetReached?'Time budget reached. Review the partial result in its chat.':result.error|| (noSources?'No source page was read in the shared browser. Review the report’s limitations.':null),sources:result.sources||[]});
    }catch(error){if(run.status==='running')Object.assign(run,{status:'failed',error:String(error?.message??error).slice(0,600)});}
    finally{run.finishedAt??=this.now().toISOString();await this.save();}
  }
  async stop(id) {
    const run=(this.store.state.researchRuns||[]).find(item=>item.id===id);
    if(run?.status==='running'){run.status='stopped';run.finishedAt=this.now().toISOString();if(run.conversationId)this.cancel(run.conversationId);await this.save();}
    return this.view();
  }
  async removeChat(id) {this.store.state.researchRuns=(this.store.state.researchRuns||[]).filter(run=>run.conversationId!==id);await this.save();}
  async init() {for(const run of this.store.state.researchRuns||[])if(run.status==='running')Object.assign(run,{status:'interrupted',error:'Exomina closed during this run. Review its chat before starting again.'});await this.save();return this;}
  close(){this.closed=true;for(const run of this.store.state.researchRuns||[])if(run.status==='running')this.stop(run.id).catch(()=>{});}
}
