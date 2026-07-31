// PlasmaShader — Code component template (Canvas 2D classic plasma effect).
//
// The CRT-demo plasma: layered sine waves drive a tonal HSL field that
// oscillates between three configurable colors. Single-pass per pixel
// on a 64x64 source buffer (upscaled to fit) so even the smoothest
// settings stay GPU-cheap on the canvas.
//
// Performance: `useStaticCanvas()` flips the code component into a paint-once
// branch (no rAF, dpr=1) on the editor canvas. Live preview and the
// published site keep the full animated version.

export const PLASMA_SHADER_COMPONENT = `'use client';

/** @label "Plasma" */
/** @comment "Classic demoscene plasma — sine-driven color field between three shades." */
/** @defaultWidth 600 */
/** @defaultHeight 400 */
/** @controls {
  "color1": { "type": "color", "label": "Color 1", "default": "#FF006E" },
  "color2": { "type": "color", "label": "Color 2", "default": "#3A86FF" },
  "color3": { "type": "color", "label": "Color 3", "default": "#FFBE0B" },
  "speed": { "type": "number", "label": "Speed", "min": 0, "max": 6, "step": 0.05, "default": 1 },
  "scale": { "type": "number", "label": "Scale", "min": 0.5, "max": 6, "step": 0.05, "default": 2 },
  "complexity": { "type": "number", "label": "Complexity", "min": 1, "max": 5, "step": 1, "default": 3 },
  "brightness": { "type": "number", "label": "Brightness", "min": 0.4, "max": 2, "step": 0.05, "default": 1 }
} */

import React, { useEffect, useRef } from 'react';
import { withResponsiveProps, useStaticCanvas } from '@revyme/runtime';

function hexRgb(hex) {
  const m = String(hex).match(/^#?([a-f\\d]{2})([a-f\\d]{2})([a-f\\d]{2})$/i);
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [255, 255, 255];
}

function PlasmaShader({
  color1 = '#FF006E',
  color2 = '#3A86FF',
  color3 = '#FFBE0B',
  speed = 1,
  scale = 2,
  complexity = 3,
  brightness = 1,
  ...props
}) {
  const canvasRef = useRef(null);
  const isStatic = useStaticCanvas();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const SRC = 64;
    const off = document.createElement('canvas');
    off.width = SRC; off.height = SRC;
    const oc = off.getContext('2d');
    if (!oc) return;
    const img = oc.createImageData(SRC, SRC);
    const c1 = hexRgb(color1), c2 = hexRgb(color2), c3 = hexRgb(color3);

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

    const lerpRgb = (a, b, t) => [
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t,
      a[2] + (b[2] - a[2]) * t,
    ];

    const draw = () => {
      if (!syncSize()) { if (!isStatic) raf = requestAnimationFrame(draw); return; }
      const t = ((performance.now() - t0) / 1000) * speed;
      const data = img.data;
      for (let y = 0; y < SRC; y++) {
        for (let x = 0; x < SRC; x++) {
          const u = (x / SRC - 0.5) * scale;
          const v = (y / SRC - 0.5) * scale;
          let s = Math.sin(u * 4 + t) + Math.cos(v * 5 + t * 1.1);
          if (complexity >= 2) s += Math.sin((u + v) * 3.5 + t * 1.3);
          if (complexity >= 3) s += Math.cos(Math.sqrt(u * u + v * v) * 8 - t * 1.5);
          if (complexity >= 4) s += Math.sin(u * v * 6 + t * 0.7);
          if (complexity >= 5) s += Math.cos((u - v) * 7 + t * 1.7);
          // Normalize roughly to 0..1
          const k = (s / complexity + 1) * 0.5;
          // Tri-color band
          const c = k < 0.5
            ? lerpRgb(c1, c2, k * 2)
            : lerpRgb(c2, c3, (k - 0.5) * 2);
          const i = (y * SRC + x) * 4;
          data[i] = Math.min(255, c[0] * brightness);
          data[i + 1] = Math.min(255, c[1] * brightness);
          data[i + 2] = Math.min(255, c[2] * brightness);
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
  }, [color1, color2, color3, speed, scale, complexity, brightness, isStatic]);

  const style = { ...(props.style || {}), position: 'relative', overflow: 'hidden' };

  return (
    <div data-id={props['data-id']} data-name={props['data-name']} style={style}>
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
    </div>
  );
}

export default withResponsiveProps(PlasmaShader);
`;
