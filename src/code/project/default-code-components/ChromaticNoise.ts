// ChromaticNoise — Code component template (Canvas 2D colorful RGB noise texture).

export const CHROMATIC_NOISE_COMPONENT = `'use client';

/** @label "Chromatic Noise" */
/** @comment "Colorful RGB noise texture." */
/** @defaultWidth 600 */
/** @defaultHeight 400 */
/** @controls {
  "intensity": { "type": "number", "label": "Intensity", "min": 0.05, "max": 0.6, "step": 0.01, "default": 0.2 },
  "pixelScale": { "type": "number", "label": "Pixel Scale", "min": 1, "max": 6, "step": 0.5, "default": 2 },
  "saturation": { "type": "number", "label": "Saturation", "min": 0, "max": 100, "step": 5, "default": 80, "unit": "%" }
} */

import { useEffect, useRef } from 'react';
import { withResponsiveProps } from '@revyme/runtime';

function ChromaticNoise({
  intensity = 0.2,
  pixelScale = 2,
  saturation = 80,
  ...props
}) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;

    function draw() {
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (w === 0 || h === 0) return;
      const cw = Math.max(1, Math.ceil(w / pixelScale));
      const ch = Math.max(1, Math.ceil(h / pixelScale));
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const off = document.createElement('canvas');
      off.width = cw; off.height = ch;
      const oc = off.getContext('2d');
      const img = oc.createImageData(cw, ch);
      const sat = saturation / 100;
      for (let i = 0; i < img.data.length; i += 4) {
        const grey = Math.random() * 255;
        const r = grey + (Math.random() - 0.5) * 510 * sat;
        const g = grey + (Math.random() - 0.5) * 510 * sat;
        const b = grey + (Math.random() - 0.5) * 510 * sat;
        img.data[i] = Math.max(0, Math.min(255, r));
        img.data[i + 1] = Math.max(0, Math.min(255, g));
        img.data[i + 2] = Math.max(0, Math.min(255, b));
        img.data[i + 3] = 255;
      }
      oc.putImageData(img, 0, 0);
      ctx.globalAlpha = intensity;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(off, 0, 0, w, h);
      ctx.globalAlpha = 1;
    }

    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [intensity, pixelScale, saturation]);

  return (
    <div data-id={props['data-id']} data-name={props['data-name']}
         style={{  position: 'relative', overflow: 'hidden', ...props.style }}>
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block', pointerEvents: 'none' }} />
    </div>
  );
}

export default withResponsiveProps(ChromaticNoise);
`;
