// DesignCursor — Code component template. 1:1 port of the old builder's
// `designCursorJS` (code-snippet-configs.ts:869-976). Custom arrow cursor
// + label badge that follows with spring physics (via framer-motion's
// `animate` API loaded from esm.sh — same dependency the old builder
// used at runtime).
//
// Architecture: region hotspot. NO slot, NO children. The wrapper IS the
// cursor zone — on enter the OS cursor hides (`cursor: none` on the
// wrapper itself), the arrow snaps to the cursor, and the label springs
// in to its configured offset position. On move, the arrow snaps and the
// label springs to follow. On leave, both fade out and the OS cursor
// returns.
//
// External dep: `framer-motion` from esm.sh, fetched once on mount. If
// the network is unreachable the effect simply doesn't activate (the
// useEffect handles the import failure silently — no crash).

export const DESIGN_CURSOR_COMPONENT = `'use client';

/** @label "Design Cursor" */
/** @comment "Custom arrow cursor with a spring-physics label follower. Hover inside the box to see it." */
/** @defaultWidth 600 */
/** @defaultHeight 400 */
/** @controls {
  "align": { "type": "select", "label": "Align", "default": "top-right", "options": [{ "label": "Top Right", "value": "top-right" }, { "label": "Top Left", "value": "top-left" }, { "label": "Bottom Right", "value": "bottom-right" }, { "label": "Bottom Left", "value": "bottom-left" }, { "label": "Top", "value": "top" }, { "label": "Bottom", "value": "bottom" }, { "label": "Left", "value": "left" }, { "label": "Right", "value": "right" }] },
  "sideOffset": { "type": "number", "label": "Side Offset", "min": 0, "max": 50, "step": 1, "default": 15 },
  "stiffness": { "type": "number", "label": "Stiffness", "min": 100, "max": 1000, "step": 50, "default": 500 },
  "damping": { "type": "number", "label": "Damping", "min": 10, "max": 100, "step": 5, "default": 50 },
  "mass": { "type": "number", "label": "Mass", "min": 0.1, "max": 5, "step": 0.1, "default": 1 },
  "labelText": { "type": "text", "label": "Label", "default": "Designer" },
  "labelTextFontSize": { "type": "number", "label": "Font Size", "min": 8, "max": 32, "step": 1, "default": 14 },
  "labelTextColor": { "type": "color", "label": "Text Color", "default": "#ffffff" },
  "cursorColor": { "type": "color", "label": "Cursor Color", "default": "#3b82f6" },
  "labelColor": { "type": "color", "label": "Label Color", "default": "#3b82f6" },
  "cursorSize": { "type": "number", "label": "Cursor Size", "min": 12, "max": 64, "step": 1, "default": 24 }
} */

import { useRef, useEffect } from 'react';
import { withResponsiveProps, useStaticCanvas } from '@revyme/runtime';

function DesignCursor({
  align = 'top-right',
  sideOffset = 15,
  stiffness = 500,
  damping = 50,
  mass = 1,
  labelText = 'Designer',
  labelTextFontSize = 14,
  labelTextColor = '#ffffff',
  cursorColor = '#3b82f6',
  labelColor = '#3b82f6',
  cursorSize = 24,
  ...props
}) {
  const boxRef = useRef(null);
  const isStatic = useStaticCanvas();

  useEffect(() => {
    if (isStatic) return;
    const container = boxRef.current;
    if (!container) return;

    container.style.position = container.style.position || 'relative';
    container.style.overflow = 'hidden';

    // Offset of the label relative to the cursor tip, based on the
    // 9-way align selector. Same switch the old builder used.
    let followOffset;
    switch (align) {
      case 'top-right':    followOffset = { x: sideOffset, y: -sideOffset }; break;
      case 'top-left':     followOffset = { x: -sideOffset, y: -sideOffset }; break;
      case 'bottom-right': followOffset = { x: sideOffset, y: sideOffset }; break;
      case 'bottom-left':  followOffset = { x: -sideOffset, y: sideOffset }; break;
      case 'top':          followOffset = { x: 0, y: -sideOffset }; break;
      case 'bottom':       followOffset = { x: 0, y: sideOffset }; break;
      case 'left':         followOffset = { x: -sideOffset, y: 0 }; break;
      case 'right':        followOffset = { x: sideOffset, y: 0 }; break;
      default:             followOffset = { x: sideOffset, y: sideOffset };
    }

    const cursorEl = document.createElement('div');
    cursorEl.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;z-index:9999;will-change:transform;opacity:0;';
    cursorEl.innerHTML = '<svg width="' + cursorSize + '" height="' + cursorSize + '" viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg"><path fill="' + cursorColor + '" d="M1.8 4.4 7 36.2c.3 1.8 2.6 2.3 3.6.8l3.9-5.7c1.7-2.5 4.5-4.1 7.5-4.3l6.9-.5c1.8-.1 2.5-2.4 1.1-3.5L5 2.5c-1.4-1.1-3.5 0-3.3 1.9Z"/></svg>';
    container.appendChild(cursorEl);

    const labelEl = document.createElement('div');
    labelEl.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;z-index:9999;will-change:transform;opacity:0;white-space:nowrap;';
    const padV = Math.max(4, labelTextFontSize / 4);
    const padH = Math.max(8, labelTextFontSize / 2);
    labelEl.innerHTML = '<div style="background:' + labelColor + ';color:' + labelTextColor + ';font-size:' + labelTextFontSize + 'px;font-family:system-ui,-apple-system,sans-serif;padding:' + padV + 'px ' + padH + 'px;border-radius:8px;box-shadow:0 10px 15px -3px rgb(0 0 0/0.1);font-weight:500;line-height:1.2;">' + labelText + '</div>';
    container.appendChild(labelEl);

    let mouseX = 0, mouseY = 0;
    let labelX = 0, labelY = 0;
    let xAnim = null, yAnim = null;
    let cancelled = false;
    let onMove = null, onEnter = null, onLeave = null;

    // framer-motion's animate API drives the spring on the label
    // independently of the arrow (which snaps without easing).
    //
    // Bypass static analysis — the live site's bundler (Next.js / Vite)
    // would otherwise parse \`import('https://...')\` at build time and
    // strip or fail it. The editor preview already uses this same trick
    // in code-component-runtime.ts.
    const dynamicImport = new Function('s', 'return import(s)');
    dynamicImport('https://esm.sh/framer-motion').then(function (mod) {
      if (cancelled) return;
      const animate = mod.animate;

      function animateLabel(tx, ty) {
        if (xAnim) xAnim.stop();
        if (yAnim) yAnim.stop();
        xAnim = animate(labelX, tx, {
          type: 'spring', stiffness: stiffness, damping: damping, mass: mass,
          onUpdate: function (v) { labelX = v; labelEl.style.transform = 'translate3d(' + labelX + 'px,' + labelY + 'px,0)'; },
        });
        yAnim = animate(labelY, ty, {
          type: 'spring', stiffness: stiffness, damping: damping, mass: mass,
          onUpdate: function (v) { labelY = v; labelEl.style.transform = 'translate3d(' + labelX + 'px,' + labelY + 'px,0)'; },
        });
      }

      onMove = function (e) {
        const rect = container.getBoundingClientRect();
        mouseX = e.clientX - rect.left;
        mouseY = e.clientY - rect.top;
        cursorEl.style.transform = 'translate3d(' + mouseX + 'px,' + mouseY + 'px,0)';
        animateLabel(mouseX + followOffset.x, mouseY + followOffset.y);
      };
      onEnter = function (e) {
        container.style.cursor = 'none';
        const rect = container.getBoundingClientRect();
        mouseX = e.clientX - rect.left;
        mouseY = e.clientY - rect.top;
        labelX = mouseX + followOffset.x;
        labelY = mouseY + followOffset.y;
        cursorEl.style.transform = 'translate3d(' + mouseX + 'px,' + mouseY + 'px,0)';
        labelEl.style.transform = 'translate3d(' + labelX + 'px,' + labelY + 'px,0)';
        cursorEl.style.opacity = '1';
        labelEl.style.opacity = '1';
      };
      onLeave = function () {
        container.style.cursor = '';
        cursorEl.style.opacity = '0';
        labelEl.style.opacity = '0';
      };

      container.addEventListener('mousemove', onMove);
      container.addEventListener('mouseenter', onEnter);
      container.addEventListener('mouseleave', onLeave);
    }).catch(function () { /* esm.sh unreachable — silently no-op */ });

    return function () {
      cancelled = true;
      if (xAnim) xAnim.stop();
      if (yAnim) yAnim.stop();
      if (onMove) container.removeEventListener('mousemove', onMove);
      if (onEnter) container.removeEventListener('mouseenter', onEnter);
      if (onLeave) container.removeEventListener('mouseleave', onLeave);
      container.style.cursor = '';
      if (cursorEl.parentNode) cursorEl.parentNode.removeChild(cursorEl);
      if (labelEl.parentNode) labelEl.parentNode.removeChild(labelEl);
    };
  }, [
    isStatic, align, sideOffset, stiffness, damping, mass,
    labelText, labelTextFontSize, labelTextColor,
    cursorColor, labelColor, cursorSize,
  ]);

  if (isStatic) {
    return (
      <div
        ref={boxRef}
        data-id={props['data-id']}
        data-name={props['data-name']}
        style={{
          position: 'relative',
          ...props.style,
          background: 'transparent',
          border: '1px dashed ' + cursorColor + '80',
          boxSizing: 'border-box',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          pointerEvents: 'none',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, opacity: 0.85 }}>
          <svg viewBox="0 0 40 40" width="22" height="22" style={{ filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.18))' }}>
            <path fill={cursorColor} d="M1.8 4.4 7 36.2c.3 1.8 2.6 2.3 3.6.8l3.9-5.7c1.7-2.5 4.5-4.1 7.5-4.3l6.9-.5c1.8-.1 2.5-2.4 1.1-3.5L5 2.5c-1.4-1.1-3.5 0-3.3 1.9Z" />
          </svg>
          <div style={{ fontSize: 11, fontWeight: 600, color: cursorColor }}>Design Cursor</div>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={boxRef}
      data-id={props['data-id']}
      data-name={props['data-name']}
      style={{ position: 'relative', overflow: 'hidden', ...props.style }}
    />
  );
}

export default withResponsiveProps(DesignCursor);
`;
