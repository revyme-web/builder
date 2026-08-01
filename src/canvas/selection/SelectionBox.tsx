// SelectionBox.tsx — Rubber-band (marquee) selection on empty canvas drag.
// Listens for pointerdown on the canvas container (not on nodes).
// Shows a blue semi-transparent rectangle and selects nodes that intersect.

import { useEffect, useRef, useState, useCallback } from 'react';
import { trace } from '@/shared/debug-trace';
import { getCanvasBridge } from '@/canvas/canvas-bridge';
import { parseRectCacheKey, vpIdFromPrefix } from '@/canvas/node-ops';
import { isGhostNodeId } from '@/shared/ghost-id';
import { getActiveAutoPan } from '@/canvas/transform';
import { isViewerMode } from '@/code/stores/viewer-mode-store';
import { getNodesSnapshot } from '@/code/stores/store';

/**
 * Suppress the next SelectionBox activation.
 * Called by iframe hit test path when a node is found — prevents SelectionBox
 * from activating on the same pointerdown event (since in iframe mode,
 * e.target is always the container, not the node element).
 */
let _suppressNextSelectionBox = false;
export function suppressSelectionBox(): void { _suppressNextSelectionBox = true; }

interface SelectionBoxProps {
  containerEl: HTMLElement | null;  // The canvas container (screen-space)
  contentEl: HTMLElement | null;    // The content div with nodes
  /** `vpId` = the viewport the marquee mostly covered (dominant-hit rule) —
   *  the mount point sets it as the interacting viewport so replicas swept
   *  by the marquee behave exactly like replica CLICKS. `viewportsByNode`
   *  feeds the overlay's per-artboard outlines (marqueeViewportSpreadAtom). */
  onSelectionChange: (ids: string[], vpId: string, viewportsByNode: Record<string, string[]>) => void;
  isActive: boolean;  // Only active when tool mode is 'select'
}

export interface BoxRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** AABB overlap test between two screen-space rects. */
export function rectsOverlap(a: BoxRect, b: DOMRect): boolean {
  return (
    a.x < b.right &&
    a.x + a.width > b.left &&
    a.y < b.bottom &&
    a.y + a.height > b.top
  );
}

export interface MarqueeSelection {
  /** Deduped node ids under the marquee — a node swept in BOTH the primary
   *  viewport and a replica appears ONCE (the selection model stores plain
   *  ids; WHICH viewport lives in `interactingViewportIdAtom`). */
  ids: string[];
  /** The viewport the marquee mostly covered — the caller sets it as the
   *  interacting viewport so the selection overlay/tools land on the same
   *  replica the user swept, mirroring what a replica CLICK does. */
  vpId: string;
  /** EVERY viewport each node was swept in — feeds the selection overlay's
   *  per-artboard outlines (`marqueeViewportSpreadAtom`), so one big sweep
   *  shows selection on desktop + tablet + mobile at once, standard. */
  viewportsByNode: Record<string, string[]>;
}

/** Sorted-ids signature — pairs a viewport-spread map with the exact
 *  selection that produced it (see `marqueeViewportSpreadAtom`). */
export function marqueeSelectionSig(ids: string[]): string {
  return [...ids].sort().join('|');
}

/**
 * All node IDs that intersect the selection rect, across the PRIMARY
 * viewport AND every replica (tablet / mobile) — replicas are first-class
 * marquee targets, same as they're first-class click targets. Reads from
 * the bridge rectCache.
 */
export function getMarqueeSelection(_contentEl: HTMLElement, selectionRect: BoxRect): MarqueeSelection {
  const bridge = getCanvasBridge();
  if (!('rectCache' in bridge)) return { ids: [], vpId: vpIdFromPrefix(''), viewportsByNode: {} };

  const matched = new Set<string>();
  const hitsPerPrefix = new Map<string, number>();
  const viewportsByNode: Record<string, string[]> = {};
  const cache = (bridge as any).rectCache as Map<string, DOMRect>;
  for (const [key] of cache) {
    const { vpPrefix, nodeId } = parseRectCacheKey(key) ?? { vpPrefix: '', nodeId: key };
    if (!nodeId || nodeId === 'root') continue;

    // Skip ghost elements by ID pattern (__N suffix)
    if (isGhostNodeId(nodeId)) continue;

    // Skip TEMPLATE chrome on templated pages. The template merge prefixes
    // every template node (header / footer / nav + their whole subtrees)
    // with `layout::` and inserts the `children-slot` placeholder — they're
    // locked chrome owned by the template file, not page content. A marquee
    // sweeping the top of the page must not scoop the template header into
    // the selection (same exclusion deleteNode applies). Applies to every
    // viewport — replica template chrome is just as locked.
    if (nodeId.startsWith('layout::') || nodeId === 'children-slot') continue;

    const nodeRect = bridge.getRect(nodeId, vpPrefix);
    if (!nodeRect) continue;

    if (rectsOverlap(selectionRect, nodeRect)) {
      matched.add(nodeId);
      hitsPerPrefix.set(vpPrefix, (hitsPerPrefix.get(vpPrefix) ?? 0) + 1);
      const nodeVpId = vpIdFromPrefix(vpPrefix);
      const list = (viewportsByNode[nodeId] ??= []);
      if (!list.includes(nodeVpId)) list.push(nodeVpId);
    }
  }

  // Dominant viewport = the prefix with the most hits; the PRIMARY ('')
  // wins ties so a sweep spanning desktop + a replica stays anchored on
  // the primary (matching where edits are least surprising).
  let dominantPrefix = '';
  let dominantCount = hitsPerPrefix.get('') ?? 0;
  for (const [prefix, count] of hitsPerPrefix) {
    if (count > dominantCount) { dominantPrefix = prefix; dominantCount = count; }
  }

  // DESCENDANT FILTER — a child's rect always overlaps whenever its matched
  // ancestor's does, so the raw sweep returned parent AND descendants
  // together (a sketch wrapper + its inner <path>, a frame + its children).
  // That poisoned every all-of-one-kind gate: marquee-selecting sketches
  // included their path children, `type === 'svg'` failed, and Group
  // vanished from the menu / Cmd+G bailed — while shift-click (wrappers
  // only) worked (user report 2026-07-29). Keep only the TOPMOST matched
  // node of each chain — the same "parent covers subtree" rule Cmd+A's
  // selectAllPageNodeIds applies.
  const ids = dropMatchedDescendants(matched, getNodesSnapshot());
  for (const id of Object.keys(viewportsByNode)) {
    if (!ids.includes(id)) delete viewportsByNode[id];
  }

  return { ids, vpId: vpIdFromPrefix(dominantPrefix), viewportsByNode };
}

/** Drop every matched id that has another matched id in its ancestor chain.
 *  Pure — unit tested. Unknown ids (not in the map) are kept — dropping a
 *  node we can't place would silently shrink the selection. */
export function dropMatchedDescendants(
  matched: ReadonlySet<string>,
  nodes: ReadonlyMap<string, { parentId?: string | null }>,
): string[] {
  const out: string[] = [];
  for (const id of matched) {
    let parent = nodes.get(id)?.parentId ?? null;
    let isDescendant = false;
    let hops = 0;
    while (parent && hops++ < 200) {
      if (matched.has(parent)) { isDescendant = true; break; }
      parent = nodes.get(parent)?.parentId ?? null;
    }
    if (!isDescendant) out.push(id);
  }
  return out;
}

/** Back-compat id-only view of `getMarqueeSelection`. */
export function getIntersectingNodeIds(contentEl: HTMLElement, selectionRect: BoxRect): string[] {
  return getMarqueeSelection(contentEl, selectionRect).ids;
}


export default function SelectionBox({ containerEl, contentEl, onSelectionChange, isActive }: SelectionBoxProps) {
  const [box, setBox] = useState<BoxRect | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const isDraggingRef = useRef(false);
  const onSelectionChangeRef = useRef(onSelectionChange);
  onSelectionChangeRef.current = onSelectionChange;
  const contentElRef = useRef(contentEl);
  contentElRef.current = contentEl;
  // Auto-pan integration — registered on pointerdown, torn down on pointerup
  // / cancellation. The tick callback re-runs the intersect with the latest
  // cursor + freshly-panned rectCache so nodes scrolling into view via
  // auto-pan are picked up by the marquee without a real mousemove.
  const autoPanCleanupRef = useRef<(() => void) | null>(null);
  const lastMoveRef = useRef<{ x: number; y: number } | null>(null);

  const handlePointerDown = useCallback((e: PointerEvent) => {
    if (!isActive) return;
    // View-only: no marquee selection. SelectionBox registers its own
    // pointerdown listener on the canvas container (independent of
    // CanvasMouseController), so it needs its own viewer gate.
    if (isViewerMode()) return;
    // Only activate on left mouse button
    if (e.button !== 0) return;
    // STRICT: Only activate when clicking DIRECTLY on the canvas container or a viewport root.
    const target = e.target as HTMLElement;
    if (!containerEl) return;
    const isCanvasContainer = target === containerEl;
    const isContentRoot = target === contentElRef.current;
    // Viewport root without data-id = empty viewport background (pages)
    // Viewport root WITH data-id = variant root (components) — should drag, not selection box
    const isViewportRoot = target.hasAttribute('data-viewport') && !target.hasAttribute('data-id');
    trace.action('selection-box:pointerdown-check', {
      tagName: target.tagName,
      dataId: target.getAttribute('data-id'),
      dataViewport: target.getAttribute('data-viewport'),
      isCanvasContainer, isContentRoot, isViewportRoot,
      passed: isCanvasContainer || isContentRoot || isViewportRoot,
    });
    if (!isCanvasContainer && !isContentRoot && !isViewportRoot) return;
    // Don't activate if modifier keys suggest other actions (except shift for extend)
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    // Reset the suppress flag at the START of every fresh marquee gesture.
    // It's set true by the hit-test (`suppressSelectionBox()`) whenever a
    // mousedown lands on a NODE, and was only ever cleared inside
    // `handlePointerMove`. A plain node CLICK (select, no drag) never fires a
    // pointermove, so the flag stayed stale-true — and the user's NEXT
    // empty-canvas drag had its first pointermove consume that stale flag and
    // cancel the marquee, forcing a throwaway click first. We've passed all
    // the empty-canvas guards here, so the hit-test will re-set the flag for
    // THIS gesture if it actually hits a node; clearing it now scopes the
    // flag to the current pointerdown only.
    _suppressNextSelectionBox = false;

    startRef.current = { x: e.clientX, y: e.clientY };
    isDraggingRef.current = false;
    lastMoveRef.current = null;
    // Don't show box yet — wait for a minimum drag distance

    // Wire auto-pan now (not on first move) so the loop is ready the
    // moment the user crosses the 5px activation threshold. The tick
    // callback re-runs the intersect using the LAST seen cursor — so
    // when the cursor stops moving at an edge, the canvas keeps panning
    // and newly-revealed elements get picked up by the marquee.
    const ctrl = getActiveAutoPan();
    if (ctrl) {
      const redraw = (clientX: number, clientY: number) => {
        if (!startRef.current || !isDraggingRef.current) return;
        const dx = clientX - startRef.current.x;
        const dy = clientY - startRef.current.y;
        const rect: BoxRect = {
          x: Math.min(startRef.current.x, clientX),
          y: Math.min(startRef.current.y, clientY),
          width: Math.abs(dx),
          height: Math.abs(dy),
        };
        setBox(rect);
        const content = contentElRef.current;
        if (content) {
          const sel = getMarqueeSelection(content, rect);
          onSelectionChangeRef.current(sel.ids, sel.vpId, sel.viewportsByNode);
        }
      };
      ctrl.setActive('selection-box', true);
      const unsub = ctrl.onTick(() => {
        const last = lastMoveRef.current;
        if (last) redraw(last.x, last.y);
      });
      autoPanCleanupRef.current = () => {
        unsub();
        ctrl.setActive('selection-box', false);
      };
    }
  }, [containerEl, isActive]);

  const handlePointerMove = useCallback((e: PointerEvent) => {
    if (!startRef.current) return;

    // In iframe mode, the suppress flag is set by the hit test handler (fires between
    // our pointerdown and this pointermove). Cancel if a node was found.
    if (_suppressNextSelectionBox) {
      _suppressNextSelectionBox = false;
      startRef.current = null;
      autoPanCleanupRef.current?.();
      autoPanCleanupRef.current = null;
      return;
    }

    // Stash the latest cursor so the auto-pan tick has something to redraw
    // against when the cursor goes stationary at an edge.
    lastMoveRef.current = { x: e.clientX, y: e.clientY };

    const dx = e.clientX - startRef.current.x;
    const dy = e.clientY - startRef.current.y;

    // Require minimum 5px drag to activate (avoid flash on clicks)
    if (!isDraggingRef.current) {
      if (Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
      isDraggingRef.current = true;
      trace.action('selection-box:start', { x: startRef.current.x, y: startRef.current.y });
    }

    // Calculate screen-space box
    const x = Math.min(startRef.current.x, e.clientX);
    const y = Math.min(startRef.current.y, e.clientY);
    const width = Math.abs(dx);
    const height = Math.abs(dy);
    const rect: BoxRect = { x, y, width, height };
    setBox(rect);

    // Find intersecting nodes — primary AND replica viewports.
    const content = contentElRef.current;
    if (content) {
      const sel = getMarqueeSelection(content, rect);
      trace.action('selection-box:intersect', {
        selectionRect: rect,
        foundIds: sel.ids,
        vpId: sel.vpId,
        viewportRootCount: content.querySelectorAll('[data-viewport]').length,
      });
      onSelectionChangeRef.current(sel.ids, sel.vpId, sel.viewportsByNode);
    }
  }, []);

  const handlePointerUp = useCallback(() => {
    if (isDraggingRef.current) {
      trace.action('selection-box:end', { hadSelection: box !== null });
    }
    startRef.current = null;
    isDraggingRef.current = false;
    lastMoveRef.current = null;
    setBox(null);
    // Always cleanup — covers the "pointerdown without ever crossing the
    // drag threshold" case (no box was shown but auto-pan was registered).
    autoPanCleanupRef.current?.();
    autoPanCleanupRef.current = null;
  }, [box]);

  useEffect(() => {
    if (!containerEl || !isActive) return;

    // Use capture phase so we get the event before anything else
    containerEl.addEventListener('pointerdown', handlePointerDown, { capture: false });
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);

    return () => {
      containerEl.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [containerEl, isActive, handlePointerDown, handlePointerMove, handlePointerUp]);

  if (!box) return null;

  return (
    <div
      data-selection-box
      style={{
        position: 'fixed',
        left: box.x,
        top: box.y,
        width: box.width,
        height: box.height,
        backgroundColor: 'color-mix(in srgb, var(--selection) 10%, transparent)',
        border: '1px solid color-mix(in srgb, var(--selection) 60%, transparent)',
        pointerEvents: 'none',
        zIndex: 5,
      }}
    />
  );
}
