// SpinningText — Code component template (characters arranged in a circle, rotating).
//
// THIRD-PARTY: technique derived from Magic UI
// (https://github.com/magicuidesign/magicui), Copyright (c) Magic UI, MIT.
// Attribution is repeated inside the template literal so it travels into
// projects this component is inserted into. See also the NOTICE file.
//
// Ported from `spinningTextJS`. Each character is positioned around a
// circle via rotate + translateY(radius*-1ch); a wrapper element rotates
// the whole group via a RAF loop. Hover speeds it up by lerping
// `currentSpeed` toward `hoverVelocity * baseSpeed`.

export const SPINNING_TEXT_COMPONENT = `'use client';

// Technique derived from Magic UI (https://github.com/magicuidesign/magicui)
// Copyright (c) Magic UI — MIT License.
// The full MIT permission notice is reproduced in the Revyme NOTICE file.

/** @label "Spinning Text" */
/** @comment "Arranges characters in a circle and rotates them, speeds up on hover" */
/** @defaultWidth 600 */
/** @defaultHeight 400 */
/** @controls {
  "text": { "type": "text", "label": "Text", "default": "SPINNING • TEXT • DEMO" },
  "duration": { "type": "number", "label": "Duration (s)", "min": 1, "max": 60, "default": 10, "step": 1 },
  "radius": { "type": "number", "label": "Radius (ch)", "min": 1, "max": 20, "default": 5, "step": 1 },
  "reverse": { "type": "toggle", "label": "Reverse", "default": false },
  "hoverSpeed": { "type": "toggle", "label": "Hover Speed", "default": true },
  "hoverVelocity": { "type": "number", "label": "Hover Velocity", "min": 1, "max": 20, "default": 4, "step": 0.5 },
  "color": { "type": "color", "label": "Color", "default": "#111111" },
  "fontSize": { "type": "number", "label": "Font Size", "min": 12, "max": 200, "default": 32, "step": 1 },
  "fontWeight": { "type": "select", "label": "Weight", "default": "700", "options": [{"label":"Regular","value":"400"},{"label":"Medium","value":"500"},{"label":"Semi Bold","value":"600"},{"label":"Bold","value":"700"},{"label":"Black","value":"900"}] },
  "fontFamily": { "type": "text", "label": "Font", "default": "Inter, sans-serif" }
} */

import { useEffect, useRef } from 'react';
import { withResponsiveProps } from '@revyme/runtime';

function SpinningText({
  text = 'SPINNING • TEXT • DEMO', duration = 10, radius = 5,
  reverse = false, hoverSpeed = true, hoverVelocity = 4,
  color = '#111111', fontSize = 32, fontWeight = '700', fontFamily = 'Inter, sans-serif',
  ...props
}: {
  text?: string; duration?: number; radius?: number;
  reverse?: boolean; hoverSpeed?: boolean; hoverVelocity?: number;
  color?: string; fontSize?: number; fontWeight?: string; fontFamily?: string;
  [key: string]: any;
}) {
  const rotatorRef = useRef<HTMLDivElement | null>(null);

  // Pad with one trailing space so the circle closes cleanly when total
  // chars don't divide 360° evenly — same trick the imperative source
  // used. Empty strings short-circuit to a single space so the loop has
  // a renderable item.
  const chars = (text.length > 0 ? text : ' ').split('');
  chars.push(' ');
  const total = chars.length;

  useEffect(() => {
    const rotator = rotatorRef.current;
    if (!rotator) return;

    const baseSpeed = 360 / duration;
    const hoverSpeedDps = 360 / (duration / hoverVelocity);
    let currentSpeed = baseSpeed;
    let targetSpeed = baseSpeed;
    let angle = 0;
    let lastTime = performance.now();
    let rafId = 0;

    const onEnter = () => { targetSpeed = hoverSpeedDps; };
    const onLeave = () => { targetSpeed = baseSpeed; };
    const parent = rotator.parentElement;
    if (hoverSpeed && parent) {
      parent.addEventListener('mouseenter', onEnter);
      parent.addEventListener('mouseleave', onLeave);
    }

    const animate = (now: number) => {
      const dt = (now - lastTime) / 1000;
      lastTime = now;
      currentSpeed += (targetSpeed - currentSpeed) * 0.08;
      const dir = reverse ? -1 : 1;
      angle += dir * currentSpeed * dt;
      rotator.style.transform = 'rotate(' + angle + 'deg)';
      rafId = requestAnimationFrame(animate);
    };
    rafId = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(rafId);
      if (hoverSpeed && parent) {
        parent.removeEventListener('mouseenter', onEnter);
        parent.removeEventListener('mouseleave', onLeave);
      }
    };
  }, [duration, reverse, hoverSpeed, hoverVelocity]);

  return (
    <span {...props} style={{ position: 'relative', display: 'inline-block', ...(props.style || {}) }}>
      <span ref={rotatorRef} style={{ position: 'relative', display: 'inline-block', width: '100%', height: '100%' }}>
        {chars.map((ch, i) => {
          const charAngle = (360 / total) * i;
          return (
            <span
              key={i}
              style={{
                position: 'absolute', top: '50%', left: '50%',
                display: 'inline-block', transformOrigin: 'center',
                transform: 'translate(-50%, -50%) rotate(' + charAngle + 'deg) translateY(' + (radius * -1) + 'ch)',
                fontSize: fontSize + 'px', fontFamily, fontWeight, color,
              }}
            >
              {ch}
            </span>
          );
        })}
      </span>
    </span>
  );
}

export default withResponsiveProps(SpinningText);
`;
