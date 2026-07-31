// Marquee3D — Code component template (connected nodes in a tilted, scrolling 3D grid).
//
// Multi-slot CONTAINER: `children` is an infinite slot. Connected nodes are
// distributed round-robin into N columns inside a `preserve-3d` box; the
// tilt (rotateX/Y/Z + perspective) is a popup GROUP. Each column's items
// are rendered MULTIPLE TIMES via React (not DOM cloneNode), so connected
// component instances stay interactive — clicks reach their handlers.

export const MARQUEE_3D_COMPONENT = `'use client';

/** @label "3D Marquee" */
/** @comment "Connected nodes laid out in a tilted 3D grid, columns scrolling in alternating directions. Connect canvas nodes as items." */
/** @defaultWidth 600 */
/** @defaultHeight 400 */
/** @controls {
  "children": { "type": "slot", "label": "Items", "slotMax": "infinite" },
  "speed": { "type": "number", "label": "Speed", "min": 4, "max": 40, "step": 2, "default": 16 },
  "gap": { "type": "number", "label": "Gap", "min": 0, "max": 80, "step": 4, "default": 24 },
  "columns": { "type": "number", "label": "Columns", "min": 2, "max": 6, "step": 1, "default": 4 },
  "tilt": { "type": "group", "label": "Tilt", "controls": {
    "tiltX": { "type": "number", "label": "Tilt X", "min": 0, "max": 75, "step": 5, "default": 50 },
    "tiltY": { "type": "number", "label": "Tilt Y", "min": -45, "max": 45, "step": 5, "default": 0 },
    "tiltZ": { "type": "number", "label": "Tilt Z", "min": -60, "max": 60, "step": 5, "default": -40 },
    "perspective": { "type": "number", "label": "Perspective", "min": 400, "max": 3000, "step": 100, "default": 1400 }
  }}
} */

import { useRef, useEffect, useState, useLayoutEffect, Children, cloneElement, isValidElement } from 'react';
import { withResponsiveProps, useStaticCanvas } from '@revyme/runtime';

function Marquee3D({
  speed = 16, gap = 24, columns = 4,
  tiltX = 50, tiltY = 0, tiltZ = -40, perspective = 1400,
  children, ...props
}) {
  const stageRef = useRef(null);
  const items = Children.toArray(children);
  const isEmpty = items.length === 0;
  const colCount = Math.max(2, Math.min(6, Math.round(columns)));
  const isStatic = useStaticCanvas();
  // Per-column copy count — like Marquee, render copies in React (not
  // cloneNode) so connected component instances stay interactive.
  const [copies, setCopies] = useState(isStatic ? 1 : 3);

  // Round-robin the connected nodes across the columns.
  const cols = [];
  for (let i = 0; i < colCount; i++) cols.push([]);
  items.forEach(function (c, i) { cols[i % colCount].push(c); });

  // Measure column inner — bump copies so column height >= stage height + one.
  useLayoutEffect(() => {
    if (isStatic) return;
    const stage = stageRef.current;
    if (!stage) return;
    const firstCol = stage.querySelector('[data-mq3d-col]');
    const firstInner = firstCol && firstCol.firstElementChild;
    if (!firstInner) return;
    const stageH = stage.clientHeight;
    const innerH = firstInner.offsetHeight + gap;
    if (innerH <= 0) return;
    const needed = Math.min(30, Math.max(2, Math.ceil(stageH / innerH) + 1));
    if (needed !== copies) setCopies(needed);
  }, [isStatic, children, gap, colCount, copies]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    // Neutralise every connected child across every column / copy.
    const columnEls = Array.from(stage.querySelectorAll('[data-mq3d-col]'));
    columnEls.forEach(function (col) {
      Array.from(col.children).forEach(function (inner) {
        Array.from(inner.children).forEach(function (c) {
          const s = c.style;
          s.position = 'relative';
          s.left = 'auto'; s.top = 'auto'; s.right = 'auto'; s.bottom = 'auto';
          s.margin = '0';
        });
      });
    });

    if (isStatic) return;

    const rafs = [];
    columnEls.forEach(function (col, ci) {
      const firstInner = col.firstElementChild;
      if (!firstInner) return;
      const span = firstInner.offsetHeight + gap;
      const dir = ci % 2 === 0 ? -1 : 1;
      let off = dir === 1 ? -span : 0;
      let last = performance.now();
      function tick(now) {
        const dt = (now - last) / 1000;
        last = now;
        if (span > 0) {
          off += dir * (span / speed) * dt;
          if (off <= -span) off += span;
          if (off >= 0) off -= span;
          col.style.transform = 'translateY(' + off + 'px)';
        }
        rafs[ci] = requestAnimationFrame(tick);
      }
      rafs[ci] = requestAnimationFrame(tick);
    });

    return function () {
      rafs.forEach(function (r) { cancelAnimationFrame(r); });
      columnEls.forEach(function (col) { col.style.transform = ''; });
    };
  }, [speed, gap, colCount, children, copies, isStatic]);

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
          <rect x="8" y="3" width="13" height="13" rx="1.5" />
          <rect x="3" y="8" width="13" height="13" rx="1.5" />
        </svg>
        <div style={{ fontWeight: 700, fontSize: '15px', color: '#e5e5e5' }}>Connect Content</div>
        <div style={{ fontSize: '13px', color: '#8a8a8a' }}>Add items to the 3D marquee grid</div>
      </div>
    );
  }

  return (
    <div
      data-id={props['data-id']}
      data-name={props['data-name']}
      style={{ position: 'relative', ...props.style, overflow: 'hidden', perspective: perspective + 'px' }}
    >
      <div
        ref={stageRef}
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'flex-start',
          gap: gap + 'px',
          transform: 'rotateX(' + tiltX + 'deg) rotateY(' + tiltY + 'deg) rotateZ(' + tiltZ + 'deg)',
          transformStyle: 'preserve-3d',
        }}
      >
        {cols.map(function (col, ci) {
          return (
            <div
              key={ci}
              data-mq3d-col="true"
              style={{ display: 'flex', flexDirection: 'column', gap: gap + 'px', willChange: 'transform' }}
            >
              {Array.from({ length: copies }).map(function (_, copyIdx) {
                return (
                  <div key={copyIdx} aria-hidden={copyIdx > 0 ? 'true' : undefined}
                    style={{ display: 'flex', flexDirection: 'column', gap: gap + 'px' }}>
                    {col.map(function (item, i) {
                      if (copyIdx === 0) return item;
                      if (!isValidElement(item)) return item;
                      return cloneElement(item, {
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
          );
        })}
      </div>
    </div>
  );
}

export default withResponsiveProps(Marquee3D);
`;
