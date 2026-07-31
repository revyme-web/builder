// WaveGradient — Code component template (Canvas 2D animated multi-color wave field).
//
// Soft rolling color regions blended into a single fluid frame — four
// configurable colors, frequency on X/Y, angle, amplitude, softness,
// blend. Each pixel samples a layered sine field so the colors move
// like silk under light. Cheap enough to run on canvas: a 96×96 source
// buffer is upscaled to the wrapper, so fill rate is fixed regardless
// of the dropped element's actual size.
//
// Performance: `useStaticCanvas()` flips the code component into a paint-once
// branch (no rAF, dpr=1) on the editor canvas. Live preview and the
// published site keep the full animated version.

export const WAVE_GRADIENT_COMPONENT = `'use client';

/** @label "Wave Gradient" */
/** @comment "Animated multi-color wave field — pick four colors, sculpt the flow with frequency + amplitude." */
/** @defaultWidth 600 */
/** @defaultHeight 400 */
/** @controls {
  "color1": { "type": "color", "label": "Color 1", "default": "#FF3624" },
  "color2": { "type": "color", "label": "Color 2", "default": "#9EABFF" },
  "color3": { "type": "color", "label": "Color 3", "default": "#FFAE00" },
  "color4": { "type": "color", "label": "Color 4", "default": "#E29EFF" },
  "seed": { "type": "number", "label": "Seed", "min": 0, "max": 999, "step": 1, "default": 32 },
  "speed": { "type": "number", "label": "Speed", "min": 0, "max": 6, "step": 0.1, "default": 1.5 },
  "freqX": { "type": "number", "label": "Freq X", "min": 0, "max": 6, "step": 0.05, "default": 0.9 },
  "freqY": { "type": "number", "label": "Freq Y", "min": 0, "max": 12, "step": 0.1, "default": 6 },
  "angle": { "type": "number", "label": "Angle", "min": 0, "max": 360, "step": 1, "default": 105 },
  "amplitude": { "type": "number", "label": "Amplitude", "min": 0, "max": 4, "step": 0.05, "default": 2.1 },
  "softness": { "type": "number", "label": "Softness", "min": 0, "max": 1, "step": 0.01, "default": 0.74 },
  "blend": { "type": "number", "label": "Blend", "min": 0, "max": 1, "step": 0.01, "default": 0.54 }
} */

import React, { useEffect, useRef } from 'react';
import { withResponsiveProps, useStaticCanvas } from '@revyme/runtime';

function hexToRgb(hex) {
  const m = String(hex).match(/^#?([a-f\\d]{2})([a-f\\d]{2})([a-f\\d]{2})$/i);
  if (!m) return [255, 255, 255];
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

function WaveGradient({
  color1 = '#FF3624',
  color2 = '#9EABFF',
  color3 = '#FFAE00',
  color4 = '#E29EFF',
  seed = 32,
  speed = 1.5,
  freqX = 0.9,
  freqY = 6,
  angle = 105,
  amplitude = 2.1,
  softness = 0.74,
  blend = 0.54,
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
    const SRC = 96;
    const off = document.createElement('canvas');
    off.width = SRC; off.height = SRC;
    const oc = off.getContext('2d');
    if (!oc) return;
    const img = oc.createImageData(SRC, SRC);
    const palette = [hexToRgb(color1), hexToRgb(color2), hexToRgb(color3), hexToRgb(color4)];
    const seedOff = (seed % 100) * 0.03;

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
      const t = ((performance.now() - t0) / 1000) * speed + seedOff;
      const ang = (angle * Math.PI) / 180;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const data = img.data;
      const soft = 0.05 + softness * 0.95;
      for (let y = 0; y < SRC; y++) {
        for (let x = 0; x < SRC; x++) {
          const u = (x / SRC - 0.5) * 2;
          const v = (y / SRC - 0.5) * 2;
          const ru = u * ca - v * sa;
          const rv = u * sa + v * ca;
          const w1 = Math.sin(ru * freqX * 3 + t) * 0.5 + 0.5;
          const w2 = Math.sin(rv * (freqY * 0.5) + t * 1.3) * 0.5 + 0.5;
          const w3 = Math.sin((ru + rv) * 1.4 + t * 0.7 + amplitude) * 0.5 + 0.5;
          const w4 = Math.cos((ru - rv) * 2.1 + t * 1.1) * 0.5 + 0.5;
          const sum = w1 + w2 + w3 + w4 + 0.0001;
          const r = (palette[0][0] * w1 + palette[1][0] * w2 + palette[2][0] * w3 + palette[3][0] * w4) / sum;
          const g = (palette[0][1] * w1 + palette[1][1] * w2 + palette[2][1] * w3 + palette[3][1] * w4) / sum;
          const b = (palette[0][2] * w1 + palette[1][2] * w2 + palette[2][2] * w3 + palette[3][2] * w4) / sum;
          // Blend reduces saturation back toward neutral; softness desaturates highlights
          const k = 1 - blend * 0.5;
          const i = (y * SRC + x) * 4;
          data[i] = r * k * soft + (1 - soft) * 255 * 0.5;
          data[i + 1] = g * k * soft + (1 - soft) * 255 * 0.5;
          data[i + 2] = b * k * soft + (1 - soft) * 255 * 0.5;
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
  }, [color1, color2, color3, color4, seed, speed, freqX, freqY, angle, amplitude, softness, blend, isStatic]);

  const style = { ...(props.style || {}), position: 'relative', overflow: 'hidden' };

  return (
    <div data-id={props['data-id']} data-name={props['data-name']} style={style}>
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
    </div>
  );
}

export default withResponsiveProps(WaveGradient);
`;
