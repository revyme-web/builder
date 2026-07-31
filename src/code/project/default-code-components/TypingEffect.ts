// TypingEffect — Code component template (typewriter text animation).

export const TYPING_EFFECT_COMPONENT = `'use client';

/** @label "Typing Effect" */
/** @comment "Typewriter animation that types out text character by character" */
/** @defaultWidth 600 */
/** @defaultHeight 400 */
/** @controls {
  "text": { "type": "text", "label": "Text", "default": "Build the future, visually." },
  "speed": { "type": "number", "label": "Speed (ms)", "min": 20, "max": 200, "default": 80, "step": 5 },
  "loop": { "type": "toggle", "label": "Loop", "default": true },
  "cursor": { "type": "toggle", "label": "Show Cursor", "default": true },
  "color": { "type": "color", "label": "Color", "default": "#111111" },
  "fontSize": { "type": "number", "label": "Font Size", "min": 12, "max": 120, "default": 32, "step": 1 },
  "fontWeight": { "type": "select", "label": "Weight", "default": "700", "options": [{"label":"Regular","value":"400"},{"label":"Medium","value":"500"},{"label":"Semi Bold","value":"600"},{"label":"Bold","value":"700"},{"label":"Black","value":"900"}] },
  "fontFamily": { "type": "text", "label": "Font", "default": "Inter, sans-serif" }
} */

import { useState, useEffect } from 'react';
import { withResponsiveProps } from '@revyme/runtime';

function TypingEffect({
  text = 'Build the future, visually.', speed = 80, loop = true, cursor = true,
  color = '#111111', fontSize = 32, fontWeight = '700', fontFamily = 'Inter, sans-serif',
  ...props
}: {
  text?: string; speed?: number; loop?: boolean; cursor?: boolean;
  color?: string; fontSize?: number; fontWeight?: string; fontFamily?: string;
  [key: string]: any;
}) {
  const [displayed, setDisplayed] = useState('');
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (index < text.length) {
      const timer = setTimeout(() => {
        setDisplayed(text.slice(0, index + 1));
        setIndex(index + 1);
      }, speed);
      return () => clearTimeout(timer);
    } else if (loop) {
      const timer = setTimeout(() => {
        setDisplayed('');
        setIndex(0);
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, [index, text, speed, loop]);

  const style = { color, fontSize: fontSize + 'px', fontWeight, fontFamily, ...(props.style || {}) };

  return (
    <span {...props} style={style}>
      {displayed}
      {cursor && <span style={{ opacity: index < text.length ? 1 : 0, animation: 'blink 1s step-end infinite' }}>|</span>}
    </span>
  );
}

export default withResponsiveProps(TypingEffect);
`;
