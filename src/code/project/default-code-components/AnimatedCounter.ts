// AnimatedCounter — Code component template (number that counts up with easing).
// Source string for the default-project virtual file system.
// Starts counting on first VIEWPORT ENTRY (IntersectionObserver, fires once),
// with an optional "Delay in view" before the count begins — not on page load.

export const ANIMATED_COUNTER_COMPONENT = `'use client';

/** @label "Animated Counter" */
/** @comment "Counts up to a target number when it enters the viewport, with smooth easing" */
/** @defaultWidth 600 */
/** @defaultHeight 400 */
/** @controls {
  "endValue": { "type": "number", "label": "Target", "min": 0, "max": 99999, "default": 1250, "step": 1 },
  "duration": { "type": "number", "label": "Duration (ms)", "min": 200, "max": 5000, "default": 2000, "step": 100 },
  "delayInView": { "type": "number", "label": "Delay in view (ms)", "min": 0, "max": 10000, "default": 0, "step": 100 },
  "suffix": { "type": "text", "label": "Suffix", "default": "+" },
  "prefix": { "type": "text", "label": "Prefix", "default": "" },
  "color": { "type": "color", "label": "Color", "default": "#111111" },
  "fontSize": { "type": "number", "label": "Font Size", "min": 12, "max": 200, "default": 48, "step": 1 },
  "fontWeight": { "type": "select", "label": "Weight", "default": "700", "options": [{"label":"Regular","value":"400"},{"label":"Medium","value":"500"},{"label":"Semi Bold","value":"600"},{"label":"Bold","value":"700"},{"label":"Black","value":"900"}] },
  "fontFamily": { "type": "text", "label": "Font", "default": "Inter, sans-serif" }
} */

import { useState, useEffect, useRef } from 'react';
import { withResponsiveProps } from '@revyme/runtime';

function AnimatedCounter({
  endValue = 1250, duration = 2000, delayInView = 0, suffix = '+', prefix = '',
  color = '#111111', fontSize = 48, fontWeight = '700', fontFamily = 'Inter, sans-serif',
  ...props
}: {
  endValue?: number; duration?: number; delayInView?: number; suffix?: string; prefix?: string;
  color?: string; fontSize?: number; fontWeight?: string; fontFamily?: string;
  [key: string]: any;
}) {
  const [count, setCount] = useState(0);
  const [started, setStarted] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  // Arm on first viewport entry (once), then wait delayInView ms before starting.
  useEffect(() => {
    if (started) return;
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') { setStarted(true); return; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        io.disconnect();
        timer = setTimeout(() => setStarted(true), Math.max(0, delayInView));
      }
    }, { threshold: 0.15 });
    io.observe(el);
    return () => { io.disconnect(); if (timer) clearTimeout(timer); };
  }, [started, delayInView]);

  useEffect(() => {
    if (!started) return;
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
  }, [started, endValue, duration]);

  return (
    <span {...props} ref={ref} style={{ color, fontSize: fontSize + 'px', fontWeight, fontFamily, ...(props.style || {}) }}>
      {prefix}{count.toLocaleString()}{suffix}
    </span>
  );
}

export default withResponsiveProps(AnimatedCounter);
`;
