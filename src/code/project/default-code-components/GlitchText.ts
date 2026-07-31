// GlitchText — Code component template (chromatic RGB-split text glitch).
//
// Three stacked copies of the same string: a base layer plus two tinted
// ghosts (one warm, one cool) using `mix-blend-mode: screen` so the
// overlaps read as additive colour fringing rather than opaque stacking.
//
// The ghosts jitter on a coarse timer, not per-frame — real glitching is
// bursty, so the effect holds a displaced pose for a few frames and then
// snaps back to zero. A `clipPath` band is displaced with each burst so a
// horizontal slice of the text tears independently of the rest.
//
// `useStaticCanvas()` pins a single displaced pose on the editor canvas so
// the still shows the effect rather than clean text.

export const GLITCH_TEXT_COMPONENT = `'use client';

/** @label "Glitch Text" */
/** @comment "Text with a chromatic RGB-split glitch and tearing bands." */
/** @defaultWidth 600 */
/** @defaultHeight 200 */
/** @controls {
  "text": { "type": "text", "label": "Text", "default": "GLITCH" },
  "baseColor": { "type": "color", "label": "Text Color", "default": "#f8fafc" },
  "ghostWarm": { "type": "color", "label": "Ghost Warm", "default": "#ff2d55" },
  "ghostCool": { "type": "color", "label": "Ghost Cool", "default": "#00e5ff" },
  "amount": { "type": "number", "label": "Displacement", "min": 0, "max": 24, "step": 1, "default": 6, "unit": "px" },
  "burstRate": { "type": "number", "label": "Burst Rate", "min": 0.2, "max": 6, "step": 0.1, "default": 2 },
  "tearing": { "type": "boolean", "label": "Tearing Bands", "default": true }
} */

import { useEffect, useRef } from 'react';
import { withResponsiveProps, useStaticCanvas } from '@revyme/runtime';

function GlitchText({
  text = 'GLITCH',
  baseColor = '#f8fafc',
  ghostWarm = '#ff2d55',
  ghostCool = '#00e5ff',
  amount = 6,
  burstRate = 2,
  tearing = true,
  ...props
}) {
  const warmRef = useRef(null);
  const coolRef = useRef(null);
  const isStatic = useStaticCanvas();

  useEffect(() => {
    const warm = warmRef.current;
    const cool = coolRef.current;
    if (!warm || !cool) return;

    function place(el, dx, dy, bandTop, bandHeight) {
      el.style.transform = 'translate(' + dx.toFixed(2) + 'px, ' + dy.toFixed(2) + 'px)';
      if (tearing && bandHeight > 0) {
        const bottom = Math.max(0, 100 - bandTop - bandHeight);
        el.style.clipPath = 'inset(' + bandTop.toFixed(1) + '% 0 ' + bottom.toFixed(1) + '% 0)';
      } else {
        el.style.clipPath = 'none';
      }
    }

    function rest() {
      place(warm, 0, 0, 0, 0);
      place(cool, 0, 0, 0, 0);
    }

    // One burst = opposing displacement on the two ghosts, plus an
    // independent tear band on each.
    function burst() {
      const dx = (Math.random() * 2 - 1) * amount;
      const dy = (Math.random() * 2 - 1) * (amount * 0.35);
      place(warm, dx, dy, Math.random() * 70, 10 + Math.random() * 25);
      place(cool, -dx, -dy, Math.random() * 70, 10 + Math.random() * 25);
    }

    if (isStatic || amount <= 0) {
      if (isStatic && amount > 0) burst();
      else rest();
      return;
    }

    let timer = 0;
    let holding = false;

    function schedule() {
      // Bursts are short; the gaps between them carry most of the time.
      const gapMs = (900 / Math.max(0.1, burstRate)) * (0.4 + Math.random());
      const holdMs = 40 + Math.random() * 90;
      timer = window.setTimeout(function () {
        if (holding) { rest(); } else { burst(); }
        holding = !holding;
        schedule();
      }, holding ? holdMs : gapMs);
    }

    rest();
    schedule();

    return function () {
      window.clearTimeout(timer);
    };
  }, [amount, burstRate, tearing, isStatic]);

  const layer = {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    whiteSpace: 'pre-wrap',
    userSelect: 'none',
    pointerEvents: 'none',
  };

  return (
    <div
      data-id={props['data-id']}
      data-name={props['data-name']}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative',
        overflow: 'hidden',
        ...props.style,
      }}
    >
      <span style={{ color: baseColor, whiteSpace: 'pre-wrap', lineHeight: 1.15 }}>{text}</span>
      <span ref={warmRef} aria-hidden="true" style={{ ...layer, color: ghostWarm, mixBlendMode: 'screen' }}>
        {text}
      </span>
      <span ref={coolRef} aria-hidden="true" style={{ ...layer, color: ghostCool, mixBlendMode: 'screen' }}>
        {text}
      </span>
    </div>
  );
}

export default withResponsiveProps(GlitchText);
`;
