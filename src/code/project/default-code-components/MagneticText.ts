// MagneticText — Code component template (letters pulled toward the cursor).
// Ported from `magneticTextJS`. Each character is a positioned span
// inside a flex container; on mousemove we compute distance from each
// letter's center to the cursor and apply a translate proportional to
// `(1 - dist/radius) * strength`. Smoothing lerps the actual transform
// toward the target so the motion feels rubbery instead of snappy.
//
// React port:
//   - Cursor position is tracked on the WRAPPER (not the window) so
//     dropping multiple instances doesn't make them all react to the
//     same cursor everywhere.
//   - Refs for the letter spans avoid React re-renders 60 times a sec;
//     the RAF loop pokes inline transform/color directly.

export const MAGNETIC_TEXT_COMPONENT = `'use client';

/** @label "Magnetic Text" */
/** @comment "Letters subtly pulled toward the mouse cursor on hover" */
/** @defaultWidth 600 */
/** @defaultHeight 400 */
/** @controls {
  "text": { "type": "text", "label": "Text", "default": "MAGNETIC TEXT" },
  "strength": { "type": "number", "label": "Pull Strength", "min": 1, "max": 30, "default": 10, "step": 1 },
  "radius": { "type": "number", "label": "Effect Radius", "min": 30, "max": 300, "default": 80, "step": 10 },
  "smoothing": { "type": "number", "label": "Smoothing", "min": 0.05, "max": 0.5, "default": 0.18, "step": 0.01 },
  "highlightColor": { "type": "color", "label": "Highlight Color", "default": "#00ffee" },
  "baseColor": { "type": "color", "label": "Base Color", "default": "#f0f0f0" },
  "fontSize": { "type": "number", "label": "Font Size", "min": 12, "max": 200, "default": 64, "step": 1 },
  "fontWeight": { "type": "select", "label": "Weight", "default": "700", "options": [{"label":"Regular","value":"400"},{"label":"Medium","value":"500"},{"label":"Semi Bold","value":"600"},{"label":"Bold","value":"700"},{"label":"Black","value":"900"}] },
  "fontFamily": { "type": "text", "label": "Font", "default": "Inter, sans-serif" }
} */

import { useEffect, useRef } from 'react';
import { withResponsiveProps } from '@revyme/runtime';

function MagneticText({
  text = 'MAGNETIC TEXT', strength = 10, radius = 80, smoothing = 0.18,
  highlightColor = '#00ffee', baseColor = '#f0f0f0',
  fontSize = 64, fontWeight = '700', fontFamily = 'Inter, sans-serif',
  ...props
}: {
  text?: string; strength?: number; radius?: number; smoothing?: number;
  highlightColor?: string; baseColor?: string;
  fontSize?: number; fontWeight?: string; fontFamily?: string;
  [key: string]: any;
}) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const letterRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const chars = (text.length ? text : 'TEXT').split('');

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    const letters = letterRefs.current.map((el) => ({
      el,
      cx: 0, cy: 0,
    })).filter((l): l is { el: HTMLSpanElement; cx: number; cy: number } => !!l.el);

    let mx = -9999, my = -9999;
    const onMove = (e: PointerEvent) => {
      const rect = wrapper.getBoundingClientRect();
      mx = e.clientX - rect.left;
      my = e.clientY - rect.top;
    };
    const onLeave = () => { mx = -9999; my = -9999; };
    wrapper.addEventListener('pointermove', onMove);
    wrapper.addEventListener('pointerleave', onLeave);

    // Hex → rgb tuple. Falls back to white on any parse error so a
    // bad color string can't kill the animation.
    const parseHex = (hex: string): [number, number, number] => {
      const h = hex.replace(/^#/, '');
      if (h.length !== 6) return [255, 255, 255];
      return [parseInt(h.slice(0, 2), 16) || 0, parseInt(h.slice(2, 4), 16) || 0, parseInt(h.slice(4, 6), 16) || 0];
    };
    const [hr, hg, hb] = parseHex(highlightColor);
    const [br, bg, bb] = parseHex(baseColor);

    let rafId = 0;
    const animate = () => {
      const wrapperRect = wrapper.getBoundingClientRect();
      for (const l of letters) {
        const lr = l.el.getBoundingClientRect();
        const lx = lr.left - wrapperRect.left + lr.width / 2;
        const ly = lr.top - wrapperRect.top + lr.height / 2;
        const dx = mx - lx;
        const dy = my - ly;
        const dist = Math.sqrt(dx * dx + dy * dy);
        let tx = 0, ty = 0;
        if (dist < radius && dist > 0) {
          const force = (1 - dist / radius) * strength;
          tx = (dx / dist) * force;
          ty = (dy / dist) * force;
          const t = 1 - dist / radius;
          const ri = Math.round(br + (hr - br) * t);
          const gi = Math.round(bg + (hg - bg) * t);
          const bi = Math.round(bb + (hb - bb) * t);
          l.el.style.color = 'rgb(' + ri + ',' + gi + ',' + bi + ')';
        } else {
          l.el.style.color = baseColor;
        }
        l.cx += (tx - l.cx) * smoothing;
        l.cy += (ty - l.cy) * smoothing;
        l.el.style.transform = 'translate(' + l.cx + 'px,' + l.cy + 'px)';
      }
      rafId = requestAnimationFrame(animate);
    };
    rafId = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(rafId);
      wrapper.removeEventListener('pointermove', onMove);
      wrapper.removeEventListener('pointerleave', onLeave);
    };
  }, [strength, radius, smoothing, highlightColor, baseColor, text]);

  const letterStyle = {
    display: 'inline-block',
    transition: 'color 0.3s',
    color: baseColor,
    fontSize: fontSize + 'px',
    fontFamily,
    fontWeight,
  };

  return (
    <div
      ref={wrapperRef}
      {...props}
      style={{
        position: 'relative', display: 'flex', flexWrap: 'wrap', justifyContent: 'center',
        gap: 0, ...(props.style || {}),
      }}
    >
      {chars.map((ch, i) => (
        <span
          key={i}
          ref={(el) => { letterRefs.current[i] = el; }}
          style={letterStyle}
        >
          {ch === ' ' ? '\\u00A0' : ch}
        </span>
      ))}
    </div>
  );
}

export default withResponsiveProps(MagneticText);
`;
