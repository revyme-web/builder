// HorizontalScroll — Code component template (connected nodes in a drag-scrollable row).
//
// Multi-slot CONTAINER: `children` is an infinite slot. Connected nodes lay
// out in a horizontal row inside a native `overflow-x` scroller with
// drag-to-scroll and optional scroll-snap. Edge fades are a popup GROUP.

export const HORIZONTAL_SCROLL_COMPONENT = `'use client';

/** @label "Horizontal Scroll" */
/** @comment "A horizontal, drag-scrollable row of connected nodes. Connect canvas nodes as items." */
/** @defaultWidth 600 */
/** @defaultHeight 400 */
/** @controls {
  "children": { "type": "slot", "label": "Items", "slotMax": "infinite" },
  "gap": { "type": "number", "label": "Gap", "min": 0, "max": 160, "step": 4, "default": 24 },
  "padding": { "type": "number", "label": "Padding", "min": 0, "max": 160, "step": 4, "default": 0 },
  "dragSpeed": { "type": "number", "label": "Drag Speed", "min": 0.5, "max": 3, "step": 0.1, "default": 1.5 },
  "snap": { "type": "toggle", "label": "Snap to Items", "default": false },
  "fade": { "type": "group", "label": "Edge Fade", "controls": {
    "fadeEdges": { "type": "toggle", "label": "Fade Edges", "default": false },
    "fadeSize": { "type": "number", "label": "Fade Size", "min": 0, "max": 240, "step": 8, "default": 64 }
  }}
} */

import { useRef, useEffect, Children } from 'react';
import { withResponsiveProps, useStaticCanvas } from '@revyme/runtime';

function HorizontalScroll({
  gap = 24, padding = 0, dragSpeed = 1.5, snap = false,
  fadeEdges = false, fadeSize = 64, children, ...props
}) {
  const scrollRef = useRef(null);
  const isEmpty = Children.count(children) === 0;
  // No drag listeners on the editor canvas (pointer events don't reach it
  // anyway — this just skips registering listeners that can't fire).
  const isStatic = useStaticCanvas();

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    // Iterate DIRECT CHILDREN — querying "[data-canvas-node]" misses
    // user-component-instance children whose DOM root doesn't forward that
    // attribute, leaving them at editor workspace coords (off-screen).
    Array.from(el.children).forEach(function (c) {
      const s = c.style;
      s.position = 'relative';
      s.left = 'auto'; s.top = 'auto'; s.right = 'auto'; s.bottom = 'auto';
      s.margin = '0'; s.flex = '0 0 auto';
      if (snap) s.scrollSnapAlign = 'start';
    });

    // Static (editor canvas) — items render; drag is irrelevant here.
    if (isStatic) return;

    let down = false, startX = 0, startScroll = 0;
    const onDown = function (e) {
      down = true;
      startX = e.pageX;
      startScroll = el.scrollLeft;
      el.style.cursor = 'grabbing';
    };
    const onMove = function (e) {
      if (!down) return;
      e.preventDefault();
      el.scrollLeft = startScroll - (e.pageX - startX) * dragSpeed;
    };
    const onUp = function () {
      down = false;
      el.style.cursor = 'grab';
    };
    el.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);

    return function () {
      el.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [dragSpeed, snap, children, isStatic]);

  if (isEmpty) {
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
          <line x1="3" y1="12" x2="21" y2="12" />
          <polyline points="7 8 3 12 7 16" />
          <polyline points="17 8 21 12 17 16" />
        </svg>
        <div style={{ fontWeight: 700, fontSize: '15px', color: '#e5e5e5' }}>Connect Content</div>
        <div style={{ fontSize: '13px', color: '#8a8a8a' }}>Add items to scroll horizontally</div>
      </div>
    );
  }

  // Clamp via CSS min() — an over-large fadeSize would invert the two #000
  // stops and the mask would collapse to transparent (whole row invisible).
  const safeFade = 'min(' + fadeSize + 'px, calc(50% - 1px))';
  const fadeMask = fadeEdges
    ? 'linear-gradient(to right, transparent, #000 ' + safeFade + ', #000 calc(100% - ' + safeFade + '), transparent)'
    : undefined;

  return (
    <div
      data-id={props['data-id']}
      data-name={props['data-name']}
      style={{
        position: 'relative', ...props.style, overflow: 'hidden',
        maskImage: fadeMask, WebkitMaskImage: fadeMask,
      }}
    >
      <div
        ref={scrollRef}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: gap + 'px',
          padding: padding + 'px',
          width: '100%',
          height: '100%',
          boxSizing: 'border-box',
          overflowX: 'auto',
          overflowY: 'hidden',
          cursor: 'grab',
          scrollbarWidth: 'none',
          msOverflowStyle: 'none',
          WebkitOverflowScrolling: 'touch',
          scrollSnapType: snap ? 'x mandatory' : 'none',
        }}
      >
        {children}
      </div>
    </div>
  );
}

export default withResponsiveProps(HorizontalScroll);
`;
