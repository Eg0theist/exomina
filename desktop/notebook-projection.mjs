// Never present summaries from an older source revision as the current notebook.
// Keep the saved plan intact for incremental refresh and undo. This is a read projection.
export function currentNotebookPlan(plan, notes) {
  if (!plan) return null;
  const byId = new Map(notes.map(note => [note.id, note]));
  if (plan.sources.some(source => !byId.has(source.id))) return null;
  const changed = new Set(plan.sources.filter(source => byId.get(source.id).revision !== source.revision).map(source => source.id));
  for(const note of notes)if(!plan.sources.some(source=>source.id===note.id))changed.add(note.id);
  if (!changed.size) return plan;
  const groups = plan.groups.flatMap(group => {
    const items = group.items.filter(item => !changed.has(item.noteId));
    return items.length ? [{...group, items, ...(items.length !== group.items.length ? {summary: 'Unchanged source notes. Changed notes are listed separately below.'} : {})}] : [];
  });
  groups.push({title: 'Changed notes', summary: 'These notes changed after the overview was written. Open their current text while the overview refreshes.', items: [...changed].sort().map(id => {
    const note = byId.get(id), offset = Math.max(0, note.text.search(/\S/));
    return {id: 'changed-' + id, noteId: id, noteTitle: note.title, title: note.title, summary: 'Read the current note. Its earlier summary is hidden until refreshed.', quote: note.text.slice(offset, offset + 200), offset, refreshRequired: true};
  })});
  return {...plan, overview: 'Some notes have changed. Earlier summaries of those notes are hidden; the current sources remain available below.', groups, projected: true};
}
