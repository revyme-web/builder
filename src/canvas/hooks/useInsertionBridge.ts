// useInsertionBridge.ts — React wrapper around setInsertionRefs.
// Publishes Canvas.tsx setSelectedIds to the insertion bridge on mount; clears on unmount.

import { useEffect } from 'react';
import { setInsertionRefs, type InsertionRefs } from '../insertion-bridge';
import { trace } from '@/shared/debug-trace';

export function useInsertionBridge(refs: InsertionRefs): void {
  useEffect(() => {
    trace.fn('useInsertionBridge:register', {});
    setInsertionRefs(refs);
    return () => {
      trace.fn('useInsertionBridge:clear', {});
      setInsertionRefs(null);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Stable refs/setters — effect runs once per mount
}
