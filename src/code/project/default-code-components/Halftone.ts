// Halftone — Code component template (SVG <pattern> halftone dot screen).
//
// Browser-cached SVG pattern instead of per-frame Canvas 2D dot painting.
// A rotated `<pattern>` paints the dot grid at the requested angle, and a
// linear-gradient mask rotated by `fadeDir` emulates the original size-fade
// (visually similar — alpha fade vs radius fade — but the GPU compositor
// keeps it cheap during slider drags).
//
// Filter / pattern / mask / gradient ids are derived from `data-id` so
// multiple Halftone instances on the same page never collide.

export const HALFTONE_COMPONENT = `'use client';

/** @label "Halftone" */
/** @comment "Classic halftone dot screen effect." */
/** @defaultWidth 600 */
/** @defaultHeight 400 */
/** @controls {
  "dotSpacing": { "type": "number", "label": "Spacing", "min": 4, "max": 30, "step": 1, "default": 10, "unit": "px" },
  "maxDot": { "type": "number", "label": "Max Dot Size", "min": 2, "max": 20, "step": 1, "default": 8, "unit": "px" },
  "color": { "type": "color", "label": "Color", "default": "#FFFFFF" },
  "angle": { "type": "number", "label": "Angle", "min": 0, "max": 90, "step": 5, "default": 15, "unit": "deg" },
  "fadeDir": { "type": "number", "label": "Fade Direction", "min": 0, "max": 360, "step": 15, "default": 135, "unit": "deg" }
} */

import React from 'react';
import { withResponsiveProps } from '@revyme/runtime';

function Halftone({
  dotSpacing = 10,
  maxDot = 8,
  color = '#FFFFFF',
  angle = 15,
  fadeDir = 135,
  ...props
}) {
  const rawId = props['data-id'] || 'default';
  const safeId = String(rawId).replace(/[^a-zA-Z0-9_-]/g, '_');
  const patternId = 'ht-pat-' + safeId;
  const maskId = 'ht-mask-' + safeId;
  const gradId = 'ht-grad-' + safeId;
  const sp = Math.max(1, dotSpacing);
  const r = Math.max(0.5, maxDot * 0.5);
  const fadeRad = (fadeDir - 90) * Math.PI / 180;
  const fx2 = 50 + Math.cos(fadeRad) * 50;
  const fy2 = 50 + Math.sin(fadeRad) * 50;
  const fx1 = 50 - Math.cos(fadeRad) * 50;
  const fy1 = 50 - Math.sin(fadeRad) * 50;

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
          pointerEvents: 'none',
          display: 'block',
        }}
      >
        <defs>
          <pattern
            id={patternId}
            x="0"
            y="0"
            width={sp}
            height={sp}
            patternUnits="userSpaceOnUse"
            patternTransform={'rotate(' + angle + ')'}
          >
            <circle cx={sp / 2} cy={sp / 2} r={r} fill={color} />
          </pattern>
          <linearGradient
            id={gradId}
            x1={fx1 + '%'}
            y1={fy1 + '%'}
            x2={fx2 + '%'}
            y2={fy2 + '%'}
          >
            <stop offset="0%" stopColor="white" stopOpacity="0.3" />
            <stop offset="100%" stopColor="white" stopOpacity="1" />
          </linearGradient>
          <mask id={maskId}>
            <rect width="100%" height="100%" fill={'url(#' + gradId + ')'} />
          </mask>
        </defs>
        <rect
          width="100%"
          height="100%"
          fill={'url(#' + patternId + ')'}
          mask={'url(#' + maskId + ')'}
        />
      </svg>
    </div>
  );
}

export default withResponsiveProps(Halftone);
`;
