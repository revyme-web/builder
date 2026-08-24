// TextCreator.ts — Text element creation tool.
// Same imperative pattern as FrameCreator but creates a text <p> element.
// Two modes: click-to-create (auto-width, expanding) and draw-to-create (fixed size).
// After creation, automatically enters TipTap text edit mode.
//
// Flow: pointerdown → draw preview → pointerup → create node → enter edit mode

import { transformManager } from '@/canvas/transform';
import { screenToCanvas, absoluteToRelativeById } from '@/canvas/canvas-math';
import { createNode, vpIdFromPrefix, getActiveFilePath } from '@/canvas/node-ops';
import { isComponentFilePath } from '@/code/project/active-file-store';
import { el, attachDragListeners } from '@/shared/dom-utils';
import { flushNow, setForceRender } from '@/code/mutation/mutation-queue';
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
} from './creator-utils';
import { generateNodeId } from '@/shared/id-utils';
import { styleHelperOps } from '@/canvas/selection/style-helper-store';
import { SELECTION_COLOR } from '@/shared/constants';
import { trace } from '@/shared/debug-trace';
import type { CanvasNode } from '@/code/parsing/parser';

const MIN_DRAW_SIZE = 5;
// Match FrameCreator's preview colors (SELECTION_COLOR blue) so all draw-to-
// create tools read as the same gesture. The previous purple was a holdover
// from when text creation was a distinct visual flow.
const PREVIEW_BORDER = SELECTION_COLOR;
const PREVIEW_FILL = 'rgba(59, 130, 246, 0.1)';
// Zero-width space so the element has height before user types
const ZERO_WIDTH_SPACE = '\u200B';

export interface TextCreatorCallbacks {
  getContainerRect: () => DOMRect;
  getContentEl: () => HTMLElement;
  getNodes: () => Map<string, CanvasNode>;
  onCreated: (nodeId: string, vpId: string) => void;
  onToolReset: () => void;
  getViewportWidth: (vpId: string) => number;
  onNodeMouseDown?: (nodeId: string, e: MouseEvent) => void;
  /** Called after text node is created to enter TipTap edit mode */
  onStartTextEdit?: (nodeId: string, el: HTMLElement) => void;
}

let previewEl: HTMLElement | null = null;
let cleanupFn: (() => void) | null = null;
let autoPanCleanup: (() => void) | null = null;

/**
 * Default style map for a new text element. Single source of truth for
 * the typography defaults the click-create flow uses; also called from
 * Canvas.tsx when an empty-frame double-click scaffolds a text child
 * inside a centered flex frame.
 *
 * Modes:
 *   - 'click'      → typography defaults + width:max-content / height:auto
 *                    (plus whiteSpace:nowrap when on canvas, set by caller)
 *   - 'draw'       → typography defaults only — caller sets width/height
 *                    from the drawn rect
 *   - 'frame-fill' → typography defaults + position:relative + flex:0 0 auto
 *                    so the text sits inside a centered flex parent
 *                    without stretching it
 *
 * The internal click/draw branches at lines 154-180 below predate this
 * helper and still inline the same values; ideally they'd be migrated to
 * call this. For now both produce the same output.
 */
export function getDefaultTextNodeStyles(
  mode: 'click' | 'draw' | 'frame-fill' = 'click',
): Record<string, string> {
  const base: Record<string, string> = {
    fontSize: '16px',
    color: '#000000',
    fontFamily: 'Inter, sans-serif',
    fontWeight: '400',
    lineHeight: '1.2',
    overflowWrap: 'break-word',
  };
  if (mode === 'click') {
    base.width = 'max-content';
    base.height = 'auto';
  } else if (mode === 'frame-fill') {
    base.position = 'relative';
    base.flex = '0 0 auto';
  }
  return base;
}

/**
 * Start text element creation on pointerdown.
 * Call from Canvas.tsx when toolMode === 'text'.
 */
export function startTextCreation(
  e: PointerEvent,
  callbacks: TextCreatorCallbacks,
): void {
  const containerRect = callbacks.getContainerRect();
  const contentEl = callbacks.getContentEl();
  const nodes = callbacks.getNodes();
  const transform = transformManager.getTransform();

  // Detect parent under cursor using bridge-based hit testing
  const parent = findParentAtPoint(e.clientX, e.clientY, nodes);
  const vpId = parent ? vpIdFromPrefix(parent.vpPrefix) : 'desktop';
  const isReplica = parent ? parent.vpPrefix !== '' : false;
  const isCanvasNode = !parent;

  const startCanvas = screenToCanvas(e.clientX, e.clientY, transform, containerRect);

  // Local-coord drawing setup (standard — draws in the parent's
  // own coordinate system so the preview tilts with rotated parents
  // and the committed width/height/left/top are in parent-local
  // space). Falls back to canvas-space for canvas-level draws.
  const parentMap = parent ? buildParentScreenMap(parent.nodeId, vpId) : null;
  const parentMapInv = parentMap ? invertAffine(parentMap) : null;
  const useLocalSpace = !!(parentMap && parentMapInv);
  const startLocal = parentMapInv
    ? parentMapInv.invertScreen(e.clientX, e.clientY)
    : { x: 0, y: 0 };

  trace.action('text-creator:start', {
    vpId, isReplica,
    parentId: parent?.nodeId ?? 'root',
    startX: Math.round(startCanvas.x), startY: Math.round(startCanvas.y),
  });

  // Preview in screen space. `transform-origin: 0 0` is required so
  // the CSS matrix translation lines up correctly when local-space
  // drawing is active.
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

  let drawnWidth = 0;
  let drawnHeight = 0;

  // Re-projects the preview rect from current cursor + live transform.
  // Called by both real mousemove and the auto-pan tick (cursor stationary
  // at edge while canvas slides beneath).
  const redraw = (clientX: number, clientY: number) => {
    const t = transformManager.getTransform();

    if (useLocalSpace && parentMap && parentMapInv) {
      // Local-space path — preview sits in parent-local coords;
      // CSS matrix carries the parent's full screen transform so the
      // preview rotates with it. Rebuild the map every frame in case
      // the parent's transform changes mid-draw.
      const liveMap = buildParentScreenMap(parent!.nodeId, vpId) ?? parentMap;
      const liveInv = invertAffine(liveMap) ?? parentMapInv;
      const currentLocal = liveInv.invertScreen(clientX, clientY);

      const left = Math.min(startLocal.x, currentLocal.x);
      const top = Math.min(startLocal.y, currentLocal.y);
      drawnWidth = Math.abs(currentLocal.x - startLocal.x);
      drawnHeight = Math.abs(currentLocal.y - startLocal.y);

      if (previewEl) {
        const composed = composeMapWithLocalOffset(liveMap, left, top);
        composed.ox -= containerRect.left;
        composed.oy -= containerRect.top;
        previewEl.style.left = '0px';
        previewEl.style.top = '0px';
        previewEl.style.width = `${drawnWidth}px`;
        previewEl.style.height = `${drawnHeight}px`;
        previewEl.style.transform = affineToCSSMatrix(composed);
      }

      styleHelperOps.show({
        type: 'dimensions',
        position: { x: clientX, y: clientY },
        dimensions: { width: Math.round(drawnWidth), height: Math.round(drawnHeight), unit: 'px' },
      });
      return;
    }

    // Canvas-space fallback (no parent — drawing on the canvas itself).
    const currentCanvas = screenToCanvas(clientX, clientY, t, containerRect);

    const left = Math.min(startCanvas.x, currentCanvas.x);
    const top = Math.min(startCanvas.y, currentCanvas.y);
    drawnWidth = Math.abs(currentCanvas.x - startCanvas.x);
    drawnHeight = Math.abs(currentCanvas.y - startCanvas.y);

    if (previewEl) {
      previewEl.style.left = `${left * t.scale + t.x}px`;
      previewEl.style.top = `${top * t.scale + t.y}px`;
      previewEl.style.width = `${drawnWidth * t.scale}px`;
      previewEl.style.height = `${drawnHeight * t.scale}px`;
    }

    styleHelperOps.show({
      type: 'dimensions',
      position: { x: clientX, y: clientY },
      dimensions: { width: Math.round(drawnWidth), height: Math.round(drawnHeight), unit: 'px' },
    });
  };

  const autoPan = attachCreatorAutoPan('text-creator', redraw);
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
      // Keep the preview as a VISIBLE box-outline placeholder (transparent fill, the
      // 1px border stays) so the user sees WHERE the text lands instantly — no blank
      // gap — until the real sandbox editor mounts (~0.2s; it's render-bound, it
      // attaches to the rendered <p> by data-node-id). We deliberately do NOT seed:
      // seeding resolves the selection overlay (resize handles), which is never
      // wanted when the node goes straight into text-edit mode. Dropped on
      // render-complete (when the editor's own outline takes over) + safety timeout.
      const placeholder = previewEl; previewEl = null;
      if (placeholder) {
        placeholder.style.backgroundColor = 'transparent';
        placeholder.style.zIndex = '1';
        let phRemoved = false;
        const removePlaceholder = () => {
          if (phRemoved) return;
          phRemoved = true;
          placeholder.remove();
          window.removeEventListener('revyme:render-complete', removePlaceholder);
        };
        window.addEventListener('revyme:render-complete', removePlaceholder);
        setTimeout(removePlaceholder, 1500);
      }
      cleanupFn = null;
      styleHelperOps.hide();

      const t = transformManager.getTransform();
      const endCanvas = screenToCanvas(upEvent.clientX, upEvent.clientY, t, containerRect);

      // Compute the rect in PARENT-LOCAL space when available — the
      // committed width/height/left/top then match the preview the
      // user actually saw on screen, even when the parent is rotated.
      let left: number, top: number, width: number, height: number;
      if (useLocalSpace && parentMapInv) {
        const endLocal = parentMapInv.invertScreen(upEvent.clientX, upEvent.clientY);
        left = Math.min(startLocal.x, endLocal.x);
        top = Math.min(startLocal.y, endLocal.y);
        width = Math.abs(endLocal.x - startLocal.x);
        height = Math.abs(endLocal.y - startLocal.y);
      } else {
        left = Math.min(startCanvas.x, endCanvas.x);
        top = Math.min(startCanvas.y, endCanvas.y);
        width = Math.abs(endCanvas.x - startCanvas.x);
        height = Math.abs(endCanvas.y - startCanvas.y);
      }

      const minSize = MIN_DRAW_SIZE / t.scale;
      const isClick = width < minSize && height < minSize;

      const nodeId = generateNodeId();

      // ─── Base text styles ─────────────────────────────────
      const styles: Record<string, string> = {
        fontSize: '16px',
        color: '#000000',
        fontFamily: 'Inter, sans-serif',
        fontWeight: '400',
        lineHeight: '1.2',
        overflowWrap: 'break-word',
      };

      if (isClick) {
        styles.width = 'max-content';
        styles.height = 'auto';
        if (isCanvasNode) {
          styles.whiteSpace = 'nowrap';
        }
        trace.action('text-creator:click-mode', { nodeId, isCanvasNode });
      } else {
        styles.width = `${Math.round(width)}px`;
        styles.height = `${Math.round(height)}px`;
        // Drawn text gets a flex column container layout so the AdjustControl
        // (vertical alignment) actually works. CSS `vertical-align` does
        // nothing on a block <p>; flex + justify-content is the only way to
        // top/center/bottom-anchor the text inside an explicit-height box.
        // `text-align` (Align control) still owns horizontal alignment via
        // the cross axis — `align-items: stretch` is fine since the implicit
        // anonymous flex item containing the text already spans the cross.
        styles.display = 'flex';
        styles.flexDirection = 'column';
        trace.action('text-creator:draw-mode', { nodeId, width: Math.round(width), height: Math.round(height) });
      }

      // ─── Positioning ──────────────────────────────────────
      if (isCanvasNode) {
        styles.position = 'absolute';
        styles.left = `${Math.round(left)}px`;
        styles.top = `${Math.round(top)}px`;

        const nodeEl = createNode({
          id: nodeId, type: 'p', name: 'Text', styles,
          textContent: ZERO_WIDTH_SPACE,
          parentEl: contentEl, parentId: 'root',
          isCanvasNode: true, contentEl,
          onMouseDown: callbacks.onNodeMouseDown,
        });

        // setForceRender bypasses the canvas-update skip flag so the iframe
        // sandbox actually re-renders the new <p>. Without it, auto-pan
        // timing shifts the render order enough that the new node lands in
        // code but doesn't paint until the next user action.
        setForceRender();
        flushNow();
        callbacks.onCreated(nodeId, vpId);
        callbacks.onToolReset();

        if (callbacks.onStartTextEdit) {
          setTimeout(() => callbacks.onStartTextEdit!(nodeId, nodeEl), 50);
        }
      } else {
        const parentId = parent!.nodeId;
        let insertIndex: number | undefined;

        const mode = getInsertionMode(parentId, vpId);
        if (mode === 'absolute') {
          // The left/top below are relative to THIS parent, so the parent has
          // to be the containing block that resolves them.
          ensureAbsChildContainingBlock(parentId, vpId, contentEl);
          styles.position = 'absolute';
          // `useLocalSpace` already produced parent-local left/top.
          // The AABB-based subtraction below only handles plain
          // translate — would mis-position the node when the parent
          // is rotated.
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
          const centerX = left + width / 2;
          const centerY = top + height / 2;
          insertIndex = getFlexInsertIndex(parentId, vpId, centerX, centerY, t, mode as any);
        }

        // Skip inline display:'none' on component master files — the
        // AnimatePresence conditional render handles per-variant
        // visibility there. Keep for page replicas (paired with
        // `@container display:'unset'` for the active vp).
        if (isReplica && !isComponentFilePath(getActiveFilePath())) {
          styles.display = 'none';
        }

        const nodeEl = createNode({
          id: nodeId, type: 'p', name: 'Text', styles,
          textContent: ZERO_WIDTH_SPACE,
          parentEl: contentEl, parentId, index: insertIndex,
          onMouseDown: callbacks.onNodeMouseDown,
        });

        // Renumber flex `order` so an explicitly-ordered parent places the new
        // node at the DRAWN flow position (no-op when no sibling has `order`).
        if (mode !== 'absolute' && insertIndex !== undefined) {
          queueCreatorFlexOrder(parentId, vpId, insertIndex, nodeId, mode as 'flex-row' | 'flex-column' | 'grid', contentEl);
        }

        if (isReplica) {
          queueReplicaCreationUnhide(nodeId, vpId, callbacks.getViewportWidth(vpId));
        }

        // See comment on the canvas-node branch above — same skip-flag
        // bypass needed for the viewport-parented variant.
        setForceRender();
        flushNow();
        callbacks.onCreated(nodeId, vpId);
        callbacks.onToolReset();

        if (callbacks.onStartTextEdit) {
          setTimeout(() => callbacks.onStartTextEdit!(nodeId, nodeEl), 50);
        }
      }
    },
  });
}
