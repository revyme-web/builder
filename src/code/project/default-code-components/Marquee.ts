// Marquee — Code component template (a continuously-scrolling strip of connected nodes).
//
// Multi-slot CONTAINER: `children` is an infinite slot. Items scroll
// horizontally or vertically in a seamless loop. The set is rendered MULTIPLE
// TIMES via React (not DOM `cloneNode`) — every copy is a real React mount,
// so connected component instances keep their own state + click handlers and
// you can interact with the components inside the marquee. A rAF translates
// the track; the count of copies is measured to ensure 2× box coverage.

export const MARQUEE_COMPONENT = `'use client';

/** @label "Marquee" */
/** @comment "A strip of connected nodes that scrolls continuously in a seamless loop. Connect canvas nodes as items." */
/** @defaultWidth 600 */
/** @defaultHeight 400 */
/** @controls {
  "children": { "type": "slot", "label": "Items", "slotMax": "infinite" },
  "speed": { "type": "number", "label": "Speed", "min": 10, "max": 300, "step": 10, "default": 60 },
  "direction": { "type": "select", "label": "Direction", "default": "left", "options": [
    { "label": "Left", "value": "left" },
    { "label": "Right", "value": "right" },
    { "label": "Up", "value": "up" },
    { "label": "Down", "value": "down" }
  ]},
  "gap": { "type": "number", "label": "Gap", "min": 0, "max": 160, "step": 4, "default": 32 },
  "pauseOnHover": { "type": "toggle", "label": "Pause on Hover", "default": true },
  "draggable": { "type": "toggle", "label": "Draggable", "default": false },
  "fade": { "type": "group", "label": "Edge Fade", "controls": {
    "fadeEdges": { "type": "toggle", "label": "Fade Edges", "default": false },
    "fadeSize": { "type": "number", "label": "Fade Size", "min": 0, "max": 240, "step": 8, "default": 64 }
  }}
} */

import { useRef, useEffect, useState, useLayoutEffect, Children, cloneElement, isValidElement } from 'react';
import { withResponsiveProps, useStaticCanvas } from '@revyme/runtime';

function Marquee({
  speed = 60, direction = 'left', gap = 32, pauseOnHover = true,
  draggable = false, fadeEdges = false, fadeSize = 64, children, ...props
}) {
  const boxRef = useRef(null);
  const trackRef = useRef(null);
  const setRef = useRef(null);
  const isEmpty = Children.count(children) === 0;
  const vertical = direction === 'up' || direction === 'down';
  const isStatic = useStaticCanvas();
  // Count of times the set is rendered. On the static canvas one is enough
  // (no loop). On live we measure and bump up to cover at least 2× the box.
  const [copies, setCopies] = useState(isStatic ? 1 : 4);

  // Measure after layout — bump copies so total content >= box×2 + one set.
  useLayoutEffect(() => {
    if (isStatic) return;
    const box = boxRef.current, set = setRef.current;
    if (!box || !set) return;
    const sizeProp = vertical ? 'offsetHeight' : 'offsetWidth';
    const boxSize = box[sizeProp], setSize = set[sizeProp];
    if (setSize <= 0) return;
    const needed = Math.min(40, Math.max(2, Math.ceil(boxSize / setSize) + 1));
    if (needed !== copies) setCopies(needed);
  }, [vertical, isStatic, children, copies]);

  useEffect(() => {
    const box = boxRef.current, track = trackRef.current, set = setRef.current;
    if (!box || !track || !set) return;

    // Neutralise every direct child of EVERY set copy (each copy is a real
    // React mount of the connected children — they all carry editor
    // workspace positioning until DOM-patched). Iterate direct children
    // instead of querying "[data-canvas-node]" so user-component instances
    // (which don't forward that attr) are caught too.
    Array.from(track.children).forEach(function (oneSet) {
      Array.from(oneSet.children).forEach(function (c) {
        const s = c.style;
        s.position = 'relative';
        s.left = 'auto'; s.top = 'auto'; s.right = 'auto'; s.bottom = 'auto';
        s.margin = '0'; s.flex = '0 0 auto';
      });
    });

    // Static (editor canvas) — no rAF, no listeners, no drag.
    if (isStatic) return;

    const sizeProp = vertical ? 'offsetHeight' : 'offsetWidth';
    const span = set[sizeProp];
    const sign = (direction === 'right' || direction === 'down') ? 1 : -1;
    let offset = sign === 1 ? -span : 0;
    let last = performance.now();
    let paused = false, dragging = false, raf = 0;
    const apply = function () {
      track.style.transform = vertical
        ? 'translateY(' + offset + 'px)'
        : 'translateX(' + offset + 'px)';
    };
    function tick(now) {
      const dt = (now - last) / 1000;
      last = now;
      if (!paused && !dragging && span > 0) {
        offset += sign * speed * dt;
        if (offset <= -span) offset += span;
        if (offset >= 0) offset -= span;
        apply();
      }
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);

    const enter = function () { if (pauseOnHover) paused = true; };
    const leave = function () { paused = false; };
    box.addEventListener('mouseenter', enter);
    box.addEventListener('mouseleave', leave);

    let down = false, startPos = 0, startOffset = 0;
    const onDown = function (e) {
      if (!draggable) return;
      down = true; dragging = true;
      startPos = vertical ? e.clientY : e.clientX;
      startOffset = offset;
    };
    const onMove = function (e) {
      if (!down || span <= 0) return;
      offset = startOffset + ((vertical ? e.clientY : e.clientX) - startPos);
      while (offset <= -span) offset += span;
      while (offset >= 0) offset -= span;
      apply();
    };
    const onUp = function () { down = false; dragging = false; };
    if (draggable) {
      box.addEventListener('pointerdown', onDown);
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    }

    return function () {
      cancelAnimationFrame(raf);
      box.removeEventListener('mouseenter', enter);
      box.removeEventListener('mouseleave', leave);
      box.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      track.style.transform = '';
    };
  }, [speed, direction, gap, pauseOnHover, draggable, children, copies, isStatic]);

  if (isEmpty) {
    return (
      <div
        data-id={props['data-id']}
        data-name={props['data-name']}
        style={{
          position: 'relative',  boxSizing: 'border-box',
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center', gap: '8px', padding: '20px', textAlign: 'center',
          background: '#141414', border: '1px dashed rgba(255,255,255,0.14)', ...props.style }}
      >
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#A855F7"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="3" y1="12" x2="20" y2="12" />
          <polyline points="14 6 20 12 14 18" />
        </svg>
        <div style={{ fontWeight: 700, fontSize: '15px', color: '#e5e5e5' }}>Connect Content</div>
        <div style={{ fontSize: '13px', color: '#8a8a8a' }}>Add items to scroll in the marquee</div>
      </div>
    );
  }

  const safeFade = 'min(' + fadeSize + 'px, calc(50% - 1px))';
  const fadeMask = fadeEdges
    ? 'linear-gradient(' + (vertical ? 'to bottom' : 'to right') +
      ', transparent, #000 ' + safeFade + ', #000 calc(100% - ' + safeFade + '), transparent)'
    : undefined;

  const setStyle = {
    display: 'flex', flexDirection: vertical ? 'column' : 'row', alignItems: 'center',
    gap: gap + 'px',
    paddingRight: vertical ? 0 : gap + 'px',
    paddingBottom: vertical ? gap + 'px' : 0,
    flex: '0 0 auto',
  };

  return (
    <div
      ref={boxRef}
      data-id={props['data-id']}
      data-name={props['data-name']}
      style={{
        position: 'relative',  overflow: 'hidden',
        display: 'flex', alignItems: 'center',
        justifyContent: vertical ? 'center' : 'flex-start',
        cursor: draggable ? 'grab' : 'default',
        maskImage: fadeMask, WebkitMaskImage: fadeMask, ...props.style }}
    >
      <div
        ref={trackRef}
        style={{ display: 'flex', flexDirection: vertical ? 'column' : 'row', alignItems: 'center', willChange: 'transform' }}
      >
        {Array.from({ length: copies }).map(function (_, copyIdx) {
          // The FIRST copy is the original — keeps the slot's children
          // verbatim, holds the setRef and the data-set marker. Later copies
          // are React-cloned (real mounts, real handlers), with the editor
          // identifying attributes stripped so duplicates don't pollute the
          // DOM. Each copy is independently interactive — clicking a
          // component instance inside any copy triggers ITS variants.
          if (copyIdx === 0) {
            return (
              <div key="orig" ref={setRef} data-set="true" style={setStyle}>
                {children}
              </div>
            );
          }
          return (
            <div key={copyIdx} aria-hidden="true" style={setStyle}>
              {Children.map(children, function (child, i) {
                if (!isValidElement(child)) return child;
                return cloneElement(child, {
                  key: copyIdx + ':' + i,
                  'data-id': undefined,
                  'data-canvas-node': undefined,
                  'data-name': undefined,
                });
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default withResponsiveProps(Marquee);
`;
