/** Native Claude questions are user input, independent of tool permissions.
 * Claude expects answers keyed by the original question text. Its runtime
 * accepts comma-separated strings for multi-select answers.
 */
export async function answerClaudeUserQuestions({input,ask}) {
  if(!input||!Array.isArray(input.questions)||input.questions.length<1||input.questions.length>4)throw Error('Claude supplied an unsupported question group. Use Exomina\'s question tools.');
  const textKeys=new Set(),questions=input.questions.map((question,index)=>{
    if(typeof question.question!=='string'||!question.question.trim()||textKeys.has(question.question))throw Error('Claude questions must have different, nonempty question text.');
    textKeys.add(question.question);
    if(question.multiSelect!==undefined&&typeof question.multiSelect!=='boolean')throw Error('Claude supplied an unsupported question selection mode.');
    if(question.kind&&!['choice','text'].includes(question.kind))throw Error('Use Exomina\'s question tools for this kind of question.');
    return {id:'claude-question-'+(index+1),question:question.question,header:question.header||'',options:(question.options||[]).map(option=>({label:option.label,...(option.description?{description:option.description}:{})})),...(question.multiSelect?{multiSelect:true}:{})};
  });
  const answers=Object.create(null);
  // Claude permits four questions; the shared host admits three per card.
  for(let offset=0;offset<questions.length;offset+=3){
    const batch=questions.slice(offset,offset+3),result=await ask({questions:batch});
    if(result.status!=='answered')return {behavior:'deny',message:'The user has not answered these questions yet. The persistent question cards remain available. Do not infer a choice from timeout, Later, or Continue while I decide.'};
    for(let index=0;index<batch.length;index++){
      const answer=result.answers?.[batch[index].id]?.answers?.[0];
      if(typeof answer!=='string'||!answer.trim())throw Error('The question host did not confirm a user answer.');
      answers[input.questions[offset+index].question]=answer;
    }
  }
  return {behavior:'allow',updatedInput:{...input,answers}};
}
