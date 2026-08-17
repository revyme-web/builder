// MatrixRain — Code component template (Canvas 2D falling-glyph rain).
//
// Performance: `useStaticCanvas()` flips the code component into a paint-once
// branch on the editor canvas — the inner paint body runs ~30 times to
// warm up the rain so the still shows characters mid-fall, then stops
// (no rAF). Live preview and the published site keep the full animated
// version. Retina is preserved because the effect is text-heavy.

export const MATRIX_RAIN_COMPONENT = `'use client';

/** @label "Matrix Rain" */
/** @comment "Falling glyph rain on Canvas 2D — many columns, classic cyberpunk vibe" */
/** @defaultWidth 600 */
/** @defaultHeight 400 */
/** @controls {
  "speed": { "type": "number", "label": "Speed", "min": 0.2, "max": 3, "default": 1, "step": 0.05 },
  "fontSize": { "type": "number", "label": "Font Size", "min": 8, "max": 36, "default": 16, "step": 1 },
  "trailFade": { "type": "number", "label": "Trail Length", "min": 0.02, "max": 0.3, "default": 0.06, "step": 0.005 },
  "glyphs": { "type": "text", "label": "Glyphs", "default": "ｱｲｳｴｵｶｷｸｹｺ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ" },
  "headColor": { "type": "color", "label": "Head Color", "default": "#d1fae5" },
  "trailColor": { "type": "color", "label": "Trail Color", "default": "#22c55e" },
  "bgColor": { "type": "color", "label": "Background", "default": "#020617" }
} */

import { useEffect, useRef } from 'react';
import { withResponsiveProps, useStaticCanvas } from '@revyme/runtime';

function MatrixRain({
  speed = 1, fontSize = 16, trailFade = 0.06,
  glyphs = 'ｱｲｳｴｵｶｷｸｹｺ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  headColor = '#d1fae5', trailColor = '#22c55e', bgColor = '#020617',
  ...props
}) {
  const canvasRef = useRef(null);
  const isStatic = useStaticCanvas();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    let w = canvas.clientWidth;
    let h = canvas.clientHeight;
    let cols = 0;
    let drops = [];
    const chars = (glyphs && glyphs.length > 0) ? glyphs : 'ABCDEF0123456789';

    function resize() {
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cols = Math.max(1, Math.floor(w / fontSize));
      drops = Array.from({ length: cols }, () => Math.random() * (h / fontSize));
      ctx.fillStyle = bgColor;
      ctx.fillRect(0, 0, w, h);
    }
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    let raf = 0;
    let last = performance.now();
    const stepMs = 50 / Math.max(0.1, speed);

    function paintFrame() {
      ctx.fillStyle = bgColor + Math.round(255 * trailFade).toString(16).padStart(2, '0').slice(-2);
      ctx.globalAlpha = trailFade;
      ctx.fillStyle = bgColor;
      ctx.fillRect(0, 0, w, h);
      ctx.globalAlpha = 1;

      ctx.font = fontSize + 'px monospace';
      for (let i = 0; i < cols; i++) {
        const ch = chars.charAt(Math.floor(Math.random() * chars.length));
        const x = i * fontSize + fontSize / 2;
        const y = drops[i] * fontSize;
        ctx.fillStyle = trailColor;
        ctx.fillText(ch, x, y);
        ctx.fillStyle = headColor;
        ctx.fillText(ch, x, y + fontSize);
        if (y > h && Math.random() > 0.975) drops[i] = 0;
        drops[i] += 1;
      }
    }

    function tick() {
      const now = performance.now();
      if (now - last >= stepMs) {
        last = now;
        paintFrame();
      }
      raf = requestAnimationFrame(tick);
    }

    if (isStatic) {
      for (let i = 0; i < 30; i++) paintFrame();
      return () => {
        ro.disconnect();
      };
    }

    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [speed, fontSize, trailFade, glyphs, headColor, trailColor, bgColor, isStatic]);

  return (
    <div data-id={props['data-id']} data-name={props['data-name']}
         style={{  position: 'relative', overflow: 'hidden', backgroundColor: bgColor, ...props.style }}>
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
    </div>
  );
}

export default withResponsiveProps(MatrixRain);
`;
