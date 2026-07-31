// FolderTree.tsx — Generic, drag-reorderable folder/item tree.
//
// Drag mechanics ported from `LayersPanel.tsx` — pointer-based
// (mousedown + document-level mousemove/mouseup), 3px threshold,
// `elementsFromPoint` hit-test, before/after/inside drop position
// resolution from row Y, blue-line / inside-outline indicators.
// Same pattern means the same coexistence properties: pointer drag
// can run alongside other pointer drags (e.g. `useComponentDrag`'s
// canvas-drop flow) without HTML5 DnD's "dragstart eats pointermove"
// problem.
//
// Each section provides:
//   • A flat tree shape (rootOrder + folder.children mixed arrays)
//   • A `moveItem(itemId, newParentId, insertIndex)` mutator
//   • `renderItem` / `renderFolder` callbacks for row visuals
//
// Two modes for item drag:
//   • `itemDrag: 'internal'` (default) — FolderTree owns the
//     pointer drag for both items AND folders. Templates use this.
//   • `itemDrag: 'external'` — items are NOT draggable by FolderTree.
//     An external drag system (e.g. `useComponentDrag`) drives them
//     and uses the exported `resolveFolderTreeDrop` helper +
//     `folderTreeIndicatorAtom` to render indicators in the right
//     place. Components / Vectors panels use this so canvas drag
//     stays on the existing pointer flow.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { atom, useAtomValue, useSetAtom } from 'jotai';

export interface FolderTreeFolder {
  id: string;
  name: string;
  /** null = root-level. Otherwise parent folder id. */
  parentId: string | null;
  /** Mixed: child item ids + child folder ids in display order. */
  children: string[];
}

type FolderDropPosition = 'before' | 'after' | 'inside';

interface FolderRowDndState {
  /** True if THIS row is being dragged. */
  isDragged: boolean;
  /** True if THIS row is the current drop target. */
  isDropTarget: boolean;
  /** Resolved drop position when this row is the target, else null. */
  dropPosition: FolderDropPosition | null;
}

export interface FolderTreeDropIndicator {
  rowId: string;
  position: FolderDropPosition;
  depth: number;
}

interface RenderItemArgs {
  itemId: string;
  depth: number;
  dndState: FolderRowDndState;
}

interface RenderFolderArgs {
  folder: FolderTreeFolder;
  depth: number;
  expanded: boolean;
  toggle: () => void;
  dndState: FolderRowDndState;
}

interface Props {
  rootOrder: string[];
  folderById: Map<string, FolderTreeFolder>;
  isFolderId: (id: string) => boolean;
  onMove: (itemId: string, newParentId: string | null, insertIndex: number) => void;
  renderItem: (args: RenderItemArgs) => ReactNode;
  renderFolder: (args: RenderFolderArgs) => ReactNode;
  /** Indent step (px) per nesting level. Defaults to 20 — matches
   *  `SidebarRow`'s chevron column (14 px `w-3.5` + 6 px `gap-1.5`)
   *  so a child item's icon lines up exactly under its parent
   *  folder's icon. Anything smaller (like 16) leaves child icons
   *  shifted a few pixels to the left of the folder column above. */
  indentStep?: number;
  /** 'internal' (default) → FolderTree pointer-drags both items AND
   *  folders. 'external' → only folders are FolderTree-draggable;
   *  items are expected to be driven by an external system that
   *  writes to `folderTreeIndicatorAtom` and calls `commitFolderTreeDrop`. */
  itemDrag?: 'internal' | 'external';
  /** Optional namespace for the data attributes FolderTree puts on
   *  rows. Lets multiple FolderTrees on the same screen target each
   *  other's rows correctly when they have similar item ids. Default:
   *  `'folder-tree'` → `data-folder-tree-row`. */
  domNamespace?: string;
  /** Drop-indicator color (the 2 px line + circle marker for
   *  before/after, and the inside outline). Defaults to
   *  `var(--accent-secondary, #a78bfa)` to match every other
   *  Library DnD affordance. The presets panel overrides this to
   *  `var(--accent)` so its drag visuals match its folder icon. */
  indicatorColor?: string;
}

// Top/bottom 30% bands count as before/after. Middle band counts as
// "inside" for folders, "after" for items (they can't accept children).
// Same ratios `LayersPanel` uses for frames vs leaves.
const DROP_BAND_RATIO = 0.3;
const DRAG_THRESHOLD_PX = 3;

// Module-level atom — shared across FolderTree instances + external
// drag systems (useComponentDrag). One drag at a time globally,
// which matches the user's mental model: you can't pointer-drag
// from two sections simultaneously.
export const folderTreeIndicatorAtom = atom<FolderTreeDropIndicator | null>(null);
export const folderTreeDraggedAtom = atom<string | null>(null);

/** Hit-test the cursor against `data-{ns}-row` ancestors and compute
 *  the drop position. Used internally by FolderTree's own pointer
 *  drag AND externally by `useComponentDrag` so the two systems
 *  produce identical drop logic. */
export function resolveFolderTreeDrop(
  clientX: number,
  clientY: number,
  draggedId: string | null,
  domNamespace = 'folder-tree',
): FolderTreeDropIndicator | null {
  const rowAttr = `data-${domNamespace}-row`;
  const folderAttr = `data-${domNamespace}-folder`;
  const depthAttr = `data-${domNamespace}-depth`;

  const elements = document.elementsFromPoint(clientX, clientY);
  const rowEl = elements.find(el => {
    const rowId = el.getAttribute(rowAttr);
    if (!rowId) return false;
    if (draggedId !== null && rowId === draggedId) return false;
    return true;
  }) as HTMLElement | undefined;
  if (!rowEl) return null;

  const rowId = rowEl.getAttribute(rowAttr)!;
  const isFolder = rowEl.getAttribute(folderAttr) === 'true';
  const depth = parseInt(rowEl.getAttribute(depthAttr) || '0', 10);

  const rect = rowEl.getBoundingClientRect();
  const relativeY = clientY - rect.top;
  const top = rect.height * DROP_BAND_RATIO;
  const bottom = rect.height * (1 - DROP_BAND_RATIO);
  let position: FolderDropPosition;
  if (relativeY < top) position = 'before';
  else if (relativeY > bottom) position = 'after';
  else position = isFolder ? 'inside' : 'after';

  return { rowId, position, depth };
}

/** Resolve a drop indicator into a (parentId, insertIndex) pair the
 *  caller's `onMove` expects. Walks `rootOrder` + every folder's
 *  children to find the target row's parent. Returns null if the
 *  target isn't anywhere in the tree (shouldn't happen for a valid
 *  indicator). */
export function commitFolderTreeDrop(
  indicator: FolderTreeDropIndicator,
  rootOrder: string[],
  folderById: Map<string, FolderTreeFolder>,
  isFolderId: (id: string) => boolean,
): { parentId: string | null; insertIndex: number } | null {
  if (indicator.position === 'inside' && isFolderId(indicator.rowId)) {
    const folder = folderById.get(indicator.rowId);
    if (!folder) return null;
    return { parentId: indicator.rowId, insertIndex: folder.children.length };
  }
  // before / after — find target in its parent's children list.
  const idxAtRoot = rootOrder.indexOf(indicator.rowId);
  if (idxAtRoot >= 0) {
    return { parentId: null, insertIndex: idxAtRoot + (indicator.position === 'after' ? 1 : 0) };
  }
  for (const f of folderById.values()) {
    const idx = f.children.indexOf(indicator.rowId);
    if (idx >= 0) {
      return { parentId: f.id, insertIndex: idx + (indicator.position === 'after' ? 1 : 0) };
    }
  }
  return null;
}

export function FolderTree({
  rootOrder,
  folderById,
  isFolderId,
  onMove,
  renderItem,
  renderFolder,
  indentStep = 20,
  itemDrag = 'internal',
  domNamespace = 'folder-tree',
  indicatorColor = 'var(--accent-secondary, #a78bfa)',
}: Props) {
  const draggedId = useAtomValue(folderTreeDraggedAtom);
  const setDraggedId = useSetAtom(folderTreeDraggedAtom);
  const indicator = useAtomValue(folderTreeIndicatorAtom);
  const setIndicator = useSetAtom(folderTreeIndicatorAtom);

  // Per-folder open state. Default open. Stored locally so re-renders
  // of the parent don't reset it.
  const [openFolders, setOpenFolders] = useState<Map<string, boolean>>(new Map());
  const isOpen = (id: string) => {
    const v = openFolders.get(id);
    return v === undefined ? true : v;
  };
  const toggleOpen = (id: string) => {
    setOpenFolders(prev => {
      const next = new Map(prev);
      next.set(id, !isOpen(id));
      return next;
    });
  };

  // Refs that stay current across the document-level listeners — same
  // pattern LayersPanel uses to read state inside a closure that was
  // captured before the user started moving the mouse.
  const dragStartPos = useRef<{ x: number; y: number } | null>(null);
  const dragThresholdMet = useRef(false);
  const draggedIdRef = useRef<string | null>(null);
  draggedIdRef.current = draggedId;
  const indicatorRef = useRef<FolderTreeDropIndicator | null>(null);
  indicatorRef.current = indicator;

  // Cycle protection — refuse to drop a folder onto itself or a
  // descendant. Returns true if the dragged folder is an ancestor of
  // the target, walking up from the target via folderById.parentId.
  const wouldCreateCycle = (folderDraggedId: string, targetId: string): boolean => {
    let cursor: string | null = targetId;
    while (cursor !== null) {
      if (cursor === folderDraggedId) return true;
      const parent = folderById.get(cursor);
      cursor = parent ? parent.parentId : null;
    }
    return false;
  };

  // The unified pointer-drag handler. Mirrors `LayersPanel`'s
  // `handleLayerDragStart` step-for-step — left-button only, 3px
  // threshold, document-level mousemove/mouseup, `elementsFromPoint`
  // hit-test, refs for closure-captured state, cursor: grabbing,
  // cleanup on mouseup.
  const startDrag = (e: React.MouseEvent, rowId: string) => {
    if (e.button !== 0) return;
    dragStartPos.current = { x: e.clientX, y: e.clientY };
    dragThresholdMet.current = false;

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragStartPos.current) return;
      if (!dragThresholdMet.current) {
        const dx = ev.clientX - dragStartPos.current.x;
        const dy = ev.clientY - dragStartPos.current.y;
        if (Math.abs(dx) < DRAG_THRESHOLD_PX && Math.abs(dy) < DRAG_THRESHOLD_PX) return;
        dragThresholdMet.current = true;
        setDraggedId(rowId);
        draggedIdRef.current = rowId;
        document.body.style.cursor = 'grabbing';
      }
      if (!draggedIdRef.current) return;

      const next = resolveFolderTreeDrop(ev.clientX, ev.clientY, draggedIdRef.current, domNamespace);
      // Cycle check for folder drops onto descendants.
      if (next && isFolderId(draggedIdRef.current) && wouldCreateCycle(draggedIdRef.current, next.rowId)) {
        setIndicator(null);
        return;
      }
      setIndicator(next);
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      dragStartPos.current = null;

      const ind = indicatorRef.current;
      const dragged = draggedIdRef.current;
      draggedIdRef.current = null;
      setDraggedId(null);
      setIndicator(null);

      if (!ind || !dragged) return;
      if (ind.rowId === dragged) return;
      const resolved = commitFolderTreeDrop(ind, rootOrder, folderById, isFolderId);
      if (!resolved) return;
      onMove(dragged, resolved.parentId, resolved.insertIndex);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  };

  // Tear down listeners on unmount in case a drag was interrupted by
  // navigating away — same defensiveness LayersPanel has.
  useEffect(() => {
    return () => {
      document.body.style.cursor = '';
    };
  }, []);

  const renderNode = (id: string, depth: number): ReactNode => {
    const folder = isFolderId(id) ? folderById.get(id) ?? null : null;
    const isFolder = folder !== null;
    const isItemDraggable = isFolder ? true : itemDrag === 'internal';

    const dndState: FolderRowDndState = {
      isDragged: draggedId === id,
      isDropTarget: indicator?.rowId === id,
      dropPosition: indicator?.rowId === id ? indicator.position : null,
    };
    // Folder rows sit at the bare depth indent. LEAF rows (items) get
    // an additional chevron-column's worth of indent so their icon
    // lands directly under the folder-icon column of their sibling
    // folders at the same depth — matches what the FileExplorer and
    // LayersPanel do with their chevron-placeholder spans. Without
    // this extra nudge, a leaf row's icon would land at the same
    // x-position as a folder's chevron (a visual slot to the LEFT of
    // the folder's own icon), which reads as "this leaf is not
    // properly nested under the folder above". 20 px matches the
    // chevron-width + gap inside `SidebarRow`'s `expandable` slot.
    const paddingLeft = depth * indentStep + (isFolder ? 0 : 20);

    const rowDataAttrs: Record<string, string> = {
      [`data-${domNamespace}-row`]: id,
      [`data-${domNamespace}-depth`]: String(depth),
      [`data-${domNamespace}-folder`]: isFolder ? 'true' : 'false',
    };

    const showBeforeIndicator = dndState.isDropTarget && dndState.dropPosition === 'before' && !dndState.isDragged;
    const showAfterIndicator = dndState.isDropTarget && dndState.dropPosition === 'after' && !dndState.isDragged;
    const showInsideHighlight = dndState.isDropTarget && dndState.dropPosition === 'inside' && !dndState.isDragged;

    // Drop-indicator visual ported from `LayersPanel` 1:1 — a 2 px
    // horizontal line PLUS a small open circle at its left end, both
    // absolutely-positioned INSIDE the row so they don't push
    // adjacent rows out of place when they appear. The circle sits
    // half-on, half-off the row edge (`top: -3px` for before,
    // `bottom: -3px` for after) so it visually marks "the gap
    // between rows" without occupying its own row of layout space.
    // Color uses `--accent-secondary` (purple) — same accent every
    // other Library DnD affordance uses.
    //
    // Indent is applied via `marginLeft` (NOT paddingLeft) so the
    // wrapper element sits AT the indent and is sized only to the
    // row's visual bounds. Using paddingLeft instead would make the
    // wrapper extend from the panel's left edge all the way across,
    // and the `outline` would then draw around that fat box —
    // visibly wider than the actual hover background on deeper
    // nested rows. Margin-based indent keeps the outline + hover
    // bg + indicators all the same width.
    const renderBeforeIndicator = () => (
      <>
        <div style={{
          position: 'absolute', top: 0, right: 8, left: 8,
          height: 2, background: indicatorColor, zIndex: 50,
        }} />
        <div style={{
          position: 'absolute', top: -3, left: 8,
          width: 8, height: 8, borderRadius: '50%',
          background: 'var(--bg-base, #fff)',
          border: `2px solid ${indicatorColor}`,
          transform: 'translateX(-50%)', zIndex: 50,
        }} />
      </>
    );
    const renderAfterIndicator = () => (
      <>
        <div style={{
          position: 'absolute', bottom: 0, right: 8, left: 8,
          height: 2, background: indicatorColor, zIndex: 50,
        }} />
        <div style={{
          position: 'absolute', bottom: -3, left: 8,
          width: 8, height: 8, borderRadius: '50%',
          background: 'var(--bg-base, #fff)',
          border: `2px solid ${indicatorColor}`,
          transform: 'translateX(-50%)', zIndex: 50,
        }} />
      </>
    );

    return (
      <div key={id}>
        <div
          {...rowDataAttrs}
          onMouseDown={isItemDraggable ? (e) => startDrag(e, id) : undefined}
          style={{
            // `relative` is what anchors the absolute-positioned
            // before/after indicators to THIS row — without it
            // they'd escape to whichever ancestor is positioned
            // (typically the section), wrecking alignment.
            position: 'relative',
            marginLeft: paddingLeft,
            opacity: dndState.isDragged ? 0.4 : 1,
            outline: showInsideHighlight ? `1px solid ${indicatorColor}` : 'none',
            outlineOffset: -1,
            borderRadius: 6,
          }}
        >
          {isFolder
            ? renderFolder({
                folder: folder!,
                depth,
                expanded: isOpen(id),
                toggle: () => toggleOpen(id),
                dndState,
              })
            : renderItem({ itemId: id, depth, dndState })}
          {showBeforeIndicator && renderBeforeIndicator()}
          {showAfterIndicator && renderAfterIndicator()}
        </div>
        {/* Folder children body — recursive. Hidden when collapsed,
            kept mounted so React state inside doesn't reset on toggle. */}
        {isFolder && folder!.children.length > 0 && (
          <div hidden={!isOpen(id)}>
            {folder!.children.map(childId => renderNode(childId, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return <>{rootOrder.map(id => renderNode(id, 0))}</>;
}
