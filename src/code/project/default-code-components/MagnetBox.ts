// MagnetBox — Code component template (a container whose content is pulled toward the cursor).
//
// Like LensBox this is a slot-based CONTAINER: the `children` control is
// declared `type: "slot"`, so the canvas shows a connection outlet and the
// connected canvas node renders here as a real JSX child. On the live site
// it is plain React: `<MagnetBox>{connectedNode}</MagnetBox>`.
//
// The pull: the offset from the box centre to the cursor is scaled by
// `strength` and applied as a translate on an inner wrapper (never on the
// connected child itself, whose own transform belongs to the user). A rAF
// lerp eases toward the target so the motion is rubbery rather than
// locked to the pointer, and releases back to centre on leave.
//
// `radius` decides how far outside the box the pull still registers, so the
// content starts leaning toward the cursor before it arrives — that
// anticipation is most of why the effect reads as magnetic.

export const MAGNET_BOX_COMPONENT = `'use client';

/** @label "Magnet Box" */
/** @comment "A container that pulls its content toward the cursor. Connect a canvas node into it." */
/** @defaultWidth 400 */
/** @defaultHeight 300 */
/** @controls {
  "children": { "type": "slot", "label": "Content", "slotMax": 1 },
  "strength": { "type": "number", "label": "Strength", "min": 0, "max": 1, "step": 0.05, "default": 0.35 },
  "range": { "type": "number", "label": "Range", "min": 0, "max": 600, "step": 10, "default": 180, "unit": "px" },
  "easing": { "type": "number", "label": "Smoothing", "min": 0.05, "max": 1, "step": 0.05, "default": 0.15 },
  "rotate": { "type": "number", "label": "Tilt", "min": 0, "max": 20, "step": 1, "default": 0, "unit": "deg" }
} */

import { useRef, useEffect, Children } from 'react';
import { withResponsiveProps, useStaticCanvas } from '@revyme/runtime';

function MagnetBox({
  strength = 0.35,
  range = 180,
  easing = 0.15,
  rotate = 0,
  children,
  ...props
}) {
  const boxRef = useRef(null);
  const pullRef = useRef(null);
  const isStatic = useStaticCanvas();
  const isEmpty = Children.count(children) === 0;

  useEffect(() => {
    const box = boxRef.current;
    const pull = pullRef.current;
    if (!box || !pull) return;

    // Connected slot children carry editor canvas-workspace positioning
    // (position:absolute + large left/top). Neutralise EVERY direct child —
    // not just [data-canvas-node] — because a child that's a user component
    // instance doesn't forward that attribute to its DOM root, so it'd be
    // missed and stuck at workspace coords (off-screen).
    Array.from(pull.children).forEach(function (c) {
      const cs = c.style;
      cs.position = 'relative';
      cs.left = 'auto';
      cs.top = 'auto';
      cs.right = 'auto';
      cs.bottom = 'auto';
      cs.margin = '0';
    });

    // Editor canvas: there is no live cursor to react to, and the resting
    // pose (content centred, untransformed) is exactly what the still should
    // show — so wire nothing and never start the loop.
    if (isStatic) {
      pull.style.transform = 'none';
      return;
    }

    let targetX = 0;
    let targetY = 0;
    let curX = 0;
    let curY = 0;
    let raf = 0;
    let running = false;

    function tick() {
      const dx = targetX - curX;
      const dy = targetY - curY;
      if (Math.abs(dx) < 0.05 && Math.abs(dy) < 0.05) {
        curX = targetX;
        curY = targetY;
        running = false;
      } else {
        curX += dx * easing;
        curY += dy * easing;
      }

      let t = 'translate(' + curX.toFixed(2) + 'px, ' + curY.toFixed(2) + 'px)';
      if (rotate > 0) {
        // Tilt tracks horizontal displacement so the content banks into the pull.
        const span = Math.max(1, range * strength);
        const deg = Math.max(-1, Math.min(1, curX / span)) * rotate;
        t += ' rotate(' + deg.toFixed(2) + 'deg)';
      }
      pull.style.transform = t;

      if (running) raf = requestAnimationFrame(tick);
    }

    function wake() {
      if (!running) {
        running = true;
        raf = requestAnimationFrame(tick);
      }
    }

    function onMove(ev) {
      const r = box.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const dx = ev.clientX - cx;
      const dy = ev.clientY - cy;

      // Outside the range the pull decays to nothing rather than cutting off.
      const dist = Math.sqrt(dx * dx + dy * dy);
      const reach = range + Math.max(r.width, r.height) / 2;
      const falloff = reach <= 0 ? 0 : Math.max(0, 1 - dist / reach);

      targetX = dx * strength * falloff;
      targetY = dy * strength * falloff;
      wake();
    }

    function onLeaveWindow() {
      targetX = 0;
      targetY = 0;
      wake();
    }

    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerout', onLeaveWindow);

    return function () {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerout', onLeaveWindow);
      cancelAnimationFrame(raf);
    };
  }, [strength, range, easing, rotate, children, isStatic]);

  // Nothing connected — show a placeholder telling the user to wire content
  // (shown anywhere the box is empty).
  if (isEmpty) {
    return (
      <div
        data-id={props['data-id']}
        data-name={props['data-name']}
        style={{
          position: 'relative',
          overflow: 'hidden',
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '8px',
          padding: '20px',
          textAlign: 'center',
          background: '#141414',
          border: '1px dashed rgba(255,255,255,0.14)',
          ...props.style,
        }}
      >
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none"
          stroke="#F59E0B" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 4v7a6 6 0 0 0 12 0V4" />
          <line x1="3" y1="4" x2="9" y2="4" />
          <line x1="15" y1="4" x2="21" y2="4" />
        </svg>
        <div style={{ fontWeight: 700, fontSize: '15px', color: '#e5e5e5' }}>
          Connect Content
        </div>
        <div style={{ fontSize: '13px', color: '#8a8a8a' }}>
          Add content to use the magnet effect
        </div>
      </div>
    );
  }

  return (
    <div
      ref={boxRef}
      data-id={props['data-id']}
      data-name={props['data-name']}
      style={{ position: 'relative', ...props.style }}
    >
      <div
        ref={pullRef}
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          willChange: 'transform',
        }}
      >
        {children}
      </div>
    </div>
  );
}

export default withResponsiveProps(MagnetBox);
`;
