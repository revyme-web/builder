// GradientOverlay.tsx — Canvas overlay for visual gradient editing.
// Shows draggable handles on the selected element when gradient fill is active.
// Linear: two endpoint circles + connecting line for angle/direction.
// Radial: center circle + ellipse outline + radius handle.
// Conic: center circle + angle arc line.
// Positioned in screen space (like SelectionBorder), transform-aware.

import { useCallback, useRef } from 'react';
import type { ScreenCorners } from '@/canvas/resize/geometry-utils';
import type { GradientStop } from '@/shared/gradient-utils';
import { pctToScreen, screenToPct, clamp } from '@/canvas/canvas-math';
import { trace } from '@/shared/debug-trace';
import { maskStopFill } from '@/shared/mask-utils';

interface GradientOverlayProps {
  corners: ScreenCorners;
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

// ─── Helpers ────────────────────────────────────────────────────────────────
// lerp, pctToScreen imported from canvas-math.ts

const getPointOnElement = pctToScreen; // alias for backward compat within this file

function getElementCenter(corners: ScreenCorners) {
  return {
    x: (corners.TL.x + corners.TR.x + corners.BR.x + corners.BL.x) / 4,
    y: (corners.TL.y + corners.TR.y + corners.BR.y + corners.BL.y) / 4,
  };
}

function degToRad(deg: number) { return (deg * Math.PI) / 180; }
function radToDeg(rad: number) { return (rad * 180) / Math.PI; }

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

// ─── Linear Gradient Overlay ────────────────────────────────────────────────

function LinearOverlay({ corners, direction, stops, selectedStopId, onDirectionChange, onStopPositionChange, onSelectStop, onCommit, isMask }: {
  corners: ScreenCorners; direction: number; stops: GradientStop[]; selectedStopId: string | null;
  onDirectionChange?: (deg: number) => void;
  onStopPositionChange?: (id: string, position: number) => void;
  onSelectStop?: (id: string) => void;
  onCommit?: () => void;
  isMask?: boolean;
}) {
  const center = getElementCenter(corners);
  // Element dimensions in screen space
  const width = Math.hypot(corners.TR.x - corners.TL.x, corners.TR.y - corners.TL.y);
  const height = Math.hypot(corners.BL.x - corners.TL.x, corners.BL.y - corners.TL.y);

  // Gradient line length: use the projection of the element rect onto the gradient axis.
  // This keeps the line endpoints within (or near) the element bounds, like the reference.
  const rad = degToRad(direction - 90); // CSS gradient 0deg = bottom-to-top
  const cosA = Math.abs(Math.cos(rad));
  const sinA = Math.abs(Math.sin(rad));
  const radius = (width * cosA + height * sinA) / 2;

  // Endpoint positions based on angle
  const startX = center.x - Math.cos(rad) * radius;
  const startY = center.y - Math.sin(rad) * radius;
  const endX = center.x + Math.cos(rad) * radius;
  const endY = center.y + Math.sin(rad) * radius;

  const handleDrag = useCallback((e: React.PointerEvent, isEnd: boolean) => {
    if (!onDirectionChange) return;
    e.stopPropagation();
    e.preventDefault();
    const el = e.currentTarget as SVGElement;
    el.setPointerCapture(e.pointerId);

    const onMove = (me: PointerEvent) => {
      const dx = me.clientX - center.x;
      const dy = me.clientY - center.y;
      let deg = radToDeg(Math.atan2(dy, dx)) + 90; // convert back to CSS degrees
      if (!isEnd) deg = (deg + 180) % 360;
      if (deg < 0) deg += 360;
      onDirectionChange(Math.round(deg));
    };

    const onUp = () => {
      el.releasePointerCapture(e.pointerId);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      onCommit?.();
      trace.action('gradient-overlay:linear-drag-end', { direction });
    };

    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    trace.action('gradient-overlay:linear-drag-start', {});
  }, [center, onDirectionChange, direction, onCommit]);

  // Stop dragging along the gradient line
  const handleStopDrag = useCallback((e: React.PointerEvent, stopId: string) => {
    if (!onStopPositionChange) return;
    e.stopPropagation();
    e.preventDefault();
    if (onSelectStop) onSelectStop(stopId);
    const el = e.currentTarget as SVGElement;
    el.setPointerCapture(e.pointerId);

    const onMove = (me: PointerEvent) => {
      // Project mouse position onto the gradient line to get 0-100%
      const dx = endX - startX;
      const dy = endY - startY;
      const len = Math.hypot(dx, dy);
      if (len < 1) return;
      const t = ((me.clientX - startX) * dx + (me.clientY - startY) * dy) / (len * len);
      const pos = clamp(Math.round(t * 100), 0, 100);
      onStopPositionChange(stopId, pos);
    };

    const onUp = () => {
      el.releasePointerCapture(e.pointerId);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      onCommit?.();
    };

    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
  }, [startX, startY, endX, endY, onStopPositionChange, onSelectStop, onCommit]);

  return (
    <>
      {/* Gradient line */}
      <line x1={startX} y1={startY} x2={endX} y2={endY}
        stroke="white" strokeWidth={1.5} opacity={0.7} />
      {/* Endpoint handles (rotation) */}
      <Handle x={startX} y={startY} color="#ff6b6b"
        onPointerDown={(e) => handleDrag(e, false)} />
      <Handle x={endX} y={endY} color="#ff6b6b"
        onPointerDown={(e) => handleDrag(e, true)} />
      {/* Stop circles along the line — rendered AFTER handles so they appear on top */}
      {stops.map(stop => {
        const t = stop.position / 100;
        const sx = startX + (endX - startX) * t;
        const sy = startY + (endY - startY) * t;
        const isSelected = stop.id === selectedStopId;
        const fill = isMask ? maskStopFill(stop.color) : stop.color;
        return (
          <circle
            key={stop.id}
            cx={sx} cy={sy}
            r={isSelected ? 7 : 5}
            fill={fill}
            stroke="white"
            strokeWidth={isSelected ? 2.5 : 1.5}
            style={{ cursor: 'grab', filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.5))' }}
            onPointerDown={(e) => handleStopDrag(e, stop.id)}
          />
        );
      })}
    </>
  );
}

// ─── Radial Gradient Overlay ────────────────────────────────────────────────

function RadialOverlay({ corners, centerX, centerY, radiusX, radiusY, radialShape, radialSize, stops, selectedStopId, onCenterChange, onRadiusChange, onStopPositionChange, onSelectStop, onCommit, isMask }: {
  corners: ScreenCorners; centerX: number; centerY: number;
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
  const centerPt = getPointOnElement(corners, centerX, centerY);
  const elWidth = Math.hypot(corners.TR.x - corners.TL.x, corners.TR.y - corners.TL.y);
  const elHeight = Math.hypot(corners.BL.x - corners.TL.x, corners.BL.y - corners.TL.y);
  const isCircle = radialShape === 'circle';
  const isCustomSize = radialSize === 'custom';

  // Calculate screen-space radii based on shape and size mode
  let rx: number;
  let ry: number;

  if (!isCustomSize) {
    // Size keyword mode — approximate the radius from element dimensions
    const cxPx = (centerX / 100) * elWidth;
    const cyPx = (centerY / 100) * elHeight;
    switch (radialSize) {
      case 'closest-side':
        rx = Math.min(cxPx, elWidth - cxPx);
        ry = isCircle ? rx : Math.min(cyPx, elHeight - cyPx);
        break;
      case 'farthest-side':
        rx = Math.max(cxPx, elWidth - cxPx);
        ry = isCircle ? rx : Math.max(cyPx, elHeight - cyPx);
        break;
      case 'closest-corner': {
        const d = Math.min(
          Math.hypot(cxPx, cyPx),
          Math.hypot(elWidth - cxPx, cyPx),
          Math.hypot(cxPx, elHeight - cyPx),
          Math.hypot(elWidth - cxPx, elHeight - cyPx)
        );
        rx = d; ry = isCircle ? d : d * (elHeight / elWidth);
        break;
      }
      default: { // farthest-corner
        const d = Math.max(
          Math.hypot(cxPx, cyPx),
          Math.hypot(elWidth - cxPx, cyPx),
          Math.hypot(cxPx, elHeight - cyPx),
          Math.hypot(elWidth - cxPx, elHeight - cyPx)
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
    e.stopPropagation();
    e.preventDefault();
    const el = e.currentTarget as SVGElement;
    el.setPointerCapture(e.pointerId);
    trace.action('gradient-overlay:radial-center-drag-start', {});

    const onMove = (me: PointerEvent) => {
      // Convert screen position to element percentage (inverse bilinear
      // across the quad — shared screenToPct from canvas-math)
      const [xRaw, yRaw] = screenToPct(corners, me.clientX, me.clientY);
      const xPct = Math.round(xRaw);
      const yPct = Math.round(yRaw);

      onCenterChange(
        clamp(xPct, 0, 100),
        clamp(yPct, 0, 100)
      );
    };

    const onUp = () => {
      el.releasePointerCapture(e.pointerId);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      onCommit?.();
      trace.action('gradient-overlay:radial-center-drag-end', {});
    };

    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
  }, [corners, onCenterChange, onCommit]);

  // Stop dragging along the horizontal radius
  const handleStopDrag = useCallback((e: React.PointerEvent, stopId: string) => {
    if (!onStopPositionChange) return;
    e.stopPropagation();
    e.preventDefault();
    if (onSelectStop) onSelectStop(stopId);
    const el = e.currentTarget as SVGElement;
    el.setPointerCapture(e.pointerId);
    trace.action('gradient-overlay:radial-stop-drag-start', { stopId });

    const onMove = (me: PointerEvent) => {
      const dist = Math.hypot(me.clientX - centerPt.x, me.clientY - centerPt.y);
      const maxR = Math.max(rx, ry);
      const pos = clamp(Math.round((dist / maxR) * 100), 0, 100);
      onStopPositionChange(stopId, pos);
    };

    const onUp = () => {
      el.releasePointerCapture(e.pointerId);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      onCommit?.();
      trace.action('gradient-overlay:radial-stop-drag-end', { stopId });
    };

    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
  }, [centerPt, rx, ry, onStopPositionChange, onSelectStop, onCommit]);

  return (
    <>
      <ellipse cx={centerPt.x} cy={centerPt.y} rx={rx} ry={ry}
        fill="none" stroke="white" strokeWidth={1} strokeDasharray="4 4" opacity={0.5} />
      {/* Horizontal line from center to right edge for stop placement */}
      <line x1={centerPt.x} y1={centerPt.y} x2={centerPt.x + rx} y2={centerPt.y}
        stroke="white" strokeWidth={1.5} opacity={0.7} />
      {/* Stop circles along the radius */}
      {stops.map(stop => {
        const t = stop.position / 100;
        const sx = centerPt.x + rx * t;
        const sy = centerPt.y;
        const isSelected = stop.id === selectedStopId;
        const fill = isMask ? maskStopFill(stop.color) : stop.color;
        return (
          <circle
            key={stop.id}
            cx={sx} cy={sy}
            r={isSelected ? 7 : 5}
            fill={fill}
            stroke="white"
            strokeWidth={isSelected ? 2.5 : 1.5}
            style={{ cursor: 'grab', filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.5))' }}
            onPointerDown={(e) => handleStopDrag(e, stop.id)}
          />
        );
      })}
      {/* Radius handles — only for custom size mode (not size keywords) */}
      {isCustomSize && !isCircle && (
        <>
          {/* Top handle — drag to resize vertical radius (ellipse only) */}
          <Handle x={centerPt.x} y={centerPt.y - ry} color="#ffffff"
            onPointerDown={(e) => {
              if (!onRadiusChange) return;
              e.stopPropagation(); e.preventDefault();
              const el = e.currentTarget as SVGElement;
              el.setPointerCapture(e.pointerId);
              const onMove = (me: PointerEvent) => {
                const dist = Math.abs(me.clientY - centerPt.y);
                const newRY = Math.max(5, Math.round((dist / elHeight) * 100));
                onRadiusChange(radiusX, newRY);
              };
              const onUp = () => { el.releasePointerCapture(e.pointerId); el.removeEventListener('pointermove', onMove); el.removeEventListener('pointerup', onUp); onCommit?.(); };
              el.addEventListener('pointermove', onMove); el.addEventListener('pointerup', onUp);
            }}
          />
          {/* Right handle — drag to resize horizontal radius (ellipse only) */}
          <Handle x={centerPt.x + rx} y={centerPt.y} color="#ffffff"
            onPointerDown={(e) => {
              if (!onRadiusChange) return;
              e.stopPropagation(); e.preventDefault();
              const el = e.currentTarget as SVGElement;
              el.setPointerCapture(e.pointerId);
              const onMove = (me: PointerEvent) => {
                const dist = Math.abs(me.clientX - centerPt.x);
                const newRX = Math.max(5, Math.round((dist / elWidth) * 100));
                onRadiusChange(newRX, radiusY);
              };
          const onUp = () => { el.releasePointerCapture(e.pointerId); el.removeEventListener('pointermove', onMove); el.removeEventListener('pointerup', onUp); onCommit?.(); };
          el.addEventListener('pointermove', onMove); el.addEventListener('pointerup', onUp);
        }}
      />
        </>
      )}
      {/* Center handle */}
      <Handle x={centerPt.x} y={centerPt.y} color="#ffffff"
        onPointerDown={handleDrag} />
    </>
  );
}

// ─── Conic Gradient Overlay ─────────────────────────────────────────────────

function ConicOverlay({ corners, centerX, centerY, angle, stops, selectedStopId, onCenterChange, onAngleChange, onStopPositionChange, onSelectStop, onCommit, isMask }: {
  corners: ScreenCorners; centerX: number; centerY: number; angle: number;
  stops: GradientStop[]; selectedStopId: string | null;
  onCenterChange?: (x: number, y: number) => void;
  onAngleChange?: (deg: number) => void;
  onStopPositionChange?: (id: string, position: number) => void;
  onSelectStop?: (id: string) => void;
  onCommit?: () => void;
  isMask?: boolean;
}) {
  const centerPt = getPointOnElement(corners, centerX, centerY);
  const width = Math.hypot(corners.TR.x - corners.TL.x, corners.TR.y - corners.TL.y);
  const height = Math.hypot(corners.BL.x - corners.TL.x, corners.BL.y - corners.TL.y);
  const radius = Math.min(width, height) / 2;

  // Angle handle position
  const rad = degToRad(angle - 90);
  const handleX = centerPt.x + Math.cos(rad) * radius;
  const handleY = centerPt.y + Math.sin(rad) * radius;

  const handleAngleDrag = useCallback((e: React.PointerEvent) => {
    if (!onAngleChange) return;
    e.stopPropagation();
    e.preventDefault();
    const el = e.currentTarget as SVGElement;
    el.setPointerCapture(e.pointerId);
    trace.action('gradient-overlay:conic-angle-drag-start', { angle });

    const onMove = (me: PointerEvent) => {
      const dx = me.clientX - centerPt.x;
      const dy = me.clientY - centerPt.y;
      let deg = radToDeg(Math.atan2(dy, dx)) + 90;
      if (deg < 0) deg += 360;
      onAngleChange(Math.round(deg));
    };

    const onUp = () => {
      el.releasePointerCapture(e.pointerId);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      onCommit?.();
      trace.action('gradient-overlay:conic-angle-drag-end', {});
    };

    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
  }, [centerPt, onAngleChange, angle, onCommit]);

  // Center drag — same as radial
  const handleCenterDrag = useCallback((e: React.PointerEvent) => {
    if (!onCenterChange) return;
    e.stopPropagation();
    e.preventDefault();
    const el = e.currentTarget as SVGElement;
    el.setPointerCapture(e.pointerId);
    trace.action('gradient-overlay:conic-center-drag-start', {});

    const onMove = (me: PointerEvent) => {
      const [xRaw, yRaw] = screenToPct(corners, me.clientX, me.clientY);
      const xPct = clamp(Math.round(xRaw), 0, 100);
      const yPct = clamp(Math.round(yRaw), 0, 100);
      onCenterChange(xPct, yPct);
    };

    const onUp = () => {
      el.releasePointerCapture(e.pointerId);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      onCommit?.();
      trace.action('gradient-overlay:conic-center-drag-end', {});
    };

    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
  }, [corners, onCenterChange, onCommit]);

  // Stop dragging along the circle
  const handleStopDrag = useCallback((e: React.PointerEvent, stopId: string) => {
    if (!onStopPositionChange) return;
    e.stopPropagation();
    e.preventDefault();
    if (onSelectStop) onSelectStop(stopId);
    const el = e.currentTarget as SVGElement;
    el.setPointerCapture(e.pointerId);
    trace.action('gradient-overlay:conic-stop-drag-start', { stopId });

    const onMove = (me: PointerEvent) => {
      const dx = me.clientX - centerPt.x;
      const dy = me.clientY - centerPt.y;
      let stopAngle = radToDeg(Math.atan2(dy, dx)) + 90 - angle; // relative to start angle
      if (stopAngle < 0) stopAngle += 360;
      const pos = clamp(Math.round((stopAngle / 360) * 100), 0, 100);
      onStopPositionChange(stopId, pos);
    };

    const onUp = () => {
      el.releasePointerCapture(e.pointerId);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      onCommit?.();
      trace.action('gradient-overlay:conic-stop-drag-end', { stopId });
    };

    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
  }, [centerPt, angle, onStopPositionChange, onSelectStop, onCommit]);

  return (
    <>
      {/* Angle line from center to handle */}
      <line x1={centerPt.x} y1={centerPt.y} x2={handleX} y2={handleY}
        stroke="white" strokeWidth={1.5} opacity={0.7} />
      {/* Circle outline */}
      <circle cx={centerPt.x} cy={centerPt.y} r={radius}
        fill="none" stroke="white" strokeWidth={1} strokeDasharray="4 4" opacity={0.3} />
      {/* Stop circles along the circumference */}
      {stops.map(stop => {
        const stopRad = degToRad(angle - 90 + (stop.position / 100) * 360);
        const sx = centerPt.x + Math.cos(stopRad) * radius;
        const sy = centerPt.y + Math.sin(stopRad) * radius;
        const isSelected = stop.id === selectedStopId;
        const fill = isMask ? maskStopFill(stop.color) : stop.color;
        return (
          <circle
            key={stop.id}
            cx={sx} cy={sy}
            r={isSelected ? 7 : 5}
            fill={fill}
            stroke="white"
            strokeWidth={isSelected ? 2.5 : 1.5}
            style={{ cursor: 'grab', filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.5))' }}
            onPointerDown={(e) => handleStopDrag(e, stop.id)}
          />
        );
      })}
      {/* Angle handle */}
      <Handle x={handleX} y={handleY} color="#4dabf7"
        onPointerDown={handleAngleDrag} />
      {/* Center handle */}
      <Handle x={centerPt.x} y={centerPt.y} color="#ffffff"
        onPointerDown={handleCenterDrag} />
    </>
  );
}

// ─── Main GradientOverlay ───────────────────────────────────────────────────

export default function GradientOverlay(props: GradientOverlayProps) {
  const { corners, gradientType, direction, centerX, centerY, radiusX, radiusY, radialShape, radialSize, angle, stops, selectedStopId,
    onDirectionChange, onCenterChange, onRadiusChange, onAngleChange, onStopPositionChange, onSelectStop, onCommit, isMask } = props;

  // Stable commit fn (latest via ref) so the sub-overlays' drag useCallbacks
  // don't re-register every render.
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;
  const commit = useCallback(() => onCommitRef.current?.(), []);

  return (
    <svg
      style={{
        position: 'fixed', left: 0, top: 0,
        width: '100vw', height: '100vh',
        pointerEvents: 'none', overflow: 'visible', zIndex: 2,
      }}
    >
      <g style={{ pointerEvents: 'auto' }}>
        {gradientType === 'linear' && (
          <LinearOverlay corners={corners} direction={direction}
            stops={stops} selectedStopId={selectedStopId}
            onDirectionChange={onDirectionChange}
            onStopPositionChange={onStopPositionChange}
            onSelectStop={onSelectStop} onCommit={commit} isMask={isMask} />
        )}
        {gradientType === 'radial' && (
          <RadialOverlay corners={corners} centerX={centerX} centerY={centerY}
            radiusX={radiusX} radiusY={radiusY}
            radialShape={radialShape} radialSize={radialSize}
            stops={stops} selectedStopId={selectedStopId}
            onCenterChange={onCenterChange}
            onRadiusChange={onRadiusChange}
            onStopPositionChange={onStopPositionChange}
            onSelectStop={onSelectStop} onCommit={commit} isMask={isMask} />
        )}
        {gradientType === 'conic' && (
          <ConicOverlay corners={corners} centerX={centerX} centerY={centerY}
            angle={angle} stops={stops} selectedStopId={selectedStopId}
            onCenterChange={onCenterChange} onAngleChange={onAngleChange}
            onStopPositionChange={onStopPositionChange}
            onSelectStop={onSelectStop} onCommit={commit} isMask={isMask} />
        )}
      </g>
    </svg>
  );
}
