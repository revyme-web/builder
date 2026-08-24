// LayoutCreator.ts — Drawing state machine for layout container creation.
// Models flex-row, flex-column, and grid containers with placeholder children.
// Imperative (no React). Pointer events. Mirrors FrameCreator structure but
// parameterized by LayoutMode so a single drag draws a populated container.
//
// Flow: pointerdown → draw preview → pointerup → validate → queue addNode/
// addCanvasNode mutation (with children) → flushNow → render in iframe.

import { transformManager } from '@/canvas/transform';
import { screenToCanvas, absoluteToRelativeById } from '@/canvas/canvas-math';
import { vpIdFromPrefix, getActiveFilePath } from '@/canvas/node-ops';
import { isComponentFilePath } from '@/code/project/active-file-store';
import { queueMutation, flushNow, setForceRender } from '@/code/mutation/mutation-queue';
import { el, attachDragListeners } from '@/shared/dom-utils';
import {
  findParentAtPoint,
  getInsertionMode,
  ensureAbsChildContainingBlock,
  getFlexInsertIndex,
  queueCreatorFlexOrder,
  queueReplicaCreationUnhide,
  attachCreatorAutoPan,
  buildParentScreenMap,
  invertAffine,
  affineToCSSMatrix,
  composeMapWithLocalOffset,
  holdCreationPlaceholder,
} from './creator-utils';
import { generateNodeId } from '@/shared/id-utils';
import { SELECTION_COLOR } from '@/shared/constants';
import { styleHelperOps } from '@/canvas/selection/style-helper-store';
import { injectNodeIntoCache } from '@/code/stores/store';
import { trace } from '@/shared/debug-trace';
import type { CanvasNode } from '@/code/parsing/parser';

const MIN_DRAW_SIZE = 5;
const PREVIEW_BORDER = SELECTION_COLOR;
const PREVIEW_FILL = 'rgba(59, 130, 246, 0.1)';
const PLACEHOLDER_BG = '#ffffff';

export type LayoutMode = 'layout-rows' | 'layout-columns' | 'layout-grids';

export interface LayoutCreatorCallbacks {
  getContainerRect: () => DOMRect;
  getContentEl: () => HTMLElement;
  getNodes: () => Map<string, CanvasNode>;
  onCreated: (nodeId: string, vpId: string) => void;
  onToolReset: () => void;
  getViewportWidth: (vpId: string) => number;
  onNodeMouseDown?: (nodeId: string, e: MouseEvent) => void;
}

let previewEl: HTMLElement | null = null;
let cleanupFn: (() => void) | null = null;
let autoPanCleanup: (() => void) | null = null;

interface ChildDef {
  id: string;
  type: 'div';
  name: string;
  styles: Record<string, string>;
}

/** Build the parent container's default styles + placeholder children for a layout mode. */
function buildLayoutTemplate(mode: LayoutMode): { name: string; styles: Record<string, string>; children: ChildDef[] } {
  switch (mode) {
    case 'layout-rows':
      return {
        name: 'Rows',
        styles: {
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
        },
        children: Array.from({ length: 3 }, () => ({
          id: generateNodeId('row'),
          type: 'div' as const,
          name: 'Row',
          styles: { flex: '1 0 0px', minHeight: '0', backgroundColor: PLACEHOLDER_BG, borderRadius: '4px' },
        })),
      };
    case 'layout-columns':
      return {
        name: 'Columns',
        styles: {
          display: 'flex',
          flexDirection: 'row',
          gap: '8px',
        },
        children: Array.from({ length: 3 }, () => ({
          id: generateNodeId('col'),
          type: 'div' as const,
          name: 'Column',
          styles: { flex: '1 0 0px', minWidth: '0', backgroundColor: PLACEHOLDER_BG, borderRadius: '4px' },
        })),
      };
    case 'layout-grids':
      return {
        name: 'Grid',
        styles: {
          display: 'grid',
          gridTemplateColumns: 'repeat(2, 1fr)',
          gridTemplateRows: 'repeat(2, 1fr)',
          gap: '8px',
        },
        children: Array.from({ length: 4 }, () => ({
          id: generateNodeId('cell'),
          type: 'div' as const,
          name: 'Cell',
          // flex on grid items is harmless (ignored by grid layout) — kept for
          // consistency so all layout-creator children share the same shape.
          styles: { flex: '1 0 0px', backgroundColor: PLACEHOLDER_BG, borderRadius: '4px' },
        })),
      };
  }
}

/**
 * Start layout creation on pointerdown.
 * Call from Canvas.tsx when isLayoutMode(toolMode) is true.
 */
export function startLayoutCreation(
  e: PointerEvent,
  layoutMode: LayoutMode,
  callbacks: LayoutCreatorCallbacks,
): void {
  const containerRect = callbacks.getContainerRect();
  const contentEl = callbacks.getContentEl();
  const nodes = callbacks.getNodes();
  const transform = transformManager.getTransform();

  const parent = findParentAtPoint(e.clientX, e.clientY, nodes);
  const vpId = parent ? vpIdFromPrefix(parent.vpPrefix) : 'desktop';
  const isReplica = parent ? parent.vpPrefix !== '' : false;
  const isCanvasNode = !parent;

  const startCanvas = screenToCanvas(e.clientX, e.clientY, transform, containerRect);

  // Local-coord drawing setup (standard — preview tilts with
  // rotated parents; committed left/top/width/height live in parent-
  // local space). See FrameCreator for the full rationale.
  const parentMap = parent ? buildParentScreenMap(parent.nodeId, vpId) : null;
  const parentMapInv = parentMap ? invertAffine(parentMap) : null;
  const useLocalSpace = !!(parentMap && parentMapInv);
  const startLocal = parentMapInv
    ? parentMapInv.invertScreen(e.clientX, e.clientY)
    : { x: 0, y: 0 };

  trace.action('layout-creator:start', {
    layoutMode, vpId, isReplica,
    parentId: parent?.nodeId ?? 'root',
    startX: Math.round(startCanvas.x), startY: Math.round(startCanvas.y),
  });

  const containerEl = contentEl.parentElement!;
  previewEl = el('div', {
    attrs: { 'data-drawing-preview': '' },
    styles: {
      position: 'absolute',
      border: `1px solid ${PREVIEW_BORDER}`,
      backgroundColor: PREVIEW_FILL,
      pointerEvents: 'none',
      zIndex: '1000',
      transformOrigin: '0 0',
    },
  });
  containerEl.appendChild(previewEl!);

  let shiftHeld = false;
  const onKeyDown = (ke: KeyboardEvent) => { if (ke.key === 'Shift') shiftHeld = true; };
  const onKeyUp = (ke: KeyboardEvent) => { if (ke.key === 'Shift') shiftHeld = false; };
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  // Pure redraw — invoked from real mousemove and from auto-pan ticks.
  const redraw = (clientX: number, clientY: number) => {
    const t = transformManager.getTransform();

    if (useLocalSpace && parentMap && parentMapInv) {
      const liveMap = buildParentScreenMap(parent!.nodeId, vpId) ?? parentMap;
      const liveInv = invertAffine(liveMap) ?? parentMapInv;
      const currentLocal = liveInv.invertScreen(clientX, clientY);

      let left = Math.min(startLocal.x, currentLocal.x);
      let top = Math.min(startLocal.y, currentLocal.y);
      let width = Math.abs(currentLocal.x - startLocal.x);
      let height = Math.abs(currentLocal.y - startLocal.y);

      if (shiftHeld) {
        const size = Math.max(width, height);
        width = size; height = size;
        if (currentLocal.x < startLocal.x) left = startLocal.x - size;
        if (currentLocal.y < startLocal.y) top = startLocal.y - size;
      }

      if (previewEl) {
        const composed = composeMapWithLocalOffset(liveMap, left, top);
        composed.ox -= containerRect.left;
        composed.oy -= containerRect.top;
        previewEl.style.left = '0px';
        previewEl.style.top = '0px';
        previewEl.style.width = `${width}px`;
        previewEl.style.height = `${height}px`;
        previewEl.style.transform = affineToCSSMatrix(composed);
      }

      styleHelperOps.show({
        type: 'dimensions',
        position: { x: clientX, y: clientY },
        dimensions: { width: Math.round(width), height: Math.round(height), unit: 'px' },
      });
      return;
    }

    // Canvas-space fallback.
    const currentCanvas = screenToCanvas(clientX, clientY, t, containerRect);

    let left = Math.min(startCanvas.x, currentCanvas.x);
    let top = Math.min(startCanvas.y, currentCanvas.y);
    let width = Math.abs(currentCanvas.x - startCanvas.x);
    let height = Math.abs(currentCanvas.y - startCanvas.y);

    if (shiftHeld) {
      const size = Math.max(width, height);
      width = size; height = size;
      if (currentCanvas.x < startCanvas.x) left = startCanvas.x - size;
      if (currentCanvas.y < startCanvas.y) top = startCanvas.y - size;
    }

    if (previewEl) {
      previewEl.style.left = `${left * t.scale + t.x}px`;
      previewEl.style.top = `${top * t.scale + t.y}px`;
      previewEl.style.width = `${width * t.scale}px`;
      previewEl.style.height = `${height * t.scale}px`;
    }

    styleHelperOps.show({
      type: 'dimensions',
      position: { x: clientX, y: clientY },
      dimensions: { width: Math.round(width), height: Math.round(height), unit: 'px' },
    });
  };

  const autoPan = attachCreatorAutoPan('layout-creator', redraw);
  autoPanCleanup = autoPan.cleanup;

  cleanupFn = attachDragListeners({
    startX: e.clientX,
    startY: e.clientY,
    threshold: 0,

    onMove: (_dx, _dy, moveEvent) => {
      autoPan.trackMouse(moveEvent.clientX, moveEvent.clientY);
      redraw(moveEvent.clientX, moveEvent.clientY);
    },

    onUp: (upEvent) => {
      autoPan.cleanup();
      autoPanCleanup = null;
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      // Keep the preview as a commit-gap placeholder (see holdCreationPlaceholder).
      const placeholder = previewEl; previewEl = null;
      cleanupFn = null;
      styleHelperOps.hide();

      const t = transformManager.getTransform();
      const endCanvas = screenToCanvas(upEvent.clientX, upEvent.clientY, t, containerRect);

      // Commit in parent-local space when the parent had a usable
      // transform map at start. See FrameCreator for rationale.
      let left: number, top: number, width: number, height: number;
      if (useLocalSpace && parentMapInv) {
        const endLocal = parentMapInv.invertScreen(upEvent.clientX, upEvent.clientY);
        left = Math.min(startLocal.x, endLocal.x);
        top = Math.min(startLocal.y, endLocal.y);
        width = Math.abs(endLocal.x - startLocal.x);
        height = Math.abs(endLocal.y - startLocal.y);
        if (shiftHeld) {
          const size = Math.max(width, height);
          width = size; height = size;
          if (endLocal.x < startLocal.x) left = startLocal.x - size;
          if (endLocal.y < startLocal.y) top = startLocal.y - size;
        }
      } else {
        left = Math.min(startCanvas.x, endCanvas.x);
        top = Math.min(startCanvas.y, endCanvas.y);
        width = Math.abs(endCanvas.x - startCanvas.x);
        height = Math.abs(endCanvas.y - startCanvas.y);

        if (shiftHeld) {
          const size = Math.max(width, height);
          width = size; height = size;
          if (endCanvas.x < startCanvas.x) left = startCanvas.x - size;
          if (endCanvas.y < startCanvas.y) top = startCanvas.y - size;
        }
      }

      const minSize = MIN_DRAW_SIZE / t.scale;
      if (width < minSize || height < minSize) {
        trace.action('layout-creator:too-small', { width, height, layoutMode });
        placeholder?.remove();
        callbacks.onToolReset();
        return;
      }

      const template = buildLayoutTemplate(layoutMode);
      const nodeId = generateNodeId('layout');
      const roundedW = Math.round(width);
      const roundedH = Math.round(height);

      const styles: Record<string, string> = {
        position: 'absolute',
        width: `${roundedW}px`,
        height: `${roundedH}px`,
        left: `${Math.round(left)}px`,
        top: `${Math.round(top)}px`,
        ...template.styles,
      };

      // Cache injection: parent only — children come from re-parse after the
      // mutation flushes. Properties panel sees the parent immediately.
      const parentCacheNode: CanvasNode = {
        id: nodeId, type: 'div', name: template.name,
        parentId: isCanvasNode ? null : (parent?.nodeId ?? null),
        children: [], styles, attrs: {}, textContent: '',
        hasMixedContent: false, order: 0,
        isCanvasNode, isComponentRoot: false,
        componentFile: null, componentInstanceId: null,
        motionVariants: null, motionVariantsRef: null, motionProps: null,
        responsiveVariantMap: null, conditionalStyles: null,
      };

      if (isCanvasNode) {
        trace.action('layout-creator:commit-canvas', { nodeId, layoutMode, width: roundedW, height: roundedH });

        injectNodeIntoCache(parentCacheNode);

        queueMutation({
          type: 'addCanvasNode',
          node: {
            id: nodeId,
            type: 'div',
            styles,
            name: template.name,
            children: template.children,
          },
        });
      } else {
        const parentId = parent!.nodeId;
        let insertIndex: number | undefined;

        const insertMode = getInsertionMode(parentId, vpId);
        if (insertMode === 'absolute') {
          // The left/top below are relative to THIS parent, so the parent has
          // to be the containing block that resolves them.
          ensureAbsChildContainingBlock(parentId, vpId, contentEl);
          // Local-space committed left/top is already parent-relative.
          // Skip AABB subtraction (which assumes axis-aligned parent).
          if (useLocalSpace) {
            styles.left = `${Math.round(left)}px`;
            styles.top = `${Math.round(top)}px`;
            } else {
            const rel = absoluteToRelativeById(left, top, parentId, vpId, t);
            styles.left = `${Math.round(rel.x)}px`;
            styles.top = `${Math.round(rel.y)}px`;
          }
        } else {
          styles.position = 'relative';
          styles.flex = '0 0 auto';
          delete styles.left;
          delete styles.top;
          const centerX = left + width / 2;
          const centerY = top + height / 2;
          insertIndex = getFlexInsertIndex(parentId, vpId, centerX, centerY, t, insertMode as any);
        }

        // Skip inline display:'none' on component masters — AnimatePresence
        // conditional render handles per-variant visibility there.
        if (isReplica && !isComponentFilePath(getActiveFilePath())) {
          styles.display = 'none';
        }

        trace.action('layout-creator:commit-viewport', {
          nodeId, parentId, layoutMode, position: styles.position, isReplica, insertIndex,
        });

        injectNodeIntoCache({ ...parentCacheNode, parentId, styles });

        queueMutation({
          type: 'addNode',
          parentId,
          node: {
            id: nodeId,
            type: 'div',
            styles,
            name: template.name,
            children: template.children,
          },
          index: insertIndex,
        });

        // Renumber flex `order` so an explicitly-ordered parent places the new
        // node at the DRAWN flow position (no-op when no sibling has `order`).
        if (insertMode !== 'absolute' && insertIndex !== undefined) {
          queueCreatorFlexOrder(parentId, vpId, insertIndex, nodeId, insertMode as 'flex-row' | 'flex-column' | 'grid', contentEl);
        }

        if (isReplica) {
          queueReplicaCreationUnhide(nodeId, vpId, callbacks.getViewportWidth(vpId));
        }
      }

      // Force render so the iframe sandbox rebuilds with the new container +
      // its placeholder children (queueMutation alone would let the canvas-
      // update skip flag swallow the next render — same "must force render
      // after flush" rule ShapeCreator follows).
      // Paint the layout's STRUCTURE (grid/rows/cols container + its cells) into the
      // placeholder so it shows INSTANTLY through the rebuild gap — not just an empty
      // box. Fixed px (gap / cell radius) are ×scale to match the on-canvas render;
      // the 1fr / flex children auto-fill. The transparent gaps ARE the grid lines.
      if (placeholder) {
        const scaleStyles = (s: Record<string, string>): Record<string, string> =>
          Object.fromEntries(Object.entries(s).map(([k, v]) =>
            [k, v.replace(/(-?\d*\.?\d+)px/g, (_m, n) => `${parseFloat(n) * t.scale}px`)]));
        placeholder.style.backgroundColor = 'transparent';
        Object.assign(placeholder.style, scaleStyles(template.styles));
        placeholder.innerHTML = '';
        for (const c of template.children) {
          const cell = document.createElement('div');
          Object.assign(cell.style, scaleStyles(c.styles));
          placeholder.appendChild(cell);
        }
      }
      // Hold the placeholder over the rebuild + seed geometry for instant select.
      holdCreationPlaceholder(nodeId, parent?.vpPrefix ?? '', placeholder, styles);
      setForceRender();
      flushNow();

      trace.action('layout-creator:created', { nodeId, layoutMode, childCount: template.children.length });
      callbacks.onCreated(nodeId, vpId);
      callbacks.onToolReset();
    },
  });
}
