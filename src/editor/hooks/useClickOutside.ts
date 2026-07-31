// useClickOutside.ts — close-on-outside-mousedown for hand-rolled dropdowns.
//
// The canonical editor dropdown pattern: while the menu is open, a document
// `mousedown` listener closes it when the press lands outside the menu's
// container element. Listener is attached only while `active` is true, so an
// idle dropdown costs nothing.

import { useEffect, useRef, type RefObject } from 'react';

/**
 * Call `onOutside` on any document mousedown outside `ref`'s subtree while
 * `active` is true.
 *
 *   const ref = useRef<HTMLDivElement>(null);
 *   useClickOutside(ref, open, () => setOpen(false));
 */
export function useClickOutside(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  onOutside: () => void,
): void {
  // Latest-callback ref so the listener never goes stale without forcing
  // re-subscription on every render.
  const cbRef = useRef(onOutside);
  cbRef.current = onOutside;

  useEffect(() => {
    if (!active) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) cbRef.current();
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [active, ref]);
}
