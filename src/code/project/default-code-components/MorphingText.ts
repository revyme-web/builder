// MorphingText — Code component template (smooth blur-morph between words).
//
// THIRD-PARTY: the blur-threshold morph technique is Magic UI's
// (https://github.com/magicuidesign/magicui), Copyright (c) Magic UI, MIT.
// Attribution is repeated inside the template literal so it travels into
// projects this component is inserted into. See also the NOTICE file.
//
// Ported from the old builder's `morphingTextJS` customCodeJs snippet:
// dual-span layered animation with an SVG color-matrix filter that
// snaps the alpha channel to a hard threshold, so progressive blurring
// produces the classic "metaball morph" between letterforms instead of
// a soft cross-fade.
//
// React port:
//   - The two-span technique stays — one fades+blurs out, the other
//     fades+blurs in.
//   - `requestAnimationFrame` drives both `morph` (animation progress)
//     and `cooldown` (hold the new word for a beat before morphing
//     again), wrapped in a `useEffect` that cleans up on unmount.
//   - SVG filter id is randomized per mount so multiple instances on
//     the same page don't share the same filter element.
//   - `words` is a comma-separated string for the controls panel; the
//     component splits it into the actual cycle list at render time.

export const MORPHING_TEXT_COMPONENT = `'use client';

// Technique derived from Magic UI (https://github.com/magicuidesign/magicui)
// Copyright (c) Magic UI — MIT License.
// The full MIT permission notice is reproduced in the Revyme NOTICE file.

/** @label "Morphing Text" */
/** @comment "Smoothly morphs between words using an SVG blur filter" */
/** @defaultWidth 600 */
/** @defaultHeight 400 */
/** @controls {
  "words": { "type": "text", "label": "Words (comma separated)", "default": "Hello,World,Morphing" },
  "speed": { "type": "number", "label": "Speed", "min": 0.5, "max": 10, "default": 2, "step": 0.5 },
  "color": { "type": "color", "label": "Color", "default": "#111111" },
  "fontSize": { "type": "number", "label": "Font Size", "min": 12, "max": 200, "default": 64, "step": 1 },
  "fontWeight": { "type": "select", "label": "Weight", "default": "700", "options": [{"label":"Regular","value":"400"},{"label":"Medium","value":"500"},{"label":"Semi Bold","value":"600"},{"label":"Bold","value":"700"},{"label":"Black","value":"900"}] },
  "fontFamily": { "type": "text", "label": "Font", "default": "Inter, sans-serif" }
} */

import { useEffect, useRef, useMemo } from 'react';
import { withResponsiveProps } from '@revyme/runtime';

function MorphingText({
  words = 'Hello,World,Morphing', speed = 2,
  color = '#111111', fontSize = 64, fontWeight = '700', fontFamily = 'Inter, sans-serif',
  ...props
}: {
  words?: string; speed?: number;
  color?: string; fontSize?: number; fontWeight?: string; fontFamily?: string;
  [key: string]: any;
}) {
  const wordList = useMemo(() => {
    const list = words.split(',').map(w => w.trim()).filter(Boolean);
    return list.length >= 2 ? list : [...list, 'Text'];
  }, [words]);

  const span1Ref = useRef<HTMLSpanElement | null>(null);
  const span2Ref = useRef<HTMLSpanElement | null>(null);
  const filterId = useMemo(() => 'morph-' + Math.random().toString(36).slice(2, 8), []);

  useEffect(() => {
    let textIndex = 0;
    let morph = 0;
    let cooldown = 0;
    let lastTime = performance.now();
    const cooldownTime = 0.5;
    let rafId = 0;

    const animate = () => {
      const now = performance.now();
      const dt = (now - lastTime) / 1000;
      lastTime = now;
      const s1 = span1Ref.current; const s2 = span2Ref.current;
      if (!s1 || !s2) { rafId = requestAnimationFrame(animate); return; }

      cooldown -= dt;
      if (cooldown <= 0) {
        morph += dt;
        let fraction = morph / speed;
        if (fraction > 1) { cooldown = cooldownTime; fraction = 1; }
        s2.style.filter = 'blur(' + Math.min(8 / fraction - 8, 100) + 'px)';
        s2.style.opacity = String(Math.pow(fraction, 0.4));
        const inv = 1 - fraction;
        s1.style.filter = 'blur(' + Math.min(8 / inv - 8, 100) + 'px)';
        s1.style.opacity = String(Math.pow(inv, 0.4));
        s1.textContent = wordList[textIndex % wordList.length];
        s2.textContent = wordList[(textIndex + 1) % wordList.length];
        if (fraction === 1) textIndex++;
      } else {
        morph = 0;
        s2.style.filter = 'none';
        s2.style.opacity = '1';
        s1.style.filter = 'none';
        s1.style.opacity = '0';
      }
      rafId = requestAnimationFrame(animate);
    };
    rafId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafId);
  }, [speed, wordList]);

  const baseStyle = { fontSize: fontSize + 'px', fontFamily, fontWeight, color, lineHeight: 1.1 };

  return (
    <span {...props} style={{ position: 'relative', display: 'inline-block', overflow: 'hidden', ...(props.style || {}) }}>
      <svg style={{ position: 'absolute', width: 0, height: 0 }} aria-hidden="true">
        <defs>
          <filter id={filterId}>
            <feColorMatrix in="SourceGraphic" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 255 -140" />
          </filter>
        </defs>
      </svg>
      <span style={{ position: 'relative', filter: 'url(#' + filterId + ') blur(0.6px)', display: 'inline-block' }}>
        <span ref={span1Ref} style={{ ...baseStyle, display: 'block' }}>{wordList[0]}</span>
        <span ref={span2Ref} style={{ ...baseStyle, display: 'block', position: 'absolute', top: 0, left: 0, width: '100%', opacity: 0 }}>{wordList[1] || ''}</span>
      </span>
    </span>
  );
}

export default withResponsiveProps(MorphingText);
`;
