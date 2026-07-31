// WaveLines — Code component template (Canvas 2D animated stacked waveform lines).
//
// Black background with rows of sinuous white lines flowing across the
// frame. The "ribbons" tilt and stack vertically, each offset by a seed
// so they don't visually align. Controls match the live website's
// shader panel: fill (background), line color, line width, blur, seed,
// speed, amplitude, tilt, zoom, height (row count), brightness.
//
// Performance: `useStaticCanvas()` flips the code component into a paint-once
// branch (no rAF, dpr=1) on the editor canvas so panning/zoom stays
// smooth. Live preview and the published site keep the full animated
// version.

export const WAVE_LINES_COMPONENT = `'use client';

/** @label "Wave Lines" */
/** @comment "Animated stacked waveform lines — set fill + line color, sculpt with amplitude/tilt/zoom." */
/** @defaultWidth 600 */
/** @defaultHeight 400 */
/** @controls {
  "fill": { "type": "color", "label": "Fill", "default": "#000000" },
  "lineColor": { "type": "color", "label": "Line Color", "default": "#FFFFFF" },
  "lineWidth": { "type": "number", "label": "Line Width", "min": 0.1, "max": 3, "step": 0.1, "default": 0.6 },
  "lineBlur": { "type": "number", "label": "Line Blur", "min": 0, "max": 8, "step": 0.5, "default": 1 },
  "seed": { "type": "number", "label": "Seed", "min": 0, "max": 999, "step": 1, "default": 333 },
  "speed": { "type": "number", "label": "Speed", "min": 0, "max": 6, "step": 0.1, "default": 2 },
  "amplitude": { "type": "number", "label": "Amplitude", "min": 0, "max": 2, "step": 0.05, "default": 0.7 },
  "tilt": { "type": "number", "label": "Tilt", "min": -45, "max": 45, "step": 1, "default": -10 },
  "zoom": { "type": "number", "label": "Zoom", "min": 0.1, "max": 3, "step": 0.05, "default": 0.6 },
  "rows": { "type": "number", "label": "Rows", "min": 8, "max": 80, "step": 1, "default": 36 },
  "brightness": { "type": "number", "label": "Brightness", "min": 0.1, "max": 4, "step": 0.1, "default": 1.6 }
} */

import React, { useEffect, useRef } from 'react';
import { withResponsiveProps, useStaticCanvas } from '@revyme/runtime';

function WaveLines({
  fill = '#000000',
  lineColor = '#FFFFFF',
  lineWidth = 0.6,
  lineBlur = 1,
  seed = 333,
  speed = 2,
  amplitude = 0.7,
  tilt = -10,
  zoom = 0.6,
  rows = 36,
  brightness = 1.6,
  ...props
}) {
  const canvasRef = useRef(null);
  const isStatic = useStaticCanvas();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let raf = 0;
    let t0 = isStatic
      ? performance.now() - 1000 / Math.max(speed, 0.1)
      : performance.now();
    let lastSize = { w: 0, h: 0 };

    const sync = () => {
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (w === 0 || h === 0) return false;
      if (w !== lastSize.w || h !== lastSize.h) {
        const dpr = isStatic ? 1 : (window.devicePixelRatio || 1);
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        lastSize = { w, h };
      }
      return true;
    };

    const draw = () => {
      if (!sync()) { if (!isStatic) raf = requestAnimationFrame(draw); return; }
      const w = lastSize.w, h = lastSize.h;
      const t = ((performance.now() - t0) / 1000) * speed;

      ctx.fillStyle = fill;
      ctx.fillRect(0, 0, w, h);

      ctx.save();
      ctx.translate(w / 2, h / 2);
      ctx.rotate((tilt * Math.PI) / 180);
      ctx.translate(-w / 2, -h / 2);

      ctx.strokeStyle = lineColor;
      ctx.lineWidth = lineWidth;
      ctx.globalAlpha = Math.min(1, brightness * 0.6);
      ctx.shadowBlur = lineBlur;
      ctx.shadowColor = lineColor;
      ctx.lineCap = 'round';

      const step = h / Math.max(2, rows);
      const segs = Math.max(40, Math.floor(w / 8));

      for (let r = 0; r < rows; r++) {
        const y0 = r * step + step / 2;
        const phase = (r * 0.41 + seed * 0.013);
        ctx.beginPath();
        for (let i = 0; i <= segs; i++) {
          const x = (i / segs) * w;
          const u = (x / w) * 6 * zoom + phase;
          const wobble =
            Math.sin(u + t) * 0.6 +
            Math.sin(u * 1.7 + t * 1.3 + r * 0.21) * 0.3 +
            Math.cos(u * 0.6 + t * 0.7) * 0.1;
          const y = y0 + wobble * step * 6 * amplitude;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      ctx.restore();
      if (!isStatic) raf = requestAnimationFrame(draw);
    };

    if (isStatic) {
      draw();
      const ro = new ResizeObserver(draw);
      ro.observe(canvas);
      return () => ro.disconnect();
    }

    raf = requestAnimationFrame(draw);
    const ro = new ResizeObserver(() => sync());
    ro.observe(canvas);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [fill, lineColor, lineWidth, lineBlur, seed, speed, amplitude, tilt, zoom, rows, brightness, isStatic]);

  const style = { ...(props.style || {}), position: 'relative', overflow: 'hidden', backgroundColor: fill };

  return (
    <div data-id={props['data-id']} data-name={props['data-name']} style={style}>
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
    </div>
  );
}

export default withResponsiveProps(WaveLines);
`;
