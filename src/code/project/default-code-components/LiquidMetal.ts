// LiquidMetal — Code component template (Canvas 2D iridescent flowing chrome).
//
// Polished metallic surface that flows like mercury — three colors plus
// a highlight band ride a slow noise field. Gives a "liquid mirror"
// look without a real shader: stacked sin layers + an HSL highlight
// drive every pixel.
//
// Performance: `useStaticCanvas()` flips the code component into a paint-once
// branch (no rAF, dpr=1) on the editor canvas. Live preview and the
// published site keep the full animated version.

export const LIQUID_METAL_COMPONENT = `'use client';

/** @label "Liquid Metal" */
/** @comment "Iridescent flowing chrome — base + accent colors with a moving highlight band." */
/** @defaultWidth 600 */
/** @defaultHeight 400 */
/** @controls {
  "baseColor": { "type": "color", "label": "Base Color", "default": "#1A1A2E" },
  "accentColor": { "type": "color", "label": "Accent Color", "default": "#7B61FF" },
  "highlightColor": { "type": "color", "label": "Highlight", "default": "#FFFFFF" },
  "speed": { "type": "number", "label": "Speed", "min": 0, "max": 4, "step": 0.05, "default": 0.8 },
  "flow": { "type": "number", "label": "Flow", "min": 0.2, "max": 4, "step": 0.05, "default": 1.6 },
  "sharpness": { "type": "number", "label": "Sharpness", "min": 0.5, "max": 6, "step": 0.1, "default": 2.4 },
  "shine": { "type": "number", "label": "Shine", "min": 0, "max": 1, "step": 0.01, "default": 0.7 }
} */

import React, { useEffect, useRef } from 'react';
import { withResponsiveProps, useStaticCanvas } from '@revyme/runtime';

function hexRgb(hex) {
  const m = String(hex).match(/^#?([a-f\\d]{2})([a-f\\d]{2})([a-f\\d]{2})$/i);
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [255, 255, 255];
}

function LiquidMetal({
  baseColor = '#1A1A2E',
  accentColor = '#7B61FF',
  highlightColor = '#FFFFFF',
  speed = 0.8,
  flow = 1.6,
  sharpness = 2.4,
  shine = 0.7,
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
    const cb = hexRgb(baseColor), ca = hexRgb(accentColor), ch = hexRgb(highlightColor);

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
          const u = (x / SRC) * flow;
          const v = (y / SRC) * flow;
          // Layered noise
          const n =
            Math.sin(u * 4 + t) * 0.5 +
            Math.sin(v * 5 - t * 1.1) * 0.3 +
            Math.sin((u + v) * 3 + t * 0.7) * 0.2;
          // Sharpened band ~ liquid mercury crests
          const band = Math.pow(Math.abs(Math.sin(n * sharpness + t * 0.5)), 4);
          // base→accent ramp (k = noise channel 0..1)
          const k = (n + 1) * 0.5;
          const r = cb[0] + (ca[0] - cb[0]) * k;
          const g = cb[1] + (ca[1] - cb[1]) * k;
          const b = cb[2] + (ca[2] - cb[2]) * k;
          const sIntensity = band * shine;
          const i = (y * SRC + x) * 4;
          data[i]     = Math.min(255, r * (1 - sIntensity) + ch[0] * sIntensity);
          data[i + 1] = Math.min(255, g * (1 - sIntensity) + ch[1] * sIntensity);
          data[i + 2] = Math.min(255, b * (1 - sIntensity) + ch[2] * sIntensity);
          data[i + 3] = 255;
        }
      }
      oc.putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.clearRect(0, 0, lastW, lastH);
      ctx.drawImage(off, 0, 0, lastW, lastH);
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
  }, [baseColor, accentColor, highlightColor, speed, flow, sharpness, shine, isStatic]);

  const style = {  position: 'relative', overflow: 'hidden', ...(props.style || {}) };

  return (
    <div data-id={props['data-id']} data-name={props['data-name']} style={style}>
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
    </div>
  );
}

export default withResponsiveProps(LiquidMetal);
`;
