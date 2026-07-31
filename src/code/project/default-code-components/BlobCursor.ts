// BlobCursor — Code component template (gooey blob trail following the cursor).
//
// Architecture: region hotspot. NO slot, NO children. The wrapper's bounding
// box IS the active zone, and the whole thing is `pointer-events: none` so it
// can sit over real content without swallowing clicks.
//
// The goo: N circles chase the cursor, each with a progressively weaker
// follow factor, so they string out into a tail. An SVG filter on the parent
// blurs the group and then pushes alpha through a steep ramp
// (feColorMatrix on the A channel with a large multiplier and negative
// offset). Blurred edges that overlap sum above the cut-off and fuse into a
// single silhouette; isolated faint edges fall below it and vanish. That
// blur-then-threshold pair is what turns discrete circles into one
// metaball-ish blob.
//
// The filter id is per-instance (useId) — a hardcoded id would collide when
// two BlobCursors are placed on the same page and both would resolve to the
// first definition.

export const BLOB_CURSOR_COMPONENT = `'use client';

/** @label "Blob Cursor" */
/** @comment "A gooey blob trail that follows the cursor inside this region." */
/** @defaultWidth 600 */
/** @defaultHeight 400 */
/** @controls {
  "blobCount": { "type": "number", "label": "Blobs", "min": 2, "max": 12, "step": 1, "default": 6 },
  "blobSize": { "type": "number", "label": "Size", "min": 10, "max": 160, "step": 2, "default": 56, "unit": "px" },
  "taper": { "type": "number", "label": "Taper", "min": 0, "max": 0.9, "step": 0.05, "default": 0.45 },
  "follow": { "type": "number", "label": "Follow Speed", "min": 0.05, "max": 1, "step": 0.05, "default": 0.35 },
  "colorHead": { "type": "color", "label": "Head Color", "default": "#a855f7" },
  "colorTail": { "type": "color", "label": "Tail Color", "default": "#5227ff" },
  "gooiness": { "type": "number", "label": "Gooiness", "min": 2, "max": 20, "step": 1, "default": 10 }
} */

import { useEffect, useRef, useId } from 'react';
import { withResponsiveProps, useStaticCanvas } from '@revyme/runtime';

function BlobCursor({
  blobCount = 6,
  blobSize = 56,
  taper = 0.45,
  follow = 0.35,
  colorHead = '#a855f7',
  colorTail = '#5227ff',
  gooiness = 10,
  ...props
}) {
  const boxRef = useRef(null);
  const rawId = useId();
  const filterId = 'blobgoo-' + String(rawId).replace(/[^a-zA-Z0-9]/g, '');
  const isStatic = useStaticCanvas();

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;

    const blobs = Array.from(box.querySelectorAll('[data-blob]'));
    if (blobs.length === 0) return;

    // Chain state: blob 0 chases the cursor, blob N chases blob N-1.
    const pos = blobs.map(function () { return { x: 0, y: 0 }; });
    let cursor = { x: 0, y: 0 };
    let seeded = false;

    function place() {
      for (let i = 0; i < blobs.length; i++) {
        const size = blobSize * (1 - taper * (i / Math.max(1, blobs.length - 1)));
        blobs[i].style.width = size.toFixed(1) + 'px';
        blobs[i].style.height = size.toFixed(1) + 'px';
        blobs[i].style.transform =
          'translate(' + (pos[i].x - size / 2).toFixed(2) + 'px, ' +
          (pos[i].y - size / 2).toFixed(2) + 'px)';
      }
    }

    function settle(x, y) {
      for (let i = 0; i < pos.length; i++) { pos[i].x = x; pos[i].y = y; }
    }

    // Editor canvas: lay the chain out along a diagonal so the still shows a
    // recognisable tail instead of every blob stacked at the origin.
    if (isStatic) {
      const r = box.getBoundingClientRect();
      for (let i = 0; i < pos.length; i++) {
        const t = i / Math.max(1, pos.length - 1);
        pos[i].x = r.width * (0.62 - 0.24 * t);
        pos[i].y = r.height * (0.38 + 0.22 * t);
      }
      place();
      return;
    }

    let raf = 0;

    function tick() {
      let head = cursor;
      for (let i = 0; i < pos.length; i++) {
        // Each link is slightly lazier than the one before it.
        const k = follow * (1 - 0.06 * i);
        pos[i].x += (head.x - pos[i].x) * Math.max(0.02, k);
        pos[i].y += (head.y - pos[i].y) * Math.max(0.02, k);
        head = pos[i];
      }
      place();
      raf = requestAnimationFrame(tick);
    }

    function onMove(ev) {
      const r = box.getBoundingClientRect();
      cursor = { x: ev.clientX - r.left, y: ev.clientY - r.top };
      if (!seeded) { settle(cursor.x, cursor.y); seeded = true; }
    }

    // Window-level so the trail is already in position when the cursor
    // crosses into the region, rather than whipping in from the corner.
    window.addEventListener('pointermove', onMove, { passive: true });
    raf = requestAnimationFrame(tick);

    return function () {
      window.removeEventListener('pointermove', onMove);
      cancelAnimationFrame(raf);
    };
  }, [blobCount, blobSize, taper, follow, gooiness, isStatic]);

  const blobs = [];
  for (let i = 0; i < Math.max(2, blobCount); i++) blobs.push(i);
  const lastIndex = Math.max(1, blobs.length - 1);

  return (
    <div
      data-id={props['data-id']}
      data-name={props['data-name']}
      ref={boxRef}
      style={{
        position: 'relative',
        overflow: 'hidden',
        pointerEvents: 'none',
        ...props.style,
      }}
    >
      <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
        <defs>
          <filter id={filterId}>
            <feGaussianBlur in="SourceGraphic" stdDeviation={gooiness} result="soft" />
            <feColorMatrix
              in="soft"
              type="matrix"
              values={'1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 ' + (gooiness * 2.4).toFixed(1) + ' -' + (gooiness * 1.1).toFixed(1)}
            />
          </filter>
        </defs>
      </svg>

      <div style={{ position: 'absolute', inset: 0, filter: 'url(#' + filterId + ')' }}>
        {blobs.map(function (i) {
          const t = i / lastIndex;
          return (
            <div
              key={i}
              data-blob=""
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                borderRadius: '50%',
                background: i === 0 ? colorHead : colorTail,
                opacity: 1 - 0.25 * t,
                willChange: 'transform',
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

export default withResponsiveProps(BlobCursor);
`;
