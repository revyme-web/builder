// GradientOverlay.tsx — Canvas overlay for visual gradient editing.
// Shows draggable handles on the selected element when gradient fill is active.
// Linear: the stops on a line spanning first → last stop; rotate zones just
//   beyond the outermost stops (the gradient's version of the frame's corner
//   rotate zones — invisible, rotate cursor turned to the axis).
// Radial: center circle + ellipse outline + radius handle.
// Conic: center circle + angle arc line.
// All geometry is laid out in the element's OWN box and mapped through its
// transformed quad (gradient-geometry.ts), so a rotated / skewed / flipped
// frame gets handles that follow it and drags that move the right way.

import { useCallback, useRef } from 'react';
import type { ScreenCorners } from '@/canvas/resize/geometry-utils';
import type { GradientStop } from '@/shared/gradient-utils';
import type { Point } from '@/shared/types';
import { screenToPct, clamp } from '@/canvas/canvas-math';
import { getRotateCursorAt } from '@/canvas/resize/cursor-utils';
import { trace } from '@/shared/debug-trace';
import { maskStopFill } from '@/shared/mask-utils';
import {
  elementFrame, localToScreen, screenToLocal, cssAngleOf, cssAngleVector, normalizeDeg,
  linearGradientLine, alongLine, linearRotateZones, rotatedGradientAngle, localEllipsePath,
  type ElementFrame,
} from './gradient-geometry';

interface GradientOverlayProps {
  corners: ScreenCorners;
  /** The element's own CSS width/height (untransformed). The gradient is laid
   *  out in this box; without it the quad's edge lengths stand in. */
  localSize?: { w: number; h: number } | null;
  gradientType: 'linear' | 'radial' | 'conic';
  /** Gradient color stops */
  stops: GradientStop[];
  /** Currently selected stop ID */
  selectedStopId: string | null;
  /** Linear: direction in degrees */
  direction: number;
  /** Radial/Conic: center X 0-100% */
  centerX: number;
  /** Radial/Conic: center Y 0-100% */
  centerY: number;
  /** Radial: shape */
  radialShape: string;
  /** Radial: size mode */
  radialSize: string;
  /** Conic: from angle in degrees */
  angle: number;
  radiusX: number;
  radiusY: number;
  onDirectionChange?: (deg: number) => void;
  onCenterChange?: (x: number, y: number) => void;
  onRadiusChange?: (rx: number, ry: number) => void;
  onAngleChange?: (deg: number) => void;
  onStopPositionChange?: (id: string, position: number) => void;
  onSelectStop?: (id: string) => void;
  /** Fires ONCE on pointer release of any handle — commits the live-patched
   *  value to code (the per-frame callbacks above only patch the canvas DOM). */
  onCommit?: () => void;
  /** When true, stop circles show as visible grey (mask stops are invisible black/transparent) */
  isMask?: boolean;
}

// ─── Handle circle ──────────────────────────────────────────────────────────

const HANDLE_R = 6;
const HANDLE_STROKE = 2;

function Handle({ x, y, color = '#ffffff', onPointerDown }: {
  x: number; y: number; color?: string;
  onPointerDown?: (e: React.PointerEvent) => void;
}) {
  return (
    <circle
      cx={x} cy={y} r={HANDLE_R}
      fill={color} stroke="#ffffff" strokeWidth={HANDLE_STROKE}
      style={{ cursor: 'grab', filter: 'drop-shadow(0 1px 3px rgba(0,0,0,0.4))' }}
      onPointerDown={onPointerDown}
    />
  );
}

/** Pointer-captured drag on an SVG handle: `onMove` per frame, `onEnd` once. */
function captureDrag(e: React.PointerEvent, onMove: (me: PointerEvent) => void, onEnd: () => void): void {
  e.stopPropagation();
  e.preventDefault();
  const el = e.currentTarget as SVGElement;
  el.setPointerCapture(e.pointerId);
  const up = () => {
    el.releasePointerCapture(e.pointerId);
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', up);
    onEnd();
  };
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', up);
}

function StopCircle({ point, stop, selected, isMask, onPointerDown }: {
  point: Point; stop: GradientStop; selected: boolean; isMask?: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
}) {
  return (
    <circle
      cx={point.x} cy={point.y}
      r={selected ? 7 : 5}
      fill={isMask ? maskStopFill(stop.color) : stop.color}
      stroke="white"
      strokeWidth={selected ? 2.5 : 1.5}
      style={{ cursor: 'grab', filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.5))' }}
      onPointerDown={onPointerDown}
    />
  );
}

// ─── Linear Gradient Overlay ────────────────────────────────────────────────

/** Rotate zone: centre this far past the end stop's centre, this radius —
 *  i.e. it spans 11–29px beyond the stop, clear of the stop's own grab area
 *  (≤ 8.25px with its stroke). Invisible, like the frame's corner zones. */
const ROTATE_ZONE_GAP = 20;
const ROTATE_ZONE_R = 9;

function LinearOverlay({ frame, direction, stops, selectedStopId, onDirectionChange, onStopPositionChange, onSelectStop, onCommit, isMask }: {
  frame: ElementFrame; direction: number; stops: GradientStop[]; selectedStopId: string | null;
  onDirectionChange?: (deg: number) => void;
  onStopPositionChange?: (id: string, position: number) => void;
  onSelectStop?: (id: string) => void;
  onCommit?: () => void;
  isMask?: boolean;
}) {
  // The 0% → 100% gradient line (where stop positions live) — not drawn
  // whole: the visible line spans only the first → last stop.
  const { start, end } = linearGradientLine(frame, direction);
  const positions = stops.map(s => s.position);
  const firstPct = positions.length ? Math.min(...positions) : 0;
  const lastPct = positions.length ? Math.max(...positions) : 100;
  const lineFrom = alongLine(start, end, firstPct);
  const lineTo = alongLine(start, end, lastPct);
  const zones = linearRotateZones(start, end, firstPct, lastPct, ROTATE_ZONE_GAP);

  const handleRotate = useCallback((e: React.PointerEvent) => {
    if (!onDirectionChange) return;
    const grab = { x: e.clientX, y: e.clientY };
    const startDeg = direction;
    trace.action('gradient-overlay:linear-rotate-start', { direction });
    captureDrag(e,
      (me) => onDirectionChange(rotatedGradientAngle(frame, startDeg, grab, { x: me.clientX, y: me.clientY }, me.shiftKey)),
      () => { onCommit?.(); trace.action('gradient-overlay:linear-rotate-end', {}); },
    );
  }, [frame, direction, onDirectionChange, onCommit]);

  // Stop dragging along the gradient line (projection onto the 0–100% axis —
  // a ratio along a line survives any affine transform).
  const handleStopDrag = useCallback((e: React.PointerEvent, stopId: string) => {
    if (!onStopPositionChange) return;
    if (onSelectStop) onSelectStop(stopId);
    const dx = end.x - start.x, dy = end.y - start.y;
    const len2 = dx * dx + dy * dy;
    captureDrag(e, (me) => {
      if (len2 < 1) return;
      const t = ((me.clientX - start.x) * dx + (me.clientY - start.y) * dy) / len2;
      onStopPositionChange(stopId, clamp(Math.round(t * 100), 0, 100));
    }, () => onCommit?.());
  }, [start, end, onStopPositionChange, onSelectStop, onCommit]);

  return (
    <>
      {/* Rotate zones beyond the outermost stops — below the stops in paint order */}
      {zones && onDirectionChange && ([['before', zones.before], ['after', zones.after]] as const).map(([key, z]) => (
        <circle
          key={key}
          data-gradient-rotate-zone={key}
          cx={z.x} cy={z.y} r={ROTATE_ZONE_R}
          fill="transparent"
          style={{ pointerEvents: 'all', cursor: getRotateCursorAt(z.outwardDeg) }}
          onPointerDown={handleRotate}
        />
      ))}
      {/* Gradient line — first stop to last stop */}
      <line x1={lineFrom.x} y1={lineFrom.y} x2={lineTo.x} y2={lineTo.y}
        stroke="white" strokeWidth={1.5} opacity={0.7} />
      {stops.map(stop => (
        <StopCircle key={stop.id} point={alongLine(start, end, stop.position)} stop={stop}
          selected={stop.id === selectedStopId} isMask={isMask}
          onPointerDown={(e) => handleStopDrag(e, stop.id)} />
      ))}
    </>
  );
}

// ─── Radial Gradient Overlay ────────────────────────────────────────────────

function RadialOverlay({ frame, centerX, centerY, radiusX, radiusY, radialShape, radialSize, stops, selectedStopId, onCenterChange, onRadiusChange, onStopPositionChange, onSelectStop, onCommit, isMask }: {
  frame: ElementFrame; centerX: number; centerY: number;
  radiusX: number; radiusY: number;
  radialShape: string; radialSize: string;
  stops: GradientStop[]; selectedStopId: string | null;
  onCenterChange?: (x: number, y: number) => void;
  onRadiusChange?: (rx: number, ry: number) => void;
  onStopPositionChange?: (id: string, position: number) => void;
  onSelectStop?: (id: string) => void;
  onCommit?: () => void;
  isMask?: boolean;
}) {
  // Everything below is LOCAL px (the element's own box), mapped to screen.
  const { w: elWidth, h: elHeight } = frame;
  const cxL = (centerX / 100) * elWidth;
  const cyL = (centerY / 100) * elHeight;
  const centerPt = localToScreen(frame, cxL, cyL);
  const isCircle = radialShape === 'circle';
  const isCustomSize = radialSize === 'custom';

  let rx: number;
  let ry: number;

  if (!isCustomSize) {
    // Size keyword mode — the radius from the element's box
    switch (radialSize) {
      case 'closest-side':
        rx = Math.min(cxL, elWidth - cxL);
        ry = isCircle ? rx : Math.min(cyL, elHeight - cyL);
        break;
      case 'farthest-side':
        rx = Math.max(cxL, elWidth - cxL);
        ry = isCircle ? rx : Math.max(cyL, elHeight - cyL);
        break;
      case 'closest-corner': {
        const d = Math.min(
          Math.hypot(cxL, cyL),
          Math.hypot(elWidth - cxL, cyL),
          Math.hypot(cxL, elHeight - cyL),
          Math.hypot(elWidth - cxL, elHeight - cyL)
        );
        rx = d; ry = isCircle ? d : d * (elHeight / elWidth);
        break;
      }
      default: { // farthest-corner
        const d = Math.max(
          Math.hypot(cxL, cyL),
          Math.hypot(elWidth - cxL, cyL),
          Math.hypot(cxL, elHeight - cyL),
          Math.hypot(elWidth - cxL, elHeight - cyL)
        );
        rx = d; ry = isCircle ? d : d * (elHeight / elWidth);
        break;
      }
    }
  } else if (isCircle) {
    // Circle with custom size — use smaller of the two radii
    const r = Math.min((radiusX / 100) * elWidth, (radiusY / 100) * elHeight);
    rx = r; ry = r;
  } else {
    // Ellipse with custom percentage radii
    rx = (radiusX / 100) * elWidth;
    ry = (radiusY / 100) * elHeight;
  }

  const handleDrag = useCallback((e: React.PointerEvent) => {
    if (!onCenterChange) return;
    trace.action('gradient-overlay:radial-center-drag-start', {});
    captureDrag(e, (me) => {
      // Inverse quad mapping (shared screenToPct from canvas-math)
      const [xRaw, yRaw] = screenToPct(frame.corners, me.clientX, me.clientY);
      onCenterChange(clamp(Math.round(xRaw), 0, 100), clamp(Math.round(yRaw), 0, 100));
    }, () => { onCommit?.(); trace.action('gradient-overlay:radial-center-drag-end', {}); });
  }, [frame, onCenterChange, onCommit]);

  // Stop dragging along the radius (the element's local +x axis)
  const handleStopDrag = useCallback((e: React.PointerEvent, stopId: string) => {
    if (!onStopPositionChange) return;
    if (onSelectStop) onSelectStop(stopId);
    trace.action('gradient-overlay:radial-stop-drag-start', { stopId });
    captureDrag(e, (me) => {
      if (rx < 1) return;
      const p = screenToLocal(frame, me.clientX, me.clientY);
      onStopPositionChange(stopId, clamp(Math.round(((p.x - cxL) / rx) * 100), 0, 100));
    }, () => { onCommit?.(); trace.action('gradient-overlay:radial-stop-drag-end', { stopId }); });
  }, [frame, cxL, rx, onStopPositionChange, onSelectStop, onCommit]);

  const radiusDrag = useCallback((e: React.PointerEvent, axis: 'x' | 'y') => {
    if (!onRadiusChange) return;
    captureDrag(e, (me) => {
      const p = screenToLocal(frame, me.clientX, me.clientY);
      if (axis === 'y') onRadiusChange(radiusX, Math.max(5, Math.round((Math.abs(p.y - cyL) / elHeight) * 100)));
      else onRadiusChange(Math.max(5, Math.round((Math.abs(p.x - cxL) / elWidth) * 100)), radiusY);
    }, () => onCommit?.());
  }, [frame, cxL, cyL, elWidth, elHeight, radiusX, radiusY, onRadiusChange, onCommit]);

  const radiusEnd = localToScreen(frame, cxL + rx, cyL);
  const radiusTop = localToScreen(frame, cxL, cyL - ry);

  return (
    <>
      <path d={localEllipsePath(frame, cxL, cyL, rx, ry)}
        fill="none" stroke="white" strokeWidth={1} strokeDasharray="4 4" opacity={0.5} />
      {/* Line from center along the radius for stop placement */}
      <line x1={centerPt.x} y1={centerPt.y} x2={radiusEnd.x} y2={radiusEnd.y}
        stroke="white" strokeWidth={1.5} opacity={0.7} />
      {stops.map(stop => (
        <StopCircle key={stop.id} point={localToScreen(frame, cxL + rx * (stop.position / 100), cyL)} stop={stop}
          selected={stop.id === selectedStopId} isMask={isMask}
          onPointerDown={(e) => handleStopDrag(e, stop.id)} />
      ))}
      {/* Radius handles — only for custom size mode (not size keywords) */}
      {isCustomSize && !isCircle && (
        <>
          <Handle x={radiusTop.x} y={radiusTop.y} color="#ffffff" onPointerDown={(e) => radiusDrag(e, 'y')} />
          <Handle x={radiusEnd.x} y={radiusEnd.y} color="#ffffff" onPointerDown={(e) => radiusDrag(e, 'x')} />
        </>
      )}
      {/* Center handle */}
      <Handle x={centerPt.x} y={centerPt.y} color="#ffffff"
        onPointerDown={handleDrag} />
    </>
  );
}

// ─── Conic Gradient Overlay ─────────────────────────────────────────────────

function ConicOverlay({ frame, centerX, centerY, angle, stops, selectedStopId, onCenterChange, onAngleChange, onStopPositionChange, onSelectStop, onCommit, isMask }: {
  frame: ElementFrame; centerX: number; centerY: number; angle: number;
  stops: GradientStop[]; selectedStopId: string | null;
  onCenterChange?: (x: number, y: number) => void;
  onAngleChange?: (deg: number) => void;
  onStopPositionChange?: (id: string, position: number) => void;
  onSelectStop?: (id: string) => void;
  onCommit?: () => void;
  isMask?: boolean;
}) {
  const cxL = (centerX / 100) * frame.w;
  const cyL = (centerY / 100) * frame.h;
  const centerPt = localToScreen(frame, cxL, cyL);
  const radius = Math.min(frame.w, frame.h) / 2;
  /** Local point on the circle at a CSS angle. */
  const onCircle = (deg: number): Point => {
    const v = cssAngleVector(deg);
    return localToScreen(frame, cxL + v.x * radius, cyL + v.y * radius);
  };
  const handlePt = onCircle(angle);
  /** CSS angle of a pointer around the centre, in the element's own space. */
  const pointerAngle = (me: PointerEvent) => {
    const p = screenToLocal(frame, me.clientX, me.clientY);
    return cssAngleOf(p.x - cxL, p.y - cyL);
  };

  const handleAngleDrag = useCallback((e: React.PointerEvent) => {
    if (!onAngleChange) return;
    trace.action('gradient-overlay:conic-angle-drag-start', { angle });
    captureDrag(e, (me) => {
      let deg = pointerAngle(me);
      if (me.shiftKey) deg = Math.round(deg / 15) * 15;
      onAngleChange(normalizeDeg(Math.round(deg)));
    }, () => { onCommit?.(); trace.action('gradient-overlay:conic-angle-drag-end', {}); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame, cxL, cyL, onAngleChange, angle, onCommit]);

  // Center drag — same as radial
  const handleCenterDrag = useCallback((e: React.PointerEvent) => {
    if (!onCenterChange) return;
    trace.action('gradient-overlay:conic-center-drag-start', {});
    captureDrag(e, (me) => {
      const [xRaw, yRaw] = screenToPct(frame.corners, me.clientX, me.clientY);
      onCenterChange(clamp(Math.round(xRaw), 0, 100), clamp(Math.round(yRaw), 0, 100));
    }, () => { onCommit?.(); trace.action('gradient-overlay:conic-center-drag-end', {}); });
  }, [frame, onCenterChange, onCommit]);

  // Stop dragging along the circle
  const handleStopDrag = useCallback((e: React.PointerEvent, stopId: string) => {
    if (!onStopPositionChange) return;
    if (onSelectStop) onSelectStop(stopId);
    trace.action('gradient-overlay:conic-stop-drag-start', { stopId });
    captureDrag(e, (me) => {
      const rel = normalizeDeg(pointerAngle(me) - angle); // relative to start angle
      onStopPositionChange(stopId, clamp(Math.round((rel / 360) * 100), 0, 100));
    }, () => { onCommit?.(); trace.action('gradient-overlay:conic-stop-drag-end', { stopId }); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame, cxL, cyL, angle, onStopPositionChange, onSelectStop, onCommit]);

  return (
    <>
      {/* Angle line from center to handle */}
      <line x1={centerPt.x} y1={centerPt.y} x2={handlePt.x} y2={handlePt.y}
        stroke="white" strokeWidth={1.5} opacity={0.7} />
      {/* Circle outline */}
      <path d={localEllipsePath(frame, cxL, cyL, radius, radius)}
        fill="none" stroke="white" strokeWidth={1} strokeDasharray="4 4" opacity={0.3} />
      {stops.map(stop => (
        <StopCircle key={stop.id} point={onCircle(angle + (stop.position / 100) * 360)} stop={stop}
          selected={stop.id === selectedStopId} isMask={isMask}
          onPointerDown={(e) => handleStopDrag(e, stop.id)} />
      ))}
      {/* Angle handle */}
      <Handle x={handlePt.x} y={handlePt.y} color="#4dabf7"
        onPointerDown={handleAngleDrag} />
      {/* Center handle */}
      <Handle x={centerPt.x} y={centerPt.y} color="#ffffff"
        onPointerDown={handleCenterDrag} />
    </>
  );
}

// ─── Main GradientOverlay ───────────────────────────────────────────────────

export default function GradientOverlay(props: GradientOverlayProps) {
  const { corners, localSize, gradientType, direction, centerX, centerY, radiusX, radiusY, radialShape, radialSize, angle, stops, selectedStopId,
    onDirectionChange, onCenterChange, onRadiusChange, onAngleChange, onStopPositionChange, onSelectStop, onCommit, isMask } = props;

  // Stable commit fn (latest via ref) so the sub-overlays' drag useCallbacks
  // don't re-register every render.
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;
  const commit = useCallback(() => onCommitRef.current?.(), []);

  const frame = elementFrame(corners, localSize);

  return (
    <svg
      data-gradient-overlay
      style={{
        position: 'fixed', left: 0, top: 0,
        width: '100vw', height: '100vh',
        pointerEvents: 'none', overflow: 'visible', zIndex: 2,
      }}
    >
      <g style={{ pointerEvents: 'auto' }}>
        {gradientType === 'linear' && (
          <LinearOverlay frame={frame} direction={direction}
            stops={stops} selectedStopId={selectedStopId}
            onDirectionChange={onDirectionChange}
            onStopPositionChange={onStopPositionChange}
            onSelectStop={onSelectStop} onCommit={commit} isMask={isMask} />
        )}
        {gradientType === 'radial' && (
          <RadialOverlay frame={frame} centerX={centerX} centerY={centerY}
            radiusX={radiusX} radiusY={radiusY}
            radialShape={radialShape} radialSize={radialSize}
            stops={stops} selectedStopId={selectedStopId}
            onCenterChange={onCenterChange}
            onRadiusChange={onRadiusChange}
            onStopPositionChange={onStopPositionChange}
            onSelectStop={onSelectStop} onCommit={commit} isMask={isMask} />
        )}
        {gradientType === 'conic' && (
          <ConicOverlay frame={frame} centerX={centerX} centerY={centerY}
            angle={angle} stops={stops} selectedStopId={selectedStopId}
            onCenterChange={onCenterChange} onAngleChange={onAngleChange}
            onStopPositionChange={onStopPositionChange}
            onSelectStop={onSelectStop} onCommit={commit} isMask={isMask} />
        )}
      </g>
    </svg>
  );
}
