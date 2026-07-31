// PerlinNoise — Code component template (Canvas 2D smooth organic noise via fBm).

export const PERLIN_NOISE_COMPONENT = `'use client';

/** @label "Perlin Noise" */
/** @comment "Smooth organic noise texture." */
/** @defaultWidth 600 */
/** @defaultHeight 400 */
/** @controls {
  "noiseScale": { "type": "number", "label": "Scale", "min": 10, "max": 200, "step": 5, "default": 60, "unit": "px" },
  "octaves": { "type": "number", "label": "Detail", "min": 1, "max": 6, "step": 1, "default": 4 },
  "intensity": { "type": "number", "label": "Intensity", "min": 0.1, "max": 1, "step": 0.05, "default": 0.5 },
  "color": { "type": "color", "label": "Color", "default": "#FFFFFF" }
} */

import { useEffect, useRef } from 'react';
import { withResponsiveProps } from '@revyme/runtime';

function PerlinNoise({
  noiseScale = 60,
  octaves = 4,
  intensity = 0.5,
  color = '#FFFFFF',
  ...props
}) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;

    // Integer hash. The multipliers are the well-known xxHash 32-bit primes
    // (PRIME32_4 / PRIME32_5 and a mixing constant), used here as a plain
    // arithmetic primitive — they are chosen for their bit-mixing behaviour,
    // not carried over from any particular implementation.
    function hash(x, y) {
      let h = (x * 374761393 + y * 668265263) | 0;
      h = ((h ^ (h >> 13)) * 1274126177) | 0;
      return ((h ^ (h >> 16)) >>> 0) / 4294967296;
    }
    function smooth(x, y) {
      const ix = Math.floor(x), iy = Math.floor(y);
      const fx = x - ix, fy = y - iy;
      const sx = fx * fx * (3 - 2 * fx);
      const sy = fy * fy * (3 - 2 * fy);
      return (hash(ix, iy) * (1 - sx) + hash(ix + 1, iy) * sx) * (1 - sy)
           + (hash(ix, iy + 1) * (1 - sx) + hash(ix + 1, iy + 1) * sx) * sy;
    }
    function fbm(x, y) {
      let v = 0, a = 0.5, f = 1;
      for (let i = 0; i < octaves; i++) {
        v += a * smooth(x * f, y * f);
        a *= 0.5; f *= 2;
      }
      return v;
    }
    function hexToRgb(hex) {
      const h = hex.replace('#', '');
      const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
      return [
        parseInt(full.slice(0, 2), 16) || 0,
        parseInt(full.slice(2, 4), 16) || 0,
        parseInt(full.slice(4, 6), 16) || 0,
      ];
    }

    function draw() {
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (w === 0 || h === 0) return;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const rgb = hexToRgb(color);
      const step = 2;
      const iw = Math.max(1, Math.ceil(w / step));
      const ih = Math.max(1, Math.ceil(h / step));
      const img = ctx.createImageData(iw, ih);
      for (let py = 0; py < ih; py++) {
        for (let px = 0; px < iw; px++) {
          const v = fbm((px * step) / noiseScale, (py * step) / noiseScale);
          const idx = (py * iw + px) * 4;
          img.data[idx] = rgb[0];
          img.data[idx + 1] = rgb[1];
          img.data[idx + 2] = rgb[2];
          img.data[idx + 3] = v * intensity * 255;
        }
      }
      const off = document.createElement('canvas');
      off.width = iw; off.height = ih;
      off.getContext('2d').putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(off, 0, 0, w, h);
    }

    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [noiseScale, octaves, intensity, color]);

  return (
    <div data-id={props['data-id']} data-name={props['data-name']}
         style={{ ...props.style, position: 'relative', overflow: 'hidden' }}>
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block', pointerEvents: 'none' }} />
    </div>
  );
}

export default withResponsiveProps(PerlinNoise);
`;
