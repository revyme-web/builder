// GradientText — Code component template (animated gradient clipped to text).
//
// The gradient is painted as a background image on the text span and clipped
// to the glyph shapes via `background-clip: text` with a transparent fill.
// Motion comes from sliding `background-position` across a background sized
// wider than the box, so the colour ramp travels through the letterforms.
//
// Driven by rAF rather than CSS `@keyframes` so each instance can carry its
// own speed without colliding on a shared animation name, and so
// `useStaticCanvas()` can freeze it to one representative frame on the
// editor canvas instead of burning a rAF per placed instance.

export const GRADIENT_TEXT_COMPONENT = `'use client';

/** @label "Gradient Text" */
/** @comment "Text filled with a travelling multi-colour gradient." */
/** @defaultWidth 600 */
/** @defaultHeight 200 */
/** @controls {
  "text": { "type": "text", "label": "Text", "default": "Gradient" },
  "colorA": { "type": "color", "label": "Color 1", "default": "#a855f7" },
  "colorB": { "type": "color", "label": "Color 2", "default": "#38bdf8" },
  "colorC": { "type": "color", "label": "Color 3", "default": "#f472b6" },
  "angle": { "type": "number", "label": "Angle", "min": 0, "max": 360, "step": 5, "default": 90, "unit": "deg" },
  "speed": { "type": "number", "label": "Speed", "min": 0, "max": 4, "step": 0.1, "default": 1 },
  "spread": { "type": "number", "label": "Spread", "min": 120, "max": 500, "step": 10, "default": 240, "unit": "%" }
} */

import { useEffect, useRef } from 'react';
import { withResponsiveProps, useStaticCanvas } from '@revyme/runtime';

function GradientText({
  text = 'Gradient',
  colorA = '#a855f7',
  colorB = '#38bdf8',
  colorC = '#f472b6',
  angle = 90,
  speed = 1,
  spread = 240,
  ...props
}) {
  const textRef = useRef(null);
  const isStatic = useStaticCanvas();

  useEffect(() => {
    const el = textRef.current;
    if (!el) return;

    // The ramp is mirrored (A B C B A) so a full traversal wraps seamlessly
    // without a visible seam where the background repeats.
    const ramp =
      'linear-gradient(' + angle + 'deg, ' +
      colorA + ' 0%, ' + colorB + ' 25%, ' + colorC + ' 50%, ' +
      colorB + ' 75%, ' + colorA + ' 100%)';

    el.style.backgroundImage = ramp;
    el.style.backgroundSize = spread + '% 100%';
    el.style.backgroundRepeat = 'repeat-x';

    function paint(offsetPct) {
      el.style.backgroundPosition = offsetPct.toFixed(2) + '% 50%';
    }

    // Static canvas: land on an off-centre frame so the still reads as a
    // gradient rather than a flat colour.
    if (isStatic || speed <= 0) {
      paint(isStatic ? 35 : 0);
      return;
    }

    let raf = 0;
    const start = performance.now();

    function tick(now) {
      const cycleMs = 6000 / Math.max(0.05, speed);
      const phase = ((now - start) % cycleMs) / cycleMs;
      paint(phase * 100);
      raf = requestAnimationFrame(tick);
    }

    raf = requestAnimationFrame(tick);
    return function () {
      cancelAnimationFrame(raf);
    };
  }, [colorA, colorB, colorC, angle, speed, spread, isStatic]);

  return (
    <div
      data-id={props['data-id']}
      data-name={props['data-name']}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        ...props.style,
      }}
    >
      <span
        ref={textRef}
        style={{
          lineHeight: 1.15,
          WebkitBackgroundClip: 'text',
          backgroundClip: 'text',
          color: 'transparent',
          WebkitTextFillColor: 'transparent',
          whiteSpace: 'pre-wrap',
        }}
      >
        {text}
      </span>
    </div>
  );
}

export default withResponsiveProps(GradientText);
`;
