// ShapeCreator.ts — Drawing state machine for SVG shape creation.
// Imperative (no React). Pointer events (immune to native drag capture).
// Uses canvas-math.ts for coordinates, bridge helpers for parent detection.
//
// Flow: pointerdown → draw preview → pointerup → validate → inject SVG JSX → cleanup
//
// Supports 4 shape types: rectangle, ellipse, triangle, path (diagonal line).
// Each generates an <svg> wrapper with the appropriate inner shape child.

import { transformManager } from '@/canvas/transform';
import { ellipsePathD } from '@/shared/svg-geometry';
import { screenToCanvas, absoluteToRelativeById } from '@/canvas/canvas-math';
import { vpIdFromPrefix, getActiveFilePath } from '@/canvas/node-ops';
import { isComponentFilePath } from '@/code/project/active-file-store';
import { attachDragListeners } from '@/shared/dom-utils';
import { el } from '@/shared/dom-utils';
import { queueMutation, flushNow, setForceRender } from '@/code/mutation/mutation-queue';
import {
  findParentAtPoint,
  getInsertionMode,
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
import { getDefaultStore } from 'jotai';
import { shapeEditingIdAtom, shapeEditPenModeAtom, shapeEditCreatedNodeAtom, selectedPointAtom, selectedAnchorInfoAtom } from '@/code/stores/shape-edit-store';
import { trace } from '@/shared/debug-trace';
import type { CanvasNode } from '@/code/parsing/parser';

const SVG_NS = 'http://www.w3.org/2000/svg';
const MIN_DRAW_SIZE = 5;
const PREVIEW_BORDER = SELECTION_COLOR;
const PREVIEW_FILL = 'rgba(59, 130, 246, 0.1)';
const DEFAULT_SHAPE_FILL = '#3b82f6';
// Pen-drawn paths commit as a neutral gray stroke (not the blue shape fill) so a
// freshly drawn line reads as line art rather than a filled shape.
const DEFAULT_PATH_STROKE = '#AAAAAA';

export type ShapeMode = 'shape-rect' | 'shape-ellipse' | 'shape-triangle' | 'shape-path';

export interface ShapeCreatorCallbacks {
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

// ─── Shape Name Mapping ─────────────────────────────────────────────────────

function shapeDisplayName(mode: ShapeMode): string {
  switch (mode) {
    case 'shape-rect': return 'Rectangle';
    case 'shape-ellipse': return 'Ellipse';
    case 'shape-triangle': return 'Triangle';
    case 'shape-path': return 'Path';
  }
}

// ─── Inner SVG Child — DOM Creation ─────────────────────────────────────────

function createInnerShapeEl(mode: ShapeMode, width: number, height: number): SVGElement {
  trace.fn('shape-creator:createInnerShapeEl', { mode, width, height });

  switch (mode) {
    case 'shape-rect': {
      const rect = document.createElementNS(SVG_NS, 'rect');
      rect.setAttribute('width', '100%');
      rect.setAttribute('height', '100%');
      rect.setAttribute('fill', DEFAULT_SHAPE_FILL);
      return rect;
    }
    case 'shape-ellipse': {
      // Bézier `<path>` (absolute coords), NOT `<ellipse rx="50%">` — see ellipsePathD.
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', ellipsePathD(Math.round(width), Math.round(height)));
      path.setAttribute('fill', DEFAULT_SHAPE_FILL);
      return path;
    }
    case 'shape-triangle': {
      const polygon = document.createElementNS(SVG_NS, 'polygon');
      const w = Math.round(width);
      const h = Math.round(height);
      polygon.setAttribute('points', `${w / 2},0 ${w},${h} 0,${h}`);
      polygon.setAttribute('fill', DEFAULT_SHAPE_FILL);
      return polygon;
    }
    case 'shape-path': {
      const path = document.createElementNS(SVG_NS, 'path');
      const w = Math.round(width);
      const h = Math.round(height);
      path.setAttribute('d', `M0,0 L${w},${h}`);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', DEFAULT_SHAPE_FILL);
      path.setAttribute('stroke-width', '2');
      return path;
    }
  }
}

// ─── Inner SVG Child — JSX String ───────────────────────────────────────────

function innerShapeJSX(mode: ShapeMode, width: number, height: number): string {
  trace.fn('shape-creator:innerShapeJSX', { mode, width, height });

  const w = Math.round(width);
  const h = Math.round(height);

  // `stroke="#000000" stroke-width="0"` is set on every shape at creation
  // time so the Stroke panel's Width input actually does something the
  // first time the user touches it — SVG ignores `stroke-width` when there
  // is no `stroke` attribute, so without a pre-set stroke color the user
  // would scrub Width up to 50 and see no visual change. Width starts at 0
  // so the shape paints clean (no involuntary 1px black border) until the
  // user opts in.
  switch (mode) {
    case 'shape-rect':
      return `<rect width="100%" height="100%" fill="${DEFAULT_SHAPE_FILL}" stroke="#000000" stroke-width="0" />`;
    case 'shape-ellipse':
      // Bézier `<path>` (absolute coords) so all geometry math works — see ellipsePathD.
      return `<path d="${ellipsePathD(w, h)}" fill="${DEFAULT_SHAPE_FILL}" stroke="#000000" stroke-width="0" />`;
    case 'shape-triangle':
      return `<polygon points="${w / 2},0 ${w},${h} 0,${h}" fill="${DEFAULT_SHAPE_FILL}" stroke="#000000" stroke-width="0" />`;
    case 'shape-path':
      // Path-mode is stroke-only (fill="none") so stroke must be visible
      // immediately — keep it at the original width=2 so the line is
      // drawn on creation.
      return `<path d="M0,0 L${w},${h}" fill="none" stroke="${DEFAULT_SHAPE_FILL}" strokeWidth="2" />`;
  }
}

// ─── SVG Wrapper — Imperative DOM Creation ──────────────────────────────────

function createSvgNode(
  nodeId: string,
  name: string,
  styles: Record<string, string>,
  mode: ShapeMode,
  width: number,
  height: number,
  onMouseDown?: (nodeId: string, e: MouseEvent) => void,
): SVGSVGElement {
  trace.fn('shape-creator:createSvgNode', { nodeId, mode, width, height });

  const svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
  svg.setAttribute('data-node-id', nodeId);
  svg.setAttribute('data-id', nodeId);
  svg.setAttribute('data-name', name);
  // viewBox + preserveAspectRatio="none" so the shape stretches to fill the
  // wrapper as the user resizes it. Without these, a path's user-space
  // coordinates are interpreted as raw pixels — when the wrapper grows the
  // path stays at its original creation-time pixel positions in the corner
  // of the now-larger box. With viewBox set to the initial size and "none"
  // preserve-aspect, the browser stretches the viewBox non-uniformly to the
  // wrapper's current width/height — same UX as the reference / Figma.
  svg.setAttribute('viewBox', `0 0 ${Math.round(width)} ${Math.round(height)}`);
  svg.setAttribute('preserveAspectRatio', 'none');

  for (const [key, value] of Object.entries(styles)) {
    try { (svg.style as any)[key] = value; } catch { /* skip */ }
  }

  const innerShape = createInnerShapeEl(mode, width, height);
  svg.appendChild(innerShape);

  if (onMouseDown) {
    svg.addEventListener('mousedown', (e: MouseEvent) => {
      e.stopPropagation();
      onMouseDown(nodeId, e);
    });
  }

  return svg;
}

// ─── Main Entry Point ───────────────────────────────────────────────────────

export function startShapeCreation(
  e: PointerEvent,
  shapeMode: ShapeMode,
  callbacks: ShapeCreatorCallbacks,
): void {
  if (shapeMode === 'shape-path') {
    startPathCreation(e, callbacks);
    return;
  }

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

  // Parent-local drawing setup. See FrameCreator for the rationale —
  // when the parent has a transform we want the preview to tilt with
  // it and the committed width/height/left/top to live in the
  // parent's local space.
  const parentMap = parent ? buildParentScreenMap(parent.nodeId, vpId) : null;
  const parentMapInv = parentMap ? invertAffine(parentMap) : null;
  const useLocalSpace = !!(parentMap && parentMapInv);
  const startLocal = parentMapInv
    ? parentMapInv.invertScreen(e.clientX, e.clientY)
    : { x: 0, y: 0 };

  trace.action('shape-creator:start', {
    shapeMode, vpId, isReplica,
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
      // Required for the CSS matrix translation in local-space mode
      // to land at the right origin (default centre-rotation breaks
      // the position math).
      transformOrigin: '0 0',
    },
  });
  containerEl.appendChild(previewEl!);

  let shiftHeld = false;
  const onKeyDown = (ke: KeyboardEvent) => { if (ke.key === 'Shift') shiftHeld = true; };
  const onKeyUp = (ke: KeyboardEvent) => { if (ke.key === 'Shift') shiftHeld = false; };
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  // Pure redraw — invoked from real mousemove and from auto-pan ticks so
  // the preview rect keeps growing through canvas space while the canvas
  // slides beneath a stationary cursor.
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

    // Canvas-space fallback (no parent / corners not cached).
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

  const autoPan = attachCreatorAutoPan('shape-creator', redraw);
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

      // Local-space commit when the parent had a usable transform
      // map at start. Width/height/left/top end up in parent-local
      // units, matching the on-screen preview exactly.
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
        trace.action('shape-creator:too-small', { width, height, shapeMode });
        placeholder?.remove();
        callbacks.onToolReset();
        return;
      }

      const nodeId = generateNodeId('shape');
      const name = shapeDisplayName(shapeMode);
      const roundedWidth = Math.round(width);
      const roundedHeight = Math.round(height);

      const styles: Record<string, string> = {
        position: 'absolute',
        width: `${roundedWidth}px`,
        height: `${roundedHeight}px`,
        overflow: 'visible',
        left: `${Math.round(left)}px`,
        top: `${Math.round(top)}px`,
      };

      const innerJSX = innerShapeJSX(shapeMode, roundedWidth, roundedHeight);
      // Wrapper attrs that make the shape stretch on parent resize. Mirrors
      // the imperative DOM in `createSvgNode`. Stored on the node so the
      // parser/renderer round-trip preserves them and the JSX writer emits
      // `<svg viewBox="…" preserveAspectRatio="none" …>`.
      const wrapperAttrs: Record<string, string> = {
        viewBox: `0 0 ${roundedWidth} ${roundedHeight}`,
        preserveAspectRatio: 'none',
      };

      if (isCanvasNode) {
        trace.action('shape-creator:commit-canvas', { nodeId, shapeMode, width: roundedWidth, height: roundedHeight });

        const svgEl = createSvgNode(nodeId, name, styles, shapeMode, roundedWidth, roundedHeight, callbacks.onNodeMouseDown);
        contentEl.appendChild(svgEl);

        injectNodeIntoCache({
          id: nodeId, type: 'svg', name, parentId: null,
          children: [], styles, attrs: wrapperAttrs,
          textContent: innerJSX, hasMixedContent: true, order: 0,
          isCanvasNode: true,
          componentFile: null, componentInstanceId: null, isComponentRoot: false,
          motionVariants: null, motionVariantsRef: null, motionProps: null,
          responsiveVariantMap: null, conditionalStyles: null,
        });

        queueMutation({ type: 'addCanvasNode', node: { id: nodeId, type: 'svg', styles, attrs: wrapperAttrs, name, textContent: innerJSX } });
      } else {
        const parentId = parent!.nodeId;
        let insertIndex: number | undefined;

        const mode = getInsertionMode(parentId, vpId);
        if (mode === 'absolute') {
          // `useLocalSpace` already produced parent-local left/top —
          // skip the AABB-based subtraction below (which only handles
          // pure translate).
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
          delete styles.left;
          delete styles.top;
          const centerX = left + width / 2;
          const centerY = top + height / 2;
          insertIndex = getFlexInsertIndex(parentId, vpId, centerX, centerY, t, mode as any);
        }

        // Skip inline display:'none' on component masters — AnimatePresence
        // conditional render handles per-variant visibility there.
        if (isReplica && !isComponentFilePath(getActiveFilePath())) {
          styles.display = 'none';
        }

        trace.action('shape-creator:commit-viewport', { nodeId, parentId, shapeMode, position: styles.position, isReplica, insertIndex });

        const svgEl = createSvgNode(nodeId, name, styles, shapeMode, roundedWidth, roundedHeight, callbacks.onNodeMouseDown);
        contentEl.appendChild(svgEl);

        injectNodeIntoCache({
          id: nodeId, type: 'svg', name, parentId,
          children: [], styles, attrs: wrapperAttrs,
          textContent: innerJSX, hasMixedContent: true, order: 0,
          isCanvasNode: false,
          componentFile: null, componentInstanceId: null, isComponentRoot: false,
          motionVariants: null, motionVariantsRef: null, motionProps: null,
          responsiveVariantMap: null, conditionalStyles: null,
        });

        queueMutation({ type: 'addNode', parentId, node: { id: nodeId, type: 'svg', styles, attrs: wrapperAttrs, name, textContent: innerJSX }, index: insertIndex });

        // Renumber flex `order` so an explicitly-ordered parent places the new
        // node at the DRAWN flow position (no-op when no sibling has `order`).
        if (mode !== 'absolute' && insertIndex !== undefined) {
          queueCreatorFlexOrder(parentId, vpId, insertIndex, nodeId, mode as 'flex-row' | 'flex-column' | 'grid', contentEl);
        }

        if (isReplica) {
          queueReplicaCreationUnhide(nodeId, vpId, callbacks.getViewportWidth(vpId));
        }
      }

      trace.action('shape-creator:created', { nodeId, shapeMode, width: roundedWidth, height: roundedHeight });
      // Structural change: imperative DOM update is a no-op in iframe mode, so the
      // sandbox needs the new node tree pushed via a full render. Without this, the
      // canvas-update skip flag swallows the next render and the shape never appears
      // in the iframe (selection chrome shows bounds but interior is empty).
      // Paint the ACTUAL shape into the placeholder (not just its bounding box) so
      // the shape — not a faint rect — shows through the ~0.2s rebuild gap. innerJSX
      // is plain SVG markup; the only non-HTML attr is path mode's camelCase
      // `strokeWidth`, normalized to `stroke-width` for innerHTML. The host <svg>
      // (viewBox 0 0 w h, preserveAspectRatio none) scales it to fill the box.
      if (placeholder) {
        placeholder.style.backgroundColor = 'transparent'; // the shape provides its own fill
        placeholder.innerHTML = `<svg viewBox="0 0 ${roundedWidth} ${roundedHeight}" preserveAspectRatio="none" width="100%" height="100%" style="display:block;overflow:visible">${innerJSX.replace(/strokeWidth=/g, 'stroke-width=')}</svg>`;
      }
      // Hold the placeholder over the rebuild + seed geometry for instant select.
      holdCreationPlaceholder(nodeId, parent?.vpPrefix ?? '', placeholder, styles);
      setForceRender();
      flushNow();
      callbacks.onCreated(nodeId, vpId);
      callbacks.onToolReset();
    },
  });
}

// ─── Path Tool: Click-to-Place Points ────────────────────────────────────────

let pathPoints: { x: number; y: number }[] = [];
let pathPreviewSvg: SVGSVGElement | null = null;
let pathPreviewPath: SVGPathElement | null = null;
let pathPreviewDots: SVGCircleElement[] = [];
let pathCleanupFns: (() => void)[] = [];

const PATH_DOT_R = 4;        // anchor dot radius in SCREEN px (matches shape-edit size 8)
const PATH_ANCHOR_STROKE = '#2680EB'; // = DEFAULT_ANCHOR_STYLE.stroke (shape-edit anchors)
const PATH_CLOSE_DIST = 12;  // click/hover within this many screen px of the START
                             // point (with ≥3 points down) snaps + closes the path
// Manual double-click detection — the canvas is a cross-origin iframe, so the
// native `dblclick` window event is unreliable; we time consecutive pointerdowns.
let pathLastClickT = 0;
let pathLastClickX = 0;
let pathLastClickY = 0;

/** A path vertex (canvas coords) → its current SCREEN position. */
function pathPointToScreen(
  p: { x: number; y: number },
  t: { scale: number; x: number; y: number },
  cr: DOMRect,
): { x: number; y: number } {
  return { x: p.x * t.scale + t.x + cr.left, y: p.y * t.scale + t.y + cr.top };
}
function screenDist(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

/** Handle a click (place point / close / finish) while a path is being drawn.
 *  Driven SOLELY by the pointerdown re-entry (CanvasMouseController re-invokes
 *  startShapeCreation on every canvas pointerdown while in 'shape-path' mode), so
 *  each physical click maps to exactly ONE call — no dual-delivery, which is what
 *  let the 2nd point get misread as a double-click and commit early. */
function handlePathPointerClick(clientX: number, clientY: number, callbacks: ShapeCreatorCallbacks): void {
  if (!pathPreviewSvg) return; // not drawing
  const cr = callbacks.getContainerRect();
  const t = transformManager.getTransform();
  const now = performance.now();

  // Click the START anchor (≥3 points) → CLOSE into a filled shape.
  if (pathPoints.length >= 3) {
    const s0 = pathPointToScreen(pathPoints[0], t, cr);
    if (screenDist(clientX, clientY, s0.x, s0.y) <= PATH_CLOSE_DIST) {
      finishPath(callbacks, cr, /* closed */ true);
      return;
    }
  }
  // DOUBLE-CLICK = the previous click ALSO placed a point at ~this spot within
  // 350ms → finish the OPEN path. Requires ≥2 existing points, so the literal
  // 2nd point (length 1 here) can never trigger it — only a real second click on
  // the just-placed last point does.
  if (pathPoints.length >= 2 && now - pathLastClickT < 350 && screenDist(clientX, clientY, pathLastClickX, pathLastClickY) <= 6) {
    finishPath(callbacks, cr, /* closed */ false);
    return;
  }

  pathLastClickT = now; pathLastClickX = clientX; pathLastClickY = clientY;
  pathPoints.push(screenToCanvas(clientX, clientY, t, cr));
  updatePathPreview(cr);
  trace.action('path-creator:point-added', { idx: pathPoints.length - 1 });
}

function updatePathPreview(containerRect: DOMRect) {
  if (!pathPreviewSvg || !pathPreviewPath || pathPoints.length === 0) return;
  const t = transformManager.getTransform();

  const screenPts = pathPoints.map(p => ({
    x: p.x * t.scale + t.x + containerRect.left,
    y: p.y * t.scale + t.y + containerRect.top,
  }));

  const d = screenPts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
  pathPreviewPath.setAttribute('d', d);

  for (let i = 0; i < screenPts.length; i++) {
    if (i >= pathPreviewDots.length) {
      // Match the shape-edit anchor exactly (DEFAULT_ANCHOR_STYLE in
      // SvgPathEditor): size 8 (r=4), white fill, #2680EB stroke, 1.5 width, and
      // NO drop-shadow — the shadow was the "glow" that made these look different.
      const dot = document.createElementNS(SVG_NS, 'circle');
      dot.setAttribute('r', String(PATH_DOT_R));
      dot.setAttribute('fill', 'white');
      dot.setAttribute('stroke', PATH_ANCHOR_STROKE);
      dot.setAttribute('stroke-width', '1.5');
      pathPreviewSvg!.appendChild(dot);
      pathPreviewDots.push(dot);
    }
    pathPreviewDots[i].setAttribute('cx', String(screenPts[i].x));
    pathPreviewDots[i].setAttribute('cy', String(screenPts[i].y));
  }
}

function finishPath(callbacks: ShapeCreatorCallbacks, _containerRect: DOMRect, closed: boolean) {
  if (pathPoints.length < 2) {
    trace.action('path-creator:too-few-points', { count: pathPoints.length });
    cleanupPath();
    callbacks.onToolReset();
    return;
  }

  const xs = pathPoints.map(p => p.x);
  const ys = pathPoints.map(p => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);

  const nodeId = generateNodeId('path');
  // Tight bbox, NO padding — match the reference's output (viewBox == bbox, wrapper at
  // the bbox origin). The wrapper is overflow:visible, so an open path's 2px
  // stroke isn't clipped at the edge.
  const w = Math.max(Math.round(maxX - minX), 1);
  const h = Math.max(Math.round(maxY - minY), 1);
  const relPoints = pathPoints.map(p => ({ x: Math.round(p.x - minX), y: Math.round(p.y - minY) }));
  // `Z` closes the path into a filled shape (click-the-start gesture); an open
  // path stays a stroked line. Match the rest of the shape tools: closed = blue
  // fill + 0-width black stroke, open = no fill + blue stroke.
  // `Z` closes the outline; CLOSED vs OPEN only differ by that — both stay a
  // stroked path with NO fill (a closed path is still just an outline, not a
  // filled shape). Use the rect/ellipse tools to make filled shapes.
  const d = relPoints.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ') + (closed ? ' Z' : '');
  const fill = 'none';
  const stroke = DEFAULT_SHAPE_FILL;
  const strokeW = '2';

  const contentEl = callbacks.getContentEl();

  const styles: Record<string, string> = {
    position: 'absolute',
    width: `${w}px`,
    height: `${h}px`,
    overflow: 'visible',
    left: `${Math.round(minX)}px`,
    top: `${Math.round(minY)}px`,
  };

  const innerJSX = `<path d="${d}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeW}" />`;
  // Wrapper attrs (see createSvgNode comment): viewBox + preserveAspectRatio
  // so the path stretches with the parent on resize.
  const wrapperAttrs: Record<string, string> = {
    viewBox: `0 0 ${w} ${h}`,
    preserveAspectRatio: 'none',
  };

  const svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
  svg.setAttribute('data-node-id', nodeId);
  svg.setAttribute('data-id', nodeId);
  svg.setAttribute('data-name', 'Path');
  svg.setAttribute('data-canvas-node', 'true');
  svg.setAttribute('viewBox', wrapperAttrs.viewBox);
  svg.setAttribute('preserveAspectRatio', wrapperAttrs.preserveAspectRatio);
  for (const [key, value] of Object.entries(styles)) {
    try { (svg.style as any)[key] = value; } catch { /* skip */ }
  }
  const pathEl = document.createElementNS(SVG_NS, 'path');
  pathEl.setAttribute('d', d);
  pathEl.setAttribute('fill', fill);
  pathEl.setAttribute('stroke', stroke);
  pathEl.setAttribute('stroke-width', strokeW);
  svg.appendChild(pathEl);
  if (callbacks.onNodeMouseDown) {
    svg.addEventListener('mousedown', (me: MouseEvent) => {
      me.stopPropagation();
      callbacks.onNodeMouseDown!(nodeId, me);
    });
  }
  contentEl.appendChild(svg);

  // Tear down ONLY the preview overlay + its listeners now (purely visual, safe
  // anytime) — the full-screen dashed preview was what froze on top of the canvas.
  // Do NOT call onToolReset here: it flips the tool-mode atom and triggers a React
  // render that consumed the force-render flag BEFORE flushNow, so the iframe never
  // rebuilt and the new path only showed after a manual reload. Reset LAST instead.
  const pointCount = pathPoints.length;
  cleanupPath();

  injectNodeIntoCache({
    id: nodeId, type: 'svg', name: 'Path',
    parentId: null, children: [], styles, attrs: wrapperAttrs,
    textContent: innerJSX, hasMixedContent: true, order: 0,
    isCanvasNode: true,
    componentFile: null, componentInstanceId: null, isComponentRoot: false,
    motionVariants: null, motionVariantsRef: null, motionProps: null,
    responsiveVariantMap: null, conditionalStyles: null,
  });
  queueMutation({ type: 'addCanvasNode', node: { id: nodeId, type: 'svg', styles, attrs: wrapperAttrs, name: 'Path', textContent: innerJSX } });

  trace.action('path-creator:created', { nodeId, pointCount, closed, width: w, height: h });
  // See startShapeCreation: force render so iframe sandbox rebuilds with the new
  // SVG path child (parent-frame contentEl.appendChild is a no-op in iframe mode).
  // Keep setForceRender → flushNow ADJACENT and uninterrupted so the flag survives.
  setForceRender();
  flushNow();
  // Path creator only ever produces canvas-level nodes (data-canvas-node),
  // which live at the master/page canvas root — viewport is always the
  // primary 'desktop'.
  callbacks.onCreated(nodeId, 'desktop');
  // Tool reset — leave the path tool.
  callbacks.onToolReset();

  // DROP INTO THE FULL VERTEX EDITOR on the freshly-drawn path: setting
  // shapeEditingIdAtom mounts SvgEditorOverlay → startShapeEdit on the new node,
  // so the user immediately gets anchors + bézier handles + the Path/Curve/Stroke
  // panel to refine every point (and `P` re-enters the pen to add more). The
  // startShapeEdit rAF-retry covers the async iframe render of the just-committed
  // node.
  getDefaultStore().set(shapeEditingIdAtom, nodeId);
  trace.action('path-creator:enter-edit', { nodeId, closed });
}

function cleanupPath() {
  if (pathPreviewSvg) { pathPreviewSvg.remove(); pathPreviewSvg = null; }
  pathPreviewPath = null;
  pathPreviewDots = [];
  pathPoints = [];
  for (const fn of pathCleanupFns) fn();
  pathCleanupFns = [];
}

function startPathCreation(
  e: PointerEvent,
  callbacks: ShapeCreatorCallbacks,
): void {
  // PATH TOOL = the full vertex editor in PEN mode (the reference pen): place points AND
  // select / curve / drag existing vertices mid-draw. We seed a canvas <svg> sized
  // to the VISIBLE VIEWPORT (so the editor overlay covers the canvas and the pen
  // catches clicks anywhere — the 100px seed was why the prior attempt only drew
  // one segment), commit it, then enter shape-edit(pen). On exit the shape
  // normalizes to the drawn bbox, or deletes itself if nothing was drawn.
  const cr = callbacks.getContainerRect();
  const t = transformManager.getTransform();
  const start = screenToCanvas(e.clientX, e.clientY, t, cr);

  // Viewport rect in CANVAS units (1 viewBox unit = 1 canvas unit).
  const originCanvas = screenToCanvas(cr.left, cr.top, t, cr);
  const left = Math.round(originCanvas.x);
  const top = Math.round(originCanvas.y);
  const w = Math.max(Math.round(cr.width / (t.scale || 1)), 100);
  const h = Math.max(Math.round(cr.height / (t.scale || 1)), 100);
  // First vertex = the click, in the node's viewBox space (click - node origin).
  const seedX = Math.round(start.x - left);
  const seedY = Math.round(start.y - top);

  const nodeId = generateNodeId('path');
  const styles: Record<string, string> = {
    position: 'absolute',
    width: `${w}px`,
    height: `${h}px`,
    overflow: 'visible',
    left: `${left}px`,
    top: `${top}px`,
  };
  const wrapperAttrs: Record<string, string> = {
    viewBox: `0 0 ${w} ${h}`,
    preserveAspectRatio: 'none',
  };
  const innerJSX = `<path d="M${seedX},${seedY}" fill="none" stroke="${DEFAULT_PATH_STROKE}" stroke-width="1" />`;

  const contentEl = callbacks.getContentEl();
  const svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
  svg.setAttribute('data-node-id', nodeId);
  svg.setAttribute('data-id', nodeId);
  svg.setAttribute('data-name', 'Path');
  svg.setAttribute('data-canvas-node', 'true');
  svg.setAttribute('viewBox', wrapperAttrs.viewBox);
  svg.setAttribute('preserveAspectRatio', wrapperAttrs.preserveAspectRatio);
  for (const [k, v] of Object.entries(styles)) { try { (svg.style as any)[k] = v; } catch { /* skip */ } }
  const pathEl = document.createElementNS(SVG_NS, 'path');
  pathEl.setAttribute('d', `M${seedX},${seedY}`);
  pathEl.setAttribute('fill', 'none');
  pathEl.setAttribute('stroke', DEFAULT_PATH_STROKE);
  pathEl.setAttribute('stroke-width', '1');
  svg.appendChild(pathEl);
  contentEl.appendChild(svg);

  injectNodeIntoCache({
    id: nodeId, type: 'svg', name: 'Path',
    parentId: null, children: [], styles, attrs: wrapperAttrs,
    textContent: innerJSX, hasMixedContent: true, order: 0,
    isCanvasNode: true,
    componentFile: null, componentInstanceId: null, isComponentRoot: false,
    motionVariants: null, motionVariantsRef: null, motionProps: null,
    responsiveVariantMap: null, conditionalStyles: null,
  });
  queueMutation({ type: 'addCanvasNode', node: { id: nodeId, type: 'svg', styles, attrs: wrapperAttrs, name: 'Path', textContent: innerJSX } });
  setForceRender();
  flushNow();
  callbacks.onCreated(nodeId, 'desktop');

  // Enter the full editor in PEN mode on the seed node.
  const store = getDefaultStore();
  // Drop any vertex-selection lingering from a PREVIOUS path-edit so starting a
  // new path doesn't leave the old one looking selected. These atoms only drive
  // the vertex-info panel — clearing them is harmless and (unlike clearing
  // selectedIdsAtom) cannot trip the watcher that exits shape-edit mode.
  store.set(selectedPointAtom, null);
  store.set(selectedAnchorInfoAtom, null);
  store.set(shapeEditPenModeAtom, true);
  store.set(shapeEditCreatedNodeAtom, nodeId);
  store.set(shapeEditingIdAtom, nodeId);

  callbacks.onToolReset();
  trace.action('path-creator:pen-seed', { nodeId, w, h, seedX, seedY });
}
