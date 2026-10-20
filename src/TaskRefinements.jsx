import React from 'react';
import './task-refinements.css';
export default function TaskRefinements({records=[]}){
 if(!records.length)return null;
 return <details className="task-refinements"><summary>Working approaches <span>{records.length} comparisons</span></summary><p>Observations and lessons recorded by your AI. Tool receipts support the comparison; review the interpretation before reusing it.</p>{records.slice().reverse().map(record=><article key={record.id}><div><strong>{record.goal}</strong><span>{record.status}</span></div><p><b>Before:</b> {record.baseline}</p><p><b>Try:</b> {record.candidate}</p><p><b>Check:</b> {record.criterion}</p>{record.observation&&<p>{record.observation}</p>}{record.lesson&&<><p><b>Lesson:</b> {record.lesson}</p><small>Applies when: {record.appliesWhen}. Limitation: {record.caveat}. Scope: {record.scope}.</small></>}<details><summary>Evidence receipts</summary>{[...(record.baselineEvidence||[]),...(record.candidateEvidence||[])].map(e=><p key={e.id}><code>{e.tool}</code> · {e.status} · {new Date(e.completedAt).toLocaleString()}</p>)}</details></article>)}</details>;
}
