// HangingCurved — Code component template (text riding a sagging SVG path).
//
// The path is a quadratic bezier spanning the full width of the box with its
// control point pushed below the baseline, so the text hangs like a slack
// cable. Both endpoints are pushed outside the viewBox by a margin, so the
// text enters and leaves off-screen rather than popping at the edges.
//
// The viewBox is sized to the element's real pixel dimensions by a
// ResizeObserver rather than being a fixed constant. That costs one observer
// but means the curve always spans the actual box and the glyphs are never
// distorted by preserveAspectRatio scaling — a fixed viewBox either stretches
// the type or letterboxes it as soon as the user resizes the frame.
//
// Seamless looping: the string is repeated until the repeats cover the real
// path length (measured with getTotalLength(), not guessed), then the running
// offset is wrapped with a single modulo of one repeat's width. Inter-repeat
// spacing uses ordinary spaces held open by xml:space="preserve", which keeps
// the separator adjustable through a normal control.

export const HANGING_CURVED_COMPONENT = `'use client';

/** @label "Hanging Curved" */
/** @comment "Text follows a curved SVG path, scrolls continuously, optionally draggable" */
/** @defaultWidth 600 */
/** @defaultHeight 400 */
/** @controls {
  "text": { "type": "text", "label": "Text", "default": "Hanging Curved Text Demo" },
  "curve": { "type": "number", "label": "Curve", "min": 0, "max": 200, "default": 50, "step": 1 },
  "speed": { "type": "number", "label": "Speed", "min": 0, "max": 10, "default": 2, "step": 0.1 },
  "direction": { "type": "select", "label": "Direction", "default": "left", "options": [{"label":"Left","value":"left"},{"label":"Right","value":"right"}] },
  "draggable": { "type": "toggle", "label": "Draggable", "default": true },
  "gap": { "type": "number", "label": "Gap", "min": 0, "max": 20, "default": 4, "step": 1 },
  "color": { "type": "color", "label": "Color", "default": "#111111" },
  "fontSize": { "type": "number", "label": "Font Size", "min": 12, "max": 200, "default": 48, "step": 1 },
  "fontWeight": { "type": "select", "label": "Weight", "default": "700", "options": [{"label":"Regular","value":"400"},{"label":"Medium","value":"500"},{"label":"Semi Bold","value":"600"},{"label":"Bold","value":"700"},{"label":"Black","value":"900"}] },
  "fontFamily": { "type": "text", "label": "Font", "default": "Inter, sans-serif" }
} */

import { useRef, useEffect, useState, useId } from 'react';
import { withResponsiveProps, useStaticCanvas } from '@revyme/runtime';

function HangingCurved({
  text = 'Hanging Curved Text Demo',
  curve = 50,
  speed = 2,
  direction = 'left',
  draggable = true,
  gap = 4,
  color = '#111111',
  fontSize = 48,
  fontWeight = '700',
  fontFamily = 'Inter, sans-serif',
  ...props
}) {
  const boxRef = useRef(null);
  const svgRef = useRef(null);
  const pathRef = useRef(null);
  const textPathRef = useRef(null);
  const rawId = useId();
  const pathId = 'hangpath-' + String(rawId).replace(/[^a-zA-Z0-9]/g, '');
  const isStatic = useStaticCanvas();

  // Real pixel size drives the viewBox, so the curve spans the actual frame.
  const [box, setBox] = useState({ w: 600, h: 400 });

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    function measure() {
      const r = el.getBoundingClientRect();
      setBox(function (prev) {
        const w = Math.max(1, Math.round(r.width));
        const h = Math.max(1, Math.round(r.height));
        return (prev.w === w && prev.h === h) ? prev : { w: w, h: h };
      });
    }
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return function () { ro.disconnect(); };
  }, []);

  // Endpoints sit outside the box so glyphs never pop in at the edges.
  const margin = Math.max(80, box.w * 0.15);
  const baseline = box.h / 2 - curve / 2;
  const pathD =
    'M' + (-margin) + ',' + baseline +
    ' Q' + (box.w / 2) + ',' + (baseline + curve) +
    ' ' + (box.w + margin) + ',' + baseline;

  const spacer = new Array(Math.max(0, Math.round(gap)) + 1).join(' ');
  const unit = (text && text.length ? text : 'Text') + spacer;

  useEffect(() => {
    const path = pathRef.current;
    const tp = textPathRef.current;
    if (!path || !tp) return;

    let raf = 0;
    let offset = 0;
    let unitWidth = 0;
    let pathLength = 0;

    // Wrap with a modulo of ONE repeat so the seam is always off-path.
    function normalise(value) {
      if (unitWidth <= 0) return 0;
      const m = value % unitWidth;
      return m > 0 ? m - unitWidth : m;
    }

    function commit() {
      tp.setAttribute('startOffset', offset.toFixed(2));
    }

    // Repeat until the copies cover the measured path, plus one spare so the
    // tail is filled while the head is still scrolling in.
    function layout() {
      pathLength = path.getTotalLength();
      tp.textContent = unit;
      unitWidth = tp.getComputedTextLength();
      if (unitWidth <= 0) return false;
      const copies = Math.ceil(pathLength / unitWidth) + 1;
      tp.textContent = new Array(copies + 1).join(unit);
      offset = normalise(offset);
      commit();
      return true;
    }

    // Layout needs the font resolved; a frame's grace avoids measuring
    // against a fallback face and getting the repeat count wrong.
    let ready = false;
    const warmup = requestAnimationFrame(function () {
      ready = layout();
      if (ready && isStatic) {
        offset = normalise(-unitWidth * 0.35);
        commit();
      }
    });

    if (isStatic) {
      return function () { cancelAnimationFrame(warmup); };
    }

    let dragging = false;
    let lastX = 0;
    let momentum = 0;
    let prevTime = 0;

    function tick(now) {
      if (!ready) { raf = requestAnimationFrame(tick); return; }
      const dt = prevTime ? Math.min(64, now - prevTime) : 16;
      prevTime = now;

      if (!dragging) {
        const drift = (direction === 'right' ? 1 : -1) * speed * (dt / 16);
        offset = normalise(offset + drift + momentum * (dt / 16));
        // Released drags coast to a stop rather than halting dead.
        momentum *= 0.94;
        if (Math.abs(momentum) < 0.01) momentum = 0;
        commit();
      }
      raf = requestAnimationFrame(tick);
    }

    function onDown(ev) {
      if (!draggable) return;
      dragging = true;
      momentum = 0;
      lastX = ev.clientX;
      if (ev.target && ev.target.setPointerCapture) {
        try { ev.target.setPointerCapture(ev.pointerId); } catch (e) { /* not capturable */ }
      }
    }
    function onMove(ev) {
      if (!dragging || !ready) return;
      const dx = ev.clientX - lastX;
      lastX = ev.clientX;
      offset = normalise(offset + dx);
      momentum = dx * 0.35;
      commit();
    }
    function onUp() { dragging = false; }

    const svg = svgRef.current;
    if (svg && draggable) {
      svg.addEventListener('pointerdown', onDown);
      svg.addEventListener('pointermove', onMove);
      svg.addEventListener('pointerup', onUp);
      svg.addEventListener('pointercancel', onUp);
    }

    raf = requestAnimationFrame(tick);

    return function () {
      cancelAnimationFrame(warmup);
      cancelAnimationFrame(raf);
      if (svg && draggable) {
        svg.removeEventListener('pointerdown', onDown);
        svg.removeEventListener('pointermove', onMove);
        svg.removeEventListener('pointerup', onUp);
        svg.removeEventListener('pointercancel', onUp);
      }
    };
  }, [unit, pathD, speed, direction, draggable, fontSize, fontWeight, fontFamily, isStatic]);

  return (
    <div
      ref={boxRef}
      data-id={props['data-id']}
      data-name={props['data-name']}
      style={{ position: 'relative', overflow: 'hidden', ...props.style }}
    >
      <svg
        ref={svgRef}
        viewBox={'0 0 ' + box.w + ' ' + box.h}
        width={box.w}
        height={box.h}
        style={{
          position: 'absolute',
          top: '0px',
          left: '0px',
          width: '100%',
          height: '100%',
          display: 'block',
          cursor: draggable ? 'grab' : 'default',
          touchAction: 'pan-y',
        }}
      >
        <defs>
          <path ref={pathRef} id={pathId} d={pathD} fill="none" />
        </defs>
        <text
          xmlSpace="preserve"
          fill={color}
          style={{
            fontSize: fontSize + 'px',
            fontWeight: fontWeight,
            fontFamily: fontFamily,
            userSelect: 'none',
          }}
        >
          <textPath ref={textPathRef} href={'#' + pathId} xlinkHref={'#' + pathId} startOffset="0" />
        </text>
      </svg>
    </div>
  );
}

export default withResponsiveProps(HangingCurved);
`;
