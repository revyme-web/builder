// RibbonMarquee — Code component template (connected nodes flowing along a curved path).
//
// Multi-slot CONTAINER: `children` is an infinite slot. Each connected node
// rides a CSS `offset-path` and travels along it, auto-rotating to the path
// tangent. A rAF advances every item's `offset-distance`. The path SHAPE is
// pickable (wave / arch / hills) and ends can fade out.

export const RIBBON_MARQUEE_COMPONENT = `'use client';

/** @label "Path Marquee" */
/** @comment "Connected nodes flow along a curved path, auto-rotating to follow it. Connect canvas nodes as items." */
/** @defaultWidth 600 */
/** @defaultHeight 400 */
/** @controls {
  "children": { "type": "slot", "label": "Items", "slotMax": "infinite" },
  "speed": { "type": "number", "label": "Speed", "min": 2, "max": 30, "step": 1, "default": 9 },
  "direction": { "type": "select", "label": "Direction", "default": "forward", "options": [
    { "label": "Forward", "value": "forward" },
    { "label": "Reverse", "value": "reverse" }
  ]},
  "pathStyle": { "type": "select", "label": "Path", "default": "wave", "options": [
    { "label": "Wave", "value": "wave" },
    { "label": "Arch", "value": "arch" },
    { "label": "Hills", "value": "hills" }
  ]},
  "fadeEnds": { "type": "toggle", "label": "Fade Ends", "default": false }
} */

import { useRef, useEffect, Children } from 'react';
import { withResponsiveProps, useStaticCanvas } from '@revyme/runtime';

function ribbonPath(style, W, H) {
  if (style === 'arch') {
    return 'M0,' + (H * 0.85) + ' Q' + (W * 0.5) + ',' + (-H * 0.1) + ' ' + W + ',' + (H * 0.85);
  }
  if (style === 'hills') {
    return 'M0,' + (H * 0.6) +
      ' C' + (W * 0.18) + ',' + (H * 0.15) + ' ' + (W * 0.32) + ',' + (H * 0.15) + ' ' + (W * 0.5) + ',' + (H * 0.6) +
      ' C' + (W * 0.68) + ',' + (H * 1.05) + ' ' + (W * 0.82) + ',' + (H * 1.05) + ' ' + W + ',' + (H * 0.6);
  }
  // wave — a double-S
  return 'M0,' + (H / 2) +
    ' C' + (W * 0.25) + ',0 ' + (W * 0.25) + ',' + H + ' ' + (W * 0.5) + ',' + (H / 2) +
    ' C' + (W * 0.75) + ',0 ' + (W * 0.75) + ',' + H + ' ' + W + ',' + (H / 2);
}

function RibbonMarquee({ speed = 9, direction = 'forward', pathStyle = 'wave', fadeEnds = false, children, ...props }) {
  const boxRef = useRef(null);
  const items = Children.toArray(children);
  const isEmpty = items.length === 0;
  // No flow on the editor canvas — items sit at evenly-spaced offsets.
  const isStatic = useStaticCanvas();

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;

    // Neutralise the connected child INSIDE each ribbon-item wrapper —
    // each wrapper holds exactly one connected canvas node. Querying
    // "[data-canvas-node]" would miss user-component instances (their DOM
    // root doesn't carry that attribute), so reach via the wrapper.
    const els = Array.from(box.querySelectorAll('[data-ribbon-item]'));
    els.forEach(function (wrap) {
      const c = wrap.firstElementChild;
      if (!c) return;
      const s = c.style;
      s.position = 'relative';
      s.left = 'auto'; s.top = 'auto'; s.right = 'auto'; s.bottom = 'auto';
      s.margin = '0';
    });
    const n = els.length;
    if (n === 0) return;

    const path = ribbonPath(pathStyle, box.offsetWidth, box.offsetHeight);
    els.forEach(function (el, i) {
      el.style.offsetPath = "path('" + path + "')";
      el.style.offsetRotate = 'auto';
      // Place items at even offsets immediately — so they're visibly
      // spaced along the path on the very first frame, both on the static
      // canvas and on live (before the first rAF tick runs). Without this
      // the live render briefly overlaps all items at distance 0 (the
      // path's starting point), which can look like "nothing rendered".
      el.style.offsetDistance = ((i * 100) / n) + '%';
    });
    if (isStatic) {
      return function () {
        els.forEach(function (el) {
          el.style.offsetPath = '';
          el.style.offsetDistance = '';
          el.style.offsetRotate = '';
        });
      };
    }

    const dir = direction === 'reverse' ? -1 : 1;
    let base = 0;
    let last = performance.now();
    let raf = 0;
    function tick(now) {
      const dt = (now - last) / 1000;
      last = now;
      base = (base + dir * (100 / speed) * dt) % 100;
      for (let i = 0; i < n; i++) {
        let d = (base + (i * 100) / n) % 100;
        if (d < 0) d += 100;
        els[i].style.offsetDistance = d + '%';
        if (fadeEnds) {
          els[i].style.opacity = String(d < 15 ? d / 15 : d > 85 ? (100 - d) / 15 : 1);
        }
      }
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);

    return function () {
      cancelAnimationFrame(raf);
      els.forEach(function (el) {
        el.style.offsetPath = '';
        el.style.offsetDistance = '';
        el.style.offsetRotate = '';
        el.style.opacity = '';
      });
    };
  }, [speed, direction, pathStyle, fadeEnds, children, isStatic]);

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
          <path d="M2 12 C6 4 10 4 12 12 C14 20 18 20 22 12" />
        </svg>
        <div style={{ fontWeight: 700, fontSize: '15px', color: '#e5e5e5' }}>Connect Content</div>
        <div style={{ fontSize: '13px', color: '#8a8a8a' }}>Add items to ride the ribbon path</div>
      </div>
    );
  }

  return (
    <div
      data-id={props['data-id']}
      data-name={props['data-name']}
      style={{ position: 'relative',  overflow: 'hidden', ...props.style }}
    >
      <div ref={boxRef} style={{ position: 'absolute', inset: 0 }}>
        {items.map(function (item, i) {
          return (
            <div key={i} data-ribbon-item="true" style={{ position: 'absolute', left: 0, top: 0 }}>
              {item}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default withResponsiveProps(RibbonMarquee);
`;
