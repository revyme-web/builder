// creative-preview-icons.tsx — Animated grid-tile previews for the
// "Creative — Code Snippets" Insert panel category. Ports of the old
// builder's `*Preview.tsx` files, scaled down to fit the 44–56 px tile
// area. They mirror the user-visible behaviour of each cs-* code component so the
// user can see what each effect looks like before dragging.
//
// Render contract: each component fills its parent container (the panel
// renders them inside a `w-full h-14` preview wrapper when the iconKey
// starts with `creative` — see index.tsx isPreviewIcon). They run the
// animation on a RAF loop and clean up on unmount.

import React, { useEffect, useRef, useState, useMemo } from 'react';

// All text fills in this file route through `TEXT_COLOR` so each preview
// adapts to light/dark mode automatically. The pastel gradient-card
// backgrounds in light mode make a hardcoded near-white text effectively
// invisible (the legacy `#f0f0f0` we used to ship). `var(--text-primary)`
// resolves to near-black in light mode and near-white in dark mode, so
// every text preview stays legible against its card without per-mode
// branches in each component.
const TEXT_COLOR = 'var(--text-primary)';

// ─── MorphingText ──────────────────────────────────────────────────────────
// Two layered spans cross-fade with a blur-clamp via an SVG color-matrix
// alpha-threshold filter, the classic morphing-glyph effect. Filter id is
// randomized per mount so multiple panel grids in the DOM (rare, but
// possible during HMR) don't share the same `<filter>` element.

export function CreativeMorphingTextIcon() {
  const span1 = useRef<HTMLSpanElement>(null);
  const span2 = useRef<HTMLSpanElement>(null);
  const filterId = useMemo(() => 'panel-morph-' + Math.random().toString(36).slice(2, 8), []);
  const texts = ['Morph', 'Text'];
  const morphTime = 1.5;
  const cooldownTime = 0.5;

  useEffect(() => {
    let raf = 0;
    let textIndex = 0;
    let morph = 0;
    let cooldown = 0;
    let last = performance.now();

    const setStyles = (fraction: number) => {
      const a = span1.current; const b = span2.current;
      if (!a || !b) return;
      b.style.filter = 'blur(' + Math.min(8 / fraction - 8, 100) + 'px)';
      b.style.opacity = String(Math.pow(fraction, 0.4));
      const inv = 1 - fraction;
      a.style.filter = 'blur(' + Math.min(8 / inv - 8, 100) + 'px)';
      a.style.opacity = String(Math.pow(inv, 0.4));
      a.textContent = texts[textIndex % texts.length];
      b.textContent = texts[(textIndex + 1) % texts.length];
    };

    const animate = () => {
      raf = requestAnimationFrame(animate);
      const now = performance.now();
      const dt = (now - last) / 1000;
      last = now;
      cooldown -= dt;
      if (cooldown <= 0) {
        morph += dt;
        let fraction = morph / morphTime;
        if (fraction > 1) { cooldown = cooldownTime; fraction = 1; morph = 0; }
        setStyles(fraction);
        if (fraction === 1) textIndex++;
      } else {
        const a = span1.current; const b = span2.current;
        if (a && b) {
          b.style.filter = 'none'; b.style.opacity = '1';
          a.style.filter = 'none'; a.style.opacity = '0';
        }
      }
    };
    animate();
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div
      className="relative w-full h-full flex items-center justify-center text-center"
      style={{ filter: 'url(#' + filterId + ') blur(0.4px)', fontSize: 12, fontWeight: 700, color: TEXT_COLOR }}
    >
      <svg className="fixed h-0 w-0" aria-hidden="true">
        <defs>
          <filter id={filterId}>
            <feColorMatrix in="SourceGraphic" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 255 -140" />
          </filter>
        </defs>
      </svg>
      <span className="absolute inset-x-0 top-1/2 -translate-y-1/2 inline-block w-full" ref={span1} />
      <span className="absolute inset-x-0 top-1/2 -translate-y-1/2 inline-block w-full" ref={span2} />
    </div>
  );
}

// ─── WordRotate ────────────────────────────────────────────────────────────
// Single span cycles through a word list, slide-up exit + slide-in enter.
// CSS transition handles the easing — no framer-motion needed at this
// size (and avoids pulling motion into the panel render path).

export function CreativeWordRotateIcon() {
  const words = ['Word', 'Rotate'];
  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState<'in' | 'out'>('in');

  useEffect(() => {
    const interval = setInterval(() => {
      setPhase('out');
      setTimeout(() => {
        setIndex(i => (i + 1) % words.length);
        setPhase('in');
      }, 250);
    }, 2200);
    return () => clearInterval(interval);
  }, [words.length]);

  return (
    <div className="overflow-hidden h-full w-full flex items-center justify-center">
      <span
        className="text-center font-bold text-[12px]"
        style={{
          color: TEXT_COLOR,
          transition: 'opacity 0.25s ease, transform 0.25s ease',
          opacity: phase === 'in' ? 1 : 0,
          transform: phase === 'in' ? 'translateY(0)' : 'translateY(-12px)',
          display: 'inline-block',
        }}
      >
        {words[index]}
      </span>
    </div>
  );
}

// ─── SpinningText ──────────────────────────────────────────────────────────
// Characters arranged on a small circle, continuously rotated via CSS
// `@keyframes spin`. No JS animation loop needed — pure CSS scales well
// to dozens of grid tiles without RAF cost.

export function CreativeSpinningTextIcon() {
  const text = 'SPIN•';
  const letters = text.split('');
  const radius = 3;
  const animName = useMemo(() => 'panel-spin-' + Math.random().toString(36).slice(2, 8), []);

  return (
    <div className="relative w-full h-full flex items-center justify-center" style={{ fontSize: 8, fontWeight: 700, color: TEXT_COLOR }}>
      <div className="relative" style={{ animation: animName + ' 4s linear infinite' }}>
        {letters.map((letter, i) => (
          <span
            key={i}
            className="absolute top-1/2 left-1/2 inline-block"
            style={{
              transform: 'translate(-50%, -50%) rotate(' + (360 / letters.length * i) + 'deg) translateY(' + (radius * -1) + 'ch)',
              transformOrigin: 'center',
            }}
          >
            {letter}
          </span>
        ))}
      </div>
      <style>{'@keyframes ' + animName + ' { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }'}</style>
    </div>
  );
}

// ─── HangingCurved ─────────────────────────────────────────────────────────
// Tiny SVG textPath with a subtle U-curve, scrolling continuously via
// startOffset RAF tweak. Mirrors the code component's "endless curved scroll".

export function CreativeHangingCurvedIcon() {
  const [offset, setOffset] = useState(0);
  const pathId = useMemo(() => 'panel-curve-' + Math.random().toString(36).slice(2, 8), []);

  useEffect(() => {
    let raf = 0;
    const step = () => {
      setOffset(prev => (prev - 0.15) % 100);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="relative w-full h-full flex items-center justify-center">
      <svg viewBox="0 0 120 40" width="80" height="28" style={{ overflow: 'visible' }}>
        <defs>
          <path id={pathId} d="M 2,25 Q 60,35 118,25" fill="none" stroke="transparent" />
        </defs>
        <text fontSize={9} fontWeight={600} fill={TEXT_COLOR} style={{ textTransform: 'uppercase' }}>
          <textPath xlinkHref={'#' + pathId} startOffset={offset + '%'}>
            Curved Text • Curved Text •
          </textPath>
        </text>
      </svg>
    </div>
  );
}

// ─── MagneticText ──────────────────────────────────────────────────────────
// Three letters with staggered translate keyframe animation. The middle
// letter glows cyan to suggest the "highlight on cursor proximity"
// behaviour the actual code component has — even though the panel preview never
// reads the cursor, the visual reads as "magnetic field".

export function CreativeMagneticTextIcon() {
  const animName = useMemo(() => 'panel-magpull-' + Math.random().toString(36).slice(2, 8), []);
  return (
    <div className="w-full h-full flex items-center justify-center overflow-hidden">
      <div
        style={{
          fontSize: 11,
          fontWeight: 800,
          fontFamily: "'Space Grotesk', sans-serif",
          color: TEXT_COLOR,
          letterSpacing: '-0.04em',
          lineHeight: '0.92em',
          display: 'flex',
          gap: 1,
        }}
      >
        {'Mag'.split('').map((ch, i) => (
          <span
            key={i}
            style={{
              display: 'inline-block',
              animation: animName + ' ' + (1.2 + i * 0.15) + 's ease-in-out infinite alternate',
              color: i === 1 ? '#00ffee' : TEXT_COLOR,
            }}
          >
            {ch}
          </span>
        ))}
      </div>
      <style>{'@keyframes ' + animName + ' { 0% { transform: translate(0, 0); } 100% { transform: translate(1.5px, -1px); } }'}</style>
    </div>
  );
}

// ─── TextPressure ──────────────────────────────────────────────────────────
// Five letters with offset-staggered scale waves so they "breathe" —
// communicates the variable-font scale-up behaviour of the code component
// without needing the actual variable font loaded in the panel.

export function CreativeTextPressureIcon() {
  const containerRef = useRef<HTMLDivElement>(null);
  const text = 'Hello';

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const spans: HTMLSpanElement[] = [];
    root.innerHTML = '';
    for (let i = 0; i < text.length; i++) {
      const span = document.createElement('span');
      span.textContent = text[i];
      span.style.cssText = 'display:inline-block;font-size:10px;font-weight:700;color:var(--text-primary);text-transform:uppercase;';
      root.appendChild(span);
      spans.push(span);
    }
    let raf = 0;
    const animate = () => {
      const t = performance.now() * 0.002;
      spans.forEach((span, i) => {
        const offset = i * 0.5;
        const scale = 1 + Math.sin(t + offset) * 0.2;
        span.style.transform = 'scale(' + scale + ')';
      });
      raf = requestAnimationFrame(animate);
    };
    animate();
    return () => cancelAnimationFrame(raf);
  }, []);

  return <div ref={containerRef} className="w-full h-full flex items-center justify-center" style={{ letterSpacing: 2 }} />;
}

// ─── TypingText ────────────────────────────────────────────────────────────
// Multi-word cycle: type forward → pause → delete → next word, with a
// blinking cursor. Mirrors the code component's behaviour at panel-tile size.

export function CreativeTypingTextIcon() {
  const words = ['Typing', 'Text'];
  const [text, setText] = useState('');
  const [wordIdx, setWordIdx] = useState(0);
  const [deleting, setDeleting] = useState(false);
  const [paused, setPaused] = useState(false);
  const blinkName = useMemo(() => 'panel-blink-' + Math.random().toString(36).slice(2, 8), []);

  useEffect(() => {
    const word = words[wordIdx];
    if (paused) {
      const t = setTimeout(() => { setPaused(false); setDeleting(true); }, 900);
      return () => clearTimeout(t);
    }
    if (deleting) {
      if (text.length > 0) {
        const t = setTimeout(() => setText(text.slice(0, -1)), 50);
        return () => clearTimeout(t);
      }
      setDeleting(false);
      setWordIdx(i => (i + 1) % words.length);
    } else {
      if (text.length < word.length) {
        const t = setTimeout(() => setText(word.slice(0, text.length + 1)), 100);
        return () => clearTimeout(t);
      }
      setPaused(true);
    }
  }, [text, wordIdx, deleting, paused, words]);

  return (
    <div className="relative w-full h-full flex items-center justify-center">
      <span style={{ fontSize: 11, fontWeight: 700, color: TEXT_COLOR, fontFamily: 'Inter, sans-serif' }}>
        {text}
        <span
          style={{
            display: 'inline-block', width: 2, height: '1em', marginLeft: 1,
            verticalAlign: 'middle', backgroundColor: TEXT_COLOR,
            animation: blinkName + ' 1s infinite',
          }}
        />
      </span>
      <style>{'@keyframes ' + blinkName + ' { 0%, 50% { opacity: 1; } 51%, 100% { opacity: 0; } }'}</style>
    </div>
  );
}

// ─── RotatingText3D ────────────────────────────────────────────────────────
// 3D cylinder of words rotating on the X-axis, pure CSS keyframes. The
// real code component drives rotation via window.scroll — for the panel preview
// we just spin continuously so the user sees the 3D shape without
// needing to scroll the canvas.

export function CreativeRotatingText3DIcon() {
  const words = ['BUILD', 'GROW', 'SCALE', 'SHIP'];
  const angleStep = 360 / words.length;
  const radius = 14;
  const animName = useMemo(() => 'panel-rot3d-' + Math.random().toString(36).slice(2, 8), []);

  return (
    <div className="w-full h-full flex items-center justify-center overflow-hidden" style={{ perspective: 80 }}>
      <div
        style={{
          position: 'relative', width: '100%', height: '100%',
          transformStyle: 'preserve-3d',
          animation: animName + ' 3s linear infinite',
        }}
      >
        {words.map((word, i) => (
          <span
            key={word}
            style={{
              position: 'absolute', left: '50%', top: '50%',
              transform: 'translate(-50%, -50%) rotateX(' + (i * angleStep) + 'deg) translateZ(' + radius + 'px)',
              transformOrigin: '50% 50%', backfaceVisibility: 'hidden',
              fontSize: 9, fontWeight: 800,
              color: i % 2 === 0 ? '#EC4899' : TEXT_COLOR,
              whiteSpace: 'nowrap',
              WebkitTextStroke: '0.3px rgba(0,0,0,0.5)',
            }}
          >
            {word}
          </span>
        ))}
      </div>
      <style>{'@keyframes ' + animName + ' { from { transform: rotateX(0deg); } to { transform: rotateX(360deg); } }'}</style>
    </div>
  );
}

// ─── VideoText ─────────────────────────────────────────────────────────────
// Bold text with an animated gradient fill that scrolls across — mimics
// the "video plays inside the letterforms" effect. We don't actually
// embed a video at panel-tile size (would be too small to read + extra
// network cost); the moving gradient communicates the effect well
// enough as a teaser.

export function CreativeVideoTextIcon() {
  const animName = useMemo(() => 'panel-vidtext-' + Math.random().toString(36).slice(2, 8), []);
  return (
    <div className="w-full h-full flex items-center justify-center">
      <span
        style={{
          fontSize: 14, fontWeight: 900, fontFamily: 'Inter, sans-serif',
          letterSpacing: '-0.02em',
          background: 'linear-gradient(90deg, #667eea, #764ba2, #f093fb, #f5576c, #667eea)',
          backgroundSize: '300% 100%',
          WebkitBackgroundClip: 'text',
          backgroundClip: 'text',
          color: 'transparent',
          animation: animName + ' 4s linear infinite',
        }}
      >
        VIDEO
      </span>
      <style>{'@keyframes ' + animName + ' { 0% { background-position: 0% 50%; } 100% { background-position: 100% 50%; } }'}</style>
    </div>
  );
}

// ─── Counter ───────────────────────────────────────────────────────────────
// Number that counts up smoothly with cubic ease-out, looping every 3s.
// Same easing the AnimatedCounter code component uses, just faster + on a loop
// so the panel tile has constant motion to draw the eye.

export function CreativeCounterIcon() {
  const [value, setValue] = useState(0);

  useEffect(() => {
    let raf = 0;
    let start = performance.now();
    const dur = 2400;
    const target = 1250;
    const step = (now: number) => {
      const elapsed = now - start;
      const t = Math.min(elapsed / dur, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(Math.floor(eased * target));
      if (t >= 1) {
        // Pause briefly at the end then restart
        setTimeout(() => { start = performance.now(); raf = requestAnimationFrame(step); }, 600);
      } else {
        raf = requestAnimationFrame(step);
      }
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="w-full h-full flex items-center justify-center">
      <span style={{ fontSize: 15, fontWeight: 800, color: TEXT_COLOR, fontFamily: 'Inter, sans-serif' }}>
        {value.toLocaleString()}+
      </span>
    </div>
  );
}

// ─── GlitchText ────────────────────────────────────────────────────────────
// Three layered spans animated with random small offsets every ~80ms —
// a red layer (#FF003C) and a cyan layer (#00E5FF) drift slightly off
// the white center, recreating the chromatic-aberration RGB-split look
// of the actual GlitchText code component. A horizontal scanline drifts to sell
// the CRT vibe.

export function CreativeGlitchTextIcon() {
  const [tick, setTick] = useState(0);
  const animName = useMemo(() => 'panel-glitch-' + Math.random().toString(36).slice(2, 8), []);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 80);
    return () => clearInterval(id);
  }, []);

  // Pseudo-random offsets per tick — small horizontal kicks for each
  // colored layer, occasionally larger to land the "glitch" hits.
  const seed = (tick * 9301 + 49297) % 233280;
  const burst = (tick % 7 === 0) ? 2.4 : 1;
  const dx1 = ((seed % 100) / 100 - 0.5) * 4 * burst;
  const dx2 = (((seed * 3) % 100) / 100 - 0.5) * 4 * burst;
  const dy1 = (((seed * 7) % 100) / 100 - 0.5) * 1.5;
  const dy2 = (((seed * 11) % 100) / 100 - 0.5) * 1.5;

  return (
    <div className="relative w-full h-full flex items-center justify-center overflow-hidden">
      <div className="relative" style={{ fontSize: 14, fontWeight: 900, fontFamily: 'Inter, sans-serif', letterSpacing: '0.04em' }}>
        <span
          style={{
            position: 'absolute', inset: 0,
            color: '#FF003C', mixBlendMode: 'screen',
            transform: 'translate(' + dx1.toFixed(2) + 'px, ' + dy1.toFixed(2) + 'px)',
          }}
        >GLITCH</span>
        <span
          style={{
            position: 'absolute', inset: 0,
            color: '#00E5FF', mixBlendMode: 'screen',
            transform: 'translate(' + dx2.toFixed(2) + 'px, ' + dy2.toFixed(2) + 'px)',
          }}
        >GLITCH</span>
        <span style={{ color: TEXT_COLOR, position: 'relative' }}>GLITCH</span>
      </div>
      {/* Drifting horizontal scanline — sells the CRT/glitch vibe. */}
      <div
        className="absolute left-0 right-0 pointer-events-none"
        style={{
          height: 2,
          background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.35), transparent)',
          animation: animName + ' 1.6s linear infinite',
        }}
      />
      <style>{'@keyframes ' + animName + ' { 0% { top: -10%; } 100% { top: 110%; } }'}</style>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Effects (slot-based code components — Marquee, Carousel, 3D Marquee, …).
// Pixel-faithful ports of the old `revyme-old/builder` InsertCategoryOverlay
// previews. Each fills the panel's `w-full h-14` preview slot (via the
// `effect*` iconKey branch in isPreviewIcon) so the user sees what the
// effect looks like before dragging it onto the canvas.
//
// All animations use CSS keyframes or RAF — no framer-motion in the panel
// render path. The keyframe names are randomized per mount so multiple
// instances of the same panel don't share or collide on a single rule.
// ───────────────────────────────────────────────────────────────────────────

// ─── Carousel ──────────────────────────────────────────────────────────────
// Centered card with chevron arrows on both sides + 3 dots underneath.
// The dot indicator advances every 1.6s so the tile reads as "active",
// matching the legacy "purple-tinted carousel" preview's still vibe (the
// old builder didn't animate this one — kept it readable as an icon).

export function EffectCarouselIcon() {
  const [active, setActive] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setActive(a => (a + 1) % 3), 1600);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="w-full h-full flex items-center justify-center">
      <div className="relative" style={{ width: 60, height: 36 }}>
        <div
          className="absolute inset-0 flex items-center justify-center rounded"
          style={{ background: 'rgba(255,255,255,0.10)' }}
        >
          <div style={{ width: 30, height: 20, borderRadius: 3, background: 'rgba(255,255,255,0.30)' }} />
        </div>
        {/* Left chevron */}
        <div
          className="absolute top-1/2 -translate-y-1/2 left-1 flex items-center justify-center"
          style={{ width: 14, height: 14, borderRadius: '50%', background: 'rgba(255,255,255,0.20)' }}
        >
          <svg viewBox="0 0 10 10" width={7} height={7} fill="none" stroke="#fff" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6,2 3,5 6,8" />
          </svg>
        </div>
        {/* Right chevron */}
        <div
          className="absolute top-1/2 -translate-y-1/2 right-1 flex items-center justify-center"
          style={{ width: 14, height: 14, borderRadius: '50%', background: 'rgba(255,255,255,0.20)' }}
        >
          <svg viewBox="0 0 10 10" width={7} height={7} fill="none" stroke="#fff" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
            <polyline points="4,2 7,5 4,8" />
          </svg>
        </div>
        {/* Dot indicator */}
        <div className="absolute left-1/2 -translate-x-1/2 flex gap-1" style={{ bottom: -6 }}>
          {[0, 1, 2].map(i => (
            <div
              key={i}
              style={{
                width: 3, height: 3, borderRadius: '50%',
                background: active === i ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.30)',
                transition: 'background 0.2s ease',
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Marquee ───────────────────────────────────────────────────────────────
// Scrolling row of purple-tinted bars with gradient fade-out edges. Pure
// CSS animation — the loop translates by -50% on a 6-copy strip (3 unique
// bars duplicated) so the wrap is seamless without measuring DOM width.

export function EffectMarqueeIcon() {
  const animName = useMemo(() => 'panel-mq-' + Math.random().toString(36).slice(2, 8), []);
  return (
    <div className="relative w-full h-full overflow-hidden rounded-md">
      {/* Fade-out gradients on both edges — same purple/transparent stops as
          the legacy preview (color matches the card's #8B5CF6 accent). */}
      <div
        className="absolute top-0 bottom-0 left-0 z-10 pointer-events-none"
        style={{ width: 14, background: 'linear-gradient(to right, #8B5CF6, transparent)' }}
      />
      <div
        className="absolute top-0 bottom-0 right-0 z-10 pointer-events-none"
        style={{ width: 14, background: 'linear-gradient(to left, #8B5CF6, transparent)' }}
      />
      <div className="absolute inset-0 flex items-center">
        <div
          className="flex gap-2"
          style={{ animation: animName + ' 3s linear infinite', willChange: 'transform' }}
        >
          {Array.from({ length: 2 }).flatMap((_, set) =>
            [0.40, 0.30, 0.50].map((alpha, i) => (
              <div
                key={set + '-' + i}
                style={{
                  flexShrink: 0,
                  width: 28, height: 22,
                  borderRadius: 3,
                  background: 'rgba(167, 139, 250, ' + alpha + ')',
                }}
              />
            )),
          )}
        </div>
      </div>
      <style>{'@keyframes ' + animName + ' { from { transform: translateX(0); } to { transform: translateX(-50%); } }'}</style>
    </div>
  );
}

// ─── Path Marquee ──────────────────────────────────────────────────────────
// Mirrors the Path Marquee code component's default "wave" path with colored dots
// traveling along it. SVG `<animateMotion mpath>` keeps the dots LOCKED
// to the same path the stroke uses — they share the SVG's viewBox so the
// coordinates align exactly (an HTML `offset-path` sibling can't, because
// the path coords live in SVG-viewBox space and the HTML element doesn't
// know how that maps to its own positioning context — the previous attempt
// floated the dots above the path; this version paints them ON it).
//
// `keyPoints="0;1"` + `keyTimes="0;1"` makes each dot travel one full
// pass of the path then loop. The dots are staggered via negative
// animation-delay equivalents in SVG: `begin="-0.6s"` etc. — so on first
// paint they're already spread out along the curve, not all stacked at
// the start. This matches the code component's continuous-along-path behaviour.

export function EffectPathMarqueeIcon() {
  // Wave: M start → quadratic peak (up) → smooth quadratic trough (down) → end.
  // Fits the 100×48 viewBox with comfortable margins on every side. Same
  // shape family the code component's default wave produces, just scaled to tile.
  const wavePath = 'M 6,30 Q 28,6 50,30 T 94,30';
  const pathId = useMemo(() => 'pm-path-' + Math.random().toString(36).slice(2, 8), []);
  const duration = 3.2; // seconds — one full pass along the path
  const dots = [
    { color: '#c4b5fd', r: 3.2, begin: '0s' },
    { color: '#a78bfa', r: 3.6, begin: '-0.8s' },
    { color: '#8b5cf6', r: 3.2, begin: '-1.6s' },
    { color: '#ddd6fe', r: 2.8, begin: '-2.4s' },
  ];
  return (
    <div className="relative w-full h-full flex items-center justify-center">
      <svg viewBox="0 0 100 48" width="88%" height="80%" style={{ overflow: 'visible' }}>
        <defs>
          {/* One path declaration — both the visible stroke AND the
              animateMotion mpath reference it, so the dots track the
              SAME curve the user sees. */}
          <path id={pathId} d={wavePath} />
        </defs>
        {/* Visible wave stroke — same path the dots ride. */}
        <use href={'#' + pathId} fill="none" stroke="rgba(255,255,255,0.30)" strokeWidth={1.4} strokeLinecap="round" />
        {dots.map((d, i) => (
          <circle key={i} r={d.r} fill={d.color} style={{ filter: 'drop-shadow(0 0 2px ' + d.color + 'aa)' }}>
            <animateMotion
              dur={duration + 's'}
              repeatCount="indefinite"
              begin={d.begin}
              rotate="auto"
              keyPoints="0;1"
              keyTimes="0;1"
              calcMode="linear"
            >
              <mpath href={'#' + pathId} />
            </animateMotion>
          </circle>
        ))}
      </svg>
    </div>
  );
}

// ─── 3D Marquee ────────────────────────────────────────────────────────────
// 4 columns × 2 items each, tilted with `rotateX(55deg) rotateZ(-45deg)`
// at scale 0.5 (vs the old preview's 0.3 — the panel slot is wider here).
// Each item is a gradient that blends two adjacent column colors so the
// grid reads as a coherent 3D plane. The whole grid drifts subtly so the
// tile has motion to draw the eye.

export function EffectThreeDMarqueeIcon() {
  const animName = useMemo(() => 'panel-3dm-' + Math.random().toString(36).slice(2, 8), []);
  const columns = [
    '#06B6D4',
    '#8B5CF6',
    '#F59E0B',
    '#EC4899',
  ];
  return (
    <div className="relative w-full h-full overflow-hidden flex items-center justify-center">
      <div
        style={{
          transform: 'rotateX(55deg) rotateZ(-45deg) scale(0.45)',
          transformStyle: 'preserve-3d',
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gap: 6,
          animation: animName + ' 4s ease-in-out infinite',
        }}
      >
        {columns.map((c, colIdx) => (
          <div key={colIdx} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {[0, 1].map(rowIdx => (
              <div
                key={rowIdx}
                style={{
                  width: 22, height: 28, borderRadius: 3,
                  background: 'linear-gradient(135deg, ' + c + ' 0%, ' + columns[(colIdx + 1) % columns.length] + ' 100%)',
                  boxShadow: '0 2px 4px rgba(0, 0, 0, 0.18)',
                }}
              />
            ))}
          </div>
        ))}
      </div>
      <style>{'@keyframes ' + animName + ' { 0%, 100% { transform: rotateX(55deg) rotateZ(-45deg) translateY(0) scale(0.45); } 50% { transform: rotateX(55deg) rotateZ(-45deg) translateY(-3px) scale(0.45); } }'}</style>
    </div>
  );
}

// ─── Motion Trail ──────────────────────────────────────────────────────────
// A small "pointer" sweeps left→right leaving a fading trail of colored
// stamps behind it. Communicates the code component's "stamps emit along motion
// path and fade out" behaviour without needing the actual pointer
// interaction in the panel.

export function EffectMotionTrailIcon() {
  const animName = useMemo(() => 'panel-mt-' + Math.random().toString(36).slice(2, 8), []);
  // Cursor sweep: linear, 2.2s, from left=8% to left=92% (range 84%).
  // Stamp `delay` is computed so the stamp pops EXACTLY when the cursor's
  // tip reaches its left-% — `delay = (pos - 8) / 84 * 2.2`. With linear
  // easing on both, this stays in sync every cycle.
  const SWEEP_DUR = 2.2;
  const SWEEP_FROM = 8;
  const SWEEP_TO = 92;
  const arrival = (pos: number) => ((pos - SWEEP_FROM) / (SWEEP_TO - SWEEP_FROM)) * SWEEP_DUR;
  const stamps = [
    { pos: 14, color: '#3B82F6' },
    { pos: 34, color: '#8B5CF6' },
    { pos: 54, color: '#EC4899' },
    { pos: 74, color: '#F59E0B' },
  ];
  return (
    <div className="relative w-full h-full overflow-hidden rounded-md">
      {stamps.map((s, i) => (
        <div
          key={i}
          className="absolute top-1/2"
          style={{
            left: s.pos + '%',
            width: 12, height: 12,
            marginTop: -6,
            marginLeft: -6,    // center on the cursor tip's x — without this the
                               // stamp lands offset, breaks the "popped under the
                               // cursor" read.
            borderRadius: 3,
            background: s.color,
            // Per-stamp inline rotation (kept out of the keyframe so the
            // animation's opacity changes don't reset the rotation each cycle).
            transform: 'rotate(' + (i % 2 === 0 ? -8 : 8) + 'deg)',
            opacity: 0,
            animation: animName + ' ' + SWEEP_DUR + 's linear infinite',
            animationDelay: arrival(s.pos).toFixed(3) + 's',
          }}
        />
      ))}
      {/* Leading "pointer" — the actual OS cursor arrow, so the tile reads
          as "this trail follows your mouse." White fill + thin dark stroke
          so the arrow stays legible on every gradient-card bg the panel
          might apply (blue/purple/dark). The classic Mac/Win arrow shape
          (M 1,1 → tip → side ear → tail). 14×14 viewBox keeps it crisp at
          tile size; positioned so the TIP (1,1) sits on the sweep path. */}
      <div
        className="absolute top-1/2 pointer-events-none"
        style={{
          width: 14, height: 14,
          marginTop: -3,    // tip is near top-left of the SVG → offset so the
          marginLeft: -3,   // tip rides the trail row, not the SVG center.
          // Linear sweep — easing here would desync the stamps (their delays
          // are computed off a linear time→position assumption).
          animation: animName + '-head ' + SWEEP_DUR + 's linear infinite',
          filter: 'drop-shadow(0 0 3px rgba(255,255,255,0.55))',
        }}
      >
        <svg viewBox="0 0 14 14" width={14} height={14} fill="#fff" stroke="#111" strokeWidth={0.8} strokeLinejoin="round">
          <path d="M 1.2,1 L 1.2,11 L 4.3,8.2 L 6.4,12.6 L 8.2,11.8 L 6.1,7.4 L 10.2,7.4 Z" />
        </svg>
      </div>
      {/* Stamp keyframe — instant pop at start, then a smooth fade over the
          full sweep duration. The stamp's `animation-delay` is set so 0%
          (opacity 1) coincides with the cursor tip arriving at the stamp's
          x; the stamp then trails behind, fading as the cursor moves on.
          Transform stays inline per-stamp so the keyframe doesn't overwrite
          the per-stamp rotation. */}
      <style>{
        '@keyframes ' + animName + ' { 0% { opacity: 1; } 100% { opacity: 0; } } ' +
        '@keyframes ' + animName + '-head { 0% { left: ' + SWEEP_FROM + '%; } 100% { left: ' + SWEEP_TO + '%; } }'
      }</style>
    </div>
  );
}

// ─── Lens Box ──────────────────────────────────────────────────────────────
// Port of the old builder's `LensPreview`. Hovering the tile drives a
// circular zoomed lens that follows the cursor; the rest of the tile shows
// the same content unzoomed. CSS mask + `transform: scale + transformOrigin`
// is the same technique the actual LensBox code component uses, just scaled to tile.

export function EffectLensBoxIcon() {
  const containerRef = useRef<HTMLDivElement>(null);
  // Idle at center until the user moves the cursor over the tile.
  const [pos, setPos] = useState({ x: 50, y: 50 });
  const [active, setActive] = useState(false);
  const ZOOM = 1.5;
  const LENS_RADIUS = 18; // px — the magnifier circle size

  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setPos({
      x: ((e.clientX - rect.left) / rect.width) * 100,
      y: ((e.clientY - rect.top) / rect.height) * 100,
    });
    setActive(true);
  };
  const onLeave = () => { setPos({ x: 50, y: 50 }); setActive(false); };

  // 4-cell grid — base layer = dim, lens overlay = bright. Lens window is
  // masked to a circle around the cursor, and the inner content scales from
  // the cursor's position so the magnification reads naturally.
  const baseCells = (
    <div className="absolute inset-0 grid grid-cols-2 grid-rows-2 gap-[2px] p-1">
      {[0, 1, 2, 3].map(i => <div key={i} style={{ background: 'rgba(255,255,255,0.30)', borderRadius: 2 }} />)}
    </div>
  );
  const lensCells = (
    <div className="absolute inset-0 grid grid-cols-2 grid-rows-2 gap-[2px] p-1">
      {[0, 1, 2, 3].map(i => <div key={i} style={{ background: 'rgba(255,255,255,0.70)', borderRadius: 2 }} />)}
    </div>
  );
  const maskCss = 'radial-gradient(circle ' + LENS_RADIUS + 'px at ' + pos.x + '% ' + pos.y + '%, black 99%, transparent 100%)';

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full overflow-hidden rounded-md"
      onMouseMove={onMove}
      onMouseLeave={onLeave}
      style={{
        background: 'linear-gradient(135deg, #667eea 0%, #764ba2 50%, #f093fb 100%)',
        cursor: 'crosshair',
      }}
    >
      {baseCells}
      {/* Lens window — masked overlay with the zoomed content. The inner
          div scales from the cursor point so the magnification feels
          locked to the cursor (matches LensBox code component behavior). */}
      <div
        className="absolute inset-0 overflow-hidden pointer-events-none"
        style={{
          WebkitMaskImage: maskCss,
          maskImage: maskCss,
          transition: active ? 'none' : 'mask-position 0.4s ease-out',
        }}
      >
        <div
          className="absolute inset-0"
          style={{
            transform: 'scale(' + ZOOM + ')',
            transformOrigin: pos.x + '% ' + pos.y + '%',
            transition: active ? 'none' : 'transform 0.3s ease-out, transform-origin 0.3s ease-out',
          }}
        >
          {lensCells}
        </div>
      </div>
    </div>
  );
}

// ─── Magnet Box ────────────────────────────────────────────────────────────
// Port of the old builder's `MagnetPreview`. Hovering the tile pulls the
// inner orange chip toward the cursor with the same easing the MagnetBox
// code component uses (snappy on attract, gentle on release). The original used a
// `window.mousemove` listener — bad in the editor panel context (would
// fire on every cursor move anywhere on the page, including the canvas),
// so this version scopes the listener to the tile via `onMouseMove`.

export function EffectMagnetBoxIcon() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [active, setActive] = useState(false);
  const STRENGTH = 1.7; // higher = looser pull; matches old "small" preset feel

  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = wrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    setOffset({
      x: (e.clientX - cx) / STRENGTH,
      y: (e.clientY - cy) / STRENGTH,
    });
    setActive(true);
  };
  const onLeave = () => { setOffset({ x: 0, y: 0 }); setActive(false); };

  return (
    <div
      ref={wrapRef}
      className="relative w-full h-full flex items-center justify-center overflow-hidden rounded-md"
      onMouseMove={onMove}
      onMouseLeave={onLeave}
      style={{ cursor: 'crosshair' }}
    >
      <div
        className="rounded-lg flex items-center justify-center"
        style={{
          width: 24, height: 24,
          transform: 'translate3d(' + offset.x.toFixed(1) + 'px, ' + offset.y.toFixed(1) + 'px, 0)',
          // Snappy on attract, gentle on release — same easing pairing the
          // code component uses.
          transition: active ? 'transform 0.2s ease-out' : 'transform 0.4s ease-in-out',
          willChange: 'transform',
          background: 'linear-gradient(135deg, #F59E0B, #D97706)',
          boxShadow: '0 2px 8px rgba(249, 115, 22, 0.45)',
        }}
      >
        {/* Pulsing dot — same affordance the legacy preview used to
            communicate "this thing is alive / interactable." */}
        <div
          style={{
            width: 6, height: 6, borderRadius: '50%', background: '#fff',
            animation: 'panel-magnet-pulse 1.4s ease-in-out infinite',
          }}
        />
      </div>
      <style>{
        '@keyframes panel-magnet-pulse { 0%, 100% { opacity: 0.6; transform: scale(1); } 50% { opacity: 1; transform: scale(1.25); } }'
      }</style>
    </div>
  );
}

// ─── Pixelated Hover ───────────────────────────────────────────────────────
// Port of the old builder's `PixelatedHoverPreview` — pure SVG, the circular
// clip auto-orbits around the tile so the pixel grid bleeds through in a
// moving disc. No mouse interaction needed; the orbit IS the affordance.

export function EffectPixelatedHoverIcon() {
  const clipId = useMemo(() => 'pix-clip-' + Math.random().toString(36).slice(2, 8), []);
  return (
    <div
      className="relative w-full h-full overflow-hidden rounded-md"
      style={{ backgroundImage: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)' }}
    >
      <svg width="100%" height="100%" viewBox="0 0 48 48" preserveAspectRatio="xMidYMid slice">
        <defs>
          <clipPath id={clipId}>
            {/* SVG `<animate>` orbit — same path the legacy preview used:
                three keyframe positions then loop back. SMIL keeps it
                framework-free (no RAF, no JS handlers). */}
            <circle cx="24" cy="24" r="11">
              <animate attributeName="cx" values="14;34;24;14" dur="3s" repeatCount="indefinite" />
              <animate attributeName="cy" values="14;22;34;14" dur="3s" repeatCount="indefinite" />
            </circle>
          </clipPath>
        </defs>
        {/* 6×6 pixel grid, only visible inside the orbiting circle. Colors
            stay in the code component's purple palette family. */}
        <g clipPath={'url(#' + clipId + ')'}>
          {Array.from({ length: 36 }, (_, i) => {
            const col = i % 6;
            const row = Math.floor(i / 6);
            const palette = ['#7c6eea', '#9b7ed8', '#6358d4', '#8b6ec7', '#a47ed0', '#7466dd'];
            return (
              <rect
                key={i}
                x={col * 8} y={row * 8}
                width={8} height={8}
                fill={palette[i % palette.length]}
                stroke="rgba(255,255,255,0.18)"
                strokeWidth={0.5}
              />
            );
          })}
        </g>
      </svg>
    </div>
  );
}

// ─── Horizontal Scroll ─────────────────────────────────────────────────────
// A row of colored cards scrolling horizontally inside a container frame.
// Below the container, 3 dots drift left-and-right to suggest "scroll
// direction." Pure CSS — no framer-motion in the panel render path.

export function EffectHorizontalScrollIcon() {
  const scrollName = useMemo(() => 'panel-hs-' + Math.random().toString(36).slice(2, 8), []);
  const dotsName = useMemo(() => 'panel-hs-dots-' + Math.random().toString(36).slice(2, 8), []);
  const colors = ['#06B6D4', '#3B82F6', '#8B5CF6', '#EC4899', '#F59E0B'];
  return (
    <div
      className="relative w-full h-full overflow-hidden rounded-md"
      style={{ background: 'linear-gradient(135deg, rgba(6,182,212,0.10), rgba(139,92,246,0.10))' }}
    >
      {/* Container-frame indicator — the inner "viewport" the scroll happens in. */}
      <div
        className="absolute rounded-sm"
        style={{ inset: 4, border: '1.5px solid rgba(6, 182, 212, 0.35)' }}
      />
      {/* Scrolling strip — two copies of the card row for seamless loop. */}
      <div
        className="absolute left-0 right-0 top-1/2 -translate-y-1/2 overflow-hidden"
        style={{ marginLeft: 6, marginRight: 6, height: 18 }}
      >
        <div
          className="flex gap-1"
          style={{ animation: scrollName + ' 3.5s linear infinite', willChange: 'transform' }}
        >
          {Array.from({ length: 2 }).flatMap((_, set) =>
            colors.map((c, i) => (
              <div
                key={set + '-' + i}
                style={{
                  flexShrink: 0,
                  width: 10, height: 16,
                  borderRadius: 2,
                  background: 'linear-gradient(135deg, ' + c + ', ' + c + 'dd)',
                  boxShadow: '0 1px 2px ' + c + '40',
                }}
              />
            )),
          )}
        </div>
      </div>
      {/* Scroll-direction dots, drifting left↔right. */}
      <div
        className="absolute left-1/2 -translate-x-1/2 flex gap-0.5"
        style={{ bottom: 5, animation: dotsName + ' 1.5s ease-in-out infinite' }}
      >
        <div style={{ width: 3, height: 3, borderRadius: '50%', background: 'rgba(6,182,212,0.65)' }} />
        <div style={{ width: 3, height: 3, borderRadius: '50%', background: 'rgba(6,182,212,0.45)' }} />
        <div style={{ width: 3, height: 3, borderRadius: '50%', background: 'rgba(6,182,212,0.25)' }} />
      </div>
      <style>{
        '@keyframes ' + scrollName + ' { from { transform: translateX(0); } to { transform: translateX(-50%); } } ' +
        '@keyframes ' + dotsName + ' { 0%, 100% { transform: translate(-50%, 0); } 50% { transform: translate(calc(-50% + 4px), 0); } }'
      }</style>
    </div>
  );
}

// ─── Neon Particles ────────────────────────────────────────────────────────
// Mirrors the NeonParticleField code component: glowing neon dots drifting on a dark
// canvas, with thin connecting lines flashing between nearby ones. The real
// code component uses pre-rendered radial-gradient sprites + connection lines drawn
// to a <canvas>; for the panel tile we use pure CSS dots (with box-shadow
// glows) + a static SVG line layer that fades on a loop. No canvas / no
// per-frame JS work — the tile sits in the panel grid and shouldn't burn
// cycles.

export function EffectNeonParticlesIcon() {
  const driftName = useMemo(() => 'panel-nps-' + Math.random().toString(36).slice(2, 8), []);
  const pulseName = useMemo(() => 'panel-npp-' + Math.random().toString(36).slice(2, 8), []);
  const linesName = useMemo(() => 'panel-npl-' + Math.random().toString(36).slice(2, 8), []);
  // Particle layout — fixed positions (in %) inside the tile, each with a
  // unique drift offset so they don't move in lockstep. Cyan/magenta palette
  // matches the code component's default neon look.
  const particles = [
    { left: 18, top: 30, color: '#22D3EE', size: 4, dx: 3,  dy: -2, dur: 4.0, delay: 0 },
    { left: 38, top: 65, color: '#A855F7', size: 5, dx: -2, dy: 3,  dur: 4.6, delay: -0.7 },
    { left: 55, top: 22, color: '#22D3EE', size: 3, dx: 2,  dy: 2,  dur: 3.6, delay: -1.4 },
    { left: 72, top: 55, color: '#EC4899', size: 5, dx: -3, dy: -2, dur: 4.3, delay: -2.1 },
    { left: 85, top: 28, color: '#22D3EE', size: 3, dx: 2,  dy: 3,  dur: 3.8, delay: -1.0 },
    { left: 28, top: 78, color: '#A855F7', size: 4, dx: 3,  dy: -2, dur: 4.2, delay: -2.6 },
    { left: 60, top: 80, color: '#22D3EE', size: 3, dx: -2, dy: -3, dur: 3.4, delay: -0.4 },
  ];
  // Connection lines between a few nearby particle indices. Each line fades
  // in and out on its own delay so the "live network" feel reads even at
  // tile size without needing distance-based JS.
  const lines = [
    { a: 0, b: 2, delay: 0.0 },
    { a: 2, b: 4, delay: 0.6 },
    { a: 1, b: 3, delay: 1.2 },
    { a: 3, b: 6, delay: 1.8 },
    { a: 0, b: 1, delay: 2.4 },
  ];
  return (
    <div
      className="relative w-full h-full overflow-hidden rounded-md"
      style={{
        // Deep near-black bg with a subtle radial vignette so the glows
        // pop. Matches the code component's "shows best on dark surfaces" recipe.
        background: 'radial-gradient(circle at 50% 50%, #0b0b1a 0%, #050510 90%)',
      }}
    >
      {/* Connection lines — drawn first so the glowing dots paint OVER
          them. Each line fades on a 3s loop with staggered delays for
          a "network is breathing" effect. */}
      <svg className="absolute inset-0 w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none">
        {lines.map((l, i) => {
          const a = particles[l.a];
          const b = particles[l.b];
          return (
            <line
              key={i}
              x1={a.left} y1={a.top}
              x2={b.left} y2={b.top}
              stroke="#67E8F9"
              strokeWidth="0.3"
              strokeLinecap="round"
              style={{
                opacity: 0,
                animation: linesName + ' 3s ease-in-out infinite',
                animationDelay: l.delay + 's',
              }}
            />
          );
        })}
      </svg>
      {/* Particles — each one drifts in a small loop AND pulses brightness
          independently, so the tile has constant gentle motion. The
          box-shadow halo gives the neon glow. */}
      {particles.map((p, i) => (
        <div
          key={i}
          className="absolute"
          style={{
            left: p.left + '%',
            top: p.top + '%',
            width: p.size, height: p.size,
            marginLeft: -p.size / 2,
            marginTop: -p.size / 2,
            borderRadius: '50%',
            background: p.color,
            boxShadow:
              '0 0 4px ' + p.color +
              ', 0 0 9px ' + p.color + 'cc' +
              ', 0 0 16px ' + p.color + '88',
            animation: driftName + '-' + i + ' ' + p.dur + 's ease-in-out infinite alternate, ' +
                       pulseName + ' ' + (1.8 + i * 0.2) + 's ease-in-out infinite alternate',
            animationDelay: p.delay + 's, 0s',
            willChange: 'transform, opacity',
          }}
        />
      ))}
      <style>{
        particles.map((p, i) =>
          '@keyframes ' + driftName + '-' + i + ' { from { transform: translate(0,0); } to { transform: translate(' + p.dx + 'px, ' + p.dy + 'px); } }'
        ).join(' ') +
        ' @keyframes ' + pulseName + ' { from { opacity: 0.55; } to { opacity: 1; } }' +
        ' @keyframes ' + linesName + ' { 0%, 100% { opacity: 0; } 40%, 60% { opacity: 0.6; } }'
      }</style>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Cursor previews — pixel-faithful ports of the old `revyme-old/builder`
// cursor previews. Each one auto-animates so the tile reads as "this is a
// custom cursor effect" without needing the user to hover it (the real
// code components replace the page cursor on the live site; we communicate that
// behavior with a self-contained loop here).
// ───────────────────────────────────────────────────────────────────────────

// ─── Design Cursor ─────────────────────────────────────────────────────────
// Blue arrow cursor + a "Designer" label that lags behind it. The actual
// code component replaces the mouse pointer and shows a label trailing the cursor;
// here we auto-drift the arrow in a circular path and let the label
// follow with a CSS transition for the "lag" feel.

export function EffectDesignCursorIcon() {
  const driftName = useMemo(() => 'panel-dc-' + Math.random().toString(36).slice(2, 8), []);
  return (
    <div className="relative w-full h-full overflow-hidden rounded-md">
      <div
        className="absolute"
        style={{
          top: '50%', left: '50%',
          width: 0, height: 0,
          animation: driftName + ' 4s ease-in-out infinite',
        }}
      >
        {/* Arrow tip — sits at the parent's (0,0) origin so the parent's
            translate IS the cursor tip position. */}
        <svg viewBox="0 0 14 14" width={14} height={14} style={{ position: 'absolute', top: -2, left: -2, color: '#3B82F6', filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.25))' }}>
          <path fill="currentColor" d="M1.2,1 L1.2,11 L4.3,8.2 L6.4,12.6 L8.2,11.8 L6.1,7.4 L10.2,7.4 Z" />
        </svg>
        {/* "Designer" label — positioned offset from the cursor with a
            slow transition so it visibly lags the arrow's motion. */}
        <div
          style={{
            position: 'absolute',
            top: 12, left: 12,
            padding: '2px 6px',
            borderRadius: 3,
            background: '#3B82F6',
            color: '#fff',
            fontSize: 8,
            fontWeight: 600,
            whiteSpace: 'nowrap',
            boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
            transition: 'transform 0.6s cubic-bezier(0.22, 0.61, 0.36, 1)',
          }}
        >
          Designer
        </div>
      </div>
      <style>{
        '@keyframes ' + driftName + ' { ' +
        '0% { transform: translate(-30px, -8px); } ' +
        '25% { transform: translate(15px, -12px); } ' +
        '50% { transform: translate(25px, 6px); } ' +
        '75% { transform: translate(-10px, 10px); } ' +
        '100% { transform: translate(-30px, -8px); } }'
      }</style>
    </div>
  );
}

// ─── Target Cursor ─────────────────────────────────────────────────────────
// 4 corner brackets + center dot, the whole thing rotates continuously.
// Theme-aware: corners use `currentColor` from a TEXT_COLOR-fed wrapper so
// the cursor reads in both light and dark mode (legacy used hardcoded
// `bg-black dark:bg-white` Tailwind classes; this version is portable
// outside Tailwind).

export function EffectBlobCursorIcon() {
  const driftA = useMemo(() => 'panel-bc-a-' + Math.random().toString(36).slice(2, 8), []);
  const driftB = useMemo(() => 'panel-bc-b-' + Math.random().toString(36).slice(2, 8), []);
  return (
    <div className="relative w-full h-full overflow-hidden flex items-center justify-center">
      {/* Bigger soft blob behind */}
      <div
        className="absolute rounded-full"
        style={{
          width: 36, height: 36,
          background: 'rgba(82, 39, 255, 0.5)',
          filter: 'blur(2px)',
          animation: driftB + ' 3s ease-in-out infinite',
        }}
      />
      {/* Crisp lead blob */}
      <div
        className="absolute rounded-full"
        style={{
          width: 18, height: 18,
          background: '#5227FF',
          boxShadow: '0 0 12px rgba(82, 39, 255, 0.6)',
          animation: driftA + ' 2.4s ease-in-out infinite',
        }}
      />
      <style>{
        '@keyframes ' + driftA + ' { 0%, 100% { transform: translate(0, 0); } 25% { transform: translate(10px, -6px); } 50% { transform: translate(0, 4px); } 75% { transform: translate(-8px, -4px); } } ' +
        '@keyframes ' + driftB + ' { 0%, 100% { transform: translate(0, 0); } 25% { transform: translate(-6px, 4px); } 50% { transform: translate(8px, -4px); } 75% { transform: translate(4px, 6px); } }'
      }</style>
    </div>
  );
}

// ─── Ribbon Cursor ─────────────────────────────────────────────────────────
// Horizontal gradient bar that spins + drifts continuously — same recipe
// the old builder used (single rotated bar with translation in a loop).
// Reads as "trailing ribbon following the cursor."

export function EffectRibbonCursorIcon() {
  const animName = useMemo(() => 'panel-rc-' + Math.random().toString(36).slice(2, 8), []);
  return (
    <div className="relative w-full h-full overflow-hidden flex items-center justify-center">
      <div
        className="absolute"
        style={{
          width: 64, height: 3,
          background: 'linear-gradient(90deg, transparent, #5227FF, transparent)',
          borderRadius: 2,
          animation: animName + ' 3s linear infinite',
          willChange: 'transform',
        }}
      />
      {/* Second ribbon, offset color + reversed timing, to give the "two
          tendrils interacting" feel the actual code component has. */}
      <div
        className="absolute"
        style={{
          width: 48, height: 2,
          background: 'linear-gradient(90deg, transparent, #A855F7, transparent)',
          borderRadius: 2,
          animation: animName + '-b 3.6s linear infinite',
          opacity: 0.7,
          willChange: 'transform',
        }}
      />
      <style>{
        '@keyframes ' + animName + ' { 0% { transform: translate(0,0) rotate(0deg); } 25% { transform: translate(8px,-6px) rotate(90deg); } 50% { transform: translate(0,0) rotate(180deg); } 75% { transform: translate(-8px,6px) rotate(270deg); } 100% { transform: translate(0,0) rotate(360deg); } } ' +
        '@keyframes ' + animName + '-b { 0% { transform: translate(0,0) rotate(0deg); } 100% { transform: translate(0,0) rotate(-360deg); } }'
      }</style>
    </div>
  );
}

// ─── Splash Cursor ─────────────────────────────────────────────────────────
// 5 blurred colored dots orbiting around the center, staggered around the
// circle. Each one orbits in its own loop with its own delay so the splash
// reads as fluid + alive.

export function EffectSplashCursorIcon() {
  const blobs = useMemo(() => {
    const N = 5;
    return Array.from({ length: N }, (_, i) => {
      const angle = (i * 2 * Math.PI) / N;
      const radius = 12;
      return {
        i,
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
        hue: (i * 360) / N,
        dur: 2 + i * 0.2,
        delay: i * 0.15,
      };
    });
  }, []);
  const animPrefix = useMemo(() => 'panel-sc-' + Math.random().toString(36).slice(2, 8), []);
  return (
    <div className="relative w-full h-full overflow-hidden flex items-center justify-center">
      {blobs.map(b => (
        <div
          key={b.i}
          className="absolute rounded-full"
          style={{
            width: 8, height: 8,
            background: 'hsl(' + b.hue + ', 70%, 60%)',
            filter: 'blur(2px)',
            animation: animPrefix + '-' + b.i + ' ' + b.dur + 's ease-in-out infinite',
            animationDelay: b.delay + 's',
            willChange: 'transform, opacity',
          }}
        />
      ))}
      <style>{
        blobs.map(b =>
          '@keyframes ' + animPrefix + '-' + b.i + ' { ' +
          '0%, 100% { transform: translate(0, 0) scale(1); opacity: 0.55; } ' +
          '50% { transform: translate(' + b.x.toFixed(1) + 'px, ' + b.y.toFixed(1) + 'px) scale(1.3); opacity: 1; } }'
        ).join(' ')
      }</style>
    </div>
  );
}

// ─── Theme Toggle ──────────────────────────────────────────────────────────
// Sun ↔ moon crossfade on a continuous loop. Mirrors the code component's behavior:
// click the toggle → cursor swaps between light/dark icons + the pill
// indicator slides between the two ends. The preview auto-cycles every
// 1.6s so the tile communicates "this is interactive" without needing the
// user to actually click it.

export function EffectThemeToggleIcon() {
  // Static — locked on the dark-mode side of the toggle. No animation:
  // the affordance reads as "this is a theme toggle" from the pill shape
  // + moon glyph alone, and a constantly-cycling preview was visual
  // noise the user didn't want in the panel grid.
  return (
    <div className="w-full h-full flex items-center justify-center">
      <div
        style={{
          position: 'relative',
          width: 48, height: 24,
          borderRadius: 12,
          background: '#1f2937',
          boxShadow: 'inset 0 0 0 1px #374151',
        }}
      >
        <div
          style={{
            position: 'absolute',
            top: 2,
            left: 26,
            width: 20, height: 20,
            borderRadius: '50%',
            background: '#e5e7eb',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
          }}
        >
          {/* Moon — crescent SVG. */}
          <svg viewBox="0 0 20 20" width={12} height={12} fill="#1f2937">
            <path d="M14.5 12.5 A 6 6 0 1 1 9 4 a 5 5 0 0 0 5.5 8.5 z" />
          </svg>
        </div>
      </div>
    </div>
  );
}

// ─── Copy Button ───────────────────────────────────────────────────────────
// Static dark pill with the two-overlapping-rects copy glyph + "Copy" label —
// the same read-at-a-glance approach as the Theme Toggle tile: the pill
// shape and glyph alone say "copies something on click", no animation.

export function EffectCopyButtonIcon() {
  return (
    <div className="w-full h-full flex items-center justify-center">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          padding: '0 16px',
          height: 30,
          borderRadius: 15,
          background: '#171a16',
          boxShadow: 'inset 0 0 0 1px #374151',
        }}
      >
        <svg viewBox="0 0 16 16" width={11} height={11} fill="none" stroke="#f7f5ee" strokeWidth={1.6}>
          <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
          <path d="M10.5 3.5v-1a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h1" />
        </svg>
        <span
          style={{
            color: '#f7f5ee',
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: '0.02em',
            fontFamily: "'Helvetica Neue', Arial, sans-serif",
          }}
        >
          Copy
        </span>
      </div>
    </div>
  );
}

// ─── Locale Switcher ───────────────────────────────────────────────────────
// Row of country flags, one highlighted (the "active" locale). The active
// one cycles every 1.4s so the tile reads as interactive. Uses Unicode
// flag emojis — cross-platform, no SVG asset cost; renders crisp at any
// size and inherits the OS's emoji font (Apple emojis on Mac, Segoe UI
// Emoji on Windows, Noto on Linux).

export function EffectLocaleSwitcherIcon() {
  // Static — all flags rendered at full opacity, no cycling "active"
  // state. The row of country flags alone communicates "this is a
  // locale switcher" clearly enough; the dim-and-cycle animation was
  // visual noise without adding affordance.
  const flags = ['🇺🇸', '🇫🇷', '🇩🇪', '🇯🇵'];
  return (
    <div className="w-full h-full flex items-center justify-center">
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        {flags.map((flag, i) => (
          <div
            key={i}
            style={{
              fontSize: 18,
              lineHeight: 1,
              padding: '2px 1px',
            }}
          >
            {flag}
          </div>
        ))}
      </div>
    </div>
  );
}
