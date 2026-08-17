// NeonParticleField — Code component template (glowing neon particle field).
//
// Port of the old builder's `neonParticleFieldJS` customCode effect into the
// Revyme Code component/code-component format. Floating particles in two neon
// hues with glowing connection lines and cursor-reactive glow links.
//
// Performance notes (rewrite — the first version killed the builder):
//   1. The glow is drawn from a PRE-RENDERED sprite (a radial-gradient on an
//      off-screen canvas) — particles render via `drawImage`. Canvas 2D
//      `shadowBlur` is enormously expensive and was being set per-particle
//      AND per-connection-line every frame; replacing it with a cached
//      sprite is orders of magnitude cheaper.
//   2. Connection lines DON'T use `shadowBlur` — alpha + color does most of
//      the visual job and `shadowBlur` was the single biggest cost.
//   3. Pair-distance check uses squared distance (skips `Math.sqrt`).
//   4. `save/restore` removed from hot loops; canvas state is set once per
//      pass and reset at the end.
//   5. `useStaticCanvas()` flips the code component to a single paint (no rAF) on the
//      editor canvas — particles are randomly placed so one paint is enough.
//      Live preview + published site keep the animated version.

export const NEON_PARTICLE_FIELD_COMPONENT = `'use client';

/** @label "Neon Particles" */
/** @comment "Floating neon particles with glowing connection lines — cursor-reactive." */
/** @defaultWidth 600 */
/** @defaultHeight 400 */
/** @controls {
  "particleCount": { "type": "number", "label": "Particle Count", "min": 20, "max": 200, "step": 5, "default": 60 },
  "speed": { "type": "number", "label": "Speed", "min": 0.1, "max": 3, "step": 0.1, "default": 1.5 },
  "primaryColor": { "type": "color", "label": "Primary Color", "default": "#00FFFF" },
  "secondaryColor": { "type": "color", "label": "Secondary Color", "default": "#FF00FF" },
  "maxDistance": { "type": "number", "label": "Connect Distance", "min": 50, "max": 200, "step": 10, "default": 120 },
  "lineOpacity": { "type": "number", "label": "Line Opacity", "min": 0.05, "max": 0.8, "step": 0.05, "default": 0.25 },
  "glowIntensity": { "type": "number", "label": "Glow Intensity", "min": 1, "max": 20, "step": 1, "default": 8 },
  "bgColor": { "type": "color", "label": "Background", "default": "#0A0A16" }
} */

import { useEffect, useRef } from 'react';
import { withResponsiveProps, useStaticCanvas } from '@revyme/runtime';

function NeonParticleField({
  particleCount = 60, speed = 1.5, primaryColor = '#00FFFF', secondaryColor = '#FF00FF',
  maxDistance = 120, lineOpacity = 0.25, glowIntensity = 8, bgColor = '#0A0A16',
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

    // Pre-render a glow sprite per particle colour. Each sprite is a radial
    // gradient on an off-screen canvas — drawing the particle is one cheap
    // drawImage instead of an expensive shadowBlur stroke.
    function makeSprite(color, glow) {
      const r = 2.5;
      const halo = Math.max(6, glow);
      const size = Math.ceil((r + halo) * 2);
      const off = document.createElement('canvas');
      off.width = size;
      off.height = size;
      const ox = off.getContext('2d');
      if (!ox) return off;
      const c = size / 2;
      const grad = ox.createRadialGradient(c, c, 0, c, c, size / 2);
      grad.addColorStop(0, color);
      grad.addColorStop(0.25, color);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ox.fillStyle = grad;
      ox.beginPath();
      ox.arc(c, c, size / 2, 0, Math.PI * 2);
      ox.fill();
      return off;
    }
    const spriteA = makeSprite(primaryColor, glowIntensity);
    const spriteB = makeSprite(secondaryColor, glowIntensity);
    const spriteHalf = spriteA.width / 2;

    const particles = Array.from({ length: particleCount }, function (_, i) {
      return {
        x: Math.random() * (w || 600),
        y: Math.random() * (h || 400),
        vx: (Math.random() - 0.5) * speed,
        vy: (Math.random() - 0.5) * speed,
        color: i % 2 === 0 ? primaryColor : secondaryColor,
        sprite: i % 2 === 0 ? spriteA : spriteB,
      };
    });

    const mouse = { x: -9999, y: -9999 };
    function onMove(e) {
      const r = canvas.getBoundingClientRect();
      mouse.x = e.clientX - r.left;
      mouse.y = e.clientY - r.top;
    }
    function onLeave() { mouse.x = -9999; mouse.y = -9999; }
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerleave', onLeave);

    const maxDistSq = maxDistance * maxDistance;
    const mouseRange = 180;
    const mouseRangeSq = mouseRange * mouseRange;
    let raf = 0;

    function paint() {
      // Background.
      ctx.globalAlpha = 1;
      ctx.fillStyle = bgColor;
      ctx.fillRect(0, 0, w, h);

      // Step particles.
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 0) { p.x = 0; p.vx *= -1; }
        else if (p.x > w) { p.x = w; p.vx *= -1; }
        if (p.y < 0) { p.y = 0; p.vy *= -1; }
        else if (p.y > h) { p.y = h; p.vy *= -1; }
      }

      // Connection lines (no shadow — too expensive; alpha + color do the work).
      ctx.lineWidth = 0.8;
      for (let i = 0; i < particles.length; i++) {
        const a = particles[i];
        for (let j = i + 1; j < particles.length; j++) {
          const b = particles[j];
          const dx = a.x - b.x, dy = a.y - b.y;
          const distSq = dx * dx + dy * dy;
          if (distSq < maxDistSq) {
            const dist = Math.sqrt(distSq);
            ctx.globalAlpha = lineOpacity * (1 - dist / maxDistance);
            ctx.strokeStyle = a.color;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
      }

      // Cursor-reactive links — same cheap stroke pattern, no shadow.
      if (mouse.x > -9000) {
        ctx.strokeStyle = primaryColor;
        ctx.lineWidth = 0.6;
        for (let i = 0; i < particles.length; i++) {
          const p = particles[i];
          const dx = p.x - mouse.x, dy = p.y - mouse.y;
          const distSq = dx * dx + dy * dy;
          if (distSq < mouseRangeSq) {
            const dist = Math.sqrt(distSq);
            ctx.globalAlpha = 0.6 * (1 - dist / mouseRange);
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(mouse.x, mouse.y);
            ctx.stroke();
          }
        }
      }

      // Particles via cached sprite — drawImage is ~free vs shadowBlur.
      ctx.globalAlpha = 1;
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        ctx.drawImage(p.sprite, p.x - spriteHalf, p.y - spriteHalf);
      }
    }

    function tick() {
      paint();
      raf = requestAnimationFrame(tick);
    }

    if (isStatic) {
      // One paint is enough — particles are placed at random positions, no
      // visible benefit from advancing the simulation in the editor.
      const settle = function () { resize(); paint(); };
      settle();
      const ro = new ResizeObserver(settle);
      ro.observe(canvas);
      return function () {
        ro.disconnect();
        canvas.removeEventListener('pointermove', onMove);
        canvas.removeEventListener('pointerleave', onLeave);
      };
    }

    raf = requestAnimationFrame(tick);
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    return function () {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
    };
  }, [particleCount, speed, primaryColor, secondaryColor, maxDistance, lineOpacity, glowIntensity, bgColor, isStatic]);

  return (
    <div data-id={props['data-id']} data-name={props['data-name']}
         style={{  position: 'relative', overflow: 'hidden', backgroundColor: bgColor, ...props.style }}>
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
    </div>
  );
}

export default withResponsiveProps(NeonParticleField);
`;
