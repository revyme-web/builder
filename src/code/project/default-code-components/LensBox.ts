// LensBox — Code component template (a container with a magnifying-lens hover effect).
//
// THIRD-PARTY: the magnifier itself — the radial-gradient circular mask
// tracking the cursor over a scaled clone of the content — derives from
// Magic UI's "Lens" (https://github.com/magicuidesign/magicui), MIT, which
// is in turn adapted from Aceternity UI. Attribution is repeated inside the
// template literal so it travels into projects this component is inserted
// into. See also the NOTICE file.
//
// Port of the old builder's `lensBoxJS` customCode effect into a Revyme
// code-component. Unlike the leaf shaders, LensBox is a CONTAINER: it
// renders `{children}` and applies a cursor-following magnifier over them.
//
// Children are connected via the code-component SLOT system — the
// `children` control is declared `type: "slot"`, so the canvas shows a
// connection outlet and the connected canvas node(s) render here as real
// JSX children (see `@controls` below). On the live site this is plain
// React: `<LensBox>{connectedNode}</LensBox>`.
//
// When nothing is connected, an empty LensBox renders a "Connect Content"
// placeholder (shown anywhere it's empty — canvas, code-editor preview).

export const LENS_BOX_COMPONENT = `'use client';

// Lens/magnifier effect derived from Magic UI's "Lens"
// (https://github.com/magicuidesign/magicui), itself adapted from
// Aceternity UI. Copyright (c) Magic UI — MIT License.
// The full MIT permission notice is reproduced in the Revyme NOTICE file.

/** @label "Lens Box" */
/** @comment "A container with a magnifying lens that follows the cursor on hover. Connect a canvas node into it." */
/** @defaultWidth 600 */
/** @defaultHeight 400 */
/** @controls {
  "children": { "type": "slot", "label": "Content", "slotMax": 1 },
  "zoomFactor": { "type": "number", "label": "Zoom", "min": 1.1, "max": 3, "step": 0.1, "default": 1.5 },
  "lensSize": { "type": "number", "label": "Lens Size", "min": 50, "max": 500, "step": 10, "default": 170 }
} */

import { useRef, useEffect, Children } from 'react';
import { withResponsiveProps } from '@revyme/runtime';

function LensBox({ zoomFactor = 1.5, lensSize = 170, children, ...props }) {
  const boxRef = useRef(null);
  const contentRef = useRef(null);
  const isEmpty = Children.count(children) === 0;

  useEffect(() => {
    const box = boxRef.current;
    const content = contentRef.current;
    if (!box || !content) return;

    // Connected slot children carry editor canvas-workspace positioning
    // (position:absolute + large left/top). Neutralise EVERY direct child
    // — not just [data-canvas-node] — because a child that's a user
    // component instance doesn't forward that attribute to its DOM root,
    // so it'd be missed and stuck at workspace coords (off-screen).
    Array.from(content.children).forEach(function (c) {
      const cs = c.style;
      cs.position = 'relative';
      cs.left = 'auto';
      cs.top = 'auto';
      cs.right = 'auto';
      cs.bottom = 'auto';
      cs.margin = '0';
    });

    // A zoomed clone of the content, revealed through a circular mask
    // that tracks the cursor — the magnifying lens.
    const overlay = document.createElement('div');
    overlay.style.cssText =
      'position:absolute;inset:0;z-index:50;pointer-events:none;overflow:hidden;opacity:0;transition:opacity 0.15s ease;';

    const zoomed = document.createElement('div');
    zoomed.style.cssText = 'position:absolute;inset:0;';
    zoomed.style.transform = 'scale(' + zoomFactor + ')';
    zoomed.appendChild(content.cloneNode(true));
    overlay.appendChild(zoomed);
    box.appendChild(overlay);

    function onEnter() { overlay.style.opacity = '1'; }
    function onLeave() { overlay.style.opacity = '0'; }
    function onMove(ev) {
      const rect = box.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;
      const r = lensSize / 2;
      const mask = 'radial-gradient(circle ' + r + 'px at ' + x + 'px ' + y + 'px, #000 100%, transparent 100%)';
      overlay.style.maskImage = mask;
      overlay.style.webkitMaskImage = mask;
      zoomed.style.transformOrigin = x + 'px ' + y + 'px';
    }

    box.addEventListener('mouseenter', onEnter);
    box.addEventListener('mouseleave', onLeave);
    box.addEventListener('mousemove', onMove);

    return function () {
      box.removeEventListener('mouseenter', onEnter);
      box.removeEventListener('mouseleave', onLeave);
      box.removeEventListener('mousemove', onMove);
      overlay.remove();
    };
  }, [zoomFactor, lensSize, children]);

  // Nothing connected — show a placeholder telling the user to wire
  // content (shown anywhere the box is empty).
  if (isEmpty) {
    return (
      <div
        data-id={props['data-id']}
        data-name={props['data-name']}
        style={{
          // 'relative' is only a DEFAULT — the user's own position
          // (e.g. absolute) wins; it just guarantees a positioning
          // context for the lens overlay when nothing is set.
          position: 'relative',
          ...props.style,
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
        }}
      >
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none"
          stroke="#A855F7" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="7" />
          <line x1="21" y1="21" x2="16.5" y2="16.5" />
        </svg>
        <div style={{ fontWeight: 700, fontSize: '15px', color: '#e5e5e5' }}>
          Connect Content
        </div>
        <div style={{ fontSize: '13px', color: '#8a8a8a' }}>
          Add content to use the lens effect
        </div>
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
      <div
        ref={contentRef}
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {children}
      </div>
    </div>
  );
}

export default withResponsiveProps(LensBox);
`;
