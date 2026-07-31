// RibbonCursor — Code component template (a tapered ribbon trailing the cursor).
//
// Architecture: region hotspot. NO slot, NO children. The bounding box IS the
// active zone and the layer is `pointer-events: none` so it can sit over real
// content without swallowing clicks.
//
// Deliberately Canvas 2D, not WebGL. The original approach for this effect is
// a GPU polyline via a 3D library pulled from a CDN; doing it on the 2D
// context keeps the published site free of an extra runtime download and is
// entirely fast enough — the ribbon is a few dozen vertices per frame.
//
// Motion is a rope solve, not per-point easing: the head springs toward the
// cursor, then every following point is pulled to sit exactly `segment` px
// behind its predecessor. Distance-constraining the chain (rather than
// lerping each point independently) is what keeps the ribbon a constant
// length instead of bunching up when the cursor stops.
//
// The outline is built by walking the spine and offsetting perpendicular to
// the local direction by a half-width that tapers to zero at the tail, so
// the two edges meet in a point.

export const RIBBON_CURSOR_COMPONENT = `'use client';

/** @label "Ribbon Cursor" */
/** @comment "A flowing tapered ribbon that trails the cursor inside this region." */
/** @defaultWidth 600 */
/** @defaultHeight 400 */
/** @controls {
  "points": { "type": "number", "label": "Length", "min": 6, "max": 80, "step": 1, "default": 32 },
  "segment": { "type": "number", "label": "Segment", "min": 2, "max": 30, "step": 1, "default": 9, "unit": "px" },
  "thickness": { "type": "number", "label": "Thickness", "min": 2, "max": 80, "step": 1, "default": 26, "unit": "px" },
  "tension": { "type": "number", "label": "Tension", "min": 0.05, "max": 1, "step": 0.05, "default": 0.3 },
  "colorHead": { "type": "color", "label": "Head Color", "default": "#a855f7" },
  "colorTail": { "type": "color", "label": "Tail Color", "default": "#5227ff" },
  "wave": { "type": "number", "label": "Wave", "min": 0, "max": 20, "step": 1, "default": 0, "unit": "px" }
} */

import { useEffect, useRef } from 'react';
import { withResponsiveProps, useStaticCanvas } from '@revyme/runtime';

function RibbonCursor({
  points = 32,
  segment = 9,
  thickness = 26,
  tension = 0.3,
  colorHead = '#a855f7',
  colorTail = '#5227ff',
  wave = 0,
  ...props
}) {
  const canvasRef = useRef(null);
  const isStatic = useStaticCanvas();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    let w = canvas.clientWidth;
    let h = canvas.clientHeight;

    function resize() {
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const count = Math.max(4, Math.round(points));
    const spine = [];
    for (let i = 0; i < count; i++) spine.push({ x: w * 0.5, y: h * 0.5 });

    let cursor = { x: w * 0.5, y: h * 0.5 };
    let seeded = false;
    let phase = 0;

    // Pull each point to sit exactly one segment behind the one in front.
    function solve() {
      spine[0].x += (cursor.x - spine[0].x) * Math.max(0.02, tension);
      spine[0].y += (cursor.y - spine[0].y) * Math.max(0.02, tension);

      for (let i = 1; i < spine.length; i++) {
        const prev = spine[i - 1];
        const cur = spine[i];
        let dx = cur.x - prev.x;
        let dy = cur.y - prev.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 0.0001;
        const scale = segment / d;
        cur.x = prev.x + dx * scale;
        cur.y = prev.y + dy * scale;
      }
    }

    function draw() {
      ctx.clearRect(0, 0, w, h);
      if (spine.length < 3) return;

      const left = [];
      const right = [];

      for (let i = 0; i < spine.length; i++) {
        const p = spine[i];
        const a = spine[Math.max(0, i - 1)];
        const b = spine[Math.min(spine.length - 1, i + 1)];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        const len = Math.sqrt(dx * dx + dy * dy) || 0.0001;
        // Perpendicular to the local direction.
        const nx = -dy / len;
        const ny = dx / len;

        const t = i / (spine.length - 1);
        const half = (thickness / 2) * (1 - t);
        // Optional sideways ripple travelling down the ribbon.
        const offset = wave > 0 ? Math.sin(phase + i * 0.35) * wave * t : 0;

        left.push({ x: p.x + nx * half + nx * offset, y: p.y + ny * half + ny * offset });
        right.push({ x: p.x - nx * half + nx * offset, y: p.y - ny * half + ny * offset });
      }

      ctx.beginPath();
      ctx.moveTo(left[0].x, left[0].y);
      for (let i = 1; i < left.length; i++) ctx.lineTo(left[i].x, left[i].y);
      for (let i = right.length - 1; i >= 0; i--) ctx.lineTo(right[i].x, right[i].y);
      ctx.closePath();

      const head = spine[0];
      const tail = spine[spine.length - 1];
      const grad = ctx.createLinearGradient(head.x, head.y, tail.x, tail.y);
      grad.addColorStop(0, colorHead);
      grad.addColorStop(1, colorTail);
      ctx.fillStyle = grad;
      ctx.fill();
    }

    // Editor canvas: pose the ribbon along a gentle arc so the still shows a
    // ribbon rather than every point collapsed onto one spot.
    if (isStatic) {
      for (let i = 0; i < spine.length; i++) {
        const t = i / (spine.length - 1);
        spine[i].x = w * (0.68 - 0.42 * t);
        spine[i].y = h * (0.38 + 0.18 * Math.sin(t * 2.2));
      }
      draw();
      return function () { ro.disconnect(); };
    }

    let raf = 0;

    function tick() {
      phase += 0.06;
      solve();
      draw();
      raf = requestAnimationFrame(tick);
    }

    function onMove(ev) {
      const r = canvas.getBoundingClientRect();
      cursor = { x: ev.clientX - r.left, y: ev.clientY - r.top };
      if (!seeded) {
        for (let i = 0; i < spine.length; i++) { spine[i].x = cursor.x; spine[i].y = cursor.y; }
        seeded = true;
      }
    }

    window.addEventListener('pointermove', onMove, { passive: true });
    raf = requestAnimationFrame(tick);

    return function () {
      window.removeEventListener('pointermove', onMove);
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [points, segment, thickness, tension, colorHead, colorTail, wave, isStatic]);

  return (
    <div
      data-id={props['data-id']}
      data-name={props['data-name']}
      style={{
        position: 'relative',
        overflow: 'hidden',
        pointerEvents: 'none',
        ...props.style,
      }}
    >
      <canvas
        ref={canvasRef}
        style={{ position: 'absolute', top: '0px', left: '0px', width: '100%', height: '100%', display: 'block' }}
      />
    </div>
  );
}

export default withResponsiveProps(RibbonCursor);
`;
