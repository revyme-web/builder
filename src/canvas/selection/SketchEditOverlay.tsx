// SketchEditOverlay.tsx — Parent-frame brush-stroke capture overlay for
// the active `<svg data-sketch="true">` wrapper.
//
// Lifecycle:
//   1. Mounts when `sketchEditingIdAtom !== null`. RAF-polls
//      `findNodeRect` so the overlay tracks the iframe-hosted wrapper as
//      the canvas pans/zooms.
//   2. Captures pointerdown → pointermove → pointerup. Per-frame the
//      stroke preview re-renders as a fat SVG `<path>` inside the
//      overlay so the user sees the brush they're drawing live (no
//      iframe round-trip per pointermove).
//   3. On pointerup the captured points run through `getStroke()`
//      (perfect-freehand) to get an outline polygon → SVG path
//      `M x,y L x,y ... Z` → committed as an `addSvgChild` mutation
//      against the wrapper. The iframe re-renders the wrapper with the
//      new `<path>` child via the normal Renderer cycle. No new bridge
//      methods needed.
//   4. Outside-click / Escape clears `sketchEditingIdAtom` → overlay
//      unmounts. (Inside-the-overlay pointer events stay captured by
//      the overlay itself, so they never reach the canvas's
//      outside-click handler.)
//
// Coordinate handling: pointer events arrive in screen coords. The
// wrapper has a fixed `viewBox="0 0 W0 H0"` from creation time but its
// CSS width/height can change after resize. To keep strokes scaling
// predictably with the wrapper (resize → strokes stretch via viewBox),
// we convert pointer screen coords → wrapper-local viewBox coords by
// ratio. So a stroke drawn at "the middle of the wrapper now" stays at
// "the middle of the wrapper" after the user resizes.
//
// Why parent-frame instead of iframe-hosted (like SvgEditorOverlay):
// SvgEditorOverlay needs the iframe-side editor for its anchor handles
// and live segment hover. Sketch-edit is just pointer capture + path
// math + one mutation — no per-element handles to drag, no segment-
// hover, no need for the overlay's pointer events to share a coord
// space with the SVG content. Parent-side keeps it small (~150 LOC)
// and avoids a new bridge protocol.

import { useEffect, useRef, useState } from 'react';
import { nextFrames } from '@/shared/dom-utils';
import { useAtomValue, useSetAtom } from 'jotai';
import { getDefaultStore } from 'jotai';
import { getStroke } from 'perfect-freehand';
import { sketchEditingIdAtom, brushConfigAtom, buildStrokeOptions, pointsToAttr, type BrushConfig } from '@/code/stores/sketch-edit-store';
import { toolModeAtom } from '@/code/stores/tool-store';
import { findNodeRect } from '@/canvas/node-ops';
import { interactingViewportIdAtom } from '@/code/stores/viewport-store';
import { nodesAtom, getNodesSnapshot } from '@/code/stores/store';
import { queueMutation, flushNow, setForceRender } from '@/code/mutation/mutation-queue';
import { autoFitSketchOnExit } from '@/canvas/creators/SketchCreator';
import { trace } from '@/shared/debug-trace';

interface ScreenRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface ViewBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Parse `viewBox="0 0 W H"` → { x, y, width, height }. Falls back to
 *  using the wrapper's screen size when the attribute is missing or
 *  malformed (which would only happen for hand-edited code). */
function parseViewBox(attr: string | undefined, fallbackW: number, fallbackH: number): ViewBox {
  if (!attr) return { x: 0, y: 0, width: fallbackW, height: fallbackH };
  const parts = attr.trim().split(/\s+/).map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isFinite(n))) {
    return { x: 0, y: 0, width: fallbackW, height: fallbackH };
  }
  return { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
}

/** Convert a perfect-freehand outline (closed polygon of points) to
 *  an SVG path `d` attribute. Standard one-line conversion every
 *  perfect-freehand demo uses. */
function outlineToPathD(outline: number[][]): string {
  if (outline.length === 0) return '';
  let d = `M ${outline[0][0].toFixed(2)} ${outline[0][1].toFixed(2)}`;
  for (let i = 1; i < outline.length; i++) {
    d += ` L ${outline[i][0].toFixed(2)} ${outline[i][1].toFixed(2)}`;
  }
  d += ' Z';
  return d;
}


export default function SketchEditOverlay() {
  const editingId = useAtomValue(sketchEditingIdAtom);
  const setEditingId = useSetAtom(sketchEditingIdAtom);
  const vpId = useAtomValue(interactingViewportIdAtom);
  // No whole-map subscription: the viewBox setup below reads a fresh
  // imperative snapshot when the effect (re)arms — commits elsewhere no
  // longer restart the RAF poll or re-render the overlay.
  const brush = useAtomValue(brushConfigAtom);

  const [rect, setRect] = useState<ScreenRect | null>(null);
  // Live preview path — refreshed on each pointermove during drawing.
  // null when no stroke is in progress.
  const [previewD, setPreviewD] = useState<string | null>(null);

  // Refs for state that's read inside pointer handlers (which are bound
  // for the lifetime of a single stroke and need the LATEST values).
  const pointsRef = useRef<number[][]>([]);
  const isDrawingRef = useRef(false);
  const brushRef = useRef<BrushConfig>(brush);
  brushRef.current = brush;

  // The wrapper's viewBox — drawn once per editingId change so strokes
  // get authored in viewBox coords (and naturally scale on later resize).
  const viewBoxRef = useRef<ViewBox>({ x: 0, y: 0, width: 0, height: 0 });

  // AutoFit-on-exit: when `editingId` flips back to null, we need to
  // run `autoFitSketchOnExit` on the ID that WAS being edited so the
  // wrapper snaps to enclose every stroke (incl. ones drawn during
  // this session that overflowed via `overflow: visible`). React
  // doesn't give us the previous prop value directly — track it in a
  // ref synced AFTER each render so the next-cleanup-or-effect tick
  // can read the OLD id while `editingId` already shows the new
  // value (null on exit). Same trick as the textEditCommitFromIframeRef
  // pattern in Canvas.tsx.
  const prevEditingIdRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevEditingIdRef.current;
    if (prev && prev !== editingId) {
      // editingId changed (either cleared OR jumped to a different
      // sketch). Run autoFit on the one that was just left so the
      // user comes back to a tight selection box, not a rectangle
      // smaller than their actual drawing.
      // Read nodes via getDefaultStore so we get the freshest value
      // post-flush — pulling from the closure's `nodes` would lose
      // any strokes committed in the same tick as the exit.
      const freshNodes = getDefaultStore().get(nodesAtom);
      autoFitSketchOnExit(prev, freshNodes);
    }
    prevEditingIdRef.current = editingId;
  }, [editingId]);

  // Tool-switch exit: if the user picks any tool other than 'select'
  // while in sketch-edit mode, clear the sketch atom. With the
  // full-viewport pointer capture, clicking the toolbar is the
  // user's main "I'm done drawing" gesture; without this hook they'd
  // pick e.g. the Frame tool and still be trapped in sketch-edit.
  // 'select' is allowed to coexist because it's the natural state
  // post-creation and shouldn't kick the user out mid-stroke.
  const toolMode = useAtomValue(toolModeAtom);
  useEffect(() => {
    if (!editingId) return;
    if (toolMode !== 'select' && toolMode !== 'sketch') {
      trace.action('sketch-edit:tool-switch-exit', { editingId, toolMode });
      setEditingId(null);
    }
  }, [toolMode, editingId, setEditingId]);

  // Track the wrapper's screen rect via RAF poll. The iframe rect cache
  // updates on every render cycle; we just mirror it into local state
  // so the overlay's CSS positioning follows pan/zoom + any inadvertent
  // resize during edit mode.
  useEffect(() => {
    if (!editingId) {
      setRect(null);
      return;
    }

    const node = getNodesSnapshot().get(editingId);
    viewBoxRef.current = parseViewBox(
      node?.attrs?.viewBox,
      // Fallbacks are read from styles. If both viewBox + style
      // width are absent (newly created sketch wrapper) parseViewBox
      // lands at (0, 0, 0, 0) — pointer math then produces NaN. The
      // minimum-1 floor means new sketches still draw something
      // sensible until their first style commit lands the real
      // width / height.
      Math.max(parseFloat(node?.styles?.width || '1') || 1, 1),
      Math.max(parseFloat(node?.styles?.height || '1') || 1, 1),
    );

    let rafId: number;
    const poll = () => {
      const r = findNodeRect(editingId, vpId);
      if (r) {
        // Drawable area = wrapper bounds, exactly. AutoFit-on-exit
        // (in SketchCreator.ts) snaps the wrapper to enclose every
        // stroke when the user leaves edit mode, so by the time
        // they re-enter, this rect ALREADY matches the visible
        // content — no separate "expanded drawable" logic needed.
        // (Strokes drawn during the current session can still
        // overflow the wrapper temporarily via `overflow: visible`;
        // the next exit normalises everything.)
        setRect(prev => {
          if (prev
            && prev.left === r.left && prev.top === r.top
            && prev.width === r.width && prev.height === r.height) {
            return prev;
          }
          return { left: r.left, top: r.top, width: r.width, height: r.height };
        });
      }
      rafId = requestAnimationFrame(poll);
    };
    rafId = requestAnimationFrame(poll);
    return () => cancelAnimationFrame(rafId);
  }, [editingId, vpId]);

  // Live re-sync of existing strokes when the brush changes is handled
  // imperatively by the SketchTool in the right panel — see
  // `sketch-live-sync.ts`. The overlay only owns NEW stroke commits
  // (drawing); brush-driven mutations on existing strokes flow through
  // SketchTool's onLive / onCommit handlers, which call the bridge
  // directly and skip the React effect cycle entirely.

  // Outside-click + Escape exit. Pointer events on the overlay itself
  // call stopPropagation so the document-level mousedown listener only
  // sees clicks on the canvas BACKGROUND or other UI — exactly the
  // "outside the sketch" gesture the user expects to mean "I'm done".
  useEffect(() => {
    if (!editingId) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      // The overlay's own pointerdown stops propagation, so any
      // mousedown reaching this listener is by definition outside.
      // Belt-and-braces: also bail if the target is the overlay itself
      // (`data-editor-panel="sketch-edit-overlay"`) — covers the case
      // where the overlay is hit-tested but `setPointerCapture` hasn't
      // engaged yet.
      if (target.closest('[data-editor-panel]')) return;
      // Don't exit on clicks inside the BottomToolbar / right panel /
      // any editor chrome — those are tool/setting changes, not "stop
      // sketching" gestures.
      if (target.closest('button[title^="Sketch"]')) return; // toggling the tool button shouldn't exit
      trace.action('sketch-edit:outside-click-exit', { editingId });
      setEditingId(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        trace.action('sketch-edit:escape-exit', { editingId });
        setEditingId(null);
      }
    };
    // Defer registration by a tick. Without this, the SAME mousedown
    // that triggered dblclick → set sketchEditingIdAtom → mount this
    // overlay is STILL propagating up through the DOM by the time
    // useEffect runs. Registering synchronously here means the
    // listener catches its own triggering event and immediately exits
    // edit mode (verified: trace showed `sketch-edit-enter` and
    // `sketch-edit:outside-click-exit` at identical timestamps). A
    // setTimeout(0) lets the dblclick event fully drain first.
    let registered = false;
    const t = setTimeout(() => {
      document.addEventListener('mousedown', onMouseDown);
      registered = true;
    }, 0);
    document.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      if (registered) document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [editingId, setEditingId]);

  if (!editingId || !rect) return null;

  // ─── Pointer → viewBox-coord conversion ────────────────────────────
  const toViewBox = (clientX: number, clientY: number, pressure: number): number[] => {
    const vb = viewBoxRef.current;
    const sx = (clientX - rect.left) / rect.width;
    const sy = (clientY - rect.top) / rect.height;
    const x = vb.x + sx * vb.width;
    const y = vb.y + sy * vb.height;
    return [x, y, pressure || 0.5];
  };

  // ─── Stroke handlers ───────────────────────────────────────────────
  const handlePointerDown = (e: React.PointerEvent) => {
    // stopPropagation so the document-level outside-click listener
    // doesn't treat THIS pointerdown as "exit edit mode".
    e.stopPropagation();
    e.preventDefault();
    if (e.button !== 0) return; // left button only
    (e.target as Element).setPointerCapture(e.pointerId);

    isDrawingRef.current = true;
    pointsRef.current = [toViewBox(e.clientX, e.clientY, e.pressure)];
    setPreviewD('');
    trace.action('sketch-edit:stroke-start', { editingId });
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!isDrawingRef.current) return;
    e.stopPropagation();
    pointsRef.current.push(toViewBox(e.clientX, e.clientY, e.pressure));
    // Live preview — feed the in-progress points through getStroke
    // every move. perfect-freehand handles partial strokes fine; the
    // outline will look slightly different from the final commit only
    // because pointer pressure is sampled differently (no big deal).
    const outline = getStroke(pointsRef.current, buildStrokeOptions(brushRef.current));
    setPreviewD(outlineToPathD(outline));
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (!isDrawingRef.current) return;
    e.stopPropagation();
    e.preventDefault();
    isDrawingRef.current = false;
    try { (e.target as Element).releasePointerCapture(e.pointerId); } catch { /* ignore */ }

    const points = pointsRef.current;
    pointsRef.current = [];

    if (points.length < 2) {
      // Single point / accidental tap — discard. Clear preview
      // immediately since we're not committing anything.
      setPreviewD(null);
      trace.action('sketch-edit:stroke-discarded-too-short', { editingId, count: points.length });
      return;
    }

    const outline = getStroke(points, buildStrokeOptions(brushRef.current));
    const d = outlineToPathD(outline);
    if (!d) {
      setPreviewD(null);
      trace.action('sketch-edit:stroke-empty-outline', { editingId, count: points.length });
      return;
    }

    // Quotes inside the stroke fill go through verbatim into the JSX
    // string the addSvgChild mutation produces. Hex colors don't need
    // escaping; if we ever support arbitrary CSS values here we'd need
    // to be more careful with the embedded fill attribute. For now hex
    // is enforced at the brush picker level.
    // Optional stroke outline (skip when width=0 so JSX stays minimal).
    const sw = brushRef.current.strokeWidth;
    const sc = brushRef.current.strokeColor;
    const strokeAttrs = sw > 0 ? ` stroke="${sc}" stroke-width="${sw}"` : '';
    // Persist input points for the live-resync system (see brush change
    // effect below). Points are in viewBox-local coords already because
    // toViewBox() runs them through the wrapper's coordinate transform.
    const pointsAttrStr = pointsToAttr(points);
    const childJSX = `<path d="${d}" fill="${brushRef.current.color}"${strokeAttrs} data-points="${pointsAttrStr}" />`;

    setForceRender();
    queueMutation({ type: 'addSvgChild', nodeId: editingId, childJSX });
    flushNow();

    // The mutation queue flush kicks off a renderer rebuild, but the
    // iframe doesn't paint the new `<path>` child until the next
    // bridge round-trip (~1-2 frames). If we cleared `previewD` right
    // here the user would see a brief gap: preview gone, stroke not
    // yet rendered → flash.
    //
    // Instead, hold the preview for 2 RAF cycles. The preview path
    // and the committed stroke both draw the SAME `d` string with
    // the SAME fill, so during the overlap window they stack
    // pixel-perfectly. By the time we clear, the iframe has
    // committed the real stroke and there's no visible transition.
    nextFrames(2, () => {
      setPreviewD(null);
    });

    trace.action('sketch-edit:stroke-committed', {
      editingId, pointCount: points.length, brushSize: brushRef.current.size, brushColor: brushRef.current.color,
    });
  };

  // ─── Render ────────────────────────────────────────────────────────
  // Two layers:
  //   1. Full-viewport pointer-capture div — invisible, captures
  //      pointerdown anywhere on screen so the user can start a
  //      stroke without being constrained to wrapper bounds. Chrome
  //      surfaces (BottomToolbar at z-9998, LeftPanel at z-5000)
  //      naturally win the hit test because their z-index is higher,
  //      so clicks on toolbar/panels still go to the chrome.
  //   2. Preview SVG positioned exactly over the wrapper rect with
  //      its viewBox set to the wrapper's viewBox — so the
  //      viewBox-coord preview path renders at the same screen
  //      pixels as the eventual committed `<path>` child of the
  //      wrapper. Pointer-events: none on this layer; only the
  //      capture div catches input.
  const vb = viewBoxRef.current;
  return (
    <>
      <div
        data-editor-panel="sketch-edit-overlay"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        style={{
          position: 'fixed',
          left: 0,
          top: 0,
          width: '100vw',
          height: '100vh',
          cursor: 'crosshair',
          zIndex: 50,
          pointerEvents: 'auto',
          // No background — fully see-through to the canvas below.
          // Chrome elements (toolbars, panels) at higher z-index
          // sit above this layer and absorb their own clicks.
        }}
      />
      {previewD && rect && (
        <svg
          style={{
            position: 'fixed',
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
            zIndex: 51,
            pointerEvents: 'none',
            overflow: 'visible',
          }}
          viewBox={`${vb.x} ${vb.y} ${vb.width} ${vb.height}`}
          preserveAspectRatio="none"
        >
          <path
            d={previewD}
            fill={brush.color}
            stroke={brush.strokeWidth > 0 ? brush.strokeColor : undefined}
            strokeWidth={brush.strokeWidth > 0 ? brush.strokeWidth : undefined}
          />
        </svg>
      )}
    </>
  );
}
