// FancyRadiusOverlay.tsx — Canvas overlay for 8-value border-radius visual editing.
// 8 draggable handles positioned where the radius curve starts on each edge.
// Horizontal handles (top/bottom edges) control horizontal radii.
// Vertical handles (left/right edges) control vertical radii.
// Same pattern as ClipPathOverlay: pointer capture, ref-based callbacks, screen coords.

import { useRef, useCallback } from 'react';
import type { ScreenCorners } from '@/canvas/resize/geometry-utils';
import type { FancyRadiusData } from '@/shared/border-radius-utils';
import { pctToScreen, screenToPct as _screenToPct, clamp } from '@/canvas/canvas-math';
import { SELECTION_COLOR } from '@/shared/constants';
import { trace } from '@/shared/debug-trace';

const screenToPct = _screenToPct;
const HANDLE_R = 6;

// ─── Handle positions (which % axis each handle controls) ───────────────────

type HandleId = 'tlH' | 'trH' | 'brH' | 'blH' | 'tlV' | 'trV' | 'brV' | 'blV';

interface HandleConfig {
  id: HandleId;
  // How to compute screen position from the data value
  getPos: (data: FancyRadiusData, corners: ScreenCorners) => { x: number; y: number };
  // Which axis is constrained (only moves along this axis)
  axis: 'x' | 'y';
  // How to convert screen drag position to percentage value
  fromScreen: (sx: number, sy: number, corners: ScreenCorners) => number;
}

// screenToPct returns [xPct, yPct] tuple
const pctX = (sx: number, sy: number, c: ScreenCorners) => screenToPct(c, sx, sy)[0];
const pctY = (sx: number, sy: number, c: ScreenCorners) => screenToPct(c, sx, sy)[1];

const HANDLES: HandleConfig[] = [
  // Top edge: TL-h (left side) and TR-h (right side)
  { id: 'tlH', getPos: (d, c) => pctToScreen(c, d.tlH, 0), axis: 'x', fromScreen: (sx, sy, c) => pctX(sx, sy, c) },
  { id: 'trH', getPos: (d, c) => pctToScreen(c, 100 - d.trH, 0), axis: 'x', fromScreen: (sx, sy, c) => 100 - pctX(sx, sy, c) },
  // Bottom edge: BL-h and BR-h
  { id: 'blH', getPos: (d, c) => pctToScreen(c, d.blH, 100), axis: 'x', fromScreen: (sx, sy, c) => pctX(sx, sy, c) },
  { id: 'brH', getPos: (d, c) => pctToScreen(c, 100 - d.brH, 100), axis: 'x', fromScreen: (sx, sy, c) => 100 - pctX(sx, sy, c) },
  // Left edge: TL-v (top side) and BL-v (bottom side)
  { id: 'tlV', getPos: (d, c) => pctToScreen(c, 0, d.tlV), axis: 'y', fromScreen: (sx, sy, c) => pctY(sx, sy, c) },
  { id: 'blV', getPos: (d, c) => pctToScreen(c, 0, 100 - d.blV), axis: 'y', fromScreen: (sx, sy, c) => 100 - pctY(sx, sy, c) },
  // Right edge: TR-v and BR-v
  { id: 'trV', getPos: (d, c) => pctToScreen(c, 100, d.trV), axis: 'y', fromScreen: (sx, sy, c) => pctY(sx, sy, c) },
  { id: 'brV', getPos: (d, c) => pctToScreen(c, 100, 100 - d.brV), axis: 'y', fromScreen: (sx, sy, c) => 100 - pctY(sx, sy, c) },
];

// ─── Overlay Component ──────────────────────────────────────────────────────

interface FancyRadiusOverlayProps {
  corners: ScreenCorners;
  data: FancyRadiusData;
  /** Live update — fires on every pointermove. Should be DOM-only. */
  onChange: (data: FancyRadiusData) => void;
  /** Commit — fires once on pointerup. Goes through the mutation queue. */
  onCommit?: (data: FancyRadiusData) => void;
}

export default function FancyRadiusOverlay({ corners, data, onChange, onCommit }: FancyRadiusOverlayProps) {
  // Refs to avoid stale closure in drag callbacks
  const dataRef = useRef(data);
  dataRef.current = data;
  const cornersRef = useRef(corners);
  cornersRef.current = corners;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;

  const handleDrag = useCallback((e: React.PointerEvent, config: HandleConfig) => {
    e.stopPropagation();
    const target = e.currentTarget as SVGElement;
    target.setPointerCapture(e.pointerId);

    const onMove = (ev: PointerEvent) => {
      const pct = config.fromScreen(ev.clientX, ev.clientY, cornersRef.current);
      const clamped = clamp(pct, 0, 100);
      const newData = { ...dataRef.current, [config.id]: clamped };
      dataRef.current = newData;
      onChangeRef.current(newData);
    };

    const onUp = () => {
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      trace.action('fancy-radius:drag-end', { handle: config.id, value: dataRef.current[config.id] });
      // Commit final value through the mutation queue. Live drag used DOM-only
      // patches to avoid racing the renderer; on release we persist to code.
      onCommitRef.current?.(dataRef.current);
    };

    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
    trace.action('fancy-radius:drag-start', { handle: config.id });
  }, []);

  // Draw the border-radius curve preview
  const tl = pctToScreen(corners, 0, 0);
  const tr = pctToScreen(corners, 100, 0);
  const br = pctToScreen(corners, 100, 100);
  const bl = pctToScreen(corners, 0, 100);

  // Curve control points for the border-radius shape preview
  const tlHp = pctToScreen(corners, data.tlH, 0);
  const trHp = pctToScreen(corners, 100 - data.trH, 0);
  const tlVp = pctToScreen(corners, 0, data.tlV);
  const trVp = pctToScreen(corners, 100, data.trV);
  const brHp = pctToScreen(corners, 100 - data.brH, 100);
  const blHp = pctToScreen(corners, data.blH, 100);
  const brVp = pctToScreen(corners, 100, 100 - data.brV);
  const blVp = pctToScreen(corners, 0, 100 - data.blV);

  // Build SVG path: move along edges with quadratic curves at corners
  const pathD = [
    `M ${tlHp.x} ${tlHp.y}`,
    // Top edge
    `L ${trHp.x} ${trHp.y}`,
    // Top-right corner curve
    `Q ${tr.x} ${tr.y} ${trVp.x} ${trVp.y}`,
    // Right edge
    `L ${brVp.x} ${brVp.y}`,
    // Bottom-right corner curve
    `Q ${br.x} ${br.y} ${brHp.x} ${brHp.y}`,
    // Bottom edge
    `L ${blHp.x} ${blHp.y}`,
    // Bottom-left corner curve
    `Q ${bl.x} ${bl.y} ${blVp.x} ${blVp.y}`,
    // Left edge
    `L ${tlVp.x} ${tlVp.y}`,
    // Top-left corner curve
    `Q ${tl.x} ${tl.y} ${tlHp.x} ${tlHp.y}`,
    'Z',
  ].join(' ');

  return (
    <svg
      style={{
        position: 'fixed', left: 0, top: 0,
        width: '100vw', height: '100vh',
        pointerEvents: 'none', overflow: 'visible', zIndex: 2,
      }}
    >
    <g style={{ pointerEvents: 'auto' }}>
      {/* Shape preview outline */}
      <path
        d={pathD}
        fill="none"
        stroke={SELECTION_COLOR}
        strokeWidth={1.5}
        strokeDasharray="4 3"
        opacity={0.6}
        style={{ pointerEvents: 'none' }}
      />

      {/* Guide lines from corners to handles */}
      {HANDLES.map(config => {
        const pos = config.getPos(data, corners);
        // Find the nearest corner for the guide line
        const cornerMap: Record<HandleId, { x: number; y: number }> = {
          tlH: tl, trH: tr, blH: bl, brH: br,
          tlV: tl, trV: tr, blV: bl, brV: br,
        };
        const corner = cornerMap[config.id];
        return (
          <line
            key={`guide-${config.id}`}
            x1={corner.x} y1={corner.y}
            x2={pos.x} y2={pos.y}
            stroke={SELECTION_COLOR}
            strokeWidth={0.8}
            opacity={0.3}
            style={{ pointerEvents: 'none' }}
          />
        );
      })}

      {/* 8 draggable handles */}
      {HANDLES.map(config => {
        const pos = config.getPos(data, corners);
        return (
          <circle
            key={config.id}
            cx={pos.x}
            cy={pos.y}
            r={HANDLE_R}
            fill={SELECTION_COLOR}
            stroke="#ffffff"
            strokeWidth={2}
            style={{
              cursor: config.axis === 'x' ? 'ew-resize' : 'ns-resize',
              filter: 'drop-shadow(0 1px 3px rgba(0,0,0,0.4))',
            }}
            onMouseDown={e => { e.stopPropagation(); }}
            onPointerDown={e => handleDrag(e, config)}
          />
        );
      })}
      {/* Values tooltip under the element */}
      {(() => {
        const bottomCenter = pctToScreen(corners, 50, 100);
        const label = `${Math.round(data.tlH)} ${Math.round(data.trH)} ${Math.round(data.brH)} ${Math.round(data.blH)} / ${Math.round(data.tlV)} ${Math.round(data.trV)} ${Math.round(data.brV)} ${Math.round(data.blV)}%`;
        return (
          <g style={{ pointerEvents: 'none' }}>
            <rect
              x={bottomCenter.x - 120}
              y={bottomCenter.y + 12}
              width={240}
              height={24}
              rx={4}
              fill="rgba(0,0,0,0.8)"
            />
            <text
              x={bottomCenter.x}
              y={bottomCenter.y + 28}
              textAnchor="middle"
              fill="#ffffff"
              fontSize={11}
              fontFamily="monospace"
            >
              {label}
            </text>
          </g>
        );
      })()}
    </g>
    </svg>
  );
}
