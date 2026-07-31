// VideoText — Code component template (video / gradient masked through text shape).
//
// THIRD-PARTY: technique derived from Magic UI
// (https://github.com/magicuidesign/magicui), Copyright (c) Magic UI, MIT.
// Attribution is repeated inside the template literal so it travels into
// projects this component is inserted into. See also the NOTICE file.
//
// Ported from `videoTextJS`. The original walks the rendered DOM to
// pick up multi-run text (per-line wraps, mixed font sizes, …) and
// builds a precise SVG mask. The React port simplifies to a single
// text string passed via prop — the user can resize / re-color via
// regular text controls; the code component just handles the masking layer.
//
// Output: an absolutely-sized div with two stacked layers — the
// background (video or gradient) and an SVG mask of the text. CSS
// `mask: url(#id)` clips the background to the text shape so the
// video plays only inside the letters.

export const VIDEO_TEXT_COMPONENT = `'use client';

// Technique derived from Magic UI (https://github.com/magicuidesign/magicui)
// Copyright (c) Magic UI — MIT License.
// The full MIT permission notice is reproduced in the Revyme NOTICE file.

/** @label "Video Text" */
/** @comment "Plays a video (or fades a gradient) clipped to the shape of text" */
/** @defaultWidth 600 */
/** @defaultHeight 400 */
/** @controls {
  "text": { "type": "text", "label": "Text", "default": "VIDEO" },
  "videoUrl": { "type": "video", "label": "Video URL", "default": "" },
  "autoPlay": { "type": "toggle", "label": "Auto Play", "default": true },
  "loop": { "type": "toggle", "label": "Loop", "default": true },
  "muted": { "type": "toggle", "label": "Muted", "default": true },
  "fallbackGradient": { "type": "text", "label": "Fallback Gradient (CSS)", "default": "linear-gradient(135deg, #667eea 0%, #764ba2 100%)" },
  "fontSize": { "type": "number", "label": "Font Size", "min": 24, "max": 400, "default": 160, "step": 4 },
  "fontWeight": { "type": "select", "label": "Weight", "default": "900", "options": [{"label":"Bold","value":"700"},{"label":"Black","value":"900"}] },
  "fontFamily": { "type": "text", "label": "Font", "default": "Inter, sans-serif" }
} */

import { useMemo } from 'react';
import { withResponsiveProps } from '@revyme/runtime';

function VideoText({
  text = 'VIDEO',
  videoUrl = '', autoPlay = true, loop = true, muted = true,
  fallbackGradient = 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
  fontSize = 160, fontWeight = '900', fontFamily = 'Inter, sans-serif',
  ...props
}: {
  text?: string;
  videoUrl?: string; autoPlay?: boolean; loop?: boolean; muted?: boolean;
  fallbackGradient?: string;
  fontSize?: number; fontWeight?: string; fontFamily?: string;
  [key: string]: any;
}) {
  // Random mask id per mount so multiple instances of VideoText on the
  // same page don't collide on the same SVG mask element.
  const maskId = useMemo(() => 'video-text-mask-' + Math.random().toString(36).slice(2, 8), []);

  const Background = videoUrl ? (
    <video
      src={videoUrl}
      autoPlay={autoPlay}
      loop={loop}
      muted={muted}
      playsInline
      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
    />
  ) : (
    <div style={{ width: '100%', height: '100%', background: fallbackGradient }} />
  );

  return (
    <div
      {...props}
      style={{
        position: 'relative', display: 'inline-block', overflow: 'hidden',
        ...(props.style || {}),
      }}
    >
      {/* Inline SVG mask — text in white masks the background to the
       *  letterforms. xMidYMid meet keeps the text centered when the
       *  wrapper is resized. */}
      <svg width="100%" height="100%" viewBox={'0 0 100 100'} preserveAspectRatio="xMidYMid meet" style={{ position: 'absolute', inset: 0 }}>
        <defs>
          <mask id={maskId}>
            <rect width="100" height="100" fill="black" />
            <text
              x="50" y="50"
              dominantBaseline="middle" textAnchor="middle"
              fontSize={fontSize / 4}
              fontWeight={fontWeight}
              fontFamily={fontFamily}
              fill="white"
            >
              {text}
            </text>
          </mask>
        </defs>
      </svg>
      <div
        style={{
          position: 'absolute', inset: 0,
          mask: 'url(#' + maskId + ')',
          WebkitMask: 'url(#' + maskId + ')',
          pointerEvents: 'none',
        }}
      >
        {Background}
      </div>
    </div>
  );
}

export default withResponsiveProps(VideoText);
`;
