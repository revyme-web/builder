// SketchCreator.ts — Single-stroke sketch creator. The user's first
// pointerdown after activating the Sketch tool starts capturing a
// brush stroke immediately (no drag-to-create-rect step); on
// pointerup the captured points run through perfect-freehand and
// land as a `<path>` child inside a newly-created `<svg
// data-sketch="true">` wrapper sized to the stroke's bounding box.
// Then `sketchEditingIdAtom` is set so SketchEditOverlay mounts and
// any subsequent strokes go INSIDE that wrapper.
//
// This is the Procreate / Excalidraw / tldraw model: the canvas
// adapts to what you draw, you don't define the canvas first. We
// originally had a drag-create-rect step (mirroring FrameCreator)
// for consistency with revyme's other creators, but it produced the
// "wrapper smaller than visible strokes" double-rect confusion when
// strokes overflowed the initial rect via `overflow: visible`. With
// the wrapper born sized-to-stroke, the wrapper bounds ARE the
// stroke bounds — selection box and drawable area always coincide
// at edit-mode entry, no double-rect.
//
// Subsequent strokes during the same edit session can still extend
// past the wrapper (`overflow: visible`); auto-fit-on-exit (in
// SketchEditOverlay) snaps the wrapper to enclose them so the
// selection box matches stroke bounds the next time the user comes
// back to the sketch.

import { transformManager } from '@/canvas/transform';
import { screenToCanvas, absoluteToRelativeById } from '@/canvas/canvas-math';
import { vpIdFromPrefix, getActiveFilePath } from '@/canvas/node-ops';
import { isComponentFilePath } from '@/code/project/active-file-store';
import { attachDragListeners } from '@/shared/dom-utils';
import { queueMutation, flushNow, setForceRender } from '@/code/mutation/mutation-queue';
import { getDefaultStore } from 'jotai';
import { brushConfigAtom, buildStrokeOptions, pointsToAttr, pointsFromAttr, readSvgAttr } from '@/code/stores/sketch-edit-store';
import { getStroke } from 'perfect-freehand';
import {
  findParentAtPoint,
  getInsertionMode,
  ensureAbsChildContainingBlock,
  getFlexInsertIndex,
  queueCreatorFlexOrder,
  queueReplicaCreationUnhide,
  buildParentScreenMap,
  invertAffine,
  holdCreationPlaceholder,
} from './creator-utils';
import { generateNodeId } from '@/shared/id-utils';
import { SELECTION_COLOR } from '@/shared/constants';
import { injectNodeIntoCache } from '@/code/stores/store';
import { trace } from '@/shared/debug-trace';
import type { CanvasNode } from '@/code/parsing/parser';

const SVG_NS = 'http://www.w3.org/2000/svg';
const MIN_POINTS = 2;
// Wrapper bbox padding around the stroke. Was 6px to give the wrapper
// "breathing room" around the strokes — but that 6px showed up
// EVERYWHERE the wrapper drives behavior the user can see: snap
// targets aligned to wrapper edges (so a sketch dragged near another
// element would visually stop ~6px short — wrapper edges touched but
// strokes didn't), inline `data-id` anchor reads against the wrapper,
// resize handles drawn at wrapper corners. Vector sets don't pad
// their wrappers and snap pixel-perfect; setting this to 0 makes
// sketches behave the same. Stroke extent (brush half-width) is
// already baked into `bounds` via `outlineBounds(outlineCanvas)`,
// so a tight wrapper still encloses the visible stroke.
const STROKE_PAD = 0;
const PREVIEW_STROKE_COLOR = SELECTION_COLOR;

export interface SketchCreatorCallbacks {
  getContainerRect: () => DOMRect;
  getContentEl: () => HTMLElement;
  getNodes: () => Map<string, CanvasNode>;
  onCreated: (nodeId: string, vpId: string) => void;
  onToolReset: () => void;
  getViewportWidth: (vpId: string) => number;
  onNodeMouseDown?: (nodeId: string, e: MouseEvent) => void;
}

let cleanupFn: (() => void) | null = null;
let previewSvgEl: SVGSVGElement | null = null;
let previewPathEl: SVGPathElement | null = null;

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Convert a perfect-freehand outline polygon to an SVG `d` string. */
function outlineToPathD(outline: number[][]): string {
  if (outline.length === 0) return '';
  let d = `M ${outline[0][0].toFixed(2)} ${outline[0][1].toFixed(2)}`;
  for (let i = 1; i < outline.length; i++) {
    d += ` L ${outline[i][0].toFixed(2)} ${outline[i][1].toFixed(2)}`;
  }
  d += ' Z';
  return d;
}

/** Bounding box of a flat outline polygon. Returns null for empty. */
function outlineBounds(outline: number[][]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (outline.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of outline) {
    if (p[0] < minX) minX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] > maxY) maxY = p[1];
  }
  if (minX === Infinity) return null;
  return { minX, minY, maxX, maxY };
}

/** Translate every (x, y) pair in a perfect-freehand-shaped d string
 *  by (dx, dy). The d only contains M / L / Z + numbers, so a token
 *  pass is sufficient and fast. Returns the rebuilt d. */
function translatePathD(d: string, dx: number, dy: number): string {
  const tokens = d.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === 'M' || t === 'L') {
      out.push(t);
      const x = parseFloat(tokens[i + 1]);
      const y = parseFloat(tokens[i + 2]);
      out.push((x + dx).toFixed(2));
      out.push((y + dy).toFixed(2));
      i += 2;
    } else if (t === 'Z' || t === 'z') {
      out.push(t);
    } else {
      // Defensive — shouldn't see anything else from our generator.
      out.push(t);
    }
  }
  return out.join(' ');
}

// ─── Imperative SVG wrapper construction ──────────────────────────────────

function createSketchWrapper(
  nodeId: string,
  styles: Record<string, string>,
  viewBoxW: number,
  viewBoxH: number,
  innerJSX: string,
  onMouseDown?: (nodeId: string, e: MouseEvent) => void,
): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
  svg.setAttribute('data-node-id', nodeId);
  svg.setAttribute('data-id', nodeId);
  svg.setAttribute('data-name', 'Sketch');
  svg.setAttribute('data-sketch', 'true');
  svg.setAttribute('viewBox', `0 0 ${Math.round(viewBoxW)} ${Math.round(viewBoxH)}`);
  svg.setAttribute('preserveAspectRatio', 'none');

  for (const [key, value] of Object.entries(styles)) {
    try { (svg.style as any)[key] = value; } catch { /* skip */ }
  }

  // Imperatively reflect the inner stroke so the user sees their
  // first stroke instantly without waiting for a Renderer cycle.
  // Renderer will rebuild from `node.textContent` next render.
  svg.innerHTML = innerJSX;

  if (onMouseDown) {
    svg.addEventListener('mousedown', (e: MouseEvent) => {
      e.stopPropagation();
      onMouseDown(nodeId, e);
    });
  }

  return svg;
}

// ─── Main entry point ─────────────────────────────────────────────────────

export function startSketchCreation(
  e: PointerEvent,
  callbacks: SketchCreatorCallbacks,
): void {
  const containerRect = callbacks.getContainerRect();
  const contentEl = callbacks.getContentEl();
  const nodes = callbacks.getNodes();
  const transform = transformManager.getTransform();
  const brush = getDefaultStore().get(brushConfigAtom);

  const parent = findParentAtPoint(e.clientX, e.clientY, nodes);
  const vpId = parent ? vpIdFromPrefix(parent.vpPrefix) : 'desktop';
  const isReplica = parent ? parent.vpPrefix !== '' : false;
  const isCanvasNode = !parent;

  trace.action('sketch-creator:start', {
    vpId, isReplica,
    parentId: parent?.nodeId ?? 'root',
  });

  // Local-coord drawing setup. When the parent has a transform, we
  // author the stroke in PARENT-LOCAL space so the stored points
  // (and the wrapper's left/top) stay correct under rotation. Falls
  // back to canvas-space for canvas-level sketches or parents
  // without a usable transform map.
  const parentMap = parent ? buildParentScreenMap(parent.nodeId, vpId) : null;
  const parentMapInv = parentMap ? invertAffine(parentMap) : null;
  const useLocalSpace = !!(parentMap && parentMapInv);

  // Capture pointer points in the active drawing space:
  //   - useLocalSpace ON  → parent-local coords (per-axis units of the
  //     parent's offsetWidth/Height)
  //   - useLocalSpace OFF → canvas coords (legacy behaviour)
  // The bbox math, viewBox derivation, and inner stroke path
  // generation downstream are coordinate-system-agnostic — they
  // operate on whatever units the points are in. Only the wrapper's
  // committed `left/top` differs (parent-local vs canvas), handled
  // explicitly in the commit branch.
  const pointsCanvas: number[][] = [];
  const startCanvas = screenToCanvas(e.clientX, e.clientY, transform, containerRect);
  const startPoint = useLocalSpace && parentMapInv
    ? parentMapInv.invertScreen(e.clientX, e.clientY)
    : startCanvas;
  pointsCanvas.push([startPoint.x, startPoint.y, e.pressure || 0.5]);

  // Screen-space preview SVG so the user sees their stroke as they
  // drag. Same pattern ShapeCreator's path-tool uses — fixed-position
  // overlay covering the viewport, redrawn on each pointermove.
  previewSvgEl = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
  previewSvgEl.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;z-index:1000;overflow:visible;';
  previewPathEl = document.createElementNS(SVG_NS, 'path');
  previewPathEl.setAttribute('fill', brush.color || PREVIEW_STROKE_COLOR);
  previewSvgEl.appendChild(previewPathEl);
  document.body.appendChild(previewSvgEl);

  /** Re-render the preview path from the current points.
   *  - Local-space path: project each stored parent-local point back
   *    to screen via the parent map (live-rebuild every frame so live
   *    edits to the parent's transform don't desync). The stroke's
   *    width is scaled by the parent's basis length so the visual
   *    thickness matches what the wrapper will render after commit.
   *  - Canvas-space path: original canvas→screen projection (matches
   *    the legacy preview behaviour). */
  const refreshPreview = () => {
    if (!previewPathEl) return;

    if (useLocalSpace && parentMap) {
      const liveMap = buildParentScreenMap(parent!.nodeId, vpId) ?? parentMap;
      const screenPts = pointsCanvas.map(p => [
        liveMap.ox + liveMap.ux * p[0] + liveMap.vx * p[1],
        liveMap.oy + liveMap.uy * p[0] + liveMap.vy * p[1],
        p[2],
      ]);
      // Basis length tells us the screen pixels-per-local-unit, so
      // multiplying the brush size by it keeps the stroke the same
      // visual thickness as the parent's content rendering scale.
      const basisLen = Math.hypot(liveMap.ux, liveMap.uy);
      const outline = getStroke(screenPts, buildStrokeOptions(brush, brush.size * basisLen));
      previewPathEl.setAttribute('d', outlineToPathD(outline));
      return;
    }

    const t = transformManager.getTransform();
    const cr = callbacks.getContainerRect();
    const screenPts = pointsCanvas.map(p => [
      p[0] * t.scale + t.x + cr.left,
      p[1] * t.scale + t.y + cr.top,
      p[2],
    ]);
    const outline = getStroke(screenPts, buildStrokeOptions(brush, brush.size * t.scale));
    previewPathEl.setAttribute('d', outlineToPathD(outline));
  };
  refreshPreview();

  cleanupFn = attachDragListeners({
    startX: e.clientX,
    startY: e.clientY,
    threshold: 0,

    onMove: (_dx, _dy, moveEvent) => {
      const t = transformManager.getTransform();
      const cr = callbacks.getContainerRect();
      // Capture each point in the active drawing space. Local-space
      // maps each screen cursor to parent-local via the live map;
      // canvas-space falls back to the legacy screen→canvas projection.
      if (useLocalSpace && parentMapInv) {
        const liveMap = buildParentScreenMap(parent!.nodeId, vpId) ?? parentMap!;
        const liveInv = invertAffine(liveMap) ?? parentMapInv;
        const lp = liveInv.invertScreen(moveEvent.clientX, moveEvent.clientY);
        pointsCanvas.push([lp.x, lp.y, moveEvent.pressure || 0.5]);
      } else {
        const cp = screenToCanvas(moveEvent.clientX, moveEvent.clientY, t, cr);
        pointsCanvas.push([cp.x, cp.y, moveEvent.pressure || 0.5]);
      }
      refreshPreview();
    },

    onUp: (_upEvent) => {
      // Keep the preview stroke as a commit-gap placeholder (see holdCreationPlaceholder).
      // Capture the PATH's rect now (the host <svg> is full-viewport, so its own
      // box is useless for seeding).
      const placeholder = previewSvgEl; previewSvgEl = null;
      const placeholderPathRect = previewPathEl?.getBoundingClientRect();
      previewPathEl = null;
      cleanupFn = null;

      if (pointsCanvas.length < MIN_POINTS) {
        trace.action('sketch-creator:too-short', { count: pointsCanvas.length });
        placeholder?.remove();
        callbacks.onToolReset();
        return;
      }

      // Compute the final stroke outline in CANVAS coords. Brush
      // size is in canvas units (un-scaled) so the stored stroke
      // geometry is zoom-independent.
      const outlineCanvas = getStroke(pointsCanvas, buildStrokeOptions(brush));
      const bounds = outlineBounds(outlineCanvas);
      if (!bounds) {
        trace.action('sketch-creator:empty-outline');
        placeholder?.remove();
        callbacks.onToolReset();
        return;
      }

      // Translate the outline into wrapper-local viewBox coords with
      // a small pad. Wrapper CSS box matches viewBox 1:1 at creation
      // time so 1 viewBox unit = 1 CSS pixel — clean baseline for
      // auto-fit math during edit mode.
      const dxToLocal = -bounds.minX + STROKE_PAD;
      const dyToLocal = -bounds.minY + STROKE_PAD;
      const vbW = (bounds.maxX - bounds.minX) + STROKE_PAD * 2;
      const vbH = (bounds.maxY - bounds.minY) + STROKE_PAD * 2;
      const localOutline = outlineCanvas.map(p => [p[0] + dxToLocal, p[1] + dyToLocal]);
      const strokeD = outlineToPathD(localOutline);
      // Persist the INPUT points (not the outline) translated into the
      // same wrapper-local viewBox coordinate space the outline lives
      // in. Re-running getStroke from these on a brush change yields a
      // new outline anchored in the same local space, so the live
      // re-sync only needs to update path d-attrs without recomputing
      // any coordinate transforms.
      const localInputPoints = pointsCanvas.map(p => [
        p[0] + dxToLocal, p[1] + dyToLocal, p[2],
      ]);
      // Stroke outline only when the user actually configured one
      // (width > 0). Skipping the attrs when zero keeps the emitted
      // JSX minimal and avoids `stroke-width="0"` lint noise.
      const strokeAttrs = brush.strokeWidth > 0
        ? ` stroke="${brush.strokeColor}" stroke-width="${brush.strokeWidth}"`
        : '';
      const innerJSX = `<path d="${strokeD}" fill="${brush.color}"${strokeAttrs} data-points="${pointsToAttr(localInputPoints)}" />`;

      // Wrapper canvas-space top-left = bounds top-left minus pad.
      const canvasLeft = bounds.minX - STROKE_PAD;
      const canvasTop = bounds.minY - STROKE_PAD;

      const nodeId = generateNodeId('sketch');
      const roundedW = Math.round(vbW);
      const roundedH = Math.round(vbH);

      const styles: Record<string, string> = {
        position: 'absolute',
        width: `${roundedW}px`,
        height: `${roundedH}px`,
        // overflow: visible lets in-progress strokes during edit
        // mode extend past the wrapper. Auto-fit-on-exit snaps the
        // wrapper back to enclose them when the user leaves edit
        // mode, so this is only a transient state.
        overflow: 'visible',
        left: `${Math.round(canvasLeft)}px`,
        top: `${Math.round(canvasTop)}px`,
      };

      const wrapperAttrs: Record<string, string> = {
        viewBox: `0 0 ${roundedW} ${roundedH}`,
        preserveAspectRatio: 'none',
        'data-sketch': 'true',
      };

      if (isCanvasNode) {
        trace.action('sketch-creator:commit-canvas', {
          nodeId, vbW: roundedW, vbH: roundedH,
          left: Math.round(canvasLeft), top: Math.round(canvasTop),
        });

        const svgEl = createSketchWrapper(nodeId, styles, roundedW, roundedH, innerJSX, callbacks.onNodeMouseDown);
        contentEl.appendChild(svgEl);

        injectNodeIntoCache({
          id: nodeId, type: 'svg', name: 'Sketch', parentId: null,
          children: [], styles, attrs: wrapperAttrs,
          textContent: innerJSX, hasMixedContent: false, order: 0,
          isCanvasNode: true,
          componentFile: null, componentInstanceId: null, isComponentRoot: false,
          motionVariants: null, motionVariantsRef: null, motionProps: null,
          responsiveVariantMap: null, conditionalStyles: null,
        });

        queueMutation({
          type: 'addCanvasNode',
          node: { id: nodeId, type: 'svg', styles, attrs: wrapperAttrs, name: 'Sketch', textContent: innerJSX },
        });
      } else {
        const parentId = parent!.nodeId;
        let insertIndex: number | undefined;

        const t2 = transformManager.getTransform();
        const mode = getInsertionMode(parentId, vpId);
        if (mode === 'absolute') {
          // The left/top below are relative to THIS parent, so the parent has
          // to be the containing block that resolves them.
          ensureAbsChildContainingBlock(parentId, vpId, contentEl);
          // When points were captured in parent-local space, the
          // bbox-derived `canvasLeft/canvasTop` are ALREADY parent-
          // relative — no subtraction needed (the variable name is
          // legacy from the canvas-space-only era). For canvas-space
          // capture, fall back to the AABB subtraction.
          if (useLocalSpace) {
            styles.left = `${Math.round(canvasLeft)}px`;
            styles.top = `${Math.round(canvasTop)}px`;
          } else {
            const rel = absoluteToRelativeById(canvasLeft, canvasTop, parentId, vpId, t2);
            styles.left = `${Math.round(rel.x)}px`;
            styles.top = `${Math.round(rel.y)}px`;
          }
        } else {
          styles.position = 'relative';
          delete styles.left;
          delete styles.top;
          const centerX = canvasLeft + roundedW / 2;
          const centerY = canvasTop + roundedH / 2;
          insertIndex = getFlexInsertIndex(parentId, vpId, centerX, centerY, t2, mode as any);
        }

        // Skip inline display:'none' on component masters — AnimatePresence
        // conditional render handles per-variant visibility there.
        if (isReplica && !isComponentFilePath(getActiveFilePath())) {
          styles.display = 'none';
        }

        trace.action('sketch-creator:commit-viewport', {
          nodeId, parentId, position: styles.position, isReplica, insertIndex,
        });

        const svgEl = createSketchWrapper(nodeId, styles, roundedW, roundedH, innerJSX, callbacks.onNodeMouseDown);
        contentEl.appendChild(svgEl);

        injectNodeIntoCache({
          id: nodeId, type: 'svg', name: 'Sketch', parentId,
          children: [], styles, attrs: wrapperAttrs,
          textContent: innerJSX, hasMixedContent: false, order: 0,
          isCanvasNode: false,
          componentFile: null, componentInstanceId: null, isComponentRoot: false,
          motionVariants: null, motionVariantsRef: null, motionProps: null,
          responsiveVariantMap: null, conditionalStyles: null,
        });

        queueMutation({
          type: 'addNode', parentId,
          node: { id: nodeId, type: 'svg', styles, attrs: wrapperAttrs, name: 'Sketch', textContent: innerJSX },
          index: insertIndex,
        });

        // Renumber flex `order` so an explicitly-ordered parent places the new
        // node at the DRAWN flow position (no-op when no sibling has `order`).
        if (mode !== 'absolute' && insertIndex !== undefined) {
          queueCreatorFlexOrder(parentId, vpId, insertIndex, nodeId, mode as 'flex-row' | 'flex-column' | 'grid', contentEl);
        }

        if (isReplica) {
          queueReplicaCreationUnhide(nodeId, vpId, callbacks.getViewportWidth(vpId));
        }
      }

      // Hold the stroke placeholder over the ~0.3s rebuild + seed the path rect for instant select.
      holdCreationPlaceholder(nodeId, parent?.vpPrefix ?? '', placeholder, styles, placeholderPathRect);
      setForceRender();
      flushNow();

      // One-shot sketch: a single stroke IS the sketch. Commit and drop straight
      // back to Select (onToolReset) — NO multi-stroke edit session (it was buggy
      // / confusing). The wrapper is already tight around the outline
      // (outlineBounds + pad), and onCreated selects it, so the right-panel
      // SketchTool can still tweak the brush of the selected sketch.
      trace.action('sketch-creator:created', {
        nodeId, vbW: roundedW, vbH: roundedH, strokePoints: pointsCanvas.length,
      });

      callbacks.onCreated(nodeId, vpId);
      callbacks.onToolReset();
    },
  });
}

// ─── Auto-fit on edit-exit ─────────────────────────────────────────────────

/** Recompute a sketch wrapper's viewBox + width / height / left / top
 *  to enclose every stroke child, translating each stroke's d to the
 *  new origin. Called by SketchEditOverlay when the user exits edit
 *  mode (Escape, click outside, tool switch) so the wrapper's
 *  selection bounds match the rendered strokes when not editing.
 *
 *  Strategy: parse every child `<path>`'s d attribute, compute the
 *  union bbox in current viewBox coords, normalize so the union
 *  starts at (PAD, PAD), update wrapper attrs / styles to match.
 *
 *  No-op when the wrapper has no stroke children, or when the
 *  current viewBox already encloses every stroke (no overflow case
 *  to clean up). */
export function autoFitSketchOnExit(
  nodeId: string,
  nodes: Map<string, CanvasNode>,
): void {
  const node = nodes.get(nodeId);
  if (!node) return;

  type StrokeEntry = { childId: string; d: string };
  const strokes: StrokeEntry[] = [];
  for (const childId of node.children ?? []) {
    const child = nodes.get(childId);
    if (!child || child.type !== 'path') continue;
    const d = child.attrs?.d;
    if (!d) continue;
    strokes.push({ childId, d });
  }
  if (strokes.length === 0) {
    trace.action('sketch:autofit-no-strokes', { nodeId });
    return;
  }

  // Parse current viewBox (always `0 0 W H` from creator/autofit —
  // we don't support translated viewBox origins here).
  const vb = (node.attrs?.viewBox || '').trim().split(/\s+/).map(Number);
  if (vb.length !== 4 || vb.some(n => !Number.isFinite(n))) {
    trace.error('sketch:autofit-bad-viewbox', { nodeId, viewBox: node.attrs?.viewBox });
    return;
  }
  const [, , vbW, vbH] = vb;

  // Compute union bbox over all strokes.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of strokes) {
    const nums = s.d.match(/-?\d+(?:\.\d+)?/g);
    if (!nums) continue;
    for (let i = 0; i + 1 < nums.length; i += 2) {
      const x = parseFloat(nums[i]);
      const y = parseFloat(nums[i + 1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (minX === Infinity) return;

  // Decide whether autoFit is needed. Target end-state: viewBox is
  // `0 0 newW newH` where strokes start at (PAD, PAD) and end at
  // (PAD + spanX, PAD + spanY). If we're already there within
  // half-a-pixel, bail without queuing mutations.
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const newVbW = spanX + STROKE_PAD * 2;
  const newVbH = spanY + STROKE_PAD * 2;
  const dx = -minX + STROKE_PAD;
  const dy = -minY + STROKE_PAD;
  const tightAlready =
    Math.abs(minX - STROKE_PAD) < 0.5 &&
    Math.abs(minY - STROKE_PAD) < 0.5 &&
    Math.abs(newVbW - vbW) < 0.5 &&
    Math.abs(newVbH - vbH) < 0.5;
  if (tightAlready) {
    trace.action('sketch:autofit-already-tight', { nodeId });
    return;
  }

  // Wrapper CSS shift. Pre-refit ratio is wrapperWidth / vbW; we
  // assume the wrapper hasn't been resized non-uniformly (typical
  // case — user just drew, hasn't touched resize handles yet). The
  // wrapper's CSS top-left corresponds to viewBox (0, 0). After
  // refit, the new (0, 0) is `(STROKE_PAD - dx)` away from the old
  // (0, 0) in viewBox coords; convert to CSS pixels via the
  // ratio (which we preserve across the refit).
  const styleW = parseFloat(node.styles?.width || `${vbW}`) || vbW;
  const styleH = parseFloat(node.styles?.height || `${vbH}`) || vbH;
  const ratioX = styleW / vbW;
  const ratioY = styleH / vbH;
  const styleLeft = parseFloat(node.styles?.left || '0') || 0;
  const styleTop = parseFloat(node.styles?.top || '0') || 0;
  const newLeft = styleLeft + (minX - STROKE_PAD) * ratioX;
  const newTop = styleTop + (minY - STROKE_PAD) * ratioY;
  const newStyleW = newVbW * ratioX;
  const newStyleH = newVbH * ratioY;

  // Build the new innerJSX with translated strokes. `replaceSvgInner`
  // swaps the entire child tree in one mutation.
  //
  // What we MUST preserve across the refit, in addition to the d
  // attribute:
  //   - `fill` — per-stroke color (a sketch can have strokes of
  //     different colors if the user changed the brush mid-edit)
  //   - `stroke` / `stroke-width` — outline ring around each stroke
  //   - `data-points` — raw input samples in the SAME local viewBox
  //     space the d's live in. They get translated by the same dx/dy
  //     so the live-resync logic later finds them in the post-refit
  //     coordinate frame (otherwise re-running getStroke on points in
  //     the OLD frame would render strokes outside the new viewBox).
  // `readSvgAttr` accepts either kebab or camelCase form. Some
  // round-trips through Babel re-emit hyphenated attrs as camelCase;
  // reading both forms keeps autoFit from silently stripping
  // `data-points` when the parser captured it as `dataPoints`.
  // Stripping was the source of "old strokes detached from the brush
  // controls" — once data-points was gone, the live-sync engine had
  // nothing to replay and could only update colors, not geometry.
  const translatedPaths: string[] = [];
  for (const s of strokes) {
    const child = nodes.get(s.childId);
    const newD = translatePathD(s.d, dx, dy);
    const fill = child?.attrs?.fill || '#000000';
    const stroke = readSvgAttr(child?.attrs, 'stroke');
    const strokeW = readSvgAttr(child?.attrs, 'stroke-width');
    let strokeAttrs = '';
    if (stroke && strokeW) {
      strokeAttrs = ` stroke="${stroke}" stroke-width="${strokeW}"`;
    }
    let pointsAttr = '';
    const rawPoints = readSvgAttr(child?.attrs, 'data-points');
    if (rawPoints) {
      const translated = pointsFromAttr(rawPoints).map(p => [p[0] + dx, p[1] + dy, p[2]]);
      pointsAttr = ` data-points="${pointsToAttr(translated)}"`;
    }
    translatedPaths.push(`<path d="${newD}" fill="${fill}"${strokeAttrs}${pointsAttr} />`);
  }
  const innerJSX = translatedPaths.join('\n');

  trace.action('sketch:autofit', {
    nodeId,
    oldVb: { w: vbW, h: vbH }, newVb: { w: newVbW, h: newVbH },
    oldStyle: { left: styleLeft, top: styleTop, w: styleW, h: styleH },
    newStyle: { left: newLeft, top: newTop, w: newStyleW, h: newStyleH },
    strokeCount: strokes.length,
  });

  setForceRender();
  queueMutation({ type: 'replaceSvgInner', nodeId, innerJSX });
  queueMutation({
    type: 'updateHtmlAttrs', nodeId,
    attrs: {
      viewBox: `0 0 ${Math.round(newVbW)} ${Math.round(newVbH)}`,
      'preserveAspectRatio': 'none',
      'data-sketch': 'true',
    },
  });
  queueMutation({
    type: 'updateStyles', nodeId,
    styles: {
      width: `${Math.round(newStyleW)}px`,
      height: `${Math.round(newStyleH)}px`,
      left: `${Math.round(newLeft)}px`,
      top: `${Math.round(newTop)}px`,
    },
  });
  flushNow();
}
