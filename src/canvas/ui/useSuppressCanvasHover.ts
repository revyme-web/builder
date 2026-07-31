// useSuppressCanvasHover.ts — keep canvas hover hit-testing out of floating
// menus (context menu, Add Breakpoint popup, any future popover).
//
// Why this exists: these menus render through portals, and React portal events
// bubble through the REACT tree, not the DOM — so a pointer moving OVER the
// menu still reaches the canvas container's onMouseMove and hit-tests the
// elements BEHIND the menu (live find 2026-06-10: hover outlines tracking
// under the context menu and the Add Breakpoint dropdown). Two-part fix:
//   1. useSuppressCanvasHover(open) — clears the lingering hover highlight the
//      moment the menu opens (the pre-open hover would otherwise stay painted).
//   2. stopHoverProbe — spread onto the menu's backdrop AND panel so mousemove
//      never reaches the canvas hover hit-test while the pointer is over them.

import { useEffect } from 'react';
import { useSetAtom } from 'jotai';
import { hoveredIdAtom, hoveredNodeIdAtom, hoveredViewportIdAtom } from '@/code/stores/store';
import { trace } from '@/shared/debug-trace';

/** Clear the canvas hover highlight whenever `open` flips true. */
export function useSuppressCanvasHover(open: boolean): void {
  const setHoveredId = useSetAtom(hoveredIdAtom);
  const setHoveredNodeId = useSetAtom(hoveredNodeIdAtom);
  const setHoveredViewport = useSetAtom(hoveredViewportIdAtom);
  useEffect(() => {
    if (!open) return;
    trace.action('canvas:menu-suppress-hover', {});
    setHoveredId(null);
    setHoveredNodeId(null);
    // The atom is typed string but the whole hover pipeline clears it with
    // null at runtime (Canvas.tsx wires setHoveredViewport with the same cast).
    setHoveredViewport(null as unknown as string);
  }, [open, setHoveredId, setHoveredNodeId, setHoveredViewport]);
}

/** Spread onto a floating menu's backdrop + panel: pointer moves over the menu
 *  stop here instead of bubbling into the canvas hover hit-test. */
export const stopHoverProbe = {
  onMouseMove: (e: { stopPropagation(): void }) => e.stopPropagation(),
} as const;
