import { useCallback, useSyncExternalStore } from 'react';
import useComposerSize from './useComposerSize.js';

function useDraft(store, draftKey, presence = false) {
  const subscribe = useCallback(callback => store.subscribe(draftKey, callback), [store, draftKey]);
  const snapshot = useCallback(() => presence ? !!store.get(draftKey).trim() : store.get(draftKey), [store, draftKey, presence]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function DraftPresence({ store, draftKey, children }) {
  return children(useDraft(store, draftKey, true));
}

export default function ComposerDraft({ store, draftKey, composerRef, children }) {
  const draft = useDraft(store, draftKey);
  const size = useComposerSize(composerRef, draft);
  return children(draft, size);
}
