// DistanceIndicators.tsx — ALT key distance lines from selected element to parent.
// Purely DOM-based. Lines rendered as fixed-position SVG, labels as StyleIndicator pills.

import React, { useEffect, useState } from 'react';
import { useAtomValue } from 'jotai';
import { selectedNodeAtom, canvasInteractingAtom, getNodesSnapshot } from '@/code/stores/store';
import { interactingViewportIdAtom } from '@/code/stores/viewport-store';
import { findNodeRect } from '@/canvas/node-ops';
import { transformManager } from '@/canvas/transform';
import StyleIndicator from '@/design-system/StyleIndicator';
import { useModifierKeys } from '@/canvas/hooks/useModifierKeys';

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

interface Distances {
  top: number; right: number; bottom: number; left: number;
  er: DOMRect; pr: DOMRect;
}

interface LineCoords {
  x1: number; y1: number; x2: number; y2: number;
  lx: number; ly: number; isH: boolean;
}

function getLineCoords(dir: string, er: DOMRect, pr: DOMRect): LineCoords {
  const isH = dir === 'left' || dir === 'right';
  const ecx = er.left + er.width / 2, ecy = er.top + er.height / 2;
  let x1: number, y1: number, x2: number, y2: number;

  if (dir === 'top') { x1 = x2 = ecx; y1 = pr.top; y2 = er.top; }
  else if (dir === 'bottom') { x1 = x2 = ecx; y1 = er.bottom; y2 = pr.bottom; }
  else if (dir === 'left') { y1 = y2 = ecy; x1 = pr.left; x2 = er.left; }
  else { y1 = y2 = ecy; x1 = er.right; x2 = pr.right; }

  return { x1: x1!, y1: y1!, x2: x2!, y2: y2!, lx: (x1! + x2!) / 2, ly: (y1! + y2!) / 2, isH };
}

function MeasureLine({ dir, er, pr }: { dir: string; er: DOMRect; pr: DOMRect }) {
  const { x1, y1, x2, y2, isH } = getLineCoords(dir, er, pr);
  return <g>
    <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={LINE_COLOR} strokeWidth={1} />
    {isH ? <>
      <line x1={x1} y1={y1 - 4} x2={x1} y2={y1 + 4} stroke={LINE_COLOR} strokeWidth={1} />
      <line x1={x2} y1={y2 - 4} x2={x2} y2={y2 + 4} stroke={LINE_COLOR} strokeWidth={1} />
    </> : <>
      <line x1={x1 - 4} y1={y1} x2={x1 + 4} y2={y1} stroke={LINE_COLOR} strokeWidth={1} />
      <line x1={x2 - 4} y1={y2} x2={x2 + 4} y2={y2} stroke={LINE_COLOR} strokeWidth={1} />
    </>}
  </g>;
}

export default function DistanceIndicators() {
  const selectedId = useAtomValue(selectedNodeAtom);
  const isInteracting = useAtomValue(canvasInteractingAtom);
  const vpId = useAtomValue(interactingViewportIdAtom);
  const [data, setData] = useState<Distances | null>(null);
  const { alt, ctrl } = useModifierKeys();

  useEffect(() => {
    if (!alt || ctrl || !selectedId) { setData(null); return; }

    const scale = transformManager.getTransform().scale;

    let rafId: number;
    const update = () => {
      // Resolve the parent FRESH each frame (imperative snapshot — no
      // whole-map subscription). A reparent mid-hover just changes which
      // parent rect the next frame measures; previously `nodes` in the
      // effect deps restarted the loop per commit for the same effect.
      const parentId = getNodesSnapshot().get(selectedId)?.parentId;
      if (!parentId) { setData(null); rafId = requestAnimationFrame(update); return; }
      const er = findNodeRect(selectedId, vpId);
      const pr = findNodeRect(parentId, vpId);
      if (er && pr) {
        setData({
          top: Math.round((er.top - pr.top) / scale),
          right: Math.round((pr.right - er.right) / scale),
          bottom: Math.round((pr.bottom - er.bottom) / scale),
          left: Math.round((er.left - pr.left) / scale),
          er, pr,
        });
      }
      rafId = requestAnimationFrame(update);
    };
    update();
    return () => { cancelAnimationFrame(rafId); };
  }, [alt, ctrl, selectedId, vpId]);

  if (!data || !alt || ctrl || isInteracting) return null;

  const dirs = (['top', 'right', 'bottom', 'left'] as const).filter(d => data[d] > 0);

  return (
    <>
      <svg style={{ position: 'fixed', left: 0, top: 0, width: '100vw', height: '100vh', pointerEvents: 'none', zIndex: 4998, overflow: 'visible' }}>
        {dirs.map(dir => <MeasureLine key={dir} dir={dir} er={data.er} pr={data.pr} />)}
      </svg>
      {dirs.map(dir => {
        const { lx, ly } = getLineCoords(dir, data.er, data.pr);
        return <StyleIndicator key={dir} x={lx} y={ly} color={LABEL_BG} fg={LABEL_FG} size="sm">{data[dir]}</StyleIndicator>;
      })}
    </>
  );
}
