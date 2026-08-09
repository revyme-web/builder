// DistanceIndicators.tsx — the ALT measuring overlay.
//
// Two pictures, one overlay (the geometry for both lives in
// `measure-geometry.ts`, which is where to look for the maths):
//
//   ALT alone           → the gaps from the selected element to its PARENT's
//                         four edges. The long-standing behaviour.
//   ALT + hover another → the single distance between the SELECTED element and
//                         the HOVERED one, with a dashed elbow when a straight
//                         line out of the selection can't reach it.
//
// The hover picture REPLACES the parent one while a target is under the pointer
// and restores when it leaves. They are states of one overlay rather than two
// overlays: two components would each own a poll and a mount decision, and
// there would be frames where both drew or neither did.
//
// Lines are drawn from raw screen-space rects into a `position: fixed` SVG, so
// no transform maths is needed. Only the NUMBERS are divided by the canvas
// scale — see the note in measure-geometry.ts.

import React from 'react';
import { useAtomValue } from 'jotai';
import {
  selectedNodeAtom, canvasInteractingAtom, getNodesSnapshot,
  hoveredIdAtom, hoveredNodeIdAtom, hoveredViewportIdAtom,
} from '@/code/stores/store';
import { interactingViewportIdAtom } from '@/code/stores/viewport-store';
import { findNodeRect } from '@/canvas/node-ops';
import { transformManager } from '@/canvas/transform';
import StyleIndicator from '@/design-system/StyleIndicator';
import { useModifierKeys } from '@/canvas/hooks/useModifierKeys';
import { usePolledValue } from '@/canvas/hooks/usePolledValue';
import { stripGhostSuffix } from '@/shared/ghost-id';
import { trace } from '@/shared/debug-trace';
import {
  computeInsetMeasure, computePairMeasure, resolveMeasureTarget, measureEqual, isUsableRect,
  type MeasureResult, type MeasureSegment,
} from './measure-geometry';

// The measuring system is PINK, fixed (user call 2026-08-08): same hue in every
// theme and in both light and dark mode, deliberately NOT an accent token. The
// label is the line's own colour at full opacity so the two can never drift,
// with white text on it.
//
// Being theme-independent is the point: a measurement reads the same wherever
// you are, and it can't be mistaken for the selection box, which DOES track the
// accent (gold on pages, violet in component mode).
//
// It was jade #16c79a for a while — chosen at hue 165 for clearance from the
// component magenta after an earlier pink sat 5° away from it. That collision
// is why the selection box and the labels must not both follow the accent; a
// fixed pink sidesteps it from the other direction.
const MEASURE_PINK = 'rgb(255, 124, 221)';
const LINE_COLOR = 'rgba(255, 124, 221, 0.8)';
const LABEL_BG = MEASURE_PINK;
const LABEL_FG = '#ffffff';

function MeasureLine({ seg }: { seg: MeasureSegment }) {
  const { x1, y1, x2, y2, isH, dash, capStart, capEnd } = seg;
  // An end cap is a tick CENTRED on the line, so it sticks out 4px to BOTH
  // sides. At the corner where the elbow turns, the half pointing away from the
  // elbow reads as the line overshooting past the turn instead of a clean right
  // angle. The corner gets no cap; the dash continues from the exact endpoint.
  return <g>
    <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={LINE_COLOR} strokeWidth={1} />
    {isH ? <>
      {capStart && <line x1={x1} y1={y1 - 4} x2={x1} y2={y1 + 4} stroke={LINE_COLOR} strokeWidth={1} />}
      {capEnd && <line x1={x2} y1={y2 - 4} x2={x2} y2={y2 + 4} stroke={LINE_COLOR} strokeWidth={1} />}
    </> : <>
      {capStart && <line x1={x1 - 4} y1={y1} x2={x1 + 4} y2={y1} stroke={LINE_COLOR} strokeWidth={1} />}
      {capEnd && <line x1={x2 - 4} y1={y2} x2={x2 + 4} y2={y2} stroke={LINE_COLOR} strokeWidth={1} />}
    </>}
    {/* The reach. Dashed and cap-less so it reads as "and then over to there",
        not as part of the measurement — the number belongs to the solid run. */}
    {dash && (
      <line
        x1={dash.x1} y1={dash.y1} x2={dash.x2} y2={dash.y2}
        stroke={LINE_COLOR} strokeWidth={1} strokeDasharray="4 4"
      />
    )}
  </g>;
}

export default function DistanceIndicators() {
  const selectedId = useAtomValue(selectedNodeAtom);
  const isInteracting = useAtomValue(canvasInteractingAtom);
  const vpId = useAtomValue(interactingViewportIdAtom);
  const hoveredId = useAtomValue(hoveredIdAtom);
  const hoveredNodeId = useAtomValue(hoveredNodeIdAtom);
  const hoveredVpId = useAtomValue(hoveredViewportIdAtom);
  const { alt, ctrl } = useModifierKeys();
  // Change-only trace key — the poll runs 60×/s and would otherwise drown the
  // trace buffer that canvas bugs are diagnosed from.
  const lastSigRef = React.useRef('');

  const data = usePolledValue<MeasureResult>(
    !!(alt && !ctrl && selectedId),
    (prev) => {
      if (!selectedId) return null;
      // Read the transform INSIDE the poll. It used to be captured once in the
      // effect body with zoom absent from the deps, so zooming with ALT held
      // reported pre-zoom numbers until you released the key. `getTransform()`
      // is a plain field read, so this costs nothing.
      const scale = transformManager.getTransform().scale;

      // Resolve the parent fresh each frame from an imperative snapshot rather
      // than subscribing to the node map — a whole-map subscription restarted
      // this poll on every commit.
      const parentId = getNodesSnapshot().get(selectedId)?.parentId;
      const target = resolveMeasureTarget({
        selectedId, selectedVpId: vpId, parentId,
        hoveredId, hoveredNodeId, hoveredVpId,
        stripGhost: stripGhostSuffix,
      });
      if (!target) return null;

      const er = findNodeRect(selectedId, vpId);
      if (!isUsableRect(er)) return prev;   // keep the last good picture

      const measure = (t: typeof target): MeasureResult | null => {
        const tr = findNodeRect(t.id, t.vpId);
        if (!isUsableRect(tr)) return null;
        // The parent path calls the inset geometry DIRECTLY rather than the
        // dispatcher: a child that overflows its parent is separated on an
        // axis, so the dispatcher would flip it to the gap picture and quietly
        // change behaviour that has shipped for months.
        return t.mode === 'parent'
          ? { kind: 'inset', segments: computeInsetMeasure(er, tr, scale) }
          : computePairMeasure(er, tr, scale);
      };

      let next = measure(target);
      // A hover that yields nothing to draw (identical boxes, or an overlap
      // with no positive side) would blank the overlay mid-gesture. Fall back
      // to the parent picture rather than flickering to nothing.
      if (target.mode === 'hover' && (!next || next.segments.length === 0) && parentId) {
        next = measure({ mode: 'parent', id: parentId, vpId });
      }
      if (!next || next.segments.length === 0) return null;

      const sig = `${target.mode}:${target.id}:${next.kind}:${next.segments.length}`;
      if (sig !== lastSigRef.current) {
        lastSigRef.current = sig;
        trace.action('distance-indicators:mode', {
          mode: target.mode, targetId: target.id, kind: next.kind, segments: next.segments.length,
        });
      }
      // Returning the PREVIOUS object when nothing moved lets React bail out of
      // the re-render. Not an optimisation: the deps below include the hovered
      // id, which churns at pointer rate, and an unconditional setState in this
      // skeleton is what blew React's update-depth limit before (see
      // pin-constraint-utils.ts).
      return measureEqual(prev, next) ? prev : next;
    },
    [selectedId, vpId, hoveredId, hoveredNodeId, hoveredVpId],
  );

  if (!data || !alt || ctrl || isInteracting) return null;

  return (
    <>
      <svg style={{ position: 'fixed', left: 0, top: 0, width: '100vw', height: '100vh', pointerEvents: 'none', zIndex: 4998, overflow: 'visible' }}>
        {data.segments.map((seg) => <MeasureLine key={seg.key} seg={seg} />)}
      </svg>
      {data.segments.map((seg) => (
        <StyleIndicator key={seg.key} x={seg.lx} y={seg.ly} color={LABEL_BG} fg={LABEL_FG} size="sm">
          {seg.value}
        </StyleIndicator>
      ))}
    </>
  );
}
