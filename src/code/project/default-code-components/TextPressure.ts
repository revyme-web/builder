// TextPressure — Code component template (per-character response to cursor proximity).
//
// Each character is its own inline-block span. On pointer move we measure the
// distance from the cursor to each span's centre, normalise it against a
// falloff radius, and drive three axes from that single scalar: weight,
// horizontal scale and opacity. Characters nearest the cursor go heavy,
// wide and opaque; distant ones relax back to the resting values.
//
// Deliberately built on plain `font-weight` + `scaleX` rather than true
// variable-font axes, so it works with ANY font family the user has loaded
// and needs no external font asset. If the active family IS variable, set
// `useVariableAxes` and the same scalar drives `font-variation-settings`
// (wght/wdth) instead, which gives smoother interpolation.
//
// Measurement is cached per layout and invalidated by ResizeObserver — the
// pointer handler must not call getBoundingClientRect() per character per
// move, or a long string turns every mouse move into a layout storm.

export const TEXT_PRESSURE_COMPONENT = `'use client';

/** @label "Text Pressure" */
/** @comment "Characters get heavier and wider as the cursor approaches them." */
/** @defaultWidth 600 */
/** @defaultHeight 200 */
/** @controls {
  "text": { "type": "text", "label": "Text", "default": "PRESSURE" },
  "color": { "type": "color", "label": "Color", "default": "#f8fafc" },
  "radius": { "type": "number", "label": "Falloff Radius", "min": 40, "max": 600, "step": 10, "default": 200, "unit": "px" },
  "restWeight": { "type": "number", "label": "Rest Weight", "min": 100, "max": 900, "step": 100, "default": 200 },
  "peakWeight": { "type": "number", "label": "Peak Weight", "min": 100, "max": 900, "step": 100, "default": 900 },
  "widen": { "type": "number", "label": "Widen", "min": 0, "max": 1, "step": 0.05, "default": 0.35 },
  "fade": { "type": "number", "label": "Distance Fade", "min": 0, "max": 0.8, "step": 0.05, "default": 0.35 },
  "smoothing": { "type": "number", "label": "Smoothing", "min": 0.05, "max": 1, "step": 0.05, "default": 0.2 },
  "useVariableAxes": { "type": "boolean", "label": "Variable Font Axes", "default": false }
} */

import { useEffect, useRef } from 'react';
import { withResponsiveProps, useStaticCanvas } from '@revyme/runtime';

function TextPressure({
  text = 'PRESSURE',
  color = '#f8fafc',
  radius = 200,
  restWeight = 200,
  peakWeight = 900,
  widen = 0.35,
  fade = 0.35,
  smoothing = 0.2,
  useVariableAxes = false,
  ...props
}) {
  const boxRef = useRef(null);
  const isStatic = useStaticCanvas();

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;

    const spans = Array.from(box.querySelectorAll('[data-pressure-char]'));
    if (spans.length === 0) return;

    // Cached centres, in box-local coordinates.
    let centres = [];
    function measure() {
      const boxRect = box.getBoundingClientRect();
      centres = spans.map(function (s) {
        const r = s.getBoundingClientRect();
        return {
          x: r.left - boxRect.left + r.width / 2,
          y: r.top - boxRect.top + r.height / 2,
        };
      });
    }
    measure();

    const ro = new ResizeObserver(measure);
    ro.observe(box);

    // Current + target intensity per character, lerped toward the target so
    // the response trails the cursor instead of snapping.
    const current = new Array(spans.length).fill(0);
    const target = new Array(spans.length).fill(0);

    function apply(i, t) {
      const s = spans[i];
      const weight = Math.round(restWeight + (peakWeight - restWeight) * t);
      const scaleX = 1 + widen * t;
      const opacity = 1 - fade * (1 - t);

      if (useVariableAxes) {
        // wdth is a percentage axis; 100 is normal, 125 comfortably wide.
        const wdth = Math.round(100 + 25 * widen * t);
        s.style.fontVariationSettings = "'wght' " + weight + ", 'wdth' " + wdth;
        s.style.transform = 'none';
      } else {
        s.style.fontVariationSettings = 'normal';
        s.style.fontWeight = String(weight);
        s.style.transform = 'scaleX(' + scaleX.toFixed(3) + ')';
      }
      s.style.opacity = opacity.toFixed(3);
    }

    // Editor canvas: pose against a fixed virtual cursor so the still shows
    // the effect rather than flat resting text.
    if (isStatic) {
      const r = box.getBoundingClientRect();
      const px = r.width * 0.38;
      const py = r.height * 0.5;
      for (let i = 0; i < spans.length; i++) {
        const dx = centres[i].x - px;
        const dy = centres[i].y - py;
        const d = Math.sqrt(dx * dx + dy * dy);
        apply(i, Math.max(0, 1 - d / Math.max(1, radius)));
      }
      return function () { ro.disconnect(); };
    }

    let raf = 0;
    let running = false;

    function tick() {
      let moving = false;
      for (let i = 0; i < spans.length; i++) {
        const diff = target[i] - current[i];
        if (Math.abs(diff) > 0.001) {
          current[i] += diff * smoothing;
          moving = true;
        } else {
          current[i] = target[i];
        }
        apply(i, current[i]);
      }
      if (moving) {
        raf = requestAnimationFrame(tick);
      } else {
        running = false;
      }
    }

    function wake() {
      if (!running) {
        running = true;
        raf = requestAnimationFrame(tick);
      }
    }

    function onMove(ev) {
      const r = box.getBoundingClientRect();
      const px = ev.clientX - r.left;
      const py = ev.clientY - r.top;
      for (let i = 0; i < spans.length; i++) {
        const dx = centres[i].x - px;
        const dy = centres[i].y - py;
        const d = Math.sqrt(dx * dx + dy * dy);
        target[i] = Math.max(0, 1 - d / Math.max(1, radius));
      }
      wake();
    }

    function onLeave() {
      for (let i = 0; i < spans.length; i++) target[i] = 0;
      wake();
    }

    // Listen on the window so the effect responds as the cursor approaches
    // from outside the box, not only once it's inside.
    window.addEventListener('pointermove', onMove, { passive: true });
    box.addEventListener('pointerleave', onLeave);

    for (let i = 0; i < spans.length; i++) apply(i, 0);

    return function () {
      window.removeEventListener('pointermove', onMove);
      box.removeEventListener('pointerleave', onLeave);
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [text, radius, restWeight, peakWeight, widen, fade, smoothing, useVariableAxes, isStatic]);

  const chars = String(text).split('');

  return (
    <div
      data-id={props['data-id']}
      data-name={props['data-name']}
      ref={boxRef}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexWrap: 'wrap',
        color: color,
        ...props.style,
      }}
    >
      {chars.map(function (ch, i) {
        return (
          <span
            key={i}
            data-pressure-char=""
            style={{
              display: 'inline-block',
              whiteSpace: 'pre',
              lineHeight: 1.15,
              willChange: 'transform, font-weight, opacity',
            }}
          >
            {ch}
          </span>
        );
      })}
    </div>
  );
}

export default withResponsiveProps(TextPressure);
`;
