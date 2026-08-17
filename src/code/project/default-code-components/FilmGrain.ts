// FilmGrain — Code component template (SVG <feTurbulence> monochrome film grain).
//
// Browser-cached fractal noise via `<feTurbulence>` instead of per-pixel
// `Math.random()` into a `<canvas>`. The SVG filter is rasterized once
// per (size, baseFrequency) tuple and composited on the GPU on subsequent
// repaints — slider drags stay smooth even at large sizes.
//
// The filter id has to be unique per instance — derived from `data-id` so
// multiple FilmGrain instances on a page never collide.

export const FILM_GRAIN_COMPONENT = `'use client';

/** @label "Film Grain" */
/** @comment "Classic monochrome film grain overlay." */
/** @defaultWidth 600 */
/** @defaultHeight 400 */
/** @controls {
  "intensity": { "type": "number", "label": "Intensity", "min": 0.05, "max": 0.5, "step": 0.01, "default": 0.15 },
  "grainScale": { "type": "number", "label": "Grain Scale", "min": 1, "max": 4, "step": 0.5, "default": 1 }
} */

import React from 'react';
import { withResponsiveProps } from '@revyme/runtime';

function FilmGrain({
  intensity = 0.15,
  grainScale = 1,
  ...props
}) {
  const rawId = props['data-id'] || 'default';
  const filterId = 'film-grain-' + String(rawId).replace(/[^a-zA-Z0-9_-]/g, '_');
  const baseFreq = 1 / Math.max(0.1, grainScale);
  return (
    <div
      data-id={props['data-id']}
      data-name={props['data-name']}
      style={{  position: 'relative', overflow: 'hidden', ...props.style }}
    >
      <svg
        width="100%"
        height="100%"
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          opacity: intensity,
          pointerEvents: 'none',
          display: 'block',
        }}
      >
        <filter id={filterId}>
          <feTurbulence type="fractalNoise" baseFrequency={baseFreq} numOctaves="2" stitchTiles="stitch" />
          <feColorMatrix type="saturate" values="0" />
        </filter>
        <rect width="100%" height="100%" filter={'url(#' + filterId + ')'} />
      </svg>
    </div>
  );
}

export default withResponsiveProps(FilmGrain);
`;
