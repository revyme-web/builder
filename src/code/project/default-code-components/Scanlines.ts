// Scanlines — Code component template (CSS-only retro CRT scanline overlay).
//
// Pure `repeating-linear-gradient` painted by the browser compositor — no
// canvas, no rAF, no ResizeObserver. The whole effect is one div with a
// background-image, so resizing and slider drags only repaint the layer
// once per change instead of running per-frame Canvas 2D work.

export const SCANLINES_COMPONENT = `'use client';

/** @label "Scanlines" */
/** @comment "Retro CRT scanline overlay." */
/** @defaultWidth 600 */
/** @defaultHeight 400 */
/** @controls {
  "lineHeight": { "type": "number", "label": "Line Height", "min": 1, "max": 6, "step": 0.5, "default": 1, "unit": "px" },
  "lineGap": { "type": "number", "label": "Gap", "min": 1, "max": 10, "step": 0.5, "default": 3, "unit": "px" },
  "color": { "type": "color", "label": "Color", "default": "#000000" },
  "opacity": { "type": "number", "label": "Opacity", "min": 0.05, "max": 0.8, "step": 0.05, "default": 0.3 }
} */

import React from 'react';
import { withResponsiveProps } from '@revyme/runtime';

function Scanlines({
  lineHeight = 1,
  lineGap = 3,
  color = '#000000',
  opacity = 0.3,
  ...props
}) {
  const stop1 = lineHeight + 'px';
  const stop2 = (lineHeight + lineGap) + 'px';
  const bg = 'repeating-linear-gradient(0deg, ' + color + ' 0, ' + color + ' ' + stop1 + ', transparent ' + stop1 + ', transparent ' + stop2 + ')';
  return (
    <div
      data-id={props['data-id']}
      data-name={props['data-name']}
      style={{
        ...props.style,
        backgroundImage: bg,
        opacity: opacity,
        pointerEvents: 'none',
      }}
    />
  );
}

export default withResponsiveProps(Scanlines);
`;
