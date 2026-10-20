/** Reserve chat/voice preparation before it becomes an active run. An approved
 * update owns the same gate through the runner handshake, so new work cannot
 * slip between the idle check and quitting the application. */
export class UpdateRestartGuard {
  constructor({busy=()=>false,blockers=()=>[],launch,finish,settled=()=>{}}) {
    Object.assign(this,{busy,blockers,launch,finish,settled});
    this.preparing=0;this.handingOver=false;this.completed=false;this.pending=null;
  }
  get idle() { return !this.preparing&&!this.handingOver&&!this.completed&&!this.busy()&&!this.blockers().length; }
  status() {
    const blockers=[...this.blockers()];
    if(this.preparing)blockers.push({kind:'preparing',count:this.preparing,message:'New work is still preparing. Wait for it to start or finish.'});
    if(this.handingOver||this.completed)blockers.push({kind:'handover',count:1,message:'The approved update is preparing to restart Exomina.'});
    if(this.busy()&&!blockers.length)blockers.push({kind:'work',count:1,message:'Finish or stop active replies and voice sessions before applying the update.'});
    return {idle:!blockers.length,blockers};
  }
  blockedError() { return Error('Update is waiting: '+this.status().blockers.map(item=>item.message).join(' ')); }
  async work(task) {
    if(this.handingOver||this.completed)throw Error('Exomina is preparing the approved update. Send this after the app reopens.');
    this.preparing++;
    try { return await task(); }
    finally { this.preparing--;this.settled(); }
  }
  run(conversationId,{beforeLaunch,allow=[]}={}) {
    if(this.pending)return this.pending;
    if(this.status().blockers.some(item=>!allow.includes(item.kind)))return Promise.reject(this.blockedError());
    this.handingOver=true;
    this.pending=(async()=>{
      if(beforeLaunch)await beforeLaunch();
      if(this.preparing||this.busy()||this.blockers().length)throw this.blockedError();
      await this.launch({conversationId});
      this.completed=true;this.finish();
    })().finally(()=>{this.handingOver=false;this.pending=null;});
    return this.pending;
  }
}

/** Counts only live host state. An interactive shell remains open while idle;
 * terminal output cannot reliably prove whether its child programs are idle. */
export function updateRestartBlockers({quitting=false,replies=0,queued=0,commands=0,terminals=0,analysis=0,followups=0,voice=false,realtime=false,realtimeClosing=0}={}) {
  const result=[],add=(kind,count,message)=>{if(count>0)result.push({kind,count,message});};
  add('closing',quitting?1:0,'Exomina is closing.');
  add('replies',replies,`Finish or stop ${replies} active ${replies===1?'reply':'replies'}.`);
  add('queued',queued,`Send or remove ${queued} queued ${queued===1?'message':'messages'}.`);
  add('commands',commands,`Finish or stop ${commands} terminal ${commands===1?'command':'commands'}.`);
  add('terminals',terminals,`Close ${terminals} open terminal ${terminals===1?'session':'sessions'} in Terminal, including shells waiting at a prompt.`);
  add('analysis',analysis,`Finish or stop ${analysis} app analysis ${analysis===1?'job':'jobs'} in Tools.`);
  add('followups',followups,`Wait for ${followups} active ${followups===1?'follow-up':'follow-ups'} to finish.`);
  add('voice',voice?1:0,'Stop voice playback or dictation.');
  add('realtime',realtime?1:0,'End the voice conversation.');
  add('realtimeClosing',realtimeClosing,'Wait for the voice session to finish closing.');
  return result;
}

/** The desktop Apply action may close only the terminal sessions explicitly
 * named by its confirmation. Recheck the gate after every asynchronous step. */
export class UpdateInstallAction {
  constructor({guard,terminalIds,confirm,close}) { Object.assign(this,{guard,terminalIds,confirm,close});this.pending=null; }
  run(conversationId=null) {
    if(this.pending)return this.pending;
    this.pending=this.perform(conversationId).finally(()=>{this.pending=null;});
    return this.pending;
  }
  async perform(conversationId) {
    const canClose=()=>this.guard.status().blockers.every(item=>item.kind==='terminals');
    if(!canClose())throw this.guard.blockedError();
    const ids=this.terminalIds();
    if(ids.length){
      if(!await this.confirm(ids.length))return {cancelled:true};
      if(!canClose())throw this.guard.blockedError();
      if(this.terminalIds().some(id=>!ids.includes(id)))throw this.guard.blockedError();
      await this.guard.run(conversationId,{allow:['terminals'],beforeLaunch:()=>this.close(ids)});
    }else{
      await this.guard.run(conversationId);
    }
    return {restarting:true};
  }
}

export const VOICE_START_METHODS=new Set([
  'voice.listen','voice.speak','voice.realtime.prepare','voice.realtime.start',
  'voice.realtime.preview.prepare','voice.realtime.preview.start','voice.realtime.preview.sample',
]);
