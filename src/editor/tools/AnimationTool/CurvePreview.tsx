// CurvePreview.tsx — Interactive bezier editor (Ease) + static spring preview.

import { useState, useRef, useCallback, useEffect } from 'react';

const W = 200, H = 80, PAD = 15, HPAD = 15, VPAD = 15;
const totalW = W + HPAD * 2;
const totalH = H + VPAD * 2;

/** Map easing names to cubic bezier control points */
export const EASE_BEZIERS: Record<string, [number, number, number, number]> = {
  'linear': [0, 0, 1, 1],
  'easeIn': [0.42, 0, 1, 1],
  'easeOut': [0, 0, 0.58, 1],
  'easeInOut': [0.42, 0, 0.58, 1],
  'backIn': [0.36, 0, 0.66, -0.56],
  'backOut': [0.34, 1.56, 0.64, 1],
  'circIn': [0.55, 0, 1, 0.45],
  'circOut': [0, 0.55, 0.45, 1],
  'anticipate': [0.36, 0, 0.66, -0.56],
};

function parseEaseValue(ease: string): { name: string; bezier: [number, number, number, number] } {
  if (EASE_BEZIERS[ease]) return { name: ease, bezier: EASE_BEZIERS[ease] };
  const nums = ease.replace(/[[\]]/g, '').split(',').map(s => parseFloat(s.trim()));
  if (nums.length === 4 && nums.every(n => !isNaN(n))) return { name: 'custom', bezier: nums as [number, number, number, number] };
  return { name: ease, bezier: EASE_BEZIERS['easeOut'] };
}

function getSpringCurvePoints(stiffness: number, damping: number, mass: number, bounce: number, mode: 'time' | 'physics'): string {
  const points: string[] = [];
  const steps = 60;
  if (mode === 'physics') {
    const omega = Math.sqrt(stiffness / Math.max(mass, 0.1));
    const zeta = damping / (2 * Math.sqrt(stiffness * Math.max(mass, 0.1)));
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * 3;
      const x = i / steps;
      let y: number;
      if (zeta < 1) {
        const wd = omega * Math.sqrt(1 - zeta * zeta);
        y = 1 - Math.exp(-zeta * omega * t) * (Math.cos(wd * t) + (zeta / Math.sqrt(1 - zeta * zeta)) * Math.sin(wd * t));
      } else {
        y = 1 - Math.exp(-omega * t) * (1 + omega * t);
      }
      y = Math.max(0, Math.min(1.3, y));
      points.push(`${x * W} ${VPAD + PAD + (1 - y / 1.3) * (H - PAD * 2)}`);
    }
  } else {
    for (let i = 0; i <= steps; i++) {
      const x = i / steps;
      const decay = Math.exp(-6 * (1 - bounce) * x);
      const oscillation = Math.cos(x * Math.PI * 2 * (1 + bounce * 3));
      let y = 1 - decay * oscillation * (1 - x);
      y = Math.max(0, Math.min(1.3, y));
      points.push(`${x * W} ${VPAD + PAD + (1 - y / 1.3) * (H - PAD * 2)}`);
    }
  }
  return 'M ' + points.join(' L ');
}

export default function CurvePreview({ isSpring, ease, bounce, stiffness, damping, mass, springMode, onEaseChange }: {
  isSpring: boolean; ease: string; bounce: number;
  stiffness: number; damping: number; mass: number;
  springMode: 'time' | 'physics';
  onEaseChange?: (bezier: [number, number, number, number]) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const mapX = (v: number) => HPAD + v * W;
  const oMapY = (v: number) => VPAD + PAD + (1 - v) * (H - PAD * 2);

  const { bezier } = parseEaseValue(ease);
  const [cp, setCp] = useState<[number, number, number, number]>(bezier);
  useEffect(() => { setCp(parseEaseValue(ease).bezier); }, [ease]);

  const handleDrag = useCallback((pointIdx: 0 | 1, e: React.PointerEvent) => {
    if (!svgRef.current || !onEaseChange) return;
    e.preventDefault();
    const rect = svgRef.current.getBoundingClientRect();
    const scaleX = totalW / rect.width;
    const scaleY = totalH / rect.height;

    const onMove = (me: PointerEvent) => {
      const x = (me.clientX - rect.left) * scaleX;
      const y = (me.clientY - rect.top) * scaleY;
      const newCp: [number, number, number, number] = [...cp];
      newCp[pointIdx * 2] = Math.round(Math.max(0, Math.min(1, (x - HPAD) / W)) * 100) / 100;
      newCp[pointIdx * 2 + 1] = Math.round((1 - (y - VPAD - PAD) / (H - PAD * 2)) * 100) / 100;
      setCp(newCp);
      onEaseChange(newCp);
    };
    const onUp = () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [cp, onEaseChange]);

  const boxStyle = { backgroundColor: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)', padding: '4px' };

  if (isSpring) {
    const path = getSpringCurvePoints(stiffness, damping, mass, bounce, springMode);
    const sMapY = (v: number) => VPAD + PAD + (1 - v) * (H - PAD * 2);
    return (
      <div className="w-full cut-corners overflow-hidden" style={boxStyle}>
        <svg width="100%" viewBox={`0 0 ${totalW} ${totalH}`} style={{ display: 'block' }}>
          <line x1={HPAD} y1={sMapY(0)} x2={HPAD + W} y2={sMapY(0)} stroke="rgba(255,255,255,0.06)" strokeWidth="0.5" />
          <line x1={HPAD} y1={sMapY(1)} x2={HPAD + W} y2={sMapY(1)} stroke="rgba(255,255,255,0.06)" strokeWidth="0.5" />
          <g transform={`translate(${HPAD}, 0)`}>
            <path d={path} fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth="2" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          </g>
        </svg>
      </div>
    );
  }

  const [x1, y1, x2, y2] = cp;
  const p0 = { x: HPAD, y: oMapY(0) };
  const p1 = { x: mapX(x1), y: oMapY(y1) };
  const p2 = { x: mapX(x2), y: oMapY(y2) };
  const p3 = { x: HPAD + W, y: oMapY(1) };
  const curvePath = `M ${p0.x} ${p0.y} C ${p1.x} ${p1.y}, ${p2.x} ${p2.y}, ${p3.x} ${p3.y}`;

  return (
    <div className="w-full cut-corners overflow-hidden" style={boxStyle}>
      <svg ref={svgRef} width="100%" viewBox={`0 0 ${totalW} ${totalH}`} style={{ display: 'block', cursor: 'default' }}>
        <line x1={HPAD} y1={oMapY(0)} x2={HPAD + W} y2={oMapY(0)} stroke="rgba(255,255,255,0.06)" strokeWidth="0.5" />
        <line x1={HPAD} y1={oMapY(1)} x2={HPAD + W} y2={oMapY(1)} stroke="rgba(255,255,255,0.06)" strokeWidth="0.5" />
        <line x1={p0.x} y1={p0.y} x2={p1.x} y2={p1.y} stroke="var(--accent)" strokeWidth="1" opacity="0.5" vectorEffect="non-scaling-stroke" />
        <line x1={p3.x} y1={p3.y} x2={p2.x} y2={p2.y} stroke="var(--accent)" strokeWidth="1" opacity="0.5" vectorEffect="non-scaling-stroke" />
        <path d={curvePath} fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth="2" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        <circle cx={p0.x} cy={p0.y} r="4" fill="rgba(255,255,255,0.3)" vectorEffect="non-scaling-stroke" />
        <circle cx={p3.x} cy={p3.y} r="4" fill="rgba(255,255,255,0.3)" vectorEffect="non-scaling-stroke" />
        <circle cx={p1.x} cy={p1.y} r="6" fill="var(--accent)" stroke="var(--accent-fg)" strokeWidth="1.5"
          style={{ cursor: 'grab' }} vectorEffect="non-scaling-stroke" onPointerDown={(e) => handleDrag(0, e)} />
        <circle cx={p2.x} cy={p2.y} r="6" fill="var(--accent)" stroke="var(--accent-fg)" strokeWidth="1.5"
          style={{ cursor: 'grab' }} vectorEffect="non-scaling-stroke" onPointerDown={(e) => handleDrag(1, e)} />
      </svg>
    </div>
  );
}

/** Mini SVG curve icon for the TransitionRow button */
export function TransitionCurveIcon({ isSpring }: { isSpring: boolean }) {
  return (
    <svg width="24" height="16" viewBox="0 0 24 16" fill="none" className="shrink-0">
      {isSpring ? (
        <path d="M1 14 C6 14, 8 1, 12 1 C14 1, 14 6, 15 4 C16 2, 17 3, 18 3 C20 3, 22 3, 23 3"
          stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" fill="none" />
      ) : (
        <path d="M1 14 C8 14, 4 2, 23 2"
          stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" fill="none" />
      )}
    </svg>
  );
}

/** Summarize transition for display */
export function summarizeTransition(t: Record<string, string>): string {
  if (!t || Object.keys(t).length === 0) return 'Default';
  if (t.type === 'instant') return 'Instant';
  if (t.type === 'spring') return `Spring ${t.duration || '0.5'}s`;
  return `Ease ${t.duration || '0.3'}s`;
}
