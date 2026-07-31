// useKeyboardShortcuts.ts — React wrapper around registerShortcuts.
// Registers the keyboard handler on mount, returns cleanup on unmount.
// All deps are stable refs/setters so the effect runs once per mount.

import { useEffect } from 'react';
import { registerShortcuts, type ShortcutRefs } from '../shortcuts';
import { trace } from '@/shared/debug-trace';

export function useKeyboardShortcuts(opts: ShortcutRefs): void {
  useEffect(() => {
    trace.fn('useKeyboardShortcuts:register', {});
    const dispose = registerShortcuts(opts);
    return () => {
      trace.fn('useKeyboardShortcuts:dispose', {});
      dispose?.();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Stable refs/setters — effect runs once per mount
}
