// useComponentDrag — pointerdown handler for library item rows
// (components, code components, icon sets, linked CDN
// components). Threshold-based drag activation (LIBRARY_DRAG_THRESHOLD_PX)
// distinguishes click → open editor from drag → drop into canvas.
// Folder-target tracking writes to folderTreeIndicatorAtom so
// FolderTree rows highlight in real time without prop drilling.

import React, { useCallback } from 'react';
import { useSetAtom, getDefaultStore } from 'jotai';
import { projectFS, projectVersionAtom } from '@/code/project/project-fs';
import {
  getComponentRootSize,
  getCodeComponentInsertSize,
  CODE_COMPONENT_FALLBACK_SIZE,
} from '@/code/components/component-registry';
import { hasComponentControls } from '@/code/components/controls-parser';
import { getCachedCdnMetadata } from '@/cloud/components/cdn-metadata-hook';
import { startToolbarDrag } from '@/canvas/drag/toolbar-drag-bridge';
import { type ToolbarItem } from '@/canvas/drag/toolbar-item-config';
import {
  resolveFolderTreeDrop,
  commitFolderTreeDrop,
  folderTreeIndicatorAtom,
} from '@/design-system/FolderTree';
import {
  listComponentFolders,
  getComponentRootOrder,
  moveFileToFolder,
  moveComponentItem,
  getFolderForFile,
  isComponentFolderId,
} from '@/code/project/component-folder-ops';
import {
  listVectorFolders,
  getVectorRootOrder,
  moveVectorToFolder,
  moveVectorItem,
  isVectorFolderId,
  getFolderForVector,
} from '@/code/project/vector-folder-ops';
import { trace } from '@/shared/debug-trace';
import { LIBRARY_DRAG_THRESHOLD_PX } from './constants';

/** Insert size for a dragged CDN component: `@defaultWidth`/`@defaultHeight`
 *  from the (prefetched) metadata cache, else the shared 200×200 fallback.
 *  Code components are fixed-size on the canvas — never sizeless. */
function cdnInsertSize(url: string): { width: string; height: string } {
  const meta = getCachedCdnMetadata(url);
  const size = {
    width: meta?.defaultWidth != null ? `${meta.defaultWidth}px` : `${CODE_COMPONENT_FALLBACK_SIZE.width}px`,
    height: meta?.defaultHeight != null ? `${meta.defaultHeight}px` : `${CODE_COMPONENT_FALLBACK_SIZE.height}px`,
  };
  trace.fn('useComponentDrag:cdn-insert-size', { url: url.slice(0, 80), cached: !!meta, ...size });
  return size;
}

/** Insert size for a dragged LOCAL component. Design components keep the
 *  master root's authored dims (may be partial — unset axes resolve at
 *  render). Code components (@controls) always get a concrete px size via
 *  `getCodeComponentInsertSize` (annotations → root px → 200×200). */
function localInsertSize(code: string): { width?: string; height?: string } {
  return hasComponentControls(code) ? getCodeComponentInsertSize(code) : getComponentRootSize(code);
}

/** Shared drag logic for component rows. Mirrors the Insert panel's
 *  GridCard handler (`insert/index.tsx:138-144`): kicks off
 *  `startToolbarDrag` synchronously from pointerdown. The previous
 *  threshold-based pattern (wait for cursor movement past
 *  MIN_DRAG_DISTANCE before activating) introduced a race — the
 *  iframe's DnD-mode forwarding takes one React commit to activate
 *  via `setCanvasInteracting`, and if the user moved the cursor into
 *  the iframe before that commit landed, the parent window stopped
 *  receiving pointermove events and the strategy's `onMove` (which
 *  drives the drop-line / parent-highlight) never fired. Insert panel
 *  drags don't hit this because they start on plain pointerdown, so
 *  by the time the cursor moves the listeners + DnD mode are both
 *  long-since live.
 *
 *  Click vs. drag still works: a click without movement triggers
 *  ToolbarDragStrategy.onEnd's `!isOverCanvas` cancel branch, the
 *  ghost is hidden, no drop is committed, and the SidebarRow's
 *  `onClick={onEdit}` still fires (the click event is dispatched
 *  after pointerup regardless of pointerdown's preventDefault).
 */
export function useComponentDrag(filePath: string, elementType: string) {
  // Wired here (not at the call site) so the same drag handler can
  // commit a folder-move atom bump if the user drops on a folder row,
  // without the row component needing to know anything about it.
  const bumpVersion = useSetAtom(projectVersionAtom);
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    // Only left-click starts a drag. Right-click (button=2) and middle-click
    // (button=1) must fall through so the row's onContextMenu fires natively
    // and SidebarRow can open its right-click menu at the cursor.
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const startEvent = e.nativeEvent;
    // Icon-set files render different content based on the `name` prop:
    // without `name` the component returns its MASTER VIEW (the full grid
    // of every icon in the set) which is correct for the master canvas
    // but wrong for a page-level instance. Force `name="icon-1"` on drop
    // so the dropped instance renders as a single icon. Also use a
    // square default size since icons are typically square (240px is
    // ICON_CARD_W from the template — keeps "drop from library" visually
    // matching the master cards).
    const isIconSet = filePath.startsWith('icons/');
    // CDN-linked components: filePath IS the URL, elementType is the
    // slug (component name). The drag carries the URL through to the
    // strategy via `cdnUrl` so onEnd can ensure the URL `import` line
    // exists on the active page before the JSX instance lands.
    const isCdnLink = filePath.startsWith('http://') || filePath.startsWith('https://');
    const item: ToolbarItem = isIconSet ? {
      id: `iconSet:${elementType}`,
      elementType,
      defaultStyles: {
        position: 'relative',
        width: '240px',
        height: '240px',
        flex: '0 0 auto',
      },
      defaultAttrs: { name: 'icon-1' },
      ghostSize: { width: 200, height: 200 },
    } : isCdnLink ? {
      id: `cdn:${elementType}`,
      elementType,
      cdnUrl: filePath,
      // CODE COMPONENTS ARE FIXED-SIZE ON THE CANVAS — a sizeless
      // instance collapses whenever the bundle's root draws via
      // absolute/100% children (tiny selection overlay, un-editable
      // "auto" in Size). Seed the creator's `@defaultWidth`/
      // `@defaultHeight` from the metadata cache (the library scanner
      // prefetches it for creator grouping, so it's warm by drag
      // time), else the shared 200×200 fallback. `position: relative`
      // + `flex: 0 0 auto` keep the instance from collapsing inside
      // flex/grid parents. The bundle's root spreads `{...style}`
      // last, so any size the user sets later still wins.
      defaultStyles: {
        position: 'relative',
        flex: '0 0 auto',
        ...cdnInsertSize(filePath),
      },
      // CDN vector URLs need a `name` attr on the dropped
      // instance so the master grid view doesn't render in place of
      // a single variant — vectors default to `icon-1`,
      // mirroring the local-master drop defaults. Component
      // CDN URLs (`/components/...`) carry no name prop.
      defaultAttrs: filePath.includes('/vectors/') ? { name: 'icon-1' }
        : undefined,
      ghostSize: { width: 200, height: 120 },
    } : {
      // Component instance defaults need position properties so the
      // dropped tag renders predictably regardless of where it lands:
      //   - On a flex/grid parent: `position: relative` + `flex: 0 0 auto`
      //     keeps the instance from being squashed by the parent's free-
      //     space distribution, matching how `Frame` toolbar drops
      //     behave once inserted into a layout container.
      //   - On the canvas (no parent): ToolbarDragStrategy.onEnd
      //     OVERWRITES position with `absolute` + computed left/top
      //     (ToolbarDragStrategy.ts:260-262), so seeding 'relative'
      //     here is harmless in that path.
      id: `component:${elementType}`,
      elementType,
      // DESIGN components inherit the master ROOT's authored width/height (the
      // PRIMARY variant's dimensions — e.g. FAQItem → 760px / auto) so the
      // dropped instance matches the master instead of a forced 300×200 box.
      // `getComponentRootSize` returns only plain-string dims; a variant-size
      // ternary stays unset and resolves to the primary width at render.
      // CODE components (@controls) are fixed-size: `getCodeComponentInsertSize`
      // resolves `@defaultWidth`/`@defaultHeight` → root px dims → 200×200,
      // guaranteeing a concrete size (auto would collapse the wrapper). Local
      // VECTORS keep an explicit placeholder (an SVG with no box collapses).
      defaultStyles: filePath.startsWith('components/') ? {
        position: 'relative',
        ...localInsertSize(projectFS.readFile(filePath) ?? ''),
        flex: '0 0 auto',
      } : {
        position: 'relative',
        width: '300px',
        height: '200px',
        flex: '0 0 auto',
      },
      ghostSize: { width: 200, height: 120 },
    };
    // Library-internal folder drop target tracking. Runs PARALLEL to
    // the canvas-drag threshold below — every pointermove also probes
    // for a `[data-folder-drop="<id>"]` ancestor under the cursor in
    // the library panel and writes the matching id (or null) into the
    // atom. UserFolder subscribes and renders an outline highlight.
    // On pointerup, if the cursor is over a folder we call
    // `moveFileToFolder` and ABORT the canvas drag — same gesture,
    // different commit path.
    //
    // Components (`components/...`) route folder moves through
    // component-folder-ops; vectors (`icons/...`) through
    // vector-folder-ops. CDN URLs aren't movable into local folders.
    const isComponentItem = filePath.startsWith('components/');
    const isVectorItem = filePath.startsWith('icons/');
    const folderRoutable = isComponentItem || isVectorItem;
    // Per-kind FolderTree namespace keeps section drag traffic
    // isolated: dragging a vector hit-tests ONLY rows tagged with
    // `data-vector-folder-tree-row`, so passing the cursor over the
    // Components section's body never produces a target.
    const folderTreeNs = isVectorItem ? 'vector-folder-tree'
      : 'component-folder-tree';
    // Section-root attribute is the fallback for dropping in empty
    // body space (no row under cursor) — same per-kind namespace as
    // the FolderTree above, but the ROOT sentinel is its own attr.
    const sectionRootAttr = isVectorItem ? 'data-vector-folder-drop'
      : 'data-component-folder-drop';
    const sectionRootValue = isVectorItem ? 'vector-root'
      : 'component-root';
    // Threshold-based start: only kick off the drag pipeline once the
    // cursor has moved more than LIBRARY_DRAG_THRESHOLD_PX from the
    // initial pointerdown position. A bare click (no movement) lets
    // the row's `onClick` fire normally so the user just opens the
    // component instead of flashing a drag ghost.
    let dragStarted = false;
    /** Suppress the `click` that fires after a drag's pointerup —
     *  without this, the row's `onClick` (navigates to the master
     *  page) runs at the end of every drag. Capture-phase listener
     *  intercepts the click before it reaches the row. Cleared
     *  on the next tick in case `click` never fires (e.g. user
     *  released over a non-clickable region). */
    const suppressNextClick = () => {
      const handler = (e: MouseEvent) => {
        e.stopPropagation();
        e.preventDefault();
      };
      document.addEventListener('click', handler, { capture: true, once: true });
      // Belt-and-braces: if no click fires within a tick, drop the
      // listener so a real click much later isn't swallowed.
      setTimeout(() => {
        document.removeEventListener('click', handler, true);
      }, 0);
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      // Clear the FolderTree drop indicator on every cleanup — drag
      // ended (with or without a commit), so the visual feedback
      // shouldn't linger.
      getDefaultStore().set(folderTreeIndicatorAtom, null);
    };
    const onMove = (moveEvent: PointerEvent) => {
      // Threshold-cross arms the canvas drag exactly once. After
      // that, the listener stays attached to keep updating the
      // FolderTree indicator while the user navigates — same
      // gesture drives both the canvas ghost AND the folder reorder
      // indicator until pointerup decides which one commits.
      if (!dragStarted) {
        const dx = moveEvent.clientX - startX;
        const dy = moveEvent.clientY - startY;
        if (dx * dx + dy * dy < LIBRARY_DRAG_THRESHOLD_PX * LIBRARY_DRAG_THRESHOLD_PX) return;
        dragStarted = true;
        trace.action('library-panel:drag-start', { elementType, isIconSet });
        startToolbarDrag(item, startEvent);
      }
      if (!folderRoutable) return;
      // Hit-test against the FolderTree's per-kind namespaced row
      // attributes. Returns `{ rowId, position, depth }` or null.
      // FolderTree subscribes to this atom and renders the matching
      // row's blue-line / inside-outline indicator live.
      const rowIndicator = resolveFolderTreeDrop(
        moveEvent.clientX, moveEvent.clientY, filePath, folderTreeNs,
      );
      if (rowIndicator) {
        getDefaultStore().set(folderTreeIndicatorAtom, rowIndicator);
      } else {
        // No row hit — but the cursor might still be over the
        // section-root wrapper (Project header / empty body). Set a
        // synthetic indicator with the sentinel as rowId so the
        // Project header (which subscribes to this atom) can render
        // its own purple-outline highlight, mirroring the visual
        // feedback every other row gets.
        //
        // Critical guard: ALSO require the cursor to be in genuinely
        // empty space (no FolderTree row underneath). Without this,
        // the cursor sitting on the DRAGGED row itself — which
        // `resolveFolderTreeDrop` filters out, returning null —
        // would still trigger the synthetic indicator (the
        // section-root wrapper is an ancestor of the row). Result:
        // Project header lit up + ungroup committed even though the
        // user didn't move. Bug repro: click a child inside a
        // folder, mouse up without moving, item jumps to root.
        const el = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY) as HTMLElement | null;
        const overAnyRow = el?.closest(`[data-${folderTreeNs}-row]`);
        if (overAnyRow) {
          getDefaultStore().set(folderTreeIndicatorAtom, null);
        } else {
          const rootEl = el?.closest(`[${sectionRootAttr}="${sectionRootValue}"]`);
          if (rootEl) {
            getDefaultStore().set(folderTreeIndicatorAtom, {
              rowId: sectionRootValue,
              position: 'after',
              depth: 0,
            });
          } else {
            getDefaultStore().set(folderTreeIndicatorAtom, null);
          }
        }
      }
    };
    const onUp = (upEvent: PointerEvent) => {
      // Only commit a folder move when the user actually crossed
      // the drag threshold. Bare click → no commit, the row's
      // onClick handler fires normally to navigate to the master.
      if (!folderRoutable || !dragStarted) {
        cleanup();
        return;
      }
      // Drag happened — block the synthetic `click` that the
      // browser fires after pointerup. Without this the row's
      // onClick handler runs at the end of every drag and navigates
      // to the master page (or starts a rename). LayersPanel doesn't
      // hit this because it uses mousedown directly and the click
      // semantics differ; pointer events DO produce a click after
      // pointerup if the cursor is still over the originating
      // element (or even if it isn't, on some browsers).
      suppressNextClick();
      const indicator = getDefaultStore().get(folderTreeIndicatorAtom);
      // Compute the section's effective root order (drift-augmented)
      // so moveItem can bake the user's visible order into the JSON
      // before splicing — required when the dragged row was a
      // drift-fallback item (one not yet referenced in the
      // persisted JSON). Mirrors the panel's own
      // `effectiveRootOrder` derivation so commit indices match
      // what `commitFolderTreeDrop` computed against the visible
      // order.
      const buildEffectiveOrder = (
        kind: 'component' | 'vector',
      ): string[] => {
        const persisted = kind === 'vector' ? getVectorRootOrder()
          : getComponentRootOrder();
        const folders = kind === 'vector' ? listVectorFolders()
          : listComponentFolders();
        const folderById = new Map(folders.map(f => [f.id, f]));
        const prefix = kind === 'vector' ? 'icons/'
          : 'components/';
        const allItems = projectFS.listFiles().filter(p => p.startsWith(prefix) && p.endsWith('.tsx'));
        const allItemsSet = new Set(allItems);
        const out = persisted.filter(id => folderById.has(id) || allItemsSet.has(id));
        const referenced = new Set<string>([...out]);
        for (const f of folders) for (const c of f.children) referenced.add(c);
        for (const item of allItems) if (!referenced.has(item)) out.push(item);
        for (const folder of folders) {
          if (!referenced.has(folder.id) && folder.parentId === null) out.push(folder.id);
        }
        return out;
      };
      if (indicator) {
        // Section-root sentinel: synthetic indicator written when
        // the cursor is over the Project header (no FolderTree row
        // underneath). `commitFolderTreeDrop` can't resolve it
        // because it's not a real row id — handle it here as
        // "ungroup, append to root tail" using the kind's
        // moveItem(parentId=null, insertIndex=rootOrder.length).
        if (indicator.rowId === sectionRootValue) {
          if (isVectorItem) {
            const effectiveOrder = buildEffectiveOrder('vector');
            const insertIndex = effectiveOrder.length;
            trace.action('library-panel:drop-section-root', { filePath, insertIndex, kind: 'vector' });
            moveVectorItem(filePath, null, insertIndex, effectiveOrder);
            bumpVersion(v => v + 1);
          } else {
            const effectiveOrder = buildEffectiveOrder('component');
            const insertIndex = effectiveOrder.length;
            trace.action('library-panel:drop-section-root', { filePath, insertIndex, kind: 'component' });
            moveComponentItem(filePath, null, insertIndex, effectiveOrder);
            bumpVersion(v => v + 1);
          }
        } else if (isVectorItem) {
          // Resolve the indicator into (parentId, insertIndex) and
          // commit through the kind-specific folder ops. This is
          // the before/after/inside path — proper reorder semantics.
          const folders = listVectorFolders();
          const folderById = new Map(folders.map(f => [f.id, f]));
          const effectiveOrder = buildEffectiveOrder('vector');
          const resolved = commitFolderTreeDrop(
            indicator, effectiveOrder, folderById, isVectorFolderId,
          );
          if (resolved) {
            trace.action('library-panel:drop-folder-tree', { filePath, ...resolved, kind: 'vector' });
            moveVectorItem(filePath, resolved.parentId, resolved.insertIndex, effectiveOrder);
            bumpVersion(v => v + 1);
          }
        } else {
          const folders = listComponentFolders();
          const folderById = new Map(folders.map(f => [f.id, f]));
          const effectiveOrder = buildEffectiveOrder('component');
          const resolved = commitFolderTreeDrop(
            indicator, effectiveOrder, folderById, isComponentFolderId,
          );
          if (resolved) {
            trace.action('library-panel:drop-folder-tree', { filePath, ...resolved, kind: 'component' });
            moveComponentItem(filePath, resolved.parentId, resolved.insertIndex, effectiveOrder);
            bumpVersion(v => v + 1);
          }
        }
      } else {
        // Indicator is null AND no row was matched. The fallback is
        // "drop on empty body = ungroup", but ONLY when the cursor is
        // genuinely in empty space — NOT when it's still over the
        // dragged row itself (the filter inside `resolveFolderTreeDrop`
        // skips the dragged row, which leaves indicator=null even
        // though the cursor is technically on a row). Without this
        // gate, a bare click on a folder child (mousedown + mouseup,
        // crosses the 5px threshold accidentally) would route to
        // ungroup. Bug repro: click a component inside a folder, it
        // jumps to root.
        const el = document.elementFromPoint(upEvent.clientX, upEvent.clientY) as HTMLElement | null;
        const overAnyRow = el?.closest(`[data-${folderTreeNs}-row]`);
        if (!overAnyRow) {
          const rootEl = el?.closest(`[${sectionRootAttr}="${sectionRootValue}"]`);
          if (rootEl) {
            if (isVectorItem) {
              const currentFolder = getFolderForVector(filePath);
              if (currentFolder) {
                trace.action('library-panel:drop-section-root', { filePath, kind: 'vector' });
                moveVectorToFolder(filePath, null);
                bumpVersion(v => v + 1);
              }
            } else {
              const currentFolder = getFolderForFile(filePath);
              if (currentFolder) {
                trace.action('library-panel:drop-section-root', { filePath, kind: 'component' });
                moveFileToFolder(filePath, null);
                bumpVersion(v => v + 1);
              }
            }
          }
        }
      }
      cleanup();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }, [filePath, elementType, bumpVersion]);

  return handlePointerDown;
}
