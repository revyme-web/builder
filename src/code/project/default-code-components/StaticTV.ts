// StaticTV — Code component template (Canvas 2D animated TV static noise).
//
// Performance: `useStaticCanvas()` flips the code component into a paint-once
// branch (no rAF) on the editor canvas — the `draw()` call already
// renders one representative frame. Live preview and the published
// site keep the full animated version.

export const STATIC_TV_COMPONENT = `'use client';

/** @label "Static TV" */
/** @comment "Animated TV static noise." */
/** @defaultWidth 600 */
/** @defaultHeight 400 */
/** @controls {
  "intensity": { "type": "number", "label": "Intensity", "min": 0.1, "max": 1, "step": 0.05, "default": 0.4 },
  "pixelSize": { "type": "number", "label": "Pixel Size", "min": 1, "max": 8, "step": 1, "default": 2, "unit": "px" },
  "speed": { "type": "number", "label": "Speed", "min": 1, "max": 30, "step": 1, "default": 12 }
} */

import { useEffect, useRef } from 'react';
import { withResponsiveProps, useStaticCanvas } from '@revyme/runtime';

function StaticTV({
  intensity = 0.4,
  pixelSize = 2,
  speed = 12,
  ...props
}) {
  const canvasRef = useRef(null);
  const isStatic = useStaticCanvas();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = isStatic ? 1 : (window.devicePixelRatio || 1);
    let raf = 0;
    let frame = 0;

    function draw() {
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (w === 0 || h === 0) return;
      const cw = Math.max(1, Math.ceil(w / pixelSize));
      const ch = Math.max(1, Math.ceil(h / pixelSize));
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const off = document.createElement('canvas');
      off.width = cw; off.height = ch;
      const oc = off.getContext('2d');
      const img = oc.createImageData(cw, ch);
      for (let i = 0; i < img.data.length; i += 4) {
        const v = Math.random() * 255;
        img.data[i] = v;
        img.data[i + 1] = v;
        img.data[i + 2] = v;
        img.data[i + 3] = intensity * 255;
      }
      oc.putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(off, 0, 0, w, h);
    }

    function tick() {
      frame++;
      if (frame % Math.max(1, Math.round(30 / speed)) === 0) draw();
      raf = requestAnimationFrame(tick);
    }

    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(canvas);

    if (isStatic) {
      return () => ro.disconnect();
    }

    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [intensity, pixelSize, speed, isStatic]);

  return (
    <div data-id={props['data-id']} data-name={props['data-name']}
         style={{ ...props.style, position: 'relative', overflow: 'hidden' }}>
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block', pointerEvents: 'none' }} />
    </div>
  );
}

export default withResponsiveProps(StaticTV);
`;
