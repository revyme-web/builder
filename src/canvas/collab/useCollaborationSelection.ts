// useCollaborationSelection.ts — Broadcast the local selection to the
// collab room. Debounced at 50ms so rapid click-through doesn't spam
// the wire. Compares against the last-sent value so identical
// selections don't re-broadcast (common when an action queues a fresh
// atom set but the IDs didn't change).

import { useEffect, useRef } from 'react';
import { useAtomValue } from 'jotai';
import { selectedIdsAtom } from '@/code/stores/store';
import { activeFilePathAtom } from '@/code/project/active-file-store';
import { useCollaboration } from './CollaborationProvider';

const DEBOUNCE_MS = 50;

export function useCollaborationSelection() {
  const { isConnected, sendSelection } = useCollaboration();
  const selectedIds = useAtomValue(selectedIdsAtom);
  const activePage = useAtomValue(activeFilePathAtom);
  const lastSentRef = useRef<string>('');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!isConnected) return;
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      const signature = `${activePage ?? ''}::${selectedIds.join(',')}`;
      if (signature === lastSentRef.current) return;
      lastSentRef.current = signature;
      sendSelection(selectedIds, activePage ?? undefined);
    }, DEBOUNCE_MS);
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [isConnected, selectedIds, activePage, sendSelection]);
}
