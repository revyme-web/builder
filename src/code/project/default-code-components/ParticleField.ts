// ParticleField — Code component template (mouse-reactive Canvas 2D particle network).
//
// Performance: `useStaticCanvas()` flips the code component into a paint-once
// branch on the editor canvas — the simulation/paint body runs ~30
// times to settle particles, then stops (no rAF, no mouse listeners
// effectively driving updates). Live preview and the published site
// keep the full animated version.

export const PARTICLE_FIELD_COMPONENT = `'use client';

/** @label "Particle Field" */
/** @comment "Mouse-reactive particle network with depth-projected dots and connection lines" */
/** @defaultWidth 600 */
/** @defaultHeight 400 */
/** @controls {
  "particleCount": { "type": "number", "label": "Particle Count", "min": 30, "max": 400, "default": 140, "step": 10 },
  "linkDistance": { "type": "number", "label": "Link Distance", "min": 40, "max": 220, "default": 120, "step": 5 },
  "speed": { "type": "number", "label": "Speed", "min": 0.1, "max": 3, "default": 0.6, "step": 0.05 },
  "mouseRepel": { "type": "number", "label": "Mouse Repel", "min": 0, "max": 200, "default": 80, "step": 5 },
  "particleColor": { "type": "color", "label": "Particle Color", "default": "#7dd3fc" },
  "linkColor": { "type": "color", "label": "Link Color", "default": "#38bdf8" },
  "bgColor": { "type": "color", "label": "Background", "default": "#020617" }
} */

import { useEffect, useRef } from 'react';
import { withResponsiveProps, useStaticCanvas } from '@revyme/runtime';

function ParticleField({
  particleCount = 140, linkDistance = 120, speed = 0.6, mouseRepel = 80,
  particleColor = '#7dd3fc', linkColor = '#38bdf8', bgColor = '#020617',
  ...props
}) {
  const canvasRef = useRef(null);
  const isStatic = useStaticCanvas();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let w = canvas.clientWidth;
    let h = canvas.clientHeight;
    const dpr = isStatic ? 1 : (window.devicePixelRatio || 1);

    function resize() {
      if (!canvas) return;
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const particles = Array.from({ length: particleCount }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      z: Math.random(),
      vx: (Math.random() - 0.5) * speed,
      vy: (Math.random() - 0.5) * speed,
    }));

    const mouse = { x: -9999, y: -9999 };
    function onMove(e) {
      const r = canvas.getBoundingClientRect();
      mouse.x = e.clientX - r.left;
      mouse.y = e.clientY - r.top;
    }
    function onLeave() { mouse.x = -9999; mouse.y = -9999; }
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerleave', onLeave);

    let raf = 0;
    const linkSq = linkDistance * linkDistance;
    const mouseSq = mouseRepel * mouseRepel;

    function simulateAndPaint() {
      ctx.fillStyle = bgColor;
      ctx.fillRect(0, 0, w, h);

      for (const p of particles) {
        if (mouse.x > -9000) {
          const dx = p.x - mouse.x;
          const dy = p.y - mouse.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < mouseSq && d2 > 0.01) {
            const f = (1 - d2 / mouseSq) * 0.6;
            const inv = 1 / Math.sqrt(d2);
            p.vx += dx * inv * f;
            p.vy += dy * inv * f;
          }
        }
        p.x += p.vx;
        p.y += p.vy;
        p.vx *= 0.96;
        p.vy *= 0.96;
        if (p.x < 0 || p.x > w) p.vx *= -1;
        if (p.y < 0 || p.y > h) p.vy *= -1;
        if (p.x < 0) p.x = 0; else if (p.x > w) p.x = w;
        if (p.y < 0) p.y = 0; else if (p.y > h) p.y = h;
      }

      ctx.strokeStyle = linkColor;
      for (let i = 0; i < particles.length; i++) {
        const a = particles[i];
        for (let j = i + 1; j < particles.length; j++) {
          const b = particles[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < linkSq) {
            const alpha = (1 - d2 / linkSq) * 0.5 * (a.z + b.z) * 0.5 + 0.05;
            ctx.globalAlpha = alpha;
            ctx.lineWidth = 0.6 + (1 - d2 / linkSq) * 0.6;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
      }

      ctx.fillStyle = particleColor;
      for (const p of particles) {
        ctx.globalAlpha = 0.4 + p.z * 0.6;
        const r = 1 + p.z * 2.5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    function tick() {
      simulateAndPaint();
      raf = requestAnimationFrame(tick);
    }

    if (isStatic) {
      for (let i = 0; i < 30; i++) simulateAndPaint();
      return () => {
        ro.disconnect();
        canvas.removeEventListener('pointermove', onMove);
        canvas.removeEventListener('pointerleave', onLeave);
      };
    }

    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
    };
  }, [particleCount, linkDistance, speed, mouseRepel, particleColor, linkColor, bgColor, isStatic]);

  return (
    <div data-id={props['data-id']} data-name={props['data-name']}
         style={{ ...props.style, position: 'relative', overflow: 'hidden', backgroundColor: bgColor }}>
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
    </div>
  );
}

export default withResponsiveProps(ParticleField);
`;
