// ClipPathOverlay.tsx — Canvas overlay for visual clip-path editing.
// Shows draggable handles on the selected element when clip-path editing is active.
// Polygon: vertex handles (drag to move, shift+click to delete, click edge to add).
// Circle: center + radius handle.
// Ellipse: center + rx + ry handles.
// Inset: 4 axis-locked edge bar handles.
// Positioned in screen space (like GradientOverlay), transform-aware.

import { useCallback, useRef } from 'react';
import type { ScreenCorners } from '@/canvas/resize/geometry-utils';
import type { ClipPathData, CSSVal } from '@/shared/clippath-utils';
import { pctToScreen, screenToPct as _screenToPct, clamp } from '@/canvas/canvas-math';
import { SELECTION_COLOR } from '@/shared/constants';
import { trace } from '@/shared/debug-trace';

// ─── Geometry helpers (lerp, pctToScreen, screenToPct imported from canvas-math.ts) ──

/** screenToPct imported from canvas-math as _screenToPct, re-exported as local name */
const screenToPct = _screenToPct;

// ─── Handle component ────────────────────────────────────────────────────────

const HANDLE_R = 6;

function Handle({ x, y, color = SELECTION_COLOR, onPointerDown }: {
  x: number; y: number; color?: string;
  onPointerDown?: (e: React.PointerEvent) => void;
}) {
  return (
    <circle
      cx={x} cy={y} r={HANDLE_R}
      fill={color} stroke="#ffffff" strokeWidth={2}
      style={{ cursor: 'grab', filter: 'drop-shadow(0 1px 3px rgba(0,0,0,0.4))' }}
      onPointerDown={onPointerDown}
    />
  );
}

// ─── Props ───────────────────────────────────────────────────────────────────

interface ClipPathOverlayProps {
  corners: ScreenCorners;
  data: ClipPathData;
  /** Live update — fires on every pointermove. Should be DOM-only. */
  onChange: (data: ClipPathData) => void;
  /** Commit — fires once on pointerup. Goes through the mutation queue. */
  onCommit?: (data: ClipPathData) => void;
}

// ─── Polygon Overlay ─────────────────────────────────────────────────────────

function PolygonOverlay({ corners, data, onChange, onCommit }: ClipPathOverlayProps) {
  // Refs for fresh values in drag callbacks (avoids stale closure oscillation)
  const cornersRef = useRef(corners);
  const dataRef = useRef(data);
  const onChangeRef = useRef(onChange);
  const onCommitRef = useRef(onCommit);
  cornersRef.current = corners;
  dataRef.current = data;
  onChangeRef.current = onChange;
  onCommitRef.current = onCommit;

  const points = data.points;
  // For screen positioning, treat px values as-is (approximate — px coords relative to element %)
  // This is imperfect for px values but keeps the overlay functional
  const screenPts = points.map(([x, y]) => pctToScreen(corners, x.v, y.v));

  // Build polygon path for outline
  const pathD = screenPts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ') + ' Z';

  const onVertexDrag = useCallback((idx: number, e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const el = e.currentTarget as SVGElement;
    el.setPointerCapture(e.pointerId);
    trace.action('clippath-overlay:polygon-drag-start', { idx });

    const onMove = (me: PointerEvent) => {
      const [xPct, yPct] = screenToPct(cornersRef.current, me.clientX, me.clientY);
      const newPoints = [...dataRef.current.points] as [CSSVal, CSSVal][];
      const oldPt = newPoints[idx];
      // Preserve the original unit — drag values are always in % space
      const clampPct = (v: number) => clamp(Math.round(v * 100) / 100, 0, 100);
      newPoints[idx] = [
        { v: clampPct(xPct), unit: oldPt[0].unit },
        { v: clampPct(yPct), unit: oldPt[1].unit },
      ];
      onChangeRef.current({ ...dataRef.current, points: newPoints });
    };

    const onUp = () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      trace.action('clippath-overlay:polygon-drag-end', { idx });
      onCommitRef.current?.(dataRef.current);
    };

    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
  }, []); // no deps — reads from refs

  // Shift+click to delete a vertex (min 3 points)
  const onVertexClick = useCallback((idx: number, e: React.PointerEvent) => {
    if (e.shiftKey && data.points.length > 3) {
      e.stopPropagation();
      const newPoints = data.points.filter((_, i) => i !== idx);
      onChange({ ...data, points: newPoints });
      trace.action('clippath-overlay:polygon-delete-vertex', { idx });
    }
  }, [data, onChange]);

  // Click on edge midpoint to add a vertex
  const onEdgeClick = useCallback((idx: number, e: React.MouseEvent) => {
    e.stopPropagation();
    const nextIdx = (idx + 1) % data.points.length;
    const [ax, ay] = data.points[idx];
    const [bx, by] = data.points[nextIdx];
    // Midpoint inherits unit from first point of the edge (% preferred)
    const midPoint: [CSSVal, CSSVal] = [
      { v: (ax.v + bx.v) / 2, unit: ax.unit },
      { v: (ay.v + by.v) / 2, unit: ay.unit },
    ];
    const newPoints = [...data.points];
    newPoints.splice(idx + 1, 0, midPoint);
    onChange({ ...data, points: newPoints });
    trace.action('clippath-overlay:polygon-add-vertex', { afterIdx: idx });
  }, [data, onChange]);

  return (
    <g>
      {/* Edge segments — visible lines + wide hit areas + midpoint handles */}
      {screenPts.map((pt, i) => {
        const next = screenPts[(i + 1) % screenPts.length];
        const mid = { x: (pt.x + next.x) / 2, y: (pt.y + next.y) / 2 };
        return (
          <g key={`edge-${i}`}
            onMouseEnter={(e) => {
              const g = e.currentTarget;
              const line = g.querySelector('.edge-line') as SVGLineElement;
              const dot = g.querySelector('.edge-dot') as SVGCircleElement;
              if (line) { line.setAttribute('stroke', '#60a5fa'); line.setAttribute('stroke-width', '3'); }
              if (dot) { dot.setAttribute('fill', '#10b981'); dot.setAttribute('stroke', '#ffffff'); dot.setAttribute('r', '4'); }
            }}
            onMouseLeave={(e) => {
              const g = e.currentTarget;
              const line = g.querySelector('.edge-line') as SVGLineElement;
              const dot = g.querySelector('.edge-dot') as SVGCircleElement;
              if (line) { line.setAttribute('stroke', SELECTION_COLOR); line.setAttribute('stroke-width', '2'); }
              if (dot) { dot.setAttribute('fill', 'transparent'); dot.setAttribute('stroke', 'transparent'); dot.setAttribute('r', '4'); }
            }}
          >
            {/* Visible edge line */}
            <line className="edge-line" x1={pt.x} y1={pt.y} x2={next.x} y2={next.y}
              stroke={SELECTION_COLOR} strokeWidth={2} style={{ transition: 'stroke 0.15s, stroke-width 0.15s' }} />
            {/* Wide invisible hit area */}
            <line x1={pt.x} y1={pt.y} x2={next.x} y2={next.y}
              stroke="transparent" strokeWidth={14} style={{ cursor: 'copy' }}
              onClick={(e) => onEdgeClick(i, e)} />
            {/* Midpoint dot — appears on hover */}
            <circle className="edge-dot" cx={mid.x} cy={mid.y} r={4}
              fill="transparent" stroke="transparent" strokeWidth={1.5}
              style={{ cursor: 'copy', transition: 'all 0.15s' }}
              onClick={(e) => onEdgeClick(i, e)} />
          </g>
        );
      })}
      {/* Vertex handles */}
      {screenPts.map((pt, i) => (
        <Handle key={i} x={pt.x} y={pt.y}
          onPointerDown={(e) => {
            onVertexClick(i, e);
            if (!e.shiftKey) onVertexDrag(i, e);
          }}
        />
      ))}
    </g>
  );
}

// ─── Circle Overlay ──────────────────────────────────────────────────────────

function CircleOverlay({ corners, data, onChange, onCommit }: ClipPathOverlayProps) {
  const cornersRef = useRef(corners); cornersRef.current = corners;
  const dataRef = useRef(data); dataRef.current = data;
  const onChangeRef = useRef(onChange); onChangeRef.current = onChange;
  const onCommitRef = useRef(onCommit); onCommitRef.current = onCommit;

  const centerPt = pctToScreen(corners, data.centerX, data.centerY);
  const radiusPt = pctToScreen(corners, data.centerX + data.radius, data.centerY);
  const radiusScreenPx = Math.hypot(radiusPt.x - centerPt.x, radiusPt.y - centerPt.y);

  const onCenterDrag = useCallback((e: React.PointerEvent) => {
    e.stopPropagation(); e.preventDefault();
    const el = e.currentTarget as SVGElement;
    el.setPointerCapture(e.pointerId);
    trace.action('clippath-overlay:circle-center-drag-start', {});
    const onMove = (me: PointerEvent) => {
      const [xPct, yPct] = screenToPct(cornersRef.current, me.clientX, me.clientY);
      onChangeRef.current({ ...dataRef.current, centerX: clamp(Math.round(xPct * 100) / 100, 0, 100), centerY: clamp(Math.round(yPct * 100) / 100, 0, 100) });
    };
    const onUp = () => {
      el.removeEventListener('pointermove', onMove); el.removeEventListener('pointerup', onUp);
      trace.action('clippath-overlay:circle-center-drag-end', {});
      onCommitRef.current?.(dataRef.current);
    };
    el.addEventListener('pointermove', onMove); el.addEventListener('pointerup', onUp);
  }, []);

  const onRadiusDrag = useCallback((e: React.PointerEvent) => {
    e.stopPropagation(); e.preventDefault();
    const el = e.currentTarget as SVGElement;
    el.setPointerCapture(e.pointerId);
    trace.action('clippath-overlay:circle-radius-drag-start', {});
    const onMove = (me: PointerEvent) => {
      const [xPct] = screenToPct(cornersRef.current, me.clientX, me.clientY);
      const newRadius = Math.max(1, Math.abs(xPct - dataRef.current.centerX));
      onChangeRef.current({ ...dataRef.current, radius: Math.round(newRadius * 100) / 100 });
    };
    const onUp = () => {
      el.removeEventListener('pointermove', onMove); el.removeEventListener('pointerup', onUp);
      trace.action('clippath-overlay:circle-radius-drag-end', {});
      onCommitRef.current?.(dataRef.current);
    };
    el.addEventListener('pointermove', onMove); el.addEventListener('pointerup', onUp);
  }, []);

  return (
    <g>
      <circle cx={centerPt.x} cy={centerPt.y} r={radiusScreenPx}
        fill="none" stroke={SELECTION_COLOR} strokeWidth={2} />
      <Handle x={radiusPt.x} y={radiusPt.y} color="#10b981" onPointerDown={onRadiusDrag} />
      <Handle x={centerPt.x} y={centerPt.y} onPointerDown={onCenterDrag} />
    </g>
  );
}

// ─── Ellipse Overlay ─────────────────────────────────────────────────────────

function EllipseOverlay({ corners, data, onChange, onCommit }: ClipPathOverlayProps) {
  const cornersRef = useRef(corners); cornersRef.current = corners;
  const dataRef = useRef(data); dataRef.current = data;
  const onChangeRef = useRef(onChange); onChangeRef.current = onChange;
  const onCommitRef = useRef(onCommit); onCommitRef.current = onCommit;

  const centerPt = pctToScreen(corners, data.centerX, data.centerY);
  const rxPt = pctToScreen(corners, data.centerX + data.radiusX, data.centerY);
  const ryPt = pctToScreen(corners, data.centerX, data.centerY + data.radiusY);
  const rxScreen = Math.hypot(rxPt.x - centerPt.x, rxPt.y - centerPt.y);
  const ryScreen = Math.hypot(ryPt.x - centerPt.x, ryPt.y - centerPt.y);

  const onCenterDrag = useCallback((e: React.PointerEvent) => {
    e.stopPropagation(); e.preventDefault();
    const el = e.currentTarget as SVGElement;
    el.setPointerCapture(e.pointerId);
    trace.action('clippath-overlay:ellipse-center-drag-start', {});
    const onMove = (me: PointerEvent) => {
      const [xPct, yPct] = screenToPct(cornersRef.current, me.clientX, me.clientY);
      onChangeRef.current({ ...dataRef.current, centerX: clamp(Math.round(xPct * 100) / 100, 0, 100), centerY: clamp(Math.round(yPct * 100) / 100, 0, 100) });
    };
    const onUp = () => {
      el.removeEventListener('pointermove', onMove); el.removeEventListener('pointerup', onUp);
      trace.action('clippath-overlay:ellipse-center-drag-end', {});
      onCommitRef.current?.(dataRef.current);
    };
    el.addEventListener('pointermove', onMove); el.addEventListener('pointerup', onUp);
  }, []);

  const onRxDrag = useCallback((e: React.PointerEvent) => {
    e.stopPropagation(); e.preventDefault();
    const el = e.currentTarget as SVGElement;
    el.setPointerCapture(e.pointerId);
    trace.action('clippath-overlay:ellipse-rx-drag-start', {});
    const onMove = (me: PointerEvent) => {
      const [xPct] = screenToPct(cornersRef.current, me.clientX, me.clientY);
      onChangeRef.current({ ...dataRef.current, radiusX: Math.max(1, Math.round(Math.abs(xPct - dataRef.current.centerX) * 100) / 100) });
    };
    const onUp = () => {
      el.removeEventListener('pointermove', onMove); el.removeEventListener('pointerup', onUp);
      trace.action('clippath-overlay:ellipse-rx-drag-end', {});
      onCommitRef.current?.(dataRef.current);
    };
    el.addEventListener('pointermove', onMove); el.addEventListener('pointerup', onUp);
  }, []);

  const onRyDrag = useCallback((e: React.PointerEvent) => {
    e.stopPropagation(); e.preventDefault();
    const el = e.currentTarget as SVGElement;
    el.setPointerCapture(e.pointerId);
    trace.action('clippath-overlay:ellipse-ry-drag-start', {});
    const onMove = (me: PointerEvent) => {
      const [, yPct] = screenToPct(cornersRef.current, me.clientX, me.clientY);
      onChangeRef.current({ ...dataRef.current, radiusY: Math.max(1, Math.round(Math.abs(yPct - dataRef.current.centerY) * 100) / 100) });
    };
    const onUp = () => {
      el.removeEventListener('pointermove', onMove); el.removeEventListener('pointerup', onUp);
      trace.action('clippath-overlay:ellipse-ry-drag-end', {});
      onCommitRef.current?.(dataRef.current);
    };
    el.addEventListener('pointermove', onMove); el.addEventListener('pointerup', onUp);
  }, []);

  return (
    <g>
      <ellipse cx={centerPt.x} cy={centerPt.y} rx={rxScreen} ry={ryScreen}
        fill="none" stroke={SELECTION_COLOR} strokeWidth={2} />
      <Handle x={rxPt.x} y={rxPt.y} color="#10b981" onPointerDown={onRxDrag} />
      <Handle x={ryPt.x} y={ryPt.y} color="#f59e0b" onPointerDown={onRyDrag} />
      <Handle x={centerPt.x} y={centerPt.y} onPointerDown={onCenterDrag} />
    </g>
  );
}

// ─── Inset Overlay ───────────────────────────────────────────────────────────

function InsetOverlay({ corners, data, onChange, onCommit }: ClipPathOverlayProps) {
  const cornersRef = useRef(corners); cornersRef.current = corners;
  const dataRef = useRef(data); dataRef.current = data;
  const onChangeRef = useRef(onChange); onChangeRef.current = onChange;
  const onCommitRef = useRef(onCommit); onCommitRef.current = onCommit;

  // 4 edge lines positioned at inset percentages
  const tl = pctToScreen(corners, data.left, data.top);
  const tr = pctToScreen(corners, 100 - data.right, data.top);
  const br = pctToScreen(corners, 100 - data.right, 100 - data.bottom);
  const bl = pctToScreen(corners, data.left, 100 - data.bottom);

  // Midpoints for the 4 drag handles
  const topMid = { x: (tl.x + tr.x) / 2, y: (tl.y + tr.y) / 2 };
  const rightMid = { x: (tr.x + br.x) / 2, y: (tr.y + br.y) / 2 };
  const bottomMid = { x: (bl.x + br.x) / 2, y: (bl.y + br.y) / 2 };
  const leftMid = { x: (tl.x + bl.x) / 2, y: (tl.y + bl.y) / 2 };

  const makeEdgeDrag = useCallback((edge: 'top' | 'right' | 'bottom' | 'left') => (e: React.PointerEvent) => {
    e.stopPropagation(); e.preventDefault();
    const el = e.currentTarget as SVGElement;
    el.setPointerCapture(e.pointerId);
    trace.action('clippath-overlay:inset-drag-start', { edge });

    const onMove = (me: PointerEvent) => {
      const [xPct, yPct] = screenToPct(cornersRef.current, me.clientX, me.clientY);
      const clampInset = (v: number) => clamp(Math.round(v * 100) / 100, 0, 99);
      const d = dataRef.current;
      switch (edge) {
        case 'top': onChangeRef.current({ ...d, top: clampInset(yPct) }); break;
        case 'bottom': onChangeRef.current({ ...d, bottom: clampInset(100 - yPct) }); break;
        case 'left': onChangeRef.current({ ...d, left: clampInset(xPct) }); break;
        case 'right': onChangeRef.current({ ...d, right: clampInset(100 - xPct) }); break;
      }
    };
    const onUp = () => {
      el.removeEventListener('pointermove', onMove); el.removeEventListener('pointerup', onUp);
      onCommitRef.current?.(dataRef.current);
    };
    el.addEventListener('pointermove', onMove); el.addEventListener('pointerup', onUp);
  }, []);

  const rectPath = `M${tl.x},${tl.y} L${tr.x},${tr.y} L${br.x},${br.y} L${bl.x},${bl.y} Z`;

  return (
    <g>
      <path d={rectPath} fill="none" stroke={SELECTION_COLOR} strokeWidth={2} />
      {/* Edge handles (pill-shaped) */}
      <Handle x={topMid.x} y={topMid.y} color="#ec4899" onPointerDown={makeEdgeDrag('top')} />
      <Handle x={rightMid.x} y={rightMid.y} color="#ec4899" onPointerDown={makeEdgeDrag('right')} />
      <Handle x={bottomMid.x} y={bottomMid.y} color="#ec4899" onPointerDown={makeEdgeDrag('bottom')} />
      <Handle x={leftMid.x} y={leftMid.y} color="#ec4899" onPointerDown={makeEdgeDrag('left')} />
    </g>
  );
}

// ─── Main Overlay ────────────────────────────────────────────────────────────

export default function ClipPathOverlay({ corners, data, onChange, onCommit }: ClipPathOverlayProps) {
  trace.fn('ClipPathOverlay:render', { type: data.type, pointCount: data.points?.length });

  let content: React.ReactNode = null;
  switch (data.type) {
    case 'polygon':
      content = <PolygonOverlay corners={corners} data={data} onChange={onChange} onCommit={onCommit} />; break;
    case 'circle':
      content = <CircleOverlay corners={corners} data={data} onChange={onChange} onCommit={onCommit} />; break;
    case 'ellipse':
      content = <EllipseOverlay corners={corners} data={data} onChange={onChange} onCommit={onCommit} />; break;
    case 'inset':
      content = <InsetOverlay corners={corners} data={data} onChange={onChange} onCommit={onCommit} />; break;
    default:
      return null;
  }

  return (
    <svg
      style={{
        position: 'fixed', left: 0, top: 0,
        width: '100vw', height: '100vh',
        pointerEvents: 'none', overflow: 'visible', zIndex: 2,
      }}
    >
      <g style={{ pointerEvents: 'auto' }}>
        {content}
      </g>
    </svg>
  );
}
