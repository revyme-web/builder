// useCanvasCommandsBridge.ts — React wrapper around setCanvasCommandsRefs.
// Publishes Canvas.tsx refs to the commands bridge on mount; clears on unmount.

import { useEffect } from 'react';
import { setCanvasCommandsRefs, type CanvasCommandsRefs } from '../canvas-commands-bridge';
import { trace } from '@/shared/debug-trace';

export function useCanvasCommandsBridge(refs: CanvasCommandsRefs): void {
  useEffect(() => {
    trace.fn('useCanvasCommandsBridge:register', {});
    setCanvasCommandsRefs(refs);
    return () => {
      trace.fn('useCanvasCommandsBridge:clear', {});
      setCanvasCommandsRefs(null);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Stable refs/setters — effect runs once per mount
}
