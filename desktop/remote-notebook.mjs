/** Paired-owner UI reads. AI note sharing is separate and cannot be changed here.
 * List metadata separately so a large notebook still fits an encrypted relay reply.
 */
export function phoneNotebookView(view) {
  const organization = view.organization || {};
  return {
    version: 1,
    notes: (view.notes || []).map(({id,title,revision,updatedAt}) => ({id,title,revision,updatedAt})),
    organization: {
      applied: organization.appliedUnavailable ? null : organization.applied || null,
      appliedUnavailable: organization.appliedUnavailable === true,
      appliedStale: organization.appliedStale === true,
      autoRefresh: organization.autoRefresh !== false,
      refreshPending: organization.refreshPending === true,
      refreshStatus: organization.refreshStatus || 'idle',
      refreshMessage: organization.refreshMessage || '',
      notice: organization.notice || '',
    },
  };
}

export function phoneNotebookNote(view, id) {
  const note = view.notes.find(item => item.id === id);
  if (!note) throw Error('This note was removed on your computer. Your phone draft is unchanged.');
  const {title,text,revision,updatedAt} = note;
  return {id:note.id,title,text,revision,updatedAt};
}
