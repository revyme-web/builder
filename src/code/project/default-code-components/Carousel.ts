// Carousel — Code component template (one connected node at a time, with slide nav).
//
// Multi-slot CONTAINER: `children` is an infinite slot — each connected
// canvas node is one slide. Built on framer-motion so the slide change can
// honour a real Motion transition (Spring / Ease / Instant) chosen via the
// `transition` control. Granular controls organised into popup GROUPS
// (Effects / Arrows / Dots) via the @controls `group` type.
//
// Sizing uses CSS percentages — the track is `count×100%` wide, each slide
// is `100/count%`, translated by index. No JS measurement, so it renders
// identically on the editor canvas and the live site.

export const CAROUSEL_COMPONENT = `'use client';

/** @label "Carousel" */
/** @comment "A slideshow of connected nodes with arrows, dots, autoplay and a Motion transition. Connect canvas nodes as slides." */
/** @defaultWidth 600 */
/** @defaultHeight 400 */
/** @controls {
  "children": { "type": "slot", "label": "Slides", "slotMax": "infinite" },
  "direction": { "type": "select", "label": "Direction", "default": "horizontal", "options": [
    { "label": "Horizontal", "value": "horizontal" },
    { "label": "Vertical", "value": "vertical" }
  ]},
  "autoplay": { "type": "toggle", "label": "Auto Play", "default": true },
  "interval": { "type": "number", "label": "Interval", "min": 1, "max": 12, "step": 0.5, "default": 4 },
  "loop": { "type": "toggle", "label": "Loop", "default": true },
  "pauseOnHover": { "type": "toggle", "label": "Pause on Hover", "default": true },
  "padding": { "type": "number", "label": "Padding", "min": 0, "max": 120, "step": 4, "default": 0 },
  "radius": { "type": "number", "label": "Radius", "min": 0, "max": 80, "step": 2, "default": 0 },
  "transitionConfig": { "type": "transition", "label": "Transition", "default": { "type": "spring", "stiffness": "200", "damping": "30", "mass": "1" } },
  "effects": { "type": "group", "label": "Effects", "controls": {
    "effectOpacity": { "type": "number", "label": "Opacity", "min": 0, "max": 1, "step": 0.05, "default": 1 },
    "effectScale": { "type": "number", "label": "Scale", "min": 0.4, "max": 1, "step": 0.05, "default": 1 },
    "effectRotate": { "type": "number", "label": "Rotate", "min": -90, "max": 90, "step": 5, "default": 0 },
    "effectPerspective": { "type": "number", "label": "Perspective", "min": 200, "max": 3000, "step": 100, "default": 1200 }
  }},
  "arrows": { "type": "group", "label": "Arrows", "controls": {
    "arrowsShow": { "type": "toggle", "label": "Show", "default": true },
    "arrowsFill": { "type": "color", "label": "Fill", "default": "rgba(0,0,0,0.45)" },
    "arrowsColor": { "type": "color", "label": "Icon", "default": "#ffffff" },
    "arrowsSize": { "type": "number", "label": "Size", "min": 20, "max": 72, "step": 2, "default": 36 },
    "arrowsRadius": { "type": "number", "label": "Radius", "min": 0, "max": 50, "step": 2, "default": 50 }
  }},
  "dots": { "type": "group", "label": "Dots", "controls": {
    "dotsShow": { "type": "toggle", "label": "Show", "default": true },
    "dotsSize": { "type": "number", "label": "Size", "min": 4, "max": 24, "step": 1, "default": 8 },
    "dotsGap": { "type": "number", "label": "Gap", "min": 2, "max": 24, "step": 1, "default": 8 },
    "dotsColor": { "type": "color", "label": "Fill", "default": "rgba(255,255,255,0.4)" },
    "dotsActiveColor": { "type": "color", "label": "Active", "default": "#ffffff" }
  }}
} */

import { useRef, useEffect, useState, Children } from 'react';
import { motion } from 'framer-motion';
import { withResponsiveProps, useStaticCanvas } from '@revyme/runtime';

// Convert a stored transition object into a framer-motion transition.
function toMotionTransition(raw) {
  let cfg = raw;
  if (typeof raw === 'string') {
    try { cfg = JSON.parse(raw); } catch (e) { cfg = null; }
  }
  if (!cfg || typeof cfg !== 'object') return { type: 'spring', stiffness: 200, damping: 30, mass: 1 };
  if (cfg.type === 'instant') return { duration: 0 };
  if (cfg.type === 'spring') {
    if (cfg.stiffness != null) {
      return { type: 'spring', stiffness: Number(cfg.stiffness), damping: Number(cfg.damping), mass: Number(cfg.mass || 1), delay: Number(cfg.delay || 0) };
    }
    return { type: 'spring', duration: Number(cfg.duration || 0.5), bounce: Number(cfg.bounce || 0.25), delay: Number(cfg.delay || 0) };
  }
  let ease = cfg.ease || 'easeInOut';
  if (typeof ease === 'string' && ease.charAt(0) === '[') {
    try { ease = JSON.parse(ease); } catch (e) { ease = 'easeInOut'; }
  }
  return { type: 'tween', duration: Number(cfg.duration || 0.45), ease: ease, delay: Number(cfg.delay || 0) };
}

function Carousel({
  direction = 'horizontal', autoplay = true, interval = 4, loop = true,
  pauseOnHover = true, padding = 0, radius = 0,
  transitionConfig = '{"type":"spring","stiffness":"200","damping":"30","mass":"1"}',
  effectOpacity = 1, effectScale = 1, effectRotate = 0, effectPerspective = 1200,
  arrowsShow = true, arrowsFill = 'rgba(0,0,0,0.45)', arrowsColor = '#ffffff',
  arrowsSize = 36, arrowsRadius = 50,
  dotsShow = true, dotsSize = 8, dotsGap = 8,
  dotsColor = 'rgba(255,255,255,0.4)', dotsActiveColor = '#ffffff',
  children, ...props
}) {
  const vertical = direction === 'vertical';
  const slides = Children.toArray(children);
  const count = slides.length;
  const [index, setIndex] = useState(0);
  const trackRef = useRef(null);
  const pausedRef = useRef(false);
  const transition = toMotionTransition(transitionConfig);
  // No autoplay on the editor canvas — index stays at 0 and framer-motion
  // doesn't animate (initial = animate), so slides sit still.
  const isStatic = useStaticCanvas();

  // Neutralise connected canvas-node positioning so each slide centres.
  // Walk each slide wrapper's first child (which IS the connected node)
  // instead of querying "[data-canvas-node]" — a user-component instance
  // doesn't forward that attribute to its rendered DOM, so the query
  // would miss it on live and the slide would sit at workspace coords.
  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    Array.from(track.children).forEach(function (slide) {
      const c = slide.firstElementChild;
      if (!c) return;
      const s = c.style;
      s.position = 'relative';
      s.left = 'auto'; s.top = 'auto'; s.right = 'auto'; s.bottom = 'auto';
      s.margin = '0';
    });
  }, [children]);

  // Autoplay — advances one slide every "interval" seconds (paused on hover).
  // Skipped on the editor canvas (isStatic) so the slideshow doesn't loop.
  useEffect(() => {
    if (isStatic || !autoplay || count < 2) return;
    const id = setInterval(function () {
      if (pausedRef.current) return;
      setIndex(function (i) { return (i + 1) % count; });
    }, interval * 1000);
    return function () { clearInterval(id); };
  }, [autoplay, interval, count, isStatic]);

  if (count === 0) {
    return (
      <div
        data-id={props['data-id']}
        data-name={props['data-name']}
        style={{
          position: 'relative', ...props.style, boxSizing: 'border-box',
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center', gap: '8px', padding: '20px', textAlign: 'center',
          background: '#141414', border: '1px dashed rgba(255,255,255,0.14)',
        }}
      >
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#A855F7"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="6" width="13" height="12" rx="1.5" />
          <line x1="19" y1="9" x2="19" y2="15" />
          <line x1="22" y1="11" x2="22" y2="13" />
        </svg>
        <div style={{ fontWeight: 700, fontSize: '15px', color: '#e5e5e5' }}>Connect Content</div>
        <div style={{ fontSize: '13px', color: '#8a8a8a' }}>Add slides to the carousel</div>
      </div>
    );
  }

  const go = function (i) {
    setIndex(loop ? ((i % count) + count) % count : Math.max(0, Math.min(count - 1, i)));
  };
  // Percentage-based sizing — track is N×100% of the box, each slide is
  // 100/N% of the track (= exactly one box). Translating the track by
  // -index*(100/N)% advances one slide. No JS measurement needed.
  const slidePct = 100 / count;
  const trackOffset = '-' + (index * slidePct) + '%';

  const arrowStyle = function (side) {
    const base = {
      position: 'absolute', zIndex: 3, cursor: 'pointer', border: 'none',
      width: arrowsSize + 'px', height: arrowsSize + 'px',
      borderRadius: arrowsRadius + '%',
      background: arrowsFill, color: arrowsColor,
      fontSize: Math.round(arrowsSize * 0.52) + 'px', lineHeight: '1',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    };
    if (vertical) {
      base.left = '50%';
      base.transform = 'translateX(-50%)';
      if (side === 'prev') base.top = '12px'; else base.bottom = '12px';
    } else {
      base.top = '50%';
      base.transform = 'translateY(-50%)';
      if (side === 'prev') base.left = '12px'; else base.right = '12px';
    }
    return base;
  };

  return (
    <div
      data-id={props['data-id']}
      data-name={props['data-name']}
      style={{ position: 'relative', ...props.style, overflow: 'hidden', borderRadius: radius + 'px', boxSizing: 'border-box', padding: padding + 'px' }}
      onMouseEnter={() => (pausedRef.current = pauseOnHover)}
      onMouseLeave={() => (pausedRef.current = false)}
    >
      <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden', borderRadius: radius + 'px', perspective: effectPerspective + 'px' }}>
        <motion.div
          ref={trackRef}
          animate={vertical ? { y: trackOffset } : { x: trackOffset }}
          transition={transition}
          style={{
            display: 'flex',
            flexDirection: vertical ? 'column' : 'row',
            width: vertical ? '100%' : (count * 100) + '%',
            height: vertical ? (count * 100) + '%' : '100%',
          }}
        >
          {slides.map(function (slide, i) {
            const active = i === index;
            return (
              <motion.div
                key={i}
                animate={{
                  opacity: active ? 1 : effectOpacity,
                  scale: active ? 1 : effectScale,
                  rotateY: vertical ? 0 : (active ? 0 : effectRotate),
                  rotateX: vertical ? (active ? 0 : effectRotate) : 0,
                }}
                transition={transition}
                style={{
                  flex: '0 0 auto',
                  width: vertical ? '100%' : slidePct + '%',
                  height: vertical ? slidePct + '%' : '100%',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
              >
                {slide}
              </motion.div>
            );
          })}
        </motion.div>
      </div>

      {arrowsShow && count > 1 && (
        <>
          <button onClick={() => go(index - 1)} style={arrowStyle('prev')} aria-label="Previous">
            {vertical ? '\\u2303' : '\\u2039'}
          </button>
          <button onClick={() => go(index + 1)} style={arrowStyle('next')} aria-label="Next">
            {vertical ? '\\u2304' : '\\u203A'}
          </button>
        </>
      )}

      {dotsShow && count > 1 && (
        <div style={{
          position: 'absolute', zIndex: 3, display: 'flex', gap: dotsGap + 'px',
          flexDirection: vertical ? 'column' : 'row',
          bottom: vertical ? 'auto' : '12px',
          top: vertical ? '50%' : 'auto',
          right: vertical ? '12px' : 'auto',
          left: vertical ? 'auto' : '50%',
          transform: vertical ? 'translateY(-50%)' : 'translateX(-50%)',
        }}>
          {slides.map(function (_, i) {
            return (
              <button
                key={i}
                onClick={() => go(i)}
                aria-label={'Go to slide ' + (i + 1)}
                style={{
                  width: dotsSize + 'px', height: dotsSize + 'px', borderRadius: '50%',
                  border: 'none', padding: 0, cursor: 'pointer',
                  background: i === index ? dotsActiveColor : dotsColor,
                }}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

export default withResponsiveProps(Carousel);
`;
