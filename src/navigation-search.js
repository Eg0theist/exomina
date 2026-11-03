const normalize=value=>String(value||'').normalize('NFKD').replace(/\p{M}/gu,'').toLocaleLowerCase().trim();

export function findDestinations(items,query) {
  const terms=normalize(query).split(/\s+/).filter(Boolean);
  return items.map((item,index)=>{
    const label=normalize(item.label),haystack=normalize([item.label,item.description,item.category,item.keywords].join(' '));
    const score=terms.reduce((total,term)=>total+(label===term?30:label.startsWith(term)?15:label.includes(term)?8:1),0);
    return {item,index,score,match:terms.every(term=>haystack.includes(term))};
  }).filter(result=>result.match).sort((a,b)=>b.score-a.score||a.index-b.index).map(result=>result.item);
}
