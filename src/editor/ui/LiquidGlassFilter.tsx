// LiquidGlassFilter.tsx — refractive "liquid glass" for the side panels.
//
// A single SVG filter (id `liquid-glass`) consumed via
// `backdrop-filter: url(#liquid-glass)`. The classic recipe: a canvas-
// generated displacement map (R = x-shift, G = y-shift, 128 = neutral)
// whose edge bands lens the backdrop outward, run through
// feDisplacementMap, then softened with a light feGaussianBlur. Knobs
// (from the user's designer, 2026-08-19): frost = blur px, depth = edge
// band px, refraction = displacement scale, splay = falloff exponent.
//
// Chromium-only: Safari/Firefox don't take url() filters in
// backdrop-filter — there the panels fall back to their translucent tint
// alone. Fine for the builder's Chrome-first audience.
//
// The map is sized to the real panel box (260 × viewport-52) and
// regenerated on resize; primitiveUnits stay in user space so 1 map px =
// 1 screen px. The left panel is 256 wide vs the map's 260 — its inner
// band loses 4px, invisible in practice.

import { useEffect, useState } from 'react';

export const LIQUID_GLASS = {
  frost: 6,
  depth: 48,
  refraction: 80,
  splay: 20,
};

const PANEL_WIDTH = 260;
const HEADER_H = 52;

function buildDisplacementMap(w: number, h: number, depth: number, splay: number): string {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  // splay eases the band's falloff: higher splay → displacement
  // concentrates harder at the very edge.
  const p = 1 + splay / 20;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const iL = Math.max(0, 1 - x / depth);
      const iR = Math.max(0, 1 - (w - 1 - x) / depth);
      const iT = Math.max(0, 1 - y / depth);
      const iB = Math.max(0, 1 - (h - 1 - y) / depth);
      // Negative toward the near edge → samples pull from OUTSIDE the
      // panel, the convex-lens look. R carries x, G carries y.
      const dx = Math.pow(iR, p) - Math.pow(iL, p);
      const dy = Math.pow(iB, p) - Math.pow(iT, p);
      const i = (y * w + x) * 4;
      img.data[i] = Math.round(128 + dx * 127);
      img.data[i + 1] = Math.round(128 + dy * 127);
      img.data[i + 2] = 128;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL();
}

export default function LiquidGlassFilter() {
  const [size, setSize] = useState(() => ({
    w: PANEL_WIDTH,
    h: Math.max(200, window.innerHeight - HEADER_H),
  }));
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const onResize = () => {
      if (t) clearTimeout(t);
      // Debounced — the map is a full-pixel loop; no reason to rebuild it
      // per resize frame.
      t = setTimeout(() => {
        setSize({ w: PANEL_WIDTH, h: Math.max(200, window.innerHeight - HEADER_H) });
      }, 150);
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      if (t) clearTimeout(t);
    };
  }, []);

  const { frost, depth, refraction, splay } = LIQUID_GLASS;
  const map = buildDisplacementMap(size.w, size.h, depth, splay);

  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden>
      <filter
        id="liquid-glass"
        x="0"
        y="0"
        width="100%"
        height="100%"
        colorInterpolationFilters="sRGB"
        primitiveUnits="userSpaceOnUse"
      >
        <feImage
          href={map}
          x="0"
          y="0"
          width={size.w}
          height={size.h}
          preserveAspectRatio="none"
          result="map"
        />
        <feDisplacementMap
          in="SourceGraphic"
          in2="map"
          scale={refraction}
          xChannelSelector="R"
          yChannelSelector="G"
          result="refracted"
        />
        <feGaussianBlur in="refracted" stdDeviation={frost} />
      </filter>
    </svg>
  );
}
