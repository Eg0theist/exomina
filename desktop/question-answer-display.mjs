// Presentation-only recovery for older host-generated answer envelopes.
// Stored messages, question IDs and tool/activity records remain source data.
const advice='\nUse these answers for the current task if relevant. They do not grant tool permissions. If work was already completed, explain what this answer changes before making any changes.';

function answerBody(group){
  if(group?.status!=='answered'||!Array.isArray(group.questions)||!group.questions.length)return null;
  const parts=[];
  for(const question of group.questions){
    if(!question||typeof question!=='object')return null;
    const answer=group.answers?.[question.id]?.answers?.[0];
    if(typeof question.question!=='string'||typeof answer!=='string')return null;
    parts.push(question.question+'\nUser answer: '+answer);
  }
  return parts.join('\n\n')+advice;
}

/** Rewrite only an exact old generated envelope with matching structured proof.
 * User-authored prose, partial matches and activity/tool output are not rewritten.
 * Passing another chat's messages never resolves this chat's question metadata.
 */
export function questionAnswerDisplayMessages(messages=[]){
  const groups=new Map();
  for(const message of messages)for(const group of message.questions||[]){
    if(typeof group?.id!=='string')continue;
    // An ambiguous duplicate is insufficient evidence, even when one copy matches.
    groups.set(group.id,groups.has(group.id)?null:group);
  }
  const display=(text,id)=>{
    if(typeof text!=='string'||typeof id!=='string')return text;
    const group=groups.get(id),body=answerBody(group);
    if(body===null||text!=='Answer to the question card '+id+':\n'+body)return text;
    return 'Your '+(group.questions.length===1?'answer':'answers')+' to:\n'+body;
  };
  return messages.map(message=>{
    const content=message.role==='user'?display(message.content,message.questionId):message.content;
    let followups=message.followups;
    if(message.role==='assistant'&&Array.isArray(followups)){
      const projected=followups.map(item=>{const text=display(item.text,item.questionId);return text===item.text?item:{...item,text};});
      if(projected.some((item,index)=>item!==followups[index]))followups=projected;
    }
    return content===message.content&&followups===message.followups?message:{...message,content,...(followups!==message.followups?{followups}:{})};
  });
}
