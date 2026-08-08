// FrameCreator.ts — Drawing state machine for frame creation.
// Imperative (no React). Pointer events (immune to native drag capture).
// Uses canvas-math.ts for coordinates, bridge helpers for parent detection.
//
// Flow: pointerdown → draw preview → pointerup → validate → inject JSX → cleanup

import { transformManager } from '@/canvas/transform';
import { toKebab } from '@/shared/css-utils';
import { screenToCanvas, absoluteToRelativeById, getAbsoluteCanvasRectById } from '@/canvas/canvas-math';
import { stripTranslateTransforms } from '@/shared/position-utils';
import type { Transform } from '@/shared/types';
import { createNode, vpIdFromPrefix, getActiveFilePath, findChildRects } from '@/canvas/node-ops';
import { getCanvasBridge } from '@/canvas/canvas-bridge';
import { isComponentFilePath } from '@/code/project/active-file-store';
import { flushNow, setForceRender, queueMutation } from '@/code/mutation/mutation-queue';
import { el, attachDragListeners } from '@/shared/dom-utils';
import {
  findParentAtPoint,
  getInsertionMode,
  getFlexInsertIndex,
  queueCreatorFlexOrder,
  nextFrameColor,
  queueReplicaCreationUnhide,
  holdFlexSlotPlaceholder,
  attachCreatorAutoPan,
  buildParentScreenMapProjective,
  invertProjective,
  projectiveToCSSMatrix3d,
  composeProjectiveWithLocalOffset,
  composeProjectiveWithScreenOffset,
} from './creator-utils';
import { generateNodeId } from '@/shared/id-utils';
import { SELECTION_COLOR } from '@/shared/constants';
import { styleHelperOps } from '@/canvas/selection/style-helper-store';
import { trace } from '@/shared/debug-trace';
import type { CanvasNode } from '@/code/parsing/parser';

const MIN_DRAW_SIZE = 5;
const PREVIEW_BORDER = SELECTION_COLOR;
const PREVIEW_FILL = 'rgba(59, 130, 246, 0.1)';
// FALLBACK for encapsulating over a ROTATED parent (where the clip-path holes
// can't be mapped — see applyEncapsulationHoles): the placeholder is held at
// this opacity over the commit gap so the wrapped content stays visible instead
// of being hidden then popping back in. The common (axis-aligned) path uses
// solid-fill-with-holes instead, which has no opacity flash at all. Tunable.
const ENCAPSULATE_PREVIEW_OPACITY = 0.4;

// Local-coord drawing helpers (buildParentScreenMapProjective,
// invertProjective, projectiveToCSSMatrix3d, composeProjectiveWithLocalOffset)
// live in creator-utils so TextCreator/ShapeCreator/LayoutCreator/SketchCreator
// can also share them. FrameCreator was the first to migrate from the 2D-affine
// helpers (buildParentScreenMap / invertAffine / affineToCSSMatrix /
// composeMapWithLocalOffset) to the projective ones — needed so drawing inside
// a parent with CSS perspective (the trapezoid shape, not a parallelogram)
// produces a preview that follows the perspective foreshortening. The
// projective math handles the affine case identically (h31=h32=0 in that
// branch), so this is a strict superset.

export interface FrameCreatorCallbacks {
  getContainerRect: () => DOMRect;
  getContentEl: () => HTMLElement;
  getNodes: () => Map<string, CanvasNode>;
  /**
   * Fired after the JSX has been written. `vpId` is the viewport the user
   * drew the new node INTO — 'desktop' for floaters / primary variant,
   * 'variant-1' / 'tablet' / etc. for non-primary. Canvas.tsx uses it to
   * also switch `interactingViewportIdAtom` so the selection overlay
   * highlights the variant the user actually drew on (otherwise drawing
   * on variant-1 from the master would leave the user in the default
   * variant's context and SelectionOverlay would track the replica on
   * default instead of the original on variant-1).
   */
  onCreated: (nodeId: string, vpId: string) => void;
  onToolReset: () => void;
  getViewportWidth: (vpId: string) => number;
  onNodeMouseDown?: (nodeId: string, e: MouseEvent) => void;
}

let previewEl: HTMLElement | null = null;
let cleanupFn: (() => void) | null = null;
let autoPanCleanup: (() => void) | null = null;

/**
 * Start frame creation on pointerdown.
 * Call from Canvas.tsx when toolMode === 'frame'.
 */
export function startFrameCreation(
  e: PointerEvent,
  callbacks: FrameCreatorCallbacks,
): void {
  const containerRect = callbacks.getContainerRect();
  const contentEl = callbacks.getContentEl();
  const nodes = callbacks.getNodes();
  const transform = transformManager.getTransform();

  // Detect parent under cursor using bridge-based hit testing
  const parent = findParentAtPoint(e.clientX, e.clientY, nodes);
  const vpId = parent ? vpIdFromPrefix(parent.vpPrefix) : 'desktop';
  const isReplica = parent ? parent.vpPrefix !== '' : false;
  const isCanvasNode = !parent; // no parent = canvas-level node

  // Start point in canvas space
  const startCanvas = screenToCanvas(e.clientX, e.clientY, transform, containerRect);

  // Parent local-coord drawing setup. Only used when the parent has
  // a transform (rotation, scale, skew, etc.) — for plain parents the
  // map is still built but ends up collapsing to "axis-aligned at
  // parent's screen origin", indistinguishable from the legacy
  // canvas-space path. Building it unconditionally keeps the move /
  // commit branches uniform.
  //
  // For canvas-level draws (no parent), we keep the original
  // canvas-space path entirely — there's nothing to be local-to.
  const parentMap = parent ? buildParentScreenMapProjective(parent.nodeId, vpId) : null;
  const parentMapInv = parentMap ? invertProjective(parentMap) : null;
  const useLocalSpace = !!(parentMap && parentMapInv);
  // Start point in PARENT-LOCAL space when available — drawing rect
  // accumulates here so its width/height are in the parent's
  // coordinate system, ready to be written directly to inline styles.
  const startLocal = parentMapInv
    ? parentMapInv.invertScreen(e.clientX, e.clientY)
    : { x: 0, y: 0 };

  trace.action('frame-creator:start', {
    vpId, isReplica,
    parentId: parent?.nodeId ?? 'root',
    startX: Math.round(startCanvas.x), startY: Math.round(startCanvas.y),
  });

  // Create preview in SCREEN SPACE — outside contentEl so border isn't affected by canvas scale.
  // Same approach as old builder: absolute positioned in the canvas container, not in contentEl.
  // When `useLocalSpace`, the preview's `left/top/width/height` are in
  // parent-local units and a `transform: matrix(...)` is applied to
  // tilt/scale the rectangle so it visually rotates with the parent
  // (standard drawing inside transformed elements). The
  // `transform-origin: 0 0` is essential — without it the CSS
  // transform would centre-rotate the preview and the position math
  // wouldn't match.
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

  // Pure redraw — invoked from both real mousemove and auto-pan tick. The
  // tick fires while the cursor is stationary at an edge but the canvas
  // is sliding underneath; calling this with the last seen screen cursor
  // re-projects via screenToCanvas against the freshly-panned transform,
  // so the preview rect keeps growing through canvas space.
  const redraw = (clientX: number, clientY: number) => {
    const t = transformManager.getTransform();

    if (useLocalSpace && parentMap && parentMapInv) {
      // Local-space path: drawing rect lives in the parent's local
      // coordinate system. The preview rectangle is placed at the
      // rect's local left/top with local width/height, then the
      // parent's local-to-screen matrix is applied via CSS transform
      // so the preview tilts with the parent.
      // We REBUILD the map every frame (cheap — just reads from
      // cornersCache + size cache) so live edits to the parent's
      // transform during draw don't desync the preview.
      const liveMap = buildParentScreenMapProjective(parent!.nodeId, vpId) ?? parentMap;
      const liveInv = invertProjective(liveMap) ?? parentMapInv;
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
        // Preview is in parent-local space; CSS matrix carries the
        // parent's full screen transform. Bake the rect offset
        // (`left`, `top`) into the map's translation component, then
        // subtract `containerRect.left/top` to re-base into the
        // container's coordinate space (preview is positioned inside
        // `containerEl`, not document-root).
        // Two-step compose:
        //   1. Bake the rect's local (left, top) into the projective map so
        //      the preview renders at local origin (0, 0) but lands at the
        //      right parent-local point.
        //   2. Re-base from viewport-screen → container-local-screen via
        //      a TRUE screen-space pre-translation (not just c/f subtract —
        //      under perspective the bottom row is non-identity, so the
        //      naive c-=dx form drifts; see composeProjectiveWithScreenOffset).
        const composed = composeProjectiveWithScreenOffset(
          composeProjectiveWithLocalOffset(liveMap, left, top),
          containerRect.left, containerRect.top,
        );
        previewEl.style.left = '0px';
        previewEl.style.top = '0px';
        previewEl.style.width = `${width}px`;
        previewEl.style.height = `${height}px`;
        previewEl.style.transform = projectiveToCSSMatrix3d(composed);
      }

      styleHelperOps.show({
        type: 'dimensions',
        position: { x: clientX, y: clientY },
        dimensions: { width: Math.round(width), height: Math.round(height), unit: 'px' },
      });
      return;
    }

    // Canvas-space path (no parent, or parent has no usable transform
    // data) — kept verbatim from the legacy behaviour.
    const currentCanvas = screenToCanvas(clientX, clientY, t, containerRect);

    let left = Math.min(startCanvas.x, currentCanvas.x);
    let top = Math.min(startCanvas.y, currentCanvas.y);
    let width = Math.abs(currentCanvas.x - startCanvas.x);
    let height = Math.abs(currentCanvas.y - startCanvas.y);

    if (shiftHeld) {
      const size = Math.max(width, height);
      width = size;
      height = size;
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

  // Auto-pan tenant — flag goes false on every termination path below.
  // Stash the cleanup at module scope so `cancelFrameCreation` can reach
  // it (the closure goes out of scope when this fn returns).
  const autoPan = attachCreatorAutoPan('frame-creator', redraw);
  autoPanCleanup = autoPan.cleanup;

  cleanupFn = attachDragListeners({
    startX: e.clientX,
    startY: e.clientY,
    threshold: 0, // draw immediately, no movement threshold

    onMove: (_dx, _dy, moveEvent) => {
      autoPan.trackMouse(moveEvent.clientX, moveEvent.clientY);
      redraw(moveEvent.clientX, moveEvent.clientY);
    },

    onUp: (upEvent) => {
      // Cleanup listeners. KEEP the preview as a frame-colored PLACEHOLDER over
      // the gap between mouseup and the iframe rendering the real node (the
      // source commit re-parses the whole page — ~0.3s on a big page). Detach it
      // from module state so `cancelFrameCreation` doesn't double-remove it; the
      // deferred-commit block below restyles + drops it once the real frame paints.
      autoPan.cleanup();
      autoPanCleanup = null;
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      const placeholder = previewEl;
      previewEl = null;
      cleanupFn = null;
      styleHelperOps.hide();

      const t = transformManager.getTransform();
      const endCanvas = screenToCanvas(upEvent.clientX, upEvent.clientY, t, containerRect);

      // Calculate drawn rectangle. When `useLocalSpace`, `left/top/
      // width/height` are in PARENT-LOCAL space (ready to be written
      // straight to inline styles below — they already account for
      // parent rotation/scale/skew). Otherwise they're in canvas
      // space and the existing `absoluteToRelativeById` conversion
      // handles parent-relative offset.
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

      // THE DRAWN RECT IN CANVAS SPACE — always, independent of which space the
      // style write above chose. `useLocalSpace` is true for EVERY draw inside a
      // parent (the map is built unconditionally; for a plain parent it collapses
      // to "axis-aligned at the PARENT's screen origin"), so `left`/`top` are
      // PARENT-LOCAL, offset from canvas coords by the parent's own position.
      // Every containment test compares against `getAbsoluteCanvasRectById`,
      // which is canvas-space — so draw-over-to-capture was comparing two
      // different origins and could essentially never match: five texts drawn
      // fully over, none adopted (user report 2026-08-08). Derived from the same
      // start/end screen points, so it needs no inverse map.
      const canvasRect = (() => {
        let l = Math.min(startCanvas.x, endCanvas.x);
        let tp = Math.min(startCanvas.y, endCanvas.y);
        let w = Math.abs(endCanvas.x - startCanvas.x);
        let h = Math.abs(endCanvas.y - startCanvas.y);
        if (shiftHeld) {
          const size = Math.max(w, h);
          if (endCanvas.x < startCanvas.x) l = startCanvas.x - size;
          if (endCanvas.y < startCanvas.y) tp = startCanvas.y - size;
          w = size; h = size;
        }
        return { left: l, top: tp, width: w, height: h };
      })();

      // Validate minimum size (scale-adjusted so small frames work when zoomed in)
      const minSize = MIN_DRAW_SIZE / t.scale;
      if (width < minSize || height < minSize) {
        trace.action('frame-creator:too-small', { width, height });
        placeholder?.remove();
        callbacks.onToolReset();
        return;
      }

      const nodeId = generateNodeId();
      const styles: Record<string, string> = {
        position: 'absolute',
        width: `${Math.round(width)}px`,
        height: `${Math.round(height)}px`,
        backgroundColor: nextFrameColor(),
        borderRadius: '0px',
        overflow: 'hidden',
        left: `${Math.round(left)}px`,
        top: `${Math.round(top)}px`,
      };

      // Restyle the kept preview to match the final frame so the on-screen
      // placeholder reads as the real node (drops the blue drawing border/tint).
      // It already sits at the drawn screen position; it stays there until the
      // iframe paints the committed node (deferred-commit block below).
      if (placeholder) {
        placeholder.style.backgroundColor = styles.backgroundColor;
        placeholder.style.border = 'none';
        placeholder.style.borderRadius = styles.borderRadius;
        // Drop the placeholder UNDER the selection overlay. While drawing it was
        // zIndex 1000 (above everything), but now it's just standing in for the
        // committed frame and must sit BELOW the selection handles — otherwise it
        // paints over the border-radius handle (zIndex 4) + resize handles (2-3),
        // which sit at/inside the frame corners. That's why the radius handle (fully
        // inside the box) only "appeared" when the placeholder was removed at
        // render-complete (~0.3s), while the corner handles peeked past its edge.
        // zIndex 1 keeps it above the iframe (zIndex 0) so the frame still shows
        // during the render gap, but below the overlay handles.
        placeholder.style.zIndex = '1';
      }

      // Ids of existing elements the new frame WRAPS — used to punch holes in
      // the commit-gap placeholder so they stay fully visible (see below).
      let encapsulatedIds: string[] = [];

      // Flex/grid commit: the new child's final spot is a LAYOUT SLOT (not the
      // drawn rect), so we drop a bridge placeholder INTO the slot for instant
      // appearance instead of the drawn-rect hold (which would jump). Captured
      // here, applied in the hold section below.
      let isFlexSlot = false;
      let flexBeforeNodeId: string | null = null;

      if (isCanvasNode) {
        // ─── Canvas node: lives outside viewports ──
        trace.action('frame-creator:commit-canvas', { nodeId, width: Math.round(width), height: Math.round(height) });

        createNode({
          id: nodeId, type: 'div', name: 'Frame', styles,
          parentEl: contentEl, parentId: 'root',
          isCanvasNode: true, contentEl,
          onMouseDown: callbacks.onNodeMouseDown,
        });

        // Encapsulate any canvas nodes whose bounding box is fully inside the
        // newly-drawn frame: reparent them as absolute children of the frame
        // and rewrite their `left`/`top` to be frame-relative so they stay
        // visually pinned in place.
        encapsulatedIds = encapsulateAbsoluteSiblings({
          newFrameId: nodeId,
          // Canvas node: inline left/top ARE canvas coords → both rects match.
          newFrameRect: { left, top, width, height },
          frameCanvasRect: { left, top, width, height },
          // Canvas-node rects are keyed under the PRIMARY prefix (''), which
          // comes from vpId 'desktop' — NOT the empty string. `getViewportPrefix('')`
          // returns '-' (a bogus prefix), so passing '' made the auto-sized
          // fallback's findNodeRect miss and skip canvas text entirely (live
          // find 2026-07-24). `vpIdFromPrefix('')` gives the vpId that maps back
          // to the '' prefix.
          vpId: vpIdFromPrefix(''),
          transform: t,
          candidates: collectCanvasNodes(nodes, nodeId),
          intoCanvasNode: false,
        });
      } else {
        // ─── Viewport node: inside a parent element ──
        const parentId = parent!.nodeId;
        let insertIndex: number | undefined;

        const mode = getInsertionMode(parentId, vpId);
        if (mode === 'absolute') {
          // `useLocalSpace` already produced parent-local left/top —
          // skip the AABB-based conversion (which only handles
          // translate, not rotation). Otherwise fall back to the
          // canvas-space → parent-relative subtraction.
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
          insertIndex = getFlexInsertIndex(parentId, vpId, centerX, centerY, t, mode as any);
          // The new child lands in a flex/grid SLOT — remember its anchor (the
          // sibling it inserts BEFORE) so the hold section can drop a bridge
          // placeholder there for instant in-layout appearance. `insertIndex`
          // indexes `findChildRects` (DOM order); null → append.
          isFlexSlot = !isReplica;  // replicas use the hide/AnimatePresence path
          const slotChildren = findChildRects(parentId, vpId);
          flexBeforeNodeId = insertIndex < slotChildren.length ? slotChildren[insertIndex].id : null;
        }

        // Inline `display: 'none'` baseline is the LEGACY hide-on-replica
        // pattern (paired with `@container display: 'unset'` for the
        // active vp). For COMPONENT MASTER variants we now use the
        // AnimatePresence + conditional render pattern instead — the
        // element is conditionally mounted, so inline display should
        // stay at the natural value. Skip the `none` write here for
        // component files; `queueReplicaCreationUnhide` below will emit
        // a `setVariantVisibility` mutation that wraps the JSX in
        // AnimatePresence and the conditional handles visibility.
        if (isReplica && !isComponentFilePath(getActiveFilePath())) {
          styles.display = 'none';
        }

        // MEASURE BEFORE MUTATING. `createNode` below inserts the frame into the
        // parent's flow SYNCHRONOUSLY (`parentEl.insertBefore`), which REFLOWS
        // every sibling: in a flex column the drawn-over texts are pushed down
        // by the new frame's height before containment is ever tested, so
        // nothing was ever captured and the frame landed as a bare sibling
        // (user report 2026-08-08 — five texts drawn fully over, none adopted).
        // The absolute path is immune because out-of-flow siblings don't move,
        // which is why only the layout case broke. Candidates are resolved here,
        // against the layout the user actually drew on; the moves are queued
        // after the node exists.
        const flowCaptures = mode !== 'absolute'
          ? collectFlowCaptures({
              newFrameId: nodeId,
              newFrameRect: canvasRect,
              parentId, vpId, nodes, transform: t,
            })
          : [];

        trace.action('frame-creator:commit-viewport', {
          nodeId, parentId, position: styles.position, isReplica, insertIndex,
          flowCaptures: flowCaptures.length,
        });

        createNode({
          id: nodeId, type: 'div', name: 'Frame', styles,
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

        // Encapsulation for frames drawn inside a parent: take any absolute
        // sibling whose bounding box (parent-relative) is fully inside the
        // new frame and reparent it. The new frame's own rect is in PARENT-
        // relative coords (`mode === 'absolute'` already converted), so we
        // can compare against siblings' inline left/top/width/height
        // directly. Only fires when the frame was committed as absolute —
        // flex children don't have a concept of containment to begin with.
        if (mode === 'absolute') {
          const newFrameLeft = parseFloat(styles.left ?? '0') || 0;
          const newFrameTop = parseFloat(styles.top ?? '0') || 0;
          encapsulatedIds = encapsulateAbsoluteSiblings({
            newFrameId: nodeId,
            // Parent-relative rect for the sized/inline path...
            newFrameRect: { left: newFrameLeft, top: newFrameTop, width, height },
            // ...and the CANVAS-space drawn rect for the auto-sized live-rect
            // fallback (auto text couldn't be captured off inline styles alone).
            // `canvasRect`, NOT the local-space draw — same origin mismatch.
            frameCanvasRect: canvasRect,
            vpId,
            transform: t,
            candidates: collectAbsoluteSiblings(nodes, parentId, nodeId),
            intoCanvasNode: false,
          });
        } else {
          // LAYOUT parent: fully-covered FLOW siblings become children too —
          // same draw-over-to-capture contract as the absolute path. Queued from
          // the pre-insert measurement above.
          encapsulatedIds = queueFlowCaptures(flowCaptures, nodeId, canvasRect, { width, height });
        }
      }

      // ENCAPSULATION instant-feel: when the frame WRAPS existing elements they
      // don't move (their left/top are rewritten frame-relative to the same
      // screen point) — but the OPAQUE placeholder above the iframe would HIDE
      // them through the commit gap (the page re-parse blocks ~0.3s on a big
      // page), so they'd vanish then pop back INSIDE the frame: the lag the
      // placeholder fix removed for the frame itself. Punch a HOLE in the
      // placeholder at each wrapped element's screen rect (clip-path, evenodd) so
      // the frame fill stays SOLID around them while they show through at FULL
      // opacity — pixel-identical to the committed result, so there's no
      // half-opacity flash when the real frame paints. Plain frames are untouched
      // (nothing underneath to reveal).
      if (placeholder && encapsulatedIds.length > 0) {
        applyEncapsulationHoles(
          placeholder,
          encapsulatedIds,
          isCanvasNode ? '' : (parent?.vpPrefix ?? ''),
          useLocalSpace,
        );
      }

      // Seed the new node's rect into the bridge cache from the placeholder (its
      // exact drawn screen position) so the SELECTION OVERLAY resolves it INSTANTLY
      // on select — instead of waiting ~0.3s for the render to measure it. The
      // overlay's getScreenCornersById falls back to findNodeRect (rect cache) for
      // a non-rotated node, so a seeded rect makes the blue box + handles appear
      // immediately. Replaced by the real measured rect on the next allRects.
      const seedBridge = getCanvasBridge();
      const seedVpPrefix = isCanvasNode ? '' : (parent?.vpPrefix ?? '');
      // Skip the rect seed for a flex-slot commit: the placeholder is at the DRAWN
      // rect, but the node's real spot is the layout slot — seeding the drawn rect
      // would make the selection box land there then jump. The slot placeholder
      // gets measured on the render instead.
      if (placeholder && seedBridge.seedRectFromScreen && !isFlexSlot) {
        seedBridge.seedRectFromScreen(nodeId, seedVpPrefix, placeholder.getBoundingClientRect());
      }
      // Same logic for COMPUTED styles — the radius/padding/gap handles + the
      // rotation gate (`transform`) read them via the bridge, so without this they
      // appear ~0.3s late. Seed the new frame's resolved values (a fresh frame has
      // no transform/padding/gap and `borderRadius:0px`). Both camelCase + kebab —
      // the selection folder queries either. Replaced by the real values on the
      // next allRects. Anything not seeded simply falls back to its prior behaviour.
      if (seedBridge.seedComputed) {
        const radius0 = (styles.borderRadius || '0px').split(' ')[0];
        const pad0 = (styles.padding || '0px').split(' ')[0];
        const base: Record<string, string> = {
          transform: styles.transform || 'none',
          display: styles.display || 'block',
          flexDirection: styles.flexDirection || 'row',
          flexWrap: styles.flexWrap || 'nowrap',
          gap: styles.gap || 'normal',
          gridAutoFlow: 'row',
          borderTopLeftRadius: radius0,
          paddingTop: pad0, paddingRight: pad0, paddingBottom: pad0, paddingLeft: pad0,
          width: styles.width || '', height: styles.height || '',
          left: styles.left || 'auto', top: styles.top || 'auto',
          position: styles.position || 'static',
        };
        const computed: Record<string, string> = {};
        for (const [k, v] of Object.entries(base)) {
          computed[k] = v;
          computed[toKebab(k)] = v; // kebab too
        }
        seedBridge.seedComputed(nodeId, seedVpPrefix, computed);
      }

      // Flex-slot commit: drop a bridge placeholder INTO the layout slot so the
      // frame appears in place INSTANTLY (no drawn-rect → slot jump). The renderer
      // swaps it for the real node atomically. Otherwise (absolute / canvas) keep
      // the drawn-rect placeholder over the commit gap — its spot IS the final one.
      if (isFlexSlot) {
        holdFlexSlotPlaceholder({
          nodeId,
          parentId: parent!.nodeId,
          vpPrefix: parent?.vpPrefix ?? '',
          beforeNodeId: flexBeforeNodeId,
          styles,
          drawPlaceholder: placeholder,
        });
      } else {
        // Register the listener BEFORE the commit so a synchronous render-complete
        // isn't missed; safety-net timeout as a fallback.
        let removed = false;
        const removePlaceholder = () => {
          if (removed) return;
          removed = true;
          placeholder?.remove();
          window.removeEventListener('revyme:render-complete', removePlaceholder);
        };
        window.addEventListener('revyme:render-complete', removePlaceholder);
        setTimeout(removePlaceholder, 1500);
      }

      // Commit — EXACT original mechanism (reliably renders the new node on ALL
      // pages incl. templated). `setForceRender` + `flushNow` write the code AND
      // set the force-render flag together, so the render includes the new node
      // and fires render-complete (→ placeholder removed). Kept synchronous:
      // forceCanvasRender / deferring the flush did NOT render a freshly-added
      // node here — the frame vanished. The only change vs the original is the
      // placeholder above, which now covers the brief render gap.
      setForceRender();
      flushNow();
      callbacks.onCreated(nodeId, vpId);
      callbacks.onToolReset();
    },
  });
}

/** Cancel ongoing frame creation (e.g., Escape key) */
export function cancelFrameCreation(): void {
  if (autoPanCleanup) { autoPanCleanup(); autoPanCleanup = null; }
  if (previewEl) { previewEl.remove(); previewEl = null; }
  if (cleanupFn) { cleanupFn(); cleanupFn = null; }
  trace.action('frame-creator:cancel');
}

// ─── Encapsulation ─────────────────────────────────────────────────────────

interface FrameRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Read an inline `Npx` style as a number. Returns 0 when missing/non-px so
 *  the comparison falls through to "not encapsulated" rather than throwing. */
function pxFromStyle(value: string | undefined): number {
  if (!value) return 0;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

/** Parse `rotate(Ndeg)` out of an inline `transform` string. 0 when absent. */
function parseRotateDeg(transform: string | undefined): number {
  if (!transform) return 0;
  const m = /rotate\(\s*(-?\d*\.?\d+)deg\s*\)/.exec(transform);
  return m ? parseFloat(m[1]) : 0;
}

/** Parse a px/percent `transform-origin` into px relative to the border box.
 *  Defaults to the box centre (CSS default `50% 50%`). */
function parseTransformOriginPx(origin: string | undefined, w: number, h: number): { ox: number; oy: number } {
  const def = { ox: w / 2, oy: h / 2 };
  if (!origin) return def;
  const parts = origin.trim().split(/\s+/);
  const axis = (val: string | undefined, size: number, fallback: number): number => {
    if (!val) return fallback;
    if (val.endsWith('%')) { const p = parseFloat(val); return Number.isFinite(p) ? (p / 100) * size : fallback; }
    const n = parseFloat(val); return Number.isFinite(n) ? n : fallback;
  };
  return { ox: axis(parts[0], w, def.ox), oy: axis(parts[1], h, def.oy) };
}

/** The candidate's box corners in the frame's coordinate space — ROTATED around
 *  its own transform-origin when it carries a CSS `rotate()` (an SVG group, or
 *  any rotated node). Without this, a rotated node's UN-rotated inline box sits
 *  at the wrong place and the containment test below silently fails. */
function nodeCornersInFrameSpace(node: CanvasNode): Array<{ x: number; y: number }> | null {
  const styles = node.styles ?? {};
  const left = pxFromStyle(styles.left);
  const top = pxFromStyle(styles.top);
  const width = pxFromStyle(styles.width);
  const height = pxFromStyle(styles.height);
  if (width <= 0 || height <= 0) return null;
  const corners = [
    { x: left, y: top }, { x: left + width, y: top },
    { x: left + width, y: top + height }, { x: left, y: top + height },
  ];
  const deg = parseRotateDeg(styles.transform);
  if (deg === 0) return corners;
  const { ox, oy } = parseTransformOriginPx(styles.transformOrigin, width, height);
  const originX = left + ox, originY = top + oy;
  const a = (deg * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
  return corners.map(c => {
    const dx = c.x - originX, dy = c.y - originY;
    return { x: originX + dx * cos - dy * sin, y: originY + dx * sin + dy * cos };
  });
}

/** True iff the candidate's box (left/top/width/height in the SAME coordinate
 *  space as the frame's rect, ROTATED if the node is rotated) is fully inside
 *  the frame. Strict inclusion — a single corner sticking out disqualifies the
 *  node. Matches the user expectation: "draw a frame OVER nodes that fit inside
 *  it" — including rotated SVG groups. */
function isNodeFullyInside(node: CanvasNode, frame: FrameRect): boolean {
  const styles = node.styles ?? {};
  if (styles.position !== 'absolute' && !node.isCanvasNode) return false;
  const corners = nodeCornersInFrameSpace(node);
  if (!corners) return false;
  return corners.every(c =>
    c.x >= frame.left &&
    c.y >= frame.top &&
    c.x <= frame.left + frame.width &&
    c.y <= frame.top + frame.height
  );
}

/** All canvas-level nodes (`isCanvasNode === true` AND no parent) excluding
 *  the freshly-drawn frame itself. */
function collectCanvasNodes(nodes: Map<string, CanvasNode>, excludeId: string): CanvasNode[] {
  const out: CanvasNode[] = [];
  for (const n of nodes.values()) {
    if (n.id === excludeId) continue;
    if (!n.isCanvasNode) continue;
    if (n.parentId) continue;
    out.push(n);
  }
  return out;
}

/** All siblings under `parentId` that are absolute-positioned (eligible for
 *  encapsulation) — excluding the freshly-drawn frame. */
function collectAbsoluteSiblings(
  nodes: Map<string, CanvasNode>,
  parentId: string,
  excludeId: string,
): CanvasNode[] {
  const out: CanvasNode[] = [];
  for (const n of nodes.values()) {
    if (n.id === excludeId) continue;
    if (n.parentId !== parentId) continue;
    if ((n.styles?.position ?? '') !== 'absolute') continue;
    out.push(n);
  }
  return out;
}

interface EncapsulateOptions {
  newFrameId: string;
  /** The frame's rect in the SAME coordinate space as the candidates' inline
   *  left/top (parent-relative for a viewport frame, canvas for a canvas-node
   *  frame). Used by the sized/rotation-aware inline path. */
  newFrameRect: FrameRect;
  /** The frame's rect in CANVAS space (the raw drawn rect). Used by the
   *  live-rect fallback for AUTO/non-px-sized candidates whose inline
   *  width/height can't build a box (text with `width: auto`, etc.). */
  frameCanvasRect: FrameRect;
  /** Viewport id the candidates render in ('' for canvas nodes) — for the
   *  bridge rect lookup. */
  vpId: string;
  /** Live camera transform — un-projects the bridge SCREEN rect to canvas. */
  transform: Transform;
  candidates: CanvasNode[];
  /** Whether the encapsulated nodes should remain canvas-level (essentially
   *  unused — encapsulation always demotes them to children of the new
   *  frame, which is itself either canvas or in-viewport). Reserved for
   *  future "merge canvas frames" cases. */
  intoCanvasNode: boolean;
}

/**
 * Reparent every fully-contained candidate into the new frame and rewrite
 * its `left` / `top` / `right` / `bottom` to be frame-relative — preserving
 * its visual position. Width/height are untouched.
 *
 * When the candidate is a canvas node (`isCanvasNode === true`), we also
 * flip `canvasNode` off in the move mutation so the generator drops the
 * `data-canvas-node` marker and removes it from the `canvasNodes` JSX
 * fragment, putting it inline with its new parent's children.
 *
 * Returns the ids of the candidates that were actually encapsulated — the
 * caller punches a hole in the commit-gap placeholder at each one's screen rect
 * so the wrapped content shows at full opacity (see applyEncapsulationHoles).
 */
function encapsulateAbsoluteSiblings(opts: EncapsulateOptions): string[] {
  const { newFrameId, newFrameRect, frameCanvasRect, vpId, transform, candidates } = opts;
  const encapsulatedIds: string[] = [];
  for (const node of candidates) {
    const oldStyles = node.styles ?? {};
    const w = pxFromStyle(oldStyles.width);
    const h = pxFromStyle(oldStyles.height);

    let newLeft: number, newTop: number;
    const styles: Record<string, string> = { position: 'absolute' };

    if (w > 0 && h > 0) {
      // SIZED path (inline px width/height) — rotation-aware containment via
      // `isNodeFullyInside`, position kept from the inline anchor (preserves
      // any translate/rotate the sized node carries).
      if (!isNodeFullyInside(node, newFrameRect)) continue;
      newLeft = Math.round(pxFromStyle(oldStyles.left) - newFrameRect.left);
      newTop = Math.round(pxFromStyle(oldStyles.top) - newFrameRect.top);
    } else {
      // AUTO / non-px-sized path — the inline box can't be built (a text node
      // with `width: auto`/`height: auto` measured 0 → the old code silently
      // skipped it, so text was NEVER captured; live find 2026-07-24). Fall
      // back to the LIVE canvas rect (post-layout, post-transform), same as
      // the flow-sibling path. Containment + placement both run against the
      // frame's CANVAS rect.
      const r = getAbsoluteCanvasRectById(node.id, vpId, transform);
      if (!r) continue;
      const inside = r.left >= frameCanvasRect.left - 0.5
        && r.top >= frameCanvasRect.top - 0.5
        && r.left + r.width <= frameCanvasRect.left + frameCanvasRect.width + 0.5
        && r.top + r.height <= frameCanvasRect.top + frameCanvasRect.height + 0.5;
      if (!inside) continue;
      // The measured rect is the VISUAL (post-transform) box, so place the node
      // at that visual top-left and drop any translate centering — keeping the
      // translate would double-shift it. rotate/scale (if any) are preserved.
      newLeft = Math.round(r.left - frameCanvasRect.left);
      newTop = Math.round(r.top - frameCanvasRect.top);
      const strippedT = stripTranslateTransforms(oldStyles.transform);
      if ((oldStyles.transform ?? '') !== strippedT) styles.transform = strippedT;
    }

    styles.left = `${newLeft}px`;
    styles.top = `${newTop}px`;
    // Strip any right/bottom inset — those are anchored to the OLD parent's
    // far edges, which would otherwise stretch the node oddly inside the
    // new frame. left/top are sufficient for visual stability.
    if (oldStyles.right) styles.right = '';
    if (oldStyles.bottom) styles.bottom = '';

    trace.action('frame-creator:encapsulate', {
      childId: node.id, newParentId: newFrameId,
      to: { left: newLeft, top: newTop },
      autoSized: !(w > 0 && h > 0),
      wasCanvasNode: !!node.isCanvasNode,
    });

    queueMutation({
      type: 'move',
      nodeId: node.id,
      newParentId: newFrameId,
      // canvasNode flag stays false: the encapsulated node is now a child
      // of a regular element, not a top-level canvas fragment. The
      // generator's move handler unwraps it from the `canvasNodes`
      // fragment when the previous canvasNode flag was true and the new
      // location is a real parent.
      canvasNode: false,
      styles,
    });
    encapsulatedIds.push(node.id);
  }
  return encapsulatedIds;
}

/**
 * FLOW-sibling encapsulation: when the frame is drawn inside a LAYOUT parent
 * (flex/grid), flow children have no inline left/top — containment is tested
 * against their live RECTS (canvas space, same space as the drawn rect in the
 * flow branch). Fully-contained siblings are reparented into the new frame as
 * absolute children pinned at their current visual spot (left/top = rect
 * minus frame origin; flow props cleared). Same UX contract as the absolute
 * path: "draw a frame OVER nodes that fit inside it → they become children".
 */
/** A flow sibling the drawn frame fully covers, with the CANVAS-space rect it
 *  had at draw time. Measured BEFORE the frame is inserted — see the call site
 *  for why that ordering is load-bearing. */
export interface FlowCapture { id: string; rect: FrameRect; }

/**
 * Which flow siblings does the drawn rect fully cover? Pure measurement — no
 * mutation — so the caller can run it against the layout the user actually drew
 * on, then insert the frame.
 */
export function collectFlowCaptures(opts: {
  newFrameId: string;
  newFrameRect: FrameRect;
  parentId: string;
  vpId: string;
  nodes: Map<string, CanvasNode>;
  transform: Transform;
}): FlowCapture[] {
  const { newFrameId, newFrameRect, parentId, vpId, nodes, transform } = opts;
  const captures: FlowCapture[] = [];
  for (const { id } of findChildRects(parentId, vpId)) {
    if (id === newFrameId) continue;
    const node = nodes.get(id);
    if (!node) continue;
    if ((node.styles?.position ?? '') === 'absolute') continue; // absolute path owns these
    // CANVAS-space rect — findChildRects rects are SCREEN-scaled (a 50% zoom
    // halved every dimension, centering the child against a phantom
    // half-size box). getAbsoluteCanvasRectById un-projects through the
    // camera transform so units match the drawn frame rect.
    const rect = getAbsoluteCanvasRectById(id, vpId, transform);
    if (!rect) continue;
    const inside = rect.left >= newFrameRect.left - 0.5
      && rect.top >= newFrameRect.top - 0.5
      && rect.left + rect.width <= newFrameRect.left + newFrameRect.width + 0.5
      && rect.top + rect.height <= newFrameRect.top + newFrameRect.height + 0.5;
    if (!inside) continue;
    captures.push({ id, rect });
  }
  return captures;
}

/**
 * Reparent the captured siblings into the new frame as absolute children.
 *
 * Placement depends on how many were captured, because "where should this go?"
 * has two different right answers:
 *  · ONE child had no position of its own (the old layout placed it), so the
 *    old spot is meaningless once reparented — CENTERING reads as the
 *    intentional composition (spec 2026-07-23).
 *  · SEVERAL children have a composition RELATIVE TO EACH OTHER, and centering
 *    every one of them stacks them all on the same point — five drawn-over
 *    texts would collapse into one pile. Keep each at its drawn offset from the
 *    frame's origin so the group survives the wrap unchanged.
 */
export function queueFlowCaptures(
  captures: FlowCapture[],
  newFrameId: string,
  /** The drawn frame in CANVAS space — the space the captures were measured in. */
  newFrameRect: FrameRect,
  /** The frame's own box as written to its inline style. Equal to the canvas
   *  size for an untransformed parent; under a SCALED parent the two differ, and
   *  a child's left/top resolve in the FRAME's space, so canvas deltas are
   *  converted with this ratio. */
  frameLocalSize?: { width: number; height: number },
): string[] {
  const localW = frameLocalSize?.width ?? newFrameRect.width;
  const localH = frameLocalSize?.height ?? newFrameRect.height;
  const sx = newFrameRect.width > 0 ? localW / newFrameRect.width : 1;
  const sy = newFrameRect.height > 0 ? localH / newFrameRect.height : 1;
  const centerSingle = captures.length === 1;
  const ids: string[] = [];
  for (const { id, rect } of captures) {
    const newLeft = centerSingle
      ? Math.round((localW - rect.width * sx) / 2)
      : Math.round((rect.left - newFrameRect.left) * sx);
    const newTop = centerSingle
      ? Math.round((localH - rect.height * sy) / 2)
      : Math.round((rect.top - newFrameRect.top) * sy);
    const styles: Record<string, string> = {
      position: 'absolute',
      left: `${newLeft}px`,
      top: `${newTop}px`,
      // Flow props belong to the OLD layout parent — clear them so the node
      // doesn't fight its new absolute placement.
      flex: '',
      order: '',
      alignSelf: '',
      marginTop: '', marginRight: '', marginBottom: '', marginLeft: '', margin: '',
    };
    trace.action('frame-creator:encapsulate-flow', {
      childId: id, newParentId: newFrameId, mode: centerSingle ? 'center' : 'preserve',
      rect: { left: Math.round(rect.left), top: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
      to: { left: newLeft, top: newTop },
    });
    queueMutation({
      type: 'move',
      nodeId: id,
      newParentId: newFrameId,
      canvasNode: false,
      styles,
    });
    ids.push(id);
  }
  return ids;
}

/** Clip the commit-gap placeholder so each wrapped element is a transparent
 *  HOLE — the frame fill stays solid around them while they show through at
 *  full opacity, matching the committed frame exactly (no half-opacity flash).
 *  Screen-rect based, so it needs the placeholder axis-aligned: a rotated parent
 *  (useLocalSpace) gives the placeholder a CSS transform that breaks the local
 *  clip-path mapping, so we fall back to a partial opacity there. */
function applyEncapsulationHoles(
  placeholder: HTMLElement,
  ids: string[],
  prefix: string,
  useLocalSpace: boolean,
): void {
  if (useLocalSpace) { placeholder.style.opacity = String(ENCAPSULATE_PREVIEW_OPACITY); return; }
  const pr = placeholder.getBoundingClientRect();
  if (pr.width < 1 || pr.height < 1) return;
  const bridge = getCanvasBridge();
  // Solid outer rect, then a hole per wrapped element (evenodd cuts each one).
  // Coords are the placeholder's local px = screen px (no transform), so a
  // child's screen rect maps by subtracting the placeholder's screen origin.
  let d = `M0 0 H${pr.width.toFixed(1)} V${pr.height.toFixed(1)} H0 Z`;
  let holes = 0;
  for (const id of ids) {
    const r = bridge.getRect(id, prefix);
    if (!r) continue;
    const x = (r.left - pr.left).toFixed(1);
    const y = (r.top - pr.top).toFixed(1);
    const x2 = (r.left - pr.left + r.width).toFixed(1);
    const y2 = (r.top - pr.top + r.height).toFixed(1);
    d += ` M${x} ${y} H${x2} V${y2} H${x} Z`;
    holes++;
  }
  // If no child rect resolved, leave the placeholder solid — still better than a
  // translucent flash; the wrapped content reappears inside on render.
  if (holes > 0) placeholder.style.clipPath = `path(evenodd, '${d}')`;
}
