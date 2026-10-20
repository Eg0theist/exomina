/** Records completion of the bundled client's metadata check, not a promise
 * that every upstream model or account entitlement is available. */
export class ModelChoiceCheck{
 constructor({load,apply,now=()=>new Date().toISOString()}){Object.assign(this,{load,apply,now});this.state={status:'idle',checkedAt:null,counts:{},error:null};this.pending=null;}
 view(){return {...this.state,counts:{...this.state.counts}};}
 refresh(){
  if(this.pending)return this.pending;
  this.state={...this.state,status:'checking',error:null};
  this.pending=Promise.resolve().then(()=>this.load()).then(models=>{
   if(!models||typeof models!=='object'||Array.isArray(models))throw Error('The model check returned no catalogue.');
   const checked=Object.fromEntries(Object.entries(models).filter(([,rows])=>Array.isArray(rows)).map(([id,rows])=>[id,rows.filter(row=>row&&typeof row.id==='string')]));
   this.apply(checked);this.state={status:'ready',checkedAt:this.now(),counts:Object.fromEntries(Object.entries(checked).map(([id,rows])=>[id,rows.length])),error:null};return this.view();
  }).catch(()=>{this.state={...this.state,status:'failed',error:'The model check did not finish. Previously reported choices remain available.'};return this.view();}).finally(()=>{this.pending=null;});
  return this.pending;
 }
}
