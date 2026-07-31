// CausticsLight — Code component template (Canvas 2D animated water caustics).
//
// Pool-floor refraction caustics: bright filaments wandering across a
// dim base. Two interfering sine fields produce the characteristic
// pinch-and-spread net pattern; brightness, scale, intensity tune
// the look from sunlit-shallows to disco-flicker.
//
// Performance: `useStaticCanvas()` flips the code component into a paint-once
// branch (no rAF, dpr=1) on the editor canvas. Live preview and the
// published site keep the full animated version.

export const CAUSTICS_LIGHT_COMPONENT = `'use client';

/** @label "Caustics" */
/** @comment "Animated underwater caustic light pattern — adjust scale, intensity, glow." */
/** @defaultWidth 600 */
/** @defaultHeight 400 */
/** @controls {
  "baseColor": { "type": "color", "label": "Base Color", "default": "#001824" },
  "lightColor": { "type": "color", "label": "Light Color", "default": "#7DF9FF" },
  "speed": { "type": "number", "label": "Speed", "min": 0, "max": 4, "step": 0.05, "default": 1.2 },
  "scale": { "type": "number", "label": "Scale", "min": 0.5, "max": 6, "step": 0.05, "default": 2.5 },
  "intensity": { "type": "number", "label": "Intensity", "min": 0.2, "max": 3, "step": 0.05, "default": 1.4 },
  "glow": { "type": "number", "label": "Glow", "min": 0, "max": 1, "step": 0.01, "default": 0.5 },
  "sharpness": { "type": "number", "label": "Sharpness", "min": 1, "max": 8, "step": 0.1, "default": 4 }
} */

import React, { useEffect, useRef } from 'react';
import { withResponsiveProps, useStaticCanvas } from '@revyme/runtime';

function hexRgb(hex) {
  const m = String(hex).match(/^#?([a-f\\d]{2})([a-f\\d]{2})([a-f\\d]{2})$/i);
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [255, 255, 255];
}

function CausticsLight({
  baseColor = '#001824',
  lightColor = '#7DF9FF',
  speed = 1.2,
  scale = 2.5,
  intensity = 1.4,
  glow = 0.5,
  sharpness = 4,
  ...props
}) {
  const canvasRef = useRef(null);
  const isStatic = useStaticCanvas();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const SRC = 80;
    const off = document.createElement('canvas');
    off.width = SRC; off.height = SRC;
    const oc = off.getContext('2d');
    if (!oc) return;
    const img = oc.createImageData(SRC, SRC);
    const cb = hexRgb(baseColor), cl = hexRgb(lightColor);

    let raf = 0;
    let t0 = isStatic
      ? performance.now() - 1000 / Math.max(speed, 0.1)
      : performance.now();
    let lastW = 0, lastH = 0;
    const syncSize = () => {
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (w === 0 || h === 0) return false;
      if (w !== lastW || h !== lastH) {
        const dpr = isStatic ? 1 : (window.devicePixelRatio || 1);
        canvas.width = w * dpr; canvas.height = h * dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        lastW = w; lastH = h;
      }
      return true;
    };

    const draw = () => {
      if (!syncSize()) { if (!isStatic) raf = requestAnimationFrame(draw); return; }
      const t = ((performance.now() - t0) / 1000) * speed;
      const data = img.data;
      for (let y = 0; y < SRC; y++) {
        for (let x = 0; x < SRC; x++) {
          const u = (x / SRC) * scale;
          const v = (y / SRC) * scale;
          // Two interfering wave fields produce the pinched-net pattern
          const a = Math.sin(u * 3 + Math.cos(v * 4 + t * 0.7) * 1.4 + t);
          const b = Math.sin(v * 3.5 + Math.cos(u * 4.2 - t * 0.5) * 1.2 + t * 0.9);
          // Edge sharpness: peaks pulled toward 1, valleys toward 0
          const k = Math.pow(Math.max(0, (a * b + 1) * 0.5), sharpness) * intensity;
          const i = (y * SRC + x) * 4;
          data[i]     = Math.min(255, cb[0] + (cl[0] - cb[0]) * k);
          data[i + 1] = Math.min(255, cb[1] + (cl[1] - cb[1]) * k);
          data[i + 2] = Math.min(255, cb[2] + (cl[2] - cb[2]) * k);
          data[i + 3] = 255;
        }
      }
      oc.putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.clearRect(0, 0, lastW, lastH);
      // base wash + glow halo by drawing twice with the second pass softer
      ctx.drawImage(off, 0, 0, lastW, lastH);
      if (glow > 0) {
        ctx.globalAlpha = glow;
        ctx.filter = 'blur(' + Math.round(8 + glow * 24) + 'px)';
        ctx.globalCompositeOperation = 'lighter';
        ctx.drawImage(off, 0, 0, lastW, lastH);
        ctx.globalAlpha = 1;
        ctx.filter = 'none';
        ctx.globalCompositeOperation = 'source-over';
      }
      if (!isStatic) raf = requestAnimationFrame(draw);
    };

    if (isStatic) {
      draw();
      const ro = new ResizeObserver(draw);
      ro.observe(canvas);
      return () => ro.disconnect();
    }

    raf = requestAnimationFrame(draw);
    const ro = new ResizeObserver(() => syncSize());
    ro.observe(canvas);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [baseColor, lightColor, speed, scale, intensity, glow, sharpness, isStatic]);

  const style = { ...(props.style || {}), position: 'relative', overflow: 'hidden' };

  return (
    <div data-id={props['data-id']} data-name={props['data-name']} style={style}>
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
    </div>
  );
}

export default withResponsiveProps(CausticsLight);
`;
