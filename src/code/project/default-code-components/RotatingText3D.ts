// RotatingText3D — Code component template (3D cylinder of words rotating on scroll).
// Ported from `rotatingTextJS`. Words sit on the surface of a cylinder
// in 3D — each word at a fixed angle around the X axis at a constant
// radius. The cylinder rotates as the user scrolls the page; words
// alternate between two colors so the depth reads more clearly.
//
// React port:
//   - The radius is derived from `(fontSize * 1.5) / (2 * tan(π / count))`
//     — keeps the words spaced evenly regardless of how many you
//     supply. Same math the imperative version uses.
//   - The scroll listener is window-level. Each instance accumulates
//     its own rotation on its own ref, so multiple cylinders on the
//     same page rotate independently from the same scroll signal.

export const ROTATING_TEXT_3D_COMPONENT = `'use client';

/** @label "Rotating 3D Text" */
/** @comment "A 3D cylinder of words that rotates with scroll. Words alternate between two colors." */
/** @defaultWidth 600 */
/** @defaultHeight 400 */
/** @controls {
  "words": { "type": "text", "label": "Words (comma separated)", "default": "INNOVATE,CREATE,DESIGN,BUILD,SCALE,GROW" },
  "perspective": { "type": "number", "label": "Perspective", "min": 200, "max": 2000, "default": 500, "step": 50 },
  "fontSize": { "type": "number", "label": "Font Size", "min": 24, "max": 200, "default": 96, "step": 4 },
  "textColor": { "type": "color", "label": "Text Color", "default": "#EC4899" },
  "accentColor": { "type": "color", "label": "Accent Color", "default": "#ffffff" },
  "fontFamily": { "type": "text", "label": "Font", "default": "Inter, sans-serif" }
} */

import { useEffect, useRef, useMemo } from 'react';
import { withResponsiveProps } from '@revyme/runtime';

function RotatingText3D({
  words = 'INNOVATE,CREATE,DESIGN,BUILD,SCALE,GROW',
  perspective = 500, fontSize = 96,
  textColor = '#EC4899', accentColor = '#ffffff',
  fontFamily = 'Inter, sans-serif',
  ...props
}: {
  words?: string; perspective?: number; fontSize?: number;
  textColor?: string; accentColor?: string;
  fontFamily?: string;
  [key: string]: any;
}) {
  const ringRef = useRef<HTMLDivElement | null>(null);
  const wordList = useMemo(() => {
    const list = words.split(',').map(w => w.trim()).filter(Boolean);
    return list.length >= 2 ? list : [...list, 'TEXT'];
  }, [words]);

  const angleStep = 360 / wordList.length;
  const radius = (fontSize * 1.5) / (2 * Math.tan(Math.PI / wordList.length));

  useEffect(() => {
    const ring = ringRef.current;
    if (!ring) return;

    let currentRotation = 0;
    let lastScrollY = window.scrollY;

    const onScroll = () => {
      const scrollY = window.scrollY;
      const delta = scrollY - lastScrollY;
      lastScrollY = scrollY;
      currentRotation += delta * 0.1;
      ring.style.transform = 'rotateX(' + currentRotation + 'deg)';
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <div
      {...props}
      style={{
        position: 'relative', overflow: 'hidden',
        perspective: perspective + 'px',
        transformStyle: 'preserve-3d',
        ...(props.style || {}),
      }}
    >
      <div
        ref={ringRef}
        style={{
          position: 'absolute', inset: 0,
          transformStyle: 'preserve-3d',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >
        {wordList.map((word, i) => (
          <div
            key={i}
            style={{
              position: 'absolute', left: '50%', top: '50%',
              transformOrigin: '50% 50%', backfaceVisibility: 'hidden',
              whiteSpace: 'nowrap',
              fontSize: fontSize + 'px', fontFamily, fontWeight: 800,
              color: i % 2 === 0 ? textColor : accentColor,
              WebkitTextStroke: '1px black',
              transform: 'translate(-50%, -50%) rotateX(' + (i * angleStep) + 'deg) translateZ(' + radius + 'px)',
            }}
          >
            {word}
          </div>
        ))}
      </div>
    </div>
  );
}

export default withResponsiveProps(RotatingText3D);
`;
