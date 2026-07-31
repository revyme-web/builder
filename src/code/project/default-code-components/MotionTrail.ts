// MotionTrail — Code component template (connected nodes stamped as a cursor trail).
//
// Multi-slot CONTAINER: `children` is an infinite slot. The connected nodes
// live in an invisible source pool; as the cursor moves across the box past
// each spacing threshold, a STAMP is added to a React state list — each
// stamp is a real React mount of the connected node (no DOM cloneNode), so
// connected component instances keep their handlers + state. Stamps fade
// out and unmount on timeout. Stamps are pointer-events:none (decorative).

export const MOTION_TRAIL_COMPONENT = `'use client';

/** @label "Motion Trail" */
/** @comment "Connected nodes are stamped along the cursor as a fading trail on hover. Connect canvas nodes as trail items." */
/** @defaultWidth 600 */
/** @defaultHeight 400 */
/** @controls {
  "children": { "type": "slot", "label": "Trail Items", "slotMax": "infinite" },
  "threshold": { "type": "number", "label": "Spacing", "min": 20, "max": 240, "step": 10, "default": 70 },
  "rotate": { "type": "toggle", "label": "Rotate to Motion", "default": false },
  "fade": { "type": "group", "label": "Fade", "controls": {
    "fadeMs": { "type": "number", "label": "Duration", "min": 200, "max": 1600, "step": 50, "default": 700 },
    "fadeScale": { "type": "number", "label": "End Scale", "min": 0, "max": 1.5, "step": 0.1, "default": 0.3 }
  }}
} */

import { useRef, useEffect, useState, Children, cloneElement, isValidElement } from 'react';
import { withResponsiveProps, useStaticCanvas } from '@revyme/runtime';

// One trail stamp — its own React mount of the source item, with a CSS
// transition from (scale 1, opacity 1) to (scale fadeScale, opacity 0).
function TrailStamp({ x, y, angle, src, fadeMs, fadeScale, rotate }) {
  const [exited, setExited] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(function () { setExited(true); });
    return function () { cancelAnimationFrame(id); };
  }, []);
  const rot = rotate ? ' rotate(' + angle + 'deg)' : '';
  return (
    <div style={{
      position: 'absolute', left: 0, top: 0, margin: 0,
      pointerEvents: 'none',
      transition: 'opacity ' + fadeMs + 'ms ease-out, transform ' + fadeMs + 'ms ease-out',
      transform: 'translate(-50%,-50%) translate(' + x + 'px,' + y + 'px) scale(' + (exited ? fadeScale : 1) + ')' + rot,
      opacity: exited ? 0 : 1,
    }}>
      {src}
    </div>
  );
}

function MotionTrail({ threshold = 70, rotate = false, fadeMs = 700, fadeScale = 0.3, children, ...props }) {
  const boxRef = useRef(null);
  const poolRef = useRef(null);
  const items = Children.toArray(children);
  const isEmpty = items.length === 0;
  const isStatic = useStaticCanvas();
  // Live trail stamps — React state list, each one a real component mount.
  const [stamps, setStamps] = useState([]);
  const idRef = useRef(0);

  useEffect(() => {
    const pool = poolRef.current;
    if (!pool) return;
    // Neutralise every direct child of the pool (catches user-component
    // instances too — they don't forward data-canvas-node to their DOM root).
    Array.from(pool.children).forEach(function (c) {
      const s = c.style;
      s.position = 'relative';
      s.left = 'auto'; s.top = 'auto'; s.right = 'auto'; s.bottom = 'auto';
      s.margin = '0';
    });
  }, [children]);

  useEffect(() => {
    if (isStatic) return;
    if (items.length === 0) return;
    const box = boxRef.current;
    if (!box) return;

    let lastX = 0, lastY = 0, primed = false, idx = 0;
    const timeouts = [];

    function onMove(ev) {
      const r = box.getBoundingClientRect();
      const x = ev.clientX - r.left, y = ev.clientY - r.top;
      if (!primed) { lastX = x; lastY = y; primed = true; return; }
      const dx = x - lastX, dy = y - lastY;
      if (Math.sqrt(dx * dx + dy * dy) >= threshold) {
        const angle = Math.atan2(dy, dx) * (180 / Math.PI);
        lastX = x; lastY = y;
        idRef.current++;
        const id = idRef.current;
        const srcIdx = idx % items.length;
        idx++;
        setStamps(function (prev) { return prev.concat([{ id: id, x: x, y: y, angle: angle, srcIdx: srcIdx }]); });
        const t = setTimeout(function () {
          setStamps(function (prev) { return prev.filter(function (s) { return s.id !== id; }); });
        }, fadeMs + 80);
        timeouts.push(t);
      }
    }

    box.addEventListener('mousemove', onMove);
    return function () {
      box.removeEventListener('mousemove', onMove);
      timeouts.forEach(function (t) { clearTimeout(t); });
    };
  }, [threshold, fadeMs, fadeScale, rotate, items, isStatic]);

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
          <circle cx="5" cy="13" r="1.4" />
          <circle cx="11" cy="11.5" r="2.1" />
          <circle cx="18" cy="9.5" r="3" />
        </svg>
        <div style={{ fontWeight: 700, fontSize: '15px', color: '#e5e5e5' }}>Connect Content</div>
        <div style={{ fontSize: '13px', color: '#8a8a8a' }}>Add items to trail the cursor</div>
      </div>
    );
  }

  return (
    <div
      ref={boxRef}
      data-id={props['data-id']}
      data-name={props['data-name']}
      style={{ position: 'relative', ...props.style, overflow: 'hidden' }}
    >
      {/* Source pool — invisible on live (only stamps render). On the
          static editor canvas it's a centred, visible preview. */}
      <div
        ref={poolRef}
        style={isStatic ? {
          position: 'absolute', inset: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexWrap: 'wrap', gap: '12px',
          pointerEvents: 'none',
        } : {
          position: 'absolute', left: 0, top: 0, opacity: 0, pointerEvents: 'none',
        }}
      >
        {children}
      </div>

      {/* Live trail — each stamp is a real React mount; component instances
          inside keep their state, though the stamp wrapper is
          pointer-events:none (the trail is decorative). */}
      {!isStatic && stamps.map(function (stamp) {
        const src = items[stamp.srcIdx];
        const cleaned = isValidElement(src)
          ? cloneElement(src, { 'data-id': undefined, 'data-canvas-node': undefined, 'data-name': undefined })
          : src;
        return (
          <TrailStamp
            key={stamp.id}
            x={stamp.x} y={stamp.y} angle={stamp.angle}
            src={cleaned}
            fadeMs={fadeMs} fadeScale={fadeScale} rotate={rotate}
          />
        );
      })}
    </div>
  );
}

export default withResponsiveProps(MotionTrail);
`;
