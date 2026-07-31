// AnimatedCounter — Code component template (number that counts up with easing).
// Source string for the default-project virtual file system.

export const ANIMATED_COUNTER_COMPONENT = `'use client';

/** @label "Animated Counter" */
/** @comment "Counts up to a target number with smooth easing animation" */
/** @defaultWidth 600 */
/** @defaultHeight 400 */
/** @controls {
  "endValue": { "type": "number", "label": "Target", "min": 0, "max": 99999, "default": 1250, "step": 1 },
  "duration": { "type": "number", "label": "Duration (ms)", "min": 200, "max": 5000, "default": 2000, "step": 100 },
  "suffix": { "type": "text", "label": "Suffix", "default": "+" },
  "prefix": { "type": "text", "label": "Prefix", "default": "" },
  "color": { "type": "color", "label": "Color", "default": "#111111" },
  "fontSize": { "type": "number", "label": "Font Size", "min": 12, "max": 200, "default": 48, "step": 1 },
  "fontWeight": { "type": "select", "label": "Weight", "default": "700", "options": [{"label":"Regular","value":"400"},{"label":"Medium","value":"500"},{"label":"Semi Bold","value":"600"},{"label":"Bold","value":"700"},{"label":"Black","value":"900"}] },
  "fontFamily": { "type": "text", "label": "Font", "default": "Inter, sans-serif" }
} */

import { useState, useEffect } from 'react';
import { withResponsiveProps } from '@revyme/runtime';

function AnimatedCounter({
  endValue = 1250, duration = 2000, suffix = '+', prefix = '',
  color = '#111111', fontSize = 48, fontWeight = '700', fontFamily = 'Inter, sans-serif',
  ...props
}: {
  endValue?: number; duration?: number; suffix?: string; prefix?: string;
  color?: string; fontSize?: number; fontWeight?: string; fontFamily?: string;
  [key: string]: any;
}) {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let start: number | null = null;
    let frame: number;
    const step = (ts: number) => {
      if (!start) start = ts;
      const p = Math.min((ts - start) / duration, 1);
      const eased = 1 - Math.pow(1 - p, 3);
      setCount(Math.floor(eased * endValue));
      if (p < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [endValue, duration]);

  return (
    <span {...props} style={{ color, fontSize: fontSize + 'px', fontWeight, fontFamily, ...(props.style || {}) }}>
      {prefix}{count.toLocaleString()}{suffix}
    </span>
  );
}

export default withResponsiveProps(AnimatedCounter);
`;
