// useDebouncedCallback.ts — THE trailing-edge debounce hook. The same
// `useRef<setTimeout> + clearTimeout + setTimeout` trio was hand-rolled in
// the preset-edit panels (border/asset/color/typography), ShadowControl and
// ComponentPropsTool — mostly to debounce the heavy projectVersion bump so
// slider drags don't fan out a re-render storm per tick. Import this instead.

import { useCallback, useMemo, useRef } from 'react';

export interface DebouncedCallback {
  /** Schedule `fn` after `delayMs` — resets any pending timer (trailing edge). */
  call: () => void;
  /** Cancel any pending timer without invoking `fn`. */
  cancel: () => void;
}

/**
 * Trailing-edge debounce of `fn` by `delayMs`. `fn` is kept fresh via a ref,
 * so the returned handle (and its `call`/`cancel`) are referentially stable
 * across renders. The hook does NOT auto-flush or auto-cancel on unmount —
 * call-sites that need a final flush own it (most preset panels bump the
 * version once more in their own unmount effect).
 */
export function useDebouncedCallback(fn: () => void, delayMs: number): DebouncedCallback {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const call = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      fnRef.current();
    }, delayMs);
  }, [delayMs]);

  const cancel = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  return useMemo(() => ({ call, cancel }), [call, cancel]);
}
