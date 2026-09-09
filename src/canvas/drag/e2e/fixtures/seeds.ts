// E2E seed pages. These are minimal but realistic JSX trees we can drag
// against. Each seed sets only `app/page.tsx` — every other file is
// supplied by `createDefaultProject` at boot, so the seeds stay short.
//
// localStorage key is `revyme-project-local` (see local-backend.ts).
// Format must match `ProjectData`: `{ format: 'revyme-v1', files: { ... } }`.
// (Legacy 'canvas-poc-v1' blobs are still accepted on read — see
//  src/backend/types.ts and the coverage in local-backend.test.ts.)

// Inline type — matches `@/backend/types` ProjectData shape.
// Inlined so Playwright's ts compilation doesn't need src path alias resolution.
type ProjectData = {
  format: 'revyme-v1';
  files: Record<string, string>;
};

function project(pageTsx: string): ProjectData {
  // Pages ship as a PAIR since the server/client split: `page.tsx` is the
  // server wrapper (metadata host), `page.client.tsx` is the canvas-editable
  // body the editor opens (activeFilePathAtom defaults to it). Mirrors
  // PAGE_SERVER_WRAPPER in code/project/project-fs.ts.
  const serverWrapper = `import PageClient from './page.client';

export const metadata = {};

export default function Page() {
  return <PageClient />;
}
`;
  return {
    format: 'revyme-v1',
    files: {
      'app/page.tsx': serverWrapper,
      'app/page.client.tsx': pageTsx,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// FLEX_COLUMN — three layout siblings stacked vertically with gap=0.
// Used for: edge-magnet between touching siblings, drop-line position,
// drop preserves visual order, hover-flash regression.
// ─────────────────────────────────────────────────────────────────────────
export const FLEX_COLUMN = project(`
/** @canvas { "viewports": [{"id":"desktop","width":1440}] } */
'use client';
export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{
      display: 'flex', flexDirection: 'column', gap: '0px',
      width: '1440px', minHeight: '900px',
      background: '#0d0d1a',
    }}>
      <div data-id="hero" data-name="Hero" style={{
        height: '300px', background: '#1a1a3a',
      }}></div>
      <div data-id="features" data-name="Features" style={{
        height: '300px', background: '#f5f5f7',
      }}></div>
      <div data-id="how" data-name="HowItWorks" style={{
        height: '300px', background: '#ffffff',
      }}></div>
    </div>
  );
}
`);

// ─────────────────────────────────────────────────────────────────────────
// FLEX_COLUMN_GAP — same as above but with a real gap. Used for
// drop-line position when there IS a gap (no magnet should fire).
// ─────────────────────────────────────────────────────────────────────────
export const FLEX_COLUMN_GAP = project(`
/** @canvas { "viewports": [{"id":"desktop","width":1440}] } */
'use client';
export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{
      display: 'flex', flexDirection: 'column', gap: '40px',
      width: '1440px', minHeight: '900px',
      background: '#0d0d1a',
    }}>
      <div data-id="hero" data-name="Hero" style={{
        height: '200px', background: '#1a1a3a',
      }}></div>
      <div data-id="features" data-name="Features" style={{
        height: '200px', background: '#f5f5f7',
      }}></div>
      <div data-id="how" data-name="HowItWorks" style={{
        height: '200px', background: '#ffffff',
      }}></div>
    </div>
  );
}
`);

// ─────────────────────────────────────────────────────────────────────────
// FLEX_ROW — three columns side-by-side. Used for row-direction drag.
// ─────────────────────────────────────────────────────────────────────────
export const FLEX_ROW = project(`
/** @canvas { "viewports": [{"id":"desktop","width":1440}] } */
'use client';
export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{
      display: 'flex', flexDirection: 'row', gap: '0px',
      width: '1440px', minHeight: '500px', background: '#0d0d1a',
    }}>
      <div data-id="col-a" data-name="ColA" style={{
        width: '480px', height: '500px', background: '#1a3a1a',
      }}></div>
      <div data-id="col-b" data-name="ColB" style={{
        width: '480px', height: '500px', background: '#3a1a1a',
      }}></div>
      <div data-id="col-c" data-name="ColC" style={{
        width: '480px', height: '500px', background: '#1a1a3a',
      }}></div>
    </div>
  );
}
`);

// ─────────────────────────────────────────────────────────────────────────
// REORDERED_FLEX_COLUMN — sections with EXPLICIT `order` styles, like
// the bug repro from the user. JSX order ≠ visual order. Tests for
// the visual-order sort and the renumber-orders fixes.
// ─────────────────────────────────────────────────────────────────────────
export const REORDERED_FLEX_COLUMN = project(`
/** @canvas { "viewports": [{"id":"desktop","width":1440}] } */
'use client';
export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{
      display: 'flex', flexDirection: 'column', gap: '0px',
      width: '1440px', minHeight: '900px',
      background: '#0d0d1a',
    }}>
      {/* Visually 3rd (order:2), but JSX[0] */}
      <div data-id="how" data-name="HowItWorks" style={{
        height: '300px', background: '#ffffff', order: '2',
      }}></div>
      {/* Visually 1st (order:0), but JSX[1] */}
      <div data-id="hero" data-name="Hero" style={{
        height: '300px', background: '#1a1a3a', order: '0',
      }}></div>
      {/* Visually 2nd (order:1), but JSX[2] */}
      <div data-id="features" data-name="Features" style={{
        height: '300px', background: '#f5f5f7', order: '1',
      }}></div>
    </div>
  );
}
`);

// ─────────────────────────────────────────────────────────────────────────
// CANVAS_NODE — a small frame floating outside the viewport, used for
// CanvasDragStrategy "drag from canvas into viewport" scenarios.
// ─────────────────────────────────────────────────────────────────────────
const CANVAS_NODE = project(`
/** @canvas { "viewports": [{"id":"desktop","width":1440}] } */
'use client';
export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{
      display: 'flex', flexDirection: 'column', gap: '0px',
      width: '1440px', minHeight: '900px',
      background: '#0d0d1a',
    }}>
      <div data-id="hero" data-name="Hero" style={{
        height: '300px', background: '#1a1a3a',
      }}></div>
      <div data-id="features" data-name="Features" style={{
        height: '300px', background: '#f5f5f7',
      }}></div>
      <div data-id="how" data-name="HowItWorks" style={{
        height: '300px', background: '#ffffff',
      }}></div>
    </div>
  );
}
const canvasNodes = (<>
  <div data-id="floater" data-name="Floater" data-canvas-node="true" style={{
    position: 'absolute',
    left: '-300px', top: '100px',
    width: '120px', height: '120px',
    background: '#ff66cc',
  }}></div>
</>);
`);

// ─────────────────────────────────────────────────────────────────────────
// ABSOLUTE_IN_FRAME — a layout viewport with one absolute-positioned
// child INSIDE the hero, plus a sibling layout section. Used for
// AbsoluteInFrameStrategy: drag absolute child within parent, exit to
// canvas, enter sibling layout.
// ─────────────────────────────────────────────────────────────────────────
export const ABSOLUTE_IN_FRAME = project(`
/** @canvas { "viewports": [{"id":"desktop","width":1440}] } */
'use client';
export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{
      display: 'flex', flexDirection: 'column', gap: '0px',
      width: '1440px', minHeight: '900px',
      background: '#0d0d1a',
    }}>
      <div data-id="hero" data-name="Hero" style={{
        position: 'relative',
        height: '400px', background: '#1a1a3a',
      }}>
        <div data-id="abs-child" data-name="AbsChild" style={{
          position: 'absolute',
          left: '40px', top: '40px',
          width: '120px', height: '120px',
          background: '#66ccff',
        }}></div>
      </div>
      <div data-id="features" data-name="Features" style={{
        display: 'flex', flexDirection: 'row', gap: '20px',
        height: '300px', background: '#f5f5f7',
        padding: '20px',
      }}>
        <div data-id="card-a" style={{
          flex: '1 1 0', background: '#ffffff',
        }}></div>
        <div data-id="card-b" style={{
          flex: '1 1 0', background: '#ffffff',
        }}></div>
      </div>
    </div>
  );
}
`);

// ─────────────────────────────────────────────────────────────────────────
// ABSOLUTE_IN_TRANSFORMED_FRAME — an absolute pinned child whose ANCESTOR
// (hero) carries a BENIGN transform (translate + scale, no rotation/skew).
// Pin constraint lines MUST still show: a plain translate/scale keeps the
// pinned edges axis-aligned. The `pinned-child-rot` hero adds a rotation so
// the same structure with a rotated ancestor can assert suppression. Regression
// guard for the "hero with a glow/parallax transform hides pin lines" bug
// (live find 2026-07-24).
// ─────────────────────────────────────────────────────────────────────────
export const ABSOLUTE_IN_TRANSFORMED_FRAME = project(`
/** @canvas { "viewports": [{"id":"desktop","width":1440}] } */
'use client';
export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{
      display: 'flex', flexDirection: 'column', gap: '0px',
      width: '1440px', minHeight: '900px', background: '#0d0d1a',
    }}>
      <div data-id="hero" data-name="Hero" style={{
        position: 'relative', height: '400px', background: '#1a1a3a',
        transform: 'translateX(0px) scale(1)',
      }}>
        <div data-id="pinned-child" data-name="PinnedChild" style={{
          position: 'absolute', left: '80px', top: '60px',
          width: '120px', height: '120px', background: '#66ccff',
        }}></div>
      </div>
      <div data-id="hero-rot" data-name="HeroRot" style={{
        position: 'relative', height: '400px', background: '#241a3a',
        transform: 'rotate(15deg)',
      }}>
        <div data-id="pinned-child-rot" data-name="PinnedChildRot" style={{
          position: 'absolute', left: '80px', top: '60px',
          width: '120px', height: '120px', background: '#ffcc66',
        }}></div>
      </div>
    </div>
  );
}
`);

// ─────────────────────────────────────────────────────────────────────────
// CENTERED_ABS_SVG — a single absolute SVG centered via `translate(-50%,-50%)`
// with a PERCENTAGE left, inside a relative frame. Used to verify Create Layout
// / Create Frame (wrap-in-parent) keeps it visually put: the old parseFloat
// bbox read `left: 68.5417%` as 68px and the wrapper (and child) flew ~900px
// off (live find 2026-07-24).
// ─────────────────────────────────────────────────────────────────────────
export const CENTERED_ABS_SVG = project(`
/** @canvas { "viewports": [{"id":"desktop","width":1440}] } */
'use client';
export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{
      position: 'relative', width: '1440px', minHeight: '900px', background: '#0d0d1a',
    }}>
      <div data-id="hero" data-name="Hero" style={{
        position: 'relative', height: '600px', background: '#1a1a3a',
      }}>
        <svg data-id="star" data-name="Star" viewBox="0 0 22 22" xmlns="http://www.w3.org/2000/svg" style={{
          position: 'absolute', left: '68.5417%', top: '300px',
          transform: 'translateX(-50%) translateY(-50%)',
          width: '80px', height: '80px', color: '#A9FF55', display: 'block',
        }}>
          <path data-id="star-path" d="M11 0 L13 9 L22 11 L13 13 L11 22 L9 13 L0 11 L9 9 Z" fill="#A9FF55" />
        </svg>
      </div>
    </div>
  );
}
`);

// ─────────────────────────────────────────────────────────────────────────
// ENCAPSULATE_MIXED — inside one relative hero: an absolute AUTO-sized text
// (width/height auto) AND an absolute px-sized box, both in the top-left. Draw
// a frame over both → BOTH must become children. The old encapsulation read
// inline width/height and skipped the auto-sized text (parseFloat('auto')=0),
// so only the px box was captured (live find 2026-07-24).
// ─────────────────────────────────────────────────────────────────────────
export const ENCAPSULATE_MIXED = project(`
/** @canvas { "viewports": [{"id":"desktop","width":1440}] } */
'use client';
export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{
      position: 'relative', width: '1440px', minHeight: '900px', background: '#0d0d1a',
    }}>
      <div data-id="hero" data-name="Hero" style={{
        position: 'relative', height: '700px', background: '#ffffff',
      }}>
        <p data-id="cap" data-name="Caption" style={{
          position: 'absolute', left: '120px', top: '90px',
          width: 'auto', height: 'auto', margin: '0', color: '#111', fontSize: '20px',
        }}>Save more and get visibility on your money</p>
        <div data-id="box" data-name="Box" style={{
          position: 'absolute', left: '120px', top: '150px',
          width: '360px', height: '200px', background: '#f9a8a8',
        }}></div>
      </div>
    </div>
  );
}
`);

// ─────────────────────────────────────────────────────────────────────────
// ENCAPSULATE_CANVAS_MIXED — two CANVAS nodes (outside any viewport): an
// auto-sized text + a px box, near each other. Draw a frame over both → BOTH
// must become children of the new canvas frame. Canvas-node counterpart of
// ENCAPSULATE_MIXED (live find 2026-07-24: viewport text captured, canvas text
// didn't).
// ─────────────────────────────────────────────────────────────────────────
export const ENCAPSULATE_CANVAS_MIXED = project(`
/** @canvas { "viewports": [{"id":"desktop","width":1440}] } */
'use client';
export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{
      display: 'flex', flexDirection: 'column',
      width: '1440px', minHeight: '900px', background: '#0d0d1a',
    }}>
      <div data-id="hero" data-name="Hero" style={{ height: '300px', background: '#1a1a3a' }}></div>
    </div>
  );
}
const canvasNodes = (<>
  <p data-id="cap" data-name="Caption" data-canvas-node="true" style={{
    position: 'absolute', left: '-500px', top: '150px',
    width: 'auto', height: 'auto', margin: '0', color: '#ffffff', fontSize: '24px',
  }}>Save more and get visibility</p>
  <div data-id="box" data-name="Box" data-canvas-node="true" style={{
    position: 'absolute', left: '-500px', top: '200px',
    width: '320px', height: '160px', background: '#f9a8a8',
  }}></div>
</>);
`);

// ─────────────────────────────────────────────────────────────────────────
// PINNED_ABS_IN_FRAME — a data-pinned absolute child inside a relative hero.
// Cmd+D / paste must keep it in the SAME parent at the SAME position — the
// pinned→canvas divert was removed 2026-07-24.
// ─────────────────────────────────────────────────────────────────────────
export const PINNED_ABS_IN_FRAME = project(`
/** @canvas { "viewports": [{"id":"desktop","width":1440}] } */
'use client';
export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{
      position: 'relative', width: '1440px', minHeight: '900px', background: '#0d0d1a',
    }}>
      <div data-id="hero" data-name="Hero" style={{
        position: 'relative', height: '600px', background: '#1a1a3a',
      }}>
        <div data-id="pinned" data-name="Pinned" data-pinned="true" style={{
          position: 'absolute', left: '80px', top: '80px',
          width: '220px', height: '140px', background: '#66ccff',
        }}></div>
      </div>
    </div>
  );
}
`);

// ─────────────────────────────────────────────────────────────────────────
// FLEX_COL_TALL — a flex-COLUMN root with 3 stacked sections and generous
// trailing space (minHeight 1400 > content) so a frame can be drawn BELOW all
// children. Draw-a-frame-into-flex must insert at the END, not the middle
// (live find 2026-07-24).
// ─────────────────────────────────────────────────────────────────────────
export const FLEX_COL_TALL = project(`
/** @canvas { "viewports": [{"id":"desktop","width":1440}] } */
'use client';
export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{
      display: 'flex', flexDirection: 'column', gap: '0px', alignItems: 'stretch',
      width: '1440px', minHeight: '1400px', background: '#ffffff',
    }}>
      <div data-id="a" data-name="A" style={{ height: '200px', background: '#f9a8a8' }}></div>
      <div data-id="b" data-name="B" style={{ height: '200px', background: '#a8c8f9' }}></div>
      <div data-id="c" data-name="C" style={{ height: '200px', background: '#a8f9b8' }}></div>
    </div>
  );
}
`);

// ─────────────────────────────────────────────────────────────────────────
// FLEX_COL_ORDERED — flex-column root whose children carry EXPLICIT `order`
// (DOM order a,b,c but VISUAL order b,c,a via order 2/0/1). Drawing a frame
// below the visually-last child must land it at the visual END — the naive
// insert (default order:0) dropped it mid-stack (live find 2026-07-24).
// ─────────────────────────────────────────────────────────────────────────
export const FLEX_COL_ORDERED = project(`
/** @canvas { "viewports": [{"id":"desktop","width":1440}] } */
'use client';
export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{
      display: 'flex', flexDirection: 'column', gap: '0px', alignItems: 'stretch',
      width: '1440px', minHeight: '1400px', background: '#ffffff',
    }}>
      <div data-id="a" data-name="A" style={{ order: '2', height: '200px', background: '#f9a8a8' }}></div>
      <div data-id="b" data-name="B" style={{ order: '0', height: '200px', background: '#a8c8f9' }}></div>
      <div data-id="c" data-name="C" style={{ order: '1', height: '200px', background: '#a8f9b8' }}></div>
    </div>
  );
}
`);

// ─────────────────────────────────────────────────────────────────────────
// IMAGE_FILL_NODE — a frame with a small DATA-URL background image (80×50,
// left pink / right blue), so the crop modal can load + rasterise it fully
// offline. Used by the crop-feature e2e.
// ─────────────────────────────────────────────────────────────────────────
const CROP_IMG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAFAAAAAyCAIAAABET8urAAAAcklEQVR4nOXOMQHAMBCAQIqWeoqK+orFbHWRHzgD8Jy9mfC9a6QrMRIjMRIjMRIjMRIjMRIjMRIjMRIjMRIjMRIjMRIjMRIjMRIjMRIjMRIjMRIjMRIjMRIjMRIjMRIjMRIjMRIjMRIjMRIjMRLj9MBtPy+eA5U8gxfjAAAAAElFTkSuQmCC';
export const IMAGE_FILL_NODE = project(`
/** @canvas { "viewports": [{"id":"desktop","width":1440}] } */
'use client';
export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{
      position: 'relative', width: '1440px', minHeight: '900px', background: '#0d0d1a',
    }}>
      <div data-id="hero" data-name="Hero" style={{ position: 'relative', height: '700px', background: '#1a1a3a' }}>
        <div data-id="pic" data-name="Pic" style={{
          position: 'absolute', left: '120px', top: '120px', width: '320px', height: '200px',
          backgroundImage: 'url(${CROP_IMG})',
          backgroundSize: 'cover', backgroundPosition: 'center', backgroundRepeat: 'no-repeat',
        }}></div>
      </div>
    </div>
  );
}
`);

// ─────────────────────────────────────────────────────────────────────────
// OVERLAY_ON_FLEX_CHILD — a flex-ROW viewport with 3 flow cards; the middle
// card is an overlay TRIGGER and the overlay (ov-a) lives at root level (as the
// generator writes it). In overlay-edit mode the overlay must be portaled +
// visible. Regression repro (2026-07-24: overlay inside flex children invisible
// in overlay mode).
// ─────────────────────────────────────────────────────────────────────────
export const OVERLAY_ON_FLEX_CHILD = project(`
/** @canvas { "viewports": [{"id":"desktop","width":1440}] } */
'use client';
import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
export default function Page() {
  const [overlayA, setOverlayA] = useState(false);
  return (
    <div data-id="root" data-name="Page" style={{
      display: 'flex', flexDirection: 'row', gap: '20px', alignItems: 'flex-start',
      width: '1440px', minHeight: '600px', padding: '60px', background: '#ffffff',
    }}>
      <div data-id="card1" data-name="Card1" style={{ flex: '1 1 0', height: '220px', background: '#f9a8a8', borderRadius: '8px' }}></div>
      <div data-id="card2" data-name="Card2" data-overlay-trigger='{"trigger":"click"}' onClick={() => setOverlayA(!overlayA)} style={{ flex: '1 1 0', height: '220px', background: '#a8c8f9', borderRadius: '8px' }}></div>
      <div data-id="card3" data-name="Card3" style={{ flex: '1 1 0', height: '220px', background: '#a8f9b8', borderRadius: '8px' }}></div>
      <AnimatePresence>{overlayA && (
        <motion.div key="ov-a" data-id="ov-a" data-name="Overlay" data-overlay='{"type":"relative","triggerId":"card2","side":"bottom","align":"center","offsetX":0,"offsetY":8}' initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 20 }} style={{ position: 'absolute', width: '200px', height: '100px', backgroundColor: '#7CBFFF', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.1)', boxShadow: '0 4px 16px rgba(0,0,0,0.12)' }}>
      </motion.div>
      )}</AnimatePresence>
    </div>
  );
}
`);

// ─────────────────────────────────────────────────────────────────────────
// CANVAS_NODE_SMALL — small floater on a touching-siblings page so the
// magnet edge-zone test can satisfy BOTH constraints: the dragged rect
// is fully inside the section AND the cursor sits within the magnet's
// 12px edge zone. Floater 40×40 (declared) → 20×20 screen at 0.5 zoom,
// half-extent = 10px, comfortably under edgePx=12.
// ─────────────────────────────────────────────────────────────────────────
export const CANVAS_NODE_SMALL = project(`
/** @canvas { "viewports": [{"id":"desktop","width":1440}] } */
'use client';
export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{
      display: 'flex', flexDirection: 'column', gap: '0px',
      width: '1440px', minHeight: '900px',
      background: '#0d0d1a',
    }}>
      <div data-id="hero" data-name="Hero" style={{
        height: '300px', background: '#1a1a3a',
      }}></div>
      <div data-id="features" data-name="Features" style={{
        height: '300px', background: '#f5f5f7',
      }}></div>
      <div data-id="how" data-name="HowItWorks" style={{
        height: '300px', background: '#ffffff',
      }}></div>
    </div>
  );
}
const canvasNodes = (<>
  <div data-id="floater" data-name="Floater" data-canvas-node="true" style={{
    position: 'absolute',
    left: '-240px', top: '-100px',
    width: '40px', height: '40px',
    background: '#ff66cc',
  }}></div>
</>);
`);

// ─────────────────────────────────────────────────────────────────────────
// CANVAS_NODE_WITH_GAP — like CANVAS_NODE but with explicit gap between
// sections so there's empty space inside `root` for a clean drop into
// the layout flow (no edge-magnet involved).
// ─────────────────────────────────────────────────────────────────────────
export const CANVAS_NODE_WITH_GAP = project(`
/** @canvas { "viewports": [{"id":"desktop","width":1440}] } */
'use client';
export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{
      display: 'flex', flexDirection: 'column', gap: '60px',
      width: '1440px', minHeight: '900px',
      background: '#0d0d1a',
    }}>
      <div data-id="hero" data-name="Hero" style={{
        height: '200px', background: '#1a1a3a',
      }}></div>
      <div data-id="features" data-name="Features" style={{
        height: '200px', background: '#f5f5f7',
      }}></div>
      <div data-id="how" data-name="HowItWorks" style={{
        height: '200px', background: '#ffffff',
      }}></div>
    </div>
  );
}
const canvasNodes = (<>
  <div data-id="floater" data-name="Floater" data-canvas-node="true" style={{
    position: 'absolute',
    left: '-300px', top: '100px',
    width: '120px', height: '120px',
    background: '#ff66cc',
  }}></div>
</>);
`);

// ─────────────────────────────────────────────────────────────────────────
// SHAPE_EDIT_TRIANGLE — a 200×200 SVG triangle on the canvas root (canvas
// node, not inside any viewport). Wrapper has matching viewBox and
// preserveAspectRatio="none" so 1 user unit = 1 CSS px. Used by
// shape-edit.spec to verify the wrapper-normalize-on-exit behavior:
// after reshaping a path beyond the original viewBox bounds, the wrapper
// should grow / move to fit the painted geometry.
// ─────────────────────────────────────────────────────────────────────────
export const SHAPE_EDIT_TRIANGLE = project(`
/** @canvas { "viewports": [{"id":"desktop","width":1440}] } */
'use client';
export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{
      display: 'flex', flexDirection: 'column',
      width: '1440px', minHeight: '900px', background: '#0d0d1a',
    }}>
    </div>
  );
}
const canvasNodes = (<>
  <svg data-id="my-svg" data-name="Triangle" data-canvas-node="true"
       viewBox="0 0 200 200" preserveAspectRatio="none"
       style={{
         position: 'absolute',
         left: '500px', top: '300px',
         width: '200px', height: '200px',
         overflow: 'visible',
       }}>
    <polygon data-id="my-polygon" points="100,0 200,200 0,200" fill="#3b82f6" />
  </svg>
</>);
`);

// ─────────────────────────────────────────────────────────────────────────
// SVG_GROUP_LETTERS — a grammar-correct svg GROUP canvas node (the exact
// markup `groupSvgs`/the plugin decompose emit): 1:1 wrapper
// (viewBox == px box, preserveAspectRatio="none", overflow visible) with
// three bbox-fitted nested `<svg x y width height viewBox>` children each
// holding one local-coords path. Used by svg-group-drag-stability.spec to
// verify that after a group-child drag COMMIT the sandbox wrapper DOM
// matches source (viewBox + box), and that a SECOND drag tracks the mouse
// (the "first drag after reload stable, all subsequent drags offset"
// regression, user report 2026-07-28).
// ─────────────────────────────────────────────────────────────────────────
export const SVG_GROUP_LETTERS = project(`
/** @canvas { "viewports": [{"id":"desktop","width":1440}] } */
'use client';
export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{
      display: 'flex', flexDirection: 'column',
      width: '1440px', minHeight: '900px', background: '#0d0d1a',
    }}>
    </div>
  );
}
const canvasNodes = (<>
  <svg data-id="grp" data-name="Group" data-canvas-node="true" viewBox="0 0 250 64" preserveAspectRatio="none" style={{ position: "absolute", left: "-400px", top: "150px", width: "250px", height: "64px", overflow: "visible" }}><svg data-id="grp-s0" data-name="LetterA" x="0" y="0" width="70" height="64" viewBox="0 0 70 64" preserveAspectRatio="none" overflow="visible"><path data-id="grp-s0-g0" d="M0 0 H70 V64 H0 Z" fill="#3b82f6" /></svg><svg data-id="grp-s1" data-name="LetterB" x="90" y="0" width="70" height="64" viewBox="0 0 70 64" preserveAspectRatio="none" overflow="visible"><path data-id="grp-s1-g0" d="M0 0 H70 V64 H0 Z" fill="#ef4444" /></svg><svg data-id="grp-s2" data-name="LetterC" x="180" y="0" width="70" height="64" viewBox="0 0 70 64" preserveAspectRatio="none" overflow="visible"><path data-id="grp-s2-g0" d="M0 0 H70 V64 H0 Z" fill="#22c55e" /></svg></svg>
</>);
`);

// ─────────────────────────────────────────────────────────────────────────
// OSS_SMOKE — covenant behavioral-baseline seed for oss-smoke.spec.ts.
// A flex column with a frame + a text node, so the smoke can exercise
// select, panel render, frame drawing, undo, resize, and text edit.
// ─────────────────────────────────────────────────────────────────────────
export const OSS_SMOKE = project(`
/** @canvas { "viewports": [{"id":"desktop","width":1440}] } */
'use client';
export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{
      display: 'flex', flexDirection: 'column', gap: '24px',
      width: '1440px', minHeight: '900px',
      background: '#0d0d1a', padding: '40px',
    }}>
      <div data-id="hero" data-name="Hero" style={{
        height: '300px', background: '#1a1a3a', borderRadius: '12px',
      }}></div>
      <p data-id="headline" data-name="Headline" style={{
        fontSize: '32px', color: '#ffffff', margin: '0px',
      }}>Baseline headline text</p>
      <div data-id="cards" data-name="Cards" style={{
        display: 'flex', flexDirection: 'row', gap: '16px', height: '200px',
      }}>
        <div data-id="card-a" data-name="CardA" style={{
          width: '300px', height: '200px', background: '#f5f5f7', borderRadius: '8px',
        }}></div>
        <div data-id="card-b" data-name="CardB" style={{
          width: '300px', height: '200px', background: '#3a1a1a', borderRadius: '8px',
        }}></div>
      </div>
    </div>
  );
}
`);

// Map of seed name → ProjectData. Tests pick a seed by name; the
// helper sets it on localStorage before navigating.
// ─────────────────────────────────────────────────────────────────────────
// CANVAS_ENTRY — TWO canvas nodes at the content root: a frame and a small
// chip below it. Used for the mid-drag canvas-node → canvas-frame ENTRY
// path (CanvasDragStrategy entry commit → AbsoluteInFrameStrategy switch):
// the chip must stay under the cursor through the reparent moment.
// ─────────────────────────────────────────────────────────────────────────
export const CANVAS_ENTRY = project(`
/** @canvas { "viewports": [{"id":"desktop","width":1440}] } */
'use client';
export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{
      display: 'flex', flexDirection: 'column', gap: '0px',
      position: 'relative', width: '100%', minHeight: '400px', background: '#ffffff',
    }}>
      <div data-id="hero" data-name="Hero" style={{
        position: 'relative', height: '300px', background: '#f5f5f7',
      }}></div>
    </div>
  );
}
const canvasNodes = (<>
  <div data-id="big-frame" data-name="BigFrame" data-canvas-node="true" style={{
    position: 'absolute',
    left: '-380px', top: '60px',
    width: '320px', height: '240px',
    background: '#e8eefc',
  }}></div>
  <div data-id="chip" data-name="Chip" data-canvas-node="true" style={{
    position: 'absolute',
    left: '-330px', top: '360px',
    width: '90px', height: '90px',
    background: '#ff66cc',
  }}></div>
</>);
`);

// ─────────────────────────────────────────────────────────────────────────
// REPLICA_AUTO_HEIGHT — two viewports; the card is fixed-size at base but
// its mobile @media band overrides height to `auto !important`. Used for:
// resize-handle visibility must follow the REPLICA-effective size (the
// mobile testimonial-card report: top/bottom circles on an auto-height
// replica), not the base inline styles.
// ─────────────────────────────────────────────────────────────────────────
export const REPLICA_AUTO_HEIGHT = project(`
/** @canvas {
  "viewports": [
    { "id": "desktop", "label": "Desktop", "width": 1440, "isPrimary": true, "order": 0 },
    { "id": "mobile", "label": "Mobile", "width": 375, "isPrimary": false, "order": 1 }
  ],
  "positions": {
    "desktop": { "x": 0, "y": 0 },
    "mobile": { "x": 1560, "y": 0 }
  }
} */
'use client';
export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{
      display: 'flex', flexDirection: 'column', alignItems: 'flex-start',
      width: '100%', minHeight: '900px', position: 'relative',
      background: '#0d0d1a', padding: '40px',
    }}>
      <style>{\`
@media (max-width: 375px) {
  [data-id="card"] { width: 300px !important; height: auto !important; }
}
\`}</style>
      <div data-id="card" data-name="Card" style={{
        display: 'flex', flexDirection: 'column', padding: '48px',
        width: '600px', height: '300px', position: 'relative',
        background: '#1a1a3a', borderRadius: '12px',
      }}>
        <div data-id="card-inner" data-name="Inner" style={{
          width: '80%', height: '150px', position: 'relative',
          background: '#3b3b6b', borderRadius: '8px',
        }}></div>
      </div>
    </div>
  );
}
`);

// ─────────────────────────────────────────────────────────────────────────
// REPLICA_ABS_DRAG — an absolute child inside a relative card, with an
// existing mobile @media band overriding its left/top. Used for: dragging
// the absolute node ON THE MOBILE REPLICA must keep the dragged position
// in the DOM after mouseup (the "reverts until I switch pages" report).
// ─────────────────────────────────────────────────────────────────────────
export const REPLICA_ABS_DRAG = project(`
/** @canvas {
  "viewports": [
    { "id": "desktop", "label": "Desktop", "width": 1440, "isPrimary": true, "order": 0 },
    { "id": "mobile", "label": "Mobile", "width": 375, "isPrimary": false, "order": 1 }
  ],
  "positions": {
    "desktop": { "x": 0, "y": 0 },
    "mobile": { "x": 1560, "y": 0 }
  }
} */
'use client';
export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{
      display: 'flex', flexDirection: 'column', alignItems: 'flex-start',
      width: '100%', minHeight: '900px', position: 'relative',
      background: '#0d0d1a', padding: '40px',
    }}>
      <style>{\`
@media (max-width: 375px) {
  [data-id="abs"] { left: 24px !important; top: 24px !important; }
}
\`}</style>
      <div data-id="card" data-name="Card" style={{
        width: '600px', height: '400px', position: 'relative',
        background: '#1a1a3a', borderRadius: '12px',
      }}>
        <div data-id="abs" data-name="Abs" style={{
          position: 'absolute', left: '200px', top: '120px',
          width: '160px', height: '100px',
          background: '#ffcc33', borderRadius: '8px',
        }}></div>
      </div>
    </div>
  );
}
`);

// ─────────────────────────────────────────────────────────────────────────
// LOCALE_TEXT — a plain text node for localization flows. The default
// project scaffold (createDefaultProject) supplies i18n/config.json with
// en (default) + fr + es and empty messages/*.json, so locale switching
// works out of the box. Used for: translate under French → switch back to
// English shows the original → reload keeps both (the "Peintre stays /
// empty after page switch" regression).
// ─────────────────────────────────────────────────────────────────────────
export const LOCALE_TEXT = project(`
/** @canvas {
  "viewports": [
    { "id": "desktop", "label": "Desktop", "width": 1440, "isPrimary": true, "order": 0 }
  ],
  "positions": { "desktop": { "x": 0, "y": 0 } }
} */
'use client';
export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{
      display: 'flex', flexDirection: 'column', alignItems: 'flex-start',
      width: '100%', minHeight: '600px', position: 'relative',
      background: '#0d0d1a', padding: '60px', gap: '16px',
    }}>
      <p data-id="intro" data-name="Intro" style={{
        position: 'relative', color: '#ffffff', fontSize: '32px',
      }}>Painter</p>
      <p data-id="tagline" data-name="Tagline" style={{
        position: 'relative', color: '#9999aa', fontSize: '18px',
      }}>Visual Artist</p>
      <input data-id="email-input" data-name="Email" type="email" placeholder="jane@example.com" style={{
        position: 'relative', width: '260px', height: '40px', padding: '0 12px',
        background: '#1a1a2e', color: '#ffffff', border: '1px solid #333', borderRadius: '8px',
      }} />
    </div>
  );
}
`);
// Seeded projects don't get the default scaffold's i18n files merged in —
// add the locale registry + empty messages explicitly so the Localization
// panel lists French and the messages round-trip has real files.
REPLICA_AUTO_HEIGHT.files['i18n/config.json'] = JSON.stringify({
  defaultLocale: 'en',
  locales: [
    { code: 'en', label: 'English' },
    { code: 'fr', label: 'French' },
  ],
}, null, 2);
REPLICA_AUTO_HEIGHT.files['messages/en.json'] = '{}';
REPLICA_AUTO_HEIGHT.files['messages/fr.json'] = '{}';

// 3-viewport variant for locale-band scoping specs (tablet between
// desktop and mobile — the ranged-band + descending-insertion cases).
export const LOCALE_3VP: ProjectData = {
  format: 'revyme-v1',
  files: { ...REPLICA_AUTO_HEIGHT.files },
};
LOCALE_3VP.files['app/page.client.tsx'] = LOCALE_3VP.files['app/page.client.tsx']
  .replace('{ "id": "mobile", "label": "Mobile", "width": 375, "isPrimary": false, "order": 1 }',
    '{ "id": "tablet", "label": "Tablet", "width": 768, "isPrimary": false, "order": 1 },\n    { "id": "mobile", "label": "Mobile", "width": 375, "isPrimary": false, "order": 2 }')
  .replace('"mobile": { "x": 1560, "y": 0 }', '"tablet": { "x": 1560, "y": 0 },\n    "mobile": { "x": 2450, "y": 0 }');

LOCALE_TEXT.files['i18n/config.json'] = JSON.stringify({
  defaultLocale: 'en',
  locales: [
    { code: 'en', label: 'English' },
    { code: 'fr', label: 'French' },
  ],
}, null, 2);
LOCALE_TEXT.files['messages/en.json'] = '{}';
LOCALE_TEXT.files['messages/fr.json'] = '{}';

// ─────────────────────────────────────────────────────────────────────────
// COMPONENT_MASTER — a design-component master (`components/Card.tsx`) with a
// single default variant + motion.* children. Open it via `__e2e.openFile(
// 'components/Card.tsx')` so the viewport becomes the component's variants.
// Used for: Hide control reactivity on a master — hiding `card-badge` (a frame
// child) via the Styles Hide control OR the Layers eye must hide it in the DOM
// immediately (no page switch), routed through setVariantVisibility.
// ─────────────────────────────────────────────────────────────────────────
export const COMPONENT_MASTER: ProjectData = {
  format: 'revyme-v1',
  files: {
    'app/page.tsx': `import PageClient from './page.client';

export const metadata = {};

export default function Page() {
  return <PageClient />;
}
`,
    'app/page.client.tsx': `/** @canvas { "viewports": [{"id":"desktop","width":1440}] } */
'use client';
export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{ width: '1440px', minHeight: '900px', background: '#0d0d1a' }} />
  );
}
`,
    'components/Card.tsx': `import { withResponsiveProps } from '@revyme/runtime';
import { motion } from 'framer-motion';

const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
];

function Card({ style, initialVariant = 'default' }: { style?: React.CSSProperties; initialVariant?: string }) {
  return (
    <motion.div layout={true} data-id="card-root" data-name="Card" initial={initialVariant} style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: '12px', width: '300px', padding: '24px', background: '#000000', ...style }}>
      <motion.h2 layout={true} data-id="card-title" data-name="Title" style={{ fontSize: '32px', color: '#ffffff' }}>02.</motion.h2>
      <motion.div layout={true} data-id="card-badge" data-name="Badge" style={{ width: '48px', height: '48px', background: '#ff2d75', borderRadius: '8px' }} />
      <motion.p layout={true} data-id="card-body" data-name="Body" style={{ fontSize: '16px', color: '#cccccc' }}>Tracking expenses</motion.p>
    </motion.div>
  );
}

export default withResponsiveProps(Card);
`,
  },
};

export const COMPONENT_MASTER_2V: ProjectData = {
  format: 'revyme-v1',
  files: {
    'app/page.tsx': `import PageClient from './page.client';\n\nexport const metadata = {};\n\nexport default function Page() {\n  return <PageClient />;\n}\n`,
    'app/page.client.tsx': `/** @canvas { "viewports": [{"id":"desktop","width":1440}] } */\n'use client';\nexport default function Page() {\n  return (\n    <div data-id="root" data-name="Page" style={{ width: '1440px', minHeight: '900px', background: '#0d0d1a' }} />\n  );\n}\n`,
    'components/Card.tsx': `import { withResponsiveProps } from '@revyme/runtime';
import { motion } from 'framer-motion';

const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Hover', x: 500, y: 0 },
];

function Card({ style, initialVariant = 'default' }: { style?: React.CSSProperties; initialVariant?: string }) {
  return (
    <motion.div layout={true} data-id="card-root" data-name="Card" initial={initialVariant} style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: '12px', width: '300px', height: '200px', padding: '24px', background: '#000000', ...style }}>
      <motion.p layout={true} data-id="card-body" data-name="Body" style={{ fontSize: '16px', color: '#cccccc' }}>Tracking expenses</motion.p>
    </motion.div>
  );
}

export default withResponsiveProps(Card);
`,
  },
};


// ─────────────────────────────────────────────────────────────────────────
// REPLICA_ABSOLUTE_EXIT — TWO viewports, so the tablet tile is a REPLICA of
// the desktop primary. `root` is NON-layout (position:relative, no flex) and
// holds an absolute child directly. Reproduces the user-reported freeze:
// dragging the absolute child out of the REPLICA to the canvas leaves the
// element stale/unmoving for the whole drag, only snapping into place on
// mouseup — while the same drag from the PRIMARY tile is smooth.
// ─────────────────────────────────────────────────────────────────────────
export const REPLICA_ABSOLUTE_EXIT = project(`
/** @canvas { "viewports": [{"id":"desktop","label":"Desktop","width":1440,"isPrimary":true,"order":0,"height":600},{"id":"tablet","label":"Tablet","width":768,"order":1,"height":600}], "positions": {"desktop":{"x":0,"y":0},"tablet":{"x":1600,"y":0}} } */
'use client';
export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{
      position: 'relative',
      width: '100%', minHeight: '600px',
      background: '#0d0d1a',
    }}>
      <div data-id="abs-child" data-name="AbsChild" style={{
        position: 'absolute',
        left: '60px', top: '60px',
        width: '120px', height: '120px',
        background: '#66ccff',
      }}></div>
    </div>
  );
}
`);

// ─────────────────────────────────────────────────────────────────────────
// GHOST_SIBLING_COLUMN — a Figma-import shape: a column of ordered sections
// with an INVISIBLE zero-size flow child ("ghost" empty frame) between them,
// and a bordered footer. The reorder insert-index math walks VISIBLE
// siblings while ranks/splices covered ALL children — one invisible child
// shifted every index by one, so "drag footer to the end" compared equal to
// its start slot and never committed. The bare `border` also locks the
// generator's order/border key-collision fix at the e2e level.
// ─────────────────────────────────────────────────────────────────────────
export const GHOST_SIBLING_COLUMN = project(`
/** @canvas { "viewports": [{"id":"desktop","width":1440}] } */
'use client';
export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{
      display: 'flex', flexDirection: 'column', gap: '0px',
      width: '1440px', minHeight: '1300px',
      background: '#0d0d1a',
    }}>
      <div data-id="nav" data-name="Nav" style={{
        height: '200px', background: '#1a1a3a', order: '0',
      }}></div>
      <div data-id="ghost" data-name="EmptyFrame" style={{
        width: 'auto', height: 'auto', order: '1',
      }}></div>
      <div data-id="hero" data-name="Hero" style={{
        height: '300px', background: '#f5f5f7', order: '2',
      }}></div>
      <div data-id="footer" data-name="Footer" style={{
        height: '300px', background: '#ffffff', border: '0', order: '3',
      }}></div>
      <div data-id="cta" data-name="CTA" style={{
        height: '300px', background: '#3a1a1a', order: '4',
      }}></div>
    </div>
  );
}
`);

// ─────────────────────────────────────────────────────────────────────────
// HANDOFF_TWO_VP — a flow parent to drag OUT of and a separate non-layout
// frame to drag INTO, rendered in two viewport tiles.
//
// Built for the mid-drag STRATEGY HANDOFF: dragging a flow child over a
// different frame commits an exit-to-canvas and swaps LayoutLifted for
// CanvasDrag *while the gesture is still live*. Two viewports because the
// hide covering the dragged node's synced twins is gesture-scoped — the
// handoff used to run the old strategy's cleanup, which un-hid the twin
// mid-drag and painted it as a duplicate (2026-08-05).
// ─────────────────────────────────────────────────────────────────────────
export const HANDOFF_TWO_VP = project(`
/** @canvas {
  "viewports": [
    { "id": "desktop", "label": "Desktop", "width": 1440, "isPrimary": true, "order": 0 },
    { "id": "tablet", "label": "Tablet", "width": 810, "isPrimary": false, "order": 1 }
  ],
  "positions": {
    "desktop": { "x": 0, "y": 0 },
    "tablet": { "x": 1560, "y": 0 }
  }
} */
'use client';
export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{
      display: 'flex', flexDirection: 'column', gap: '24px',
      width: '100%', minHeight: '900px', position: 'relative',
      background: '#0d0d1a', padding: '40px',
    }}>
      <div data-id="source-box" data-name="Source" style={{
        display: 'flex', flexDirection: 'column', gap: '12px',
        width: '100%', position: 'relative', padding: '16px',
        background: '#1a1a3a', flex: '0 0 auto', order: '0',
      }}>
        <div data-id="chip-a" data-name="ChipA" style={{
          width: '100%', height: '80px', background: '#3355ff',
          position: 'relative', flex: '0 0 auto', order: '0',
        }}></div>
        <div data-id="chip-b" data-name="ChipB" style={{
          width: '100%', height: '80px', background: '#ffcc33',
          position: 'relative', flex: '0 0 auto', order: '1',
        }}></div>
      </div>
      <div data-id="target-box" data-name="Target" style={{
        display: 'flex', flexDirection: 'column', gap: '12px',
        width: '100%', height: '320px', position: 'relative', padding: '16px',
        background: '#2a1a1a', flex: '0 0 auto', order: '1',
      }}>
        <div data-id="chip-c" data-name="ChipC" style={{
          width: '100%', height: '80px', background: '#33cc88',
          position: 'relative', flex: '0 0 auto', order: '0',
        }}></div>
      </div>
    </div>
  );
}
`);

// ─────────────────────────────────────────────────────────────────────────
// NEGATIVE_MARGIN_ROW — overlapping pills in a row, the middle two pulled
// left by a negative margin LONGHAND (`marginLeft`, not the shorthand).
//
// The distinction is the whole point: the drag lift snapshots and restores
// `margin`, and writing the shorthand back as '' also clears any longhand
// — so a reorder silently flattened the overlap in the canvas while the
// source (and the published site) kept it.
// ─────────────────────────────────────────────────────────────────────────
export const NEGATIVE_MARGIN_ROW = project(`
/** @canvas { "viewports": [{"id":"desktop","label":"Desktop","width":1440,"isPrimary":true,"order":0}] } */
'use client';
export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{
      display: 'flex', flexDirection: 'column', width: '1440px',
      minHeight: '700px', background: '#0d0d1a', padding: '40px',
    }}>
      <div data-id="strip" data-name="Strip" style={{
        display: 'flex', flexDirection: 'row', alignItems: 'center',
        width: '100%', height: '400px', position: 'relative',
        background: '#a8d4ff', flex: '0 0 auto', order: '0',
      }}>
        <div data-id="pill-a" data-name="PillA" style={{
          width: '200px', height: '400px', background: '#ffe0c2',
          borderRadius: '218px', position: 'relative', flex: '0 0 auto', order: '0',
        }}></div>
        <div data-id="pill-b" data-name="PillB" style={{
          width: '200px', height: '400px', background: '#8a5a1e',
          borderRadius: '218px', position: 'relative', flex: '0 0 auto',
          marginLeft: '-70px', order: '1',
        }}></div>
        <div data-id="pill-c" data-name="PillC" style={{
          width: '200px', height: '400px', background: '#323543',
          borderRadius: '218px', position: 'relative', flex: '0 0 auto',
          marginLeft: '-70px', order: '2',
        }}></div>
        <div data-id="pill-d" data-name="PillD" style={{
          width: '200px', height: '400px', background: '#ffb3bd',
          borderRadius: '218px', position: 'relative', flex: '0 0 auto', order: '3',
        }}></div>
      </div>
    </div>
  );
}
`);

// ─────────────────────────────────────────────────────────────────────────
// REPLICA_EXIT_TO_FRAME — a flex child in a 3-viewport page plus a NO-LAYOUT
// canvas frame below the tablet tile. Used for: drag `card-inner` out of the
// TABLET/MOBILE replica, across open canvas, into `drop-frame` in ONE gesture
// — the LayoutLifted → Canvas mid-drag handoff whose entry detection went
// blind for replica-origin drags, plus the replica SPLIT (clone + hide-on-
// origin, reported 2026-08-26). The frame is deliberately no-layout (no
// display) and larger than the dragged card so the fully-inside entry rule
// can fire. `solo-chip` is SOLO on the tablet replica the MANUAL way (inline
// display:none + tablet-band un-hide, deliberately NO data-replica-solo attr
// — exit-commit's attr-gated display clear must not be what saves it) — its
// drag-out must MOVE the source, keep selection, reset the interacting
// viewport to primary, and land VISIBLE even inside a canvas frame.
// ─────────────────────────────────────────────────────────────────────────
export const REPLICA_EXIT_TO_FRAME = project(`
/** @canvas {
  "viewports": [
    { "id": "desktop", "label": "Desktop", "width": 1440, "isPrimary": true, "order": 0 },
    { "id": "tablet", "label": "Tablet", "width": 768, "isPrimary": false, "order": 1 },
    { "id": "mobile", "label": "Mobile", "width": 375, "isPrimary": false, "order": 2 }
  ],
  "positions": {
    "desktop": { "x": 0, "y": 0 },
    "tablet": { "x": 1560, "y": 0 },
    "mobile": { "x": 2450, "y": 0 }
  }
} */
'use client';
export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{
      display: 'flex', flexDirection: 'column', alignItems: 'flex-start',
      width: '100%', minHeight: '640px', position: 'relative',
      background: '#0d0d1a', padding: '40px',
    }}>
      <style>{\`
@media (max-width: 768px) and (min-width: 375.02px) {
  [data-id="solo-chip"] { display: unset !important; }
}
\`}</style>
      <div data-id="card" data-name="Card" style={{
        display: 'flex', flexDirection: 'column', padding: '32px',
        width: '480px', height: '260px', position: 'relative',
        background: '#1a1a3a', borderRadius: '12px',
      }}>
        <div data-id="card-inner" data-name="Inner" style={{
          width: '240px', height: '110px', position: 'relative',
          background: '#3b3b6b', borderRadius: '8px',
        }}></div>
        <div data-id="solo-chip" data-name="SoloChip" style={{
          width: '180px', height: '70px', position: 'relative',
          background: '#cc4477', borderRadius: '8px', display: 'none',
        }}></div>
      </div>
    </div>
  );
}
const canvasNodes = (<>
  <div data-id="drop-frame" data-name="DropFrame" data-canvas-node="true" style={{
    position: 'absolute',
    left: '1650px', top: '780px',
    width: '620px', height: '360px',
    background: '#e8eefc', borderRadius: '10px',
    overflow: 'hidden',
  }}>
    <div data-id="dead-child" data-name="DeadChild" style={{
      position: 'absolute', width: '440px', height: '198px',
      background: '#0d263a', display: 'none',
      left: '-3162px', top: '-200px',
    }}></div>
  </div>
  <div data-id="layout-frame" data-name="LayoutFrame" data-canvas-node="true" style={{
    position: 'absolute',
    left: '860px', top: '780px',
    width: '620px', height: '360px',
    display: 'flex', flexDirection: 'column', alignItems: 'flex-start',
    background: '#fce8ee', borderRadius: '10px',
  }}></div>
  <div data-id="canvas-chip" data-name="CanvasChip" data-canvas-node="true" style={{
    position: 'absolute',
    left: '1650px', top: '-200px',
    width: '180px', height: '80px',
    background: '#7c5cff', borderRadius: '8px',
  }}></div>
</>);
`);

// ─────────────────────────────────────────────────────────────────────────
// ROTATED_FLEX_FRAME — a 90°-rotated absolute frame with a COLUMN flex
// layout and two flow children (user repro 2026-09-09: dragging a flex child
// of a transformed frame left the lifted overlay offset from the cursor).
export const ROTATED_FLEX_FRAME = project(`
/** @canvas { "viewports": [{"id":"desktop","width":700}] } */
'use client';
export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{
      position: 'relative', width: '700px', minHeight: '640px', background: '#0d0d1a',
    }}>
      <div data-id="spinframe" data-name="Frame" style={{
        position: 'absolute', width: '260px', height: '400px', backgroundColor: '#7d7d7d',
        left: '220px', top: '120px', transform: 'rotate(90deg)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '20px',
      }}>
        <div data-id="chip" data-name="Chip" style={{
          position: 'relative', width: '120px', height: '40px', backgroundColor: '#ff6b6b', flex: '0 0 auto',
        }}></div>
        <div data-id="card" data-name="Card" style={{
          position: 'relative', width: '120px', height: '160px', backgroundColor: '#baffc9', flex: '0 0 auto',
        }}></div>
      </div>
    </div>
  );
}
`);

// ─────────────────────────────────────────────────────────────────────────
// CMS_LIST_ROWS — a collection list (3 items) whose template row is a flex
// child, for the "drag the row and release in place" ghost regression.
export const CMS_LIST_ROWS: ProjectData = {
  format: 'revyme-v1',
  files: {
    'app/page.tsx': `import PageClient from './page.client';

export const metadata = {};

export default function Page() {
  return <PageClient />;
}
`,
    'app/page.client.tsx': `/** @canvas { "viewports": [{"id":"desktop","width":900}] } */
'use client';
import React from 'react';
import team from '@/cms/team.json';
import { RevymeSplitText } from '@revyme/runtime';
export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{ position: 'relative', width: '900px', minHeight: '700px', background: '#0d0d1a', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '60px' }}>
      <p data-id="title" data-name="Text" data-text-anim='{"animationType":"word","opacity":0,"blur":10,"delay":0.05}' style={{ fontSize: '32px', color: '#ffffff', position: 'relative', flex: '0 0 auto' }}><RevymeSplitText data-id="RevymeSplitText-e2e-1" spec={{ animationType: "word", opacity: 0, blur: 10, delay: 0.05 }}>Our team.</RevymeSplitText></p>
      <div data-id="list" data-name="List" data-collection-list="team" style={{ display: 'flex', flexDirection: 'column', gap: '12px', width: '300px', padding: '12px', background: '#ffffff', borderRadius: '8px', position: 'relative' }}>
        {team.map((item, idx) => (
          <div data-id="row" data-name="Row" key={idx} style={{ display: 'flex', alignItems: 'center', gap: '10px', width: '100%', height: '56px', padding: '8px', background: '#eeeeee', borderRadius: '6px', position: 'relative', flex: '0 0 auto' }}>
            <div data-id="avatar" style={{ width: '40px', height: '40px', background: '#cccccc', borderRadius: '6px', flex: '0 0 auto' }}></div>
            <p data-id="name" style={{ fontSize: '14px', color: '#111111', flex: '0 0 auto' }}>{item.name}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
`,
    'cms/team.schema.json': JSON.stringify({ slug: 'team', name: 'Team', fields: [{ id: 'name', name: 'Name', type: 'text' }] }),
    'cms/team.json': JSON.stringify([
      { _id: 'i1', _slug: 'john', _status: 'published', name: 'John Doe' },
      { _id: 'i2', _slug: 'jane', _status: 'published', name: 'Jane Roe' },
      { _id: 'i3', _slug: 'max', _status: 'published', name: 'Max Mustermann' },
    ]),
  },
};

// ─────────────────────────────────────────────────────────────────────────
// FLEX_WITH_ABSOLUTE_HERO — a flex-column section holding one flow section
// (opaque) plus an ABSOLUTE hero and an absolute top bar pinned at its top,
// and a canvas-node header to drop above the flow section. Dropping it
// renumbers the flow siblings; the overlays must keep painting above.
export const FLEX_WITH_ABSOLUTE_HERO = project(`
/** @canvas { "viewports": [{"id":"desktop","width":900}] } */
'use client';
export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{ position: 'relative', width: '900px', minHeight: '900px', background: '#0d0d1a', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <div data-id="wrap" data-name="Wrap" style={{ display: 'flex', flexDirection: 'column', width: '100%', position: 'relative', flex: '0 0 auto', paddingTop: '48px' }}>
        <div data-id="body" data-name="Body" style={{ position: 'relative', width: '100%', height: '700px', backgroundColor: '#0a0a0a', flex: '0 0 auto', order: '0' }}></div>
        <div data-id="hero" data-name="Hero" style={{ position: 'absolute', left: '0px', top: '0px', width: '70%', height: '200px', backgroundColor: '#ff3366' }}></div>
        <div data-id="bar" data-name="Bar" style={{ position: 'absolute', left: '0px', top: '0px', width: '70%', height: '60px', backgroundColor: '#3366ff' }}></div>
      </div>
    </div>
  );
}
const canvasNodes = (<>
  <div data-id="hdr" data-name="Header" data-canvas-node="true" style={{ position: 'absolute', left: '-500px', top: '100px', width: '300px', height: '80px', backgroundColor: '#22cc88' }}></div>
</>);
`);

// ─── USER PAGE REPRO (hero collapse after dropping a frame above the section) ───
export const USER_HERO_BEFORE: ProjectData = {
  format: 'revyme-v1',
  files: {
    'app/collection-1/[slug]/page.tsx': `import PageClient from './page.client';

export const metadata = {};

export default function Page() {
  return <PageClient />;
}
`,
    'app/collection-1/[slug]/page.client.tsx': `'use client';

/** @canvas {
  "viewports": [
    { "id": "desktop", "label": "Desktop", "width": 1440, "isPrimary": true, "order": 0 },
    { "id": "tablet", "label": "Tablet", "width": 768, "isPrimary": false, "order": 1 },
    { "id": "mobile", "label": "Mobile", "width": 375, "isPrimary": false, "order": 2 }
  ],
  "positions": {
    "desktop": { "x": 0, "y": 0 },
    "tablet": { "x": 1600, "y": 0 },
    "mobile": { "x": 2528, "y": 0 }
  }
} */
/** @cmsPage {
  "collection": "collection-1",
  "kind": "detail"
} */

import React, { useState, useRef, useLayoutEffect } from 'react';
import { useParams } from 'next/navigation';
import collection1 from '@/cms/collection-1.json';
import BaRoLe from '@/components/BaRoLe';

function useResponsiveText(primary, overrides, vpWidths) {
  const ref = useRef(null);
  const [w, setW] = useState(() => typeof window !== 'undefined' ? window.innerWidth : Infinity);
  useLayoutEffect(() => {
    if (typeof window === 'undefined') return;
    let host = ref.current && ref.current.parentElement;
    while (host && host !== document.body && !host.hasAttribute('data-viewport-width')) {
      host = host.parentElement;
    }
    if (host && host.hasAttribute && host.hasAttribute('data-viewport-width')) {
      const read = () => setW(parseInt(host.getAttribute('data-viewport-width'), 10) || window.innerWidth);
      read();
      const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(read) : null;
      if (ro) ro.observe(host);
      const mo = new MutationObserver(read);
      mo.observe(host, {
        attributes: true,
        attributeFilter: ['data-viewport-width']
      });
      return () => {
        if (ro) ro.disconnect();
        mo.disconnect();
      };
    }
    const onResize = () => setW(window.innerWidth);
    setW(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  // Bucket the current width into one of the configured viewports, then look
  // up that bucket's override. Smallest viewport width >= w wins. If no
  // viewport is wider than w, fall through to primary. Without the full
  // viewport list, we can't tell mobile (375) from tablet (768) when only
  // tablet has an override — both would resolve to tablet's text.
  const widths = (vpWidths || Object.keys(overrides || {}).map(Number)).filter(function (n) {
    return typeof n === 'number' && isFinite(n) && n > 0;
  }).slice().sort(function (a, b) {
    return a - b;
  });
  let bucket = null;
  for (let i = 0; i < widths.length; i++) {
    if (w <= widths[i]) {
      bucket = widths[i];
      break;
    }
  }
  let value = primary;
  if (bucket !== null && overrides && overrides[bucket] !== undefined) {
    value = overrides[bucket];
  }
  // Override values may contain rich-text marks emitted by TipTap on commit
  // (\`<span style="font-size: 14px">word</span>\` etc.). Plain string children
  // get escaped by React, so use dangerouslySetInnerHTML when the value looks
  // like HTML. Plain text falls through to the children path so React's text
  // diffing stays cheap.
  const isHtml = typeof value === 'string' && /<[a-z][^>]*>/i.test(value);
  return isHtml ? React.createElement('span', {
    ref: ref,
    style: {
      display: 'contents'
    },
    dangerouslySetInnerHTML: {
      __html: value
    }
  }) : React.createElement('span', {
    ref: ref,
    style: {
      display: 'contents'
    }
  }, value);
}
// @useResponsiveText-end

export default function Page() {
  const params = useParams();
  const item = collection1.find(i => i._slug === params?.slug) ?? collection1[0];
  return <div data-id="root" key={String(params?.slug ?? '')} data-name="Case study Detail" style={{
    position: 'relative',
    width: '100%',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    height: 'auto', overflowX: 'clip', backgroundColor: '#ffffff'}}>
      
  <style>{\`
    @media (max-width: 768px) and (min-width: 375.02px) {
      [data-id="div-mt9uiobo-10"] { flex-direction: column !important; height: min-content !important; gap: 32px !important; }
      [data-id="div-mt9uiobo-11"] { width: 100% !important; flex: 0 0 auto !important; }
      [data-id="div-mt9uiobo-16"] { width: 100% !important; flex: 0 0 auto !important; }
      [data-id="div-mt9uiobo-1l"] { padding-top: 0 !important; padding-right: 16px !important; padding-bottom: 0 !important; padding-left: 16px !important; height: min-content !important; }
      [data-id="div-mt9uiobg-6"] { flex-direction: column !important; height: min-content !important; }
      [data-id="div-mt9uiobo-u"] { width: 100% !important; flex: 0 0 auto !important; }
      [data-id="div-mt9uiobn-7"] { width: 100% !important; flex-direction: column !important; }
      [data-id="div-mt9uiobo-z"] { padding-top: 112px !important; padding-right: 16px !important; padding-bottom: 112px !important; padding-left: 16px !important; }
      [data-id="div-mt9uiobg-4"] { padding-top: 40px !important; padding-right: 16px !important; padding-bottom: 112px !important; padding-left: 16px !important; }
      [data-id="p-mt9uiobo-32"] { width: 100% !important; }
      [data-id="div-mt9uiobo-2y"] { padding-top: 0px !important; padding-right: 16px !important; padding-bottom: 16px !important; padding-left: 16px !important; }
      [data-id="div-mt9uiobo-1p"] { display: flex !important; height: min-content !important; gap: 32px !important; flex-direction: column !important; align-items: center !important; justify-content: center !important; }
      [data-id="div-mt9uiobo-1q"] { width: 100% !important; height: 100% !important; }
      [data-id="div-mt9uiobo-1v"] { width: 100% !important; height: 100% !important; }
      [data-id="div-mt9uiobo-20"] { width: 100% !important; height: 100% !important; }
      [data-id="div-mt9uiobo-25"] { width: 100% !important; height: 100% !important; }
      [data-id="div-mt9uiobo-1o"] { height: min-content !important; }
      [data-id="div-mt9uiobo-1m"] { width: 100% !important; }
      [data-id="div-mt9uiobo-1k"] { height: min-content !important; padding-top: 40px !important; padding-right: 0 !important; padding-bottom: 40px !important; padding-left: 0 !important; }
    }
    @media (max-width: 375px) {
      [data-id="div-mt9uiobo-10"] { flex-direction: column !important; height: min-content !important; gap: 40px !important; }
      [data-id="div-mt9uiobo-11"] { width: 100% !important; flex: 0 0 auto !important; height: min-content !important; }
      [data-id="div-mt9uiobo-16"] { width: 100% !important; flex: 0 0 auto !important; height: min-content !important; }
      [data-id="div-mt9uiobo-19"] { height: min-content !important; }
      [data-id="div-mt9uiobo-z"] { padding-top: 112px !important; padding-right: 16px !important; padding-bottom: 112px !important; padding-left: 16px !important; }
      [data-id="div-mt9uiobg-6"] { flex-direction: column !important; height: min-content !important; }
      [data-id="div-mt9uiobo-u"] { width: 100% !important; flex: 0 0 auto !important; height: min-content !important; }
      [data-id="div-mt9uiobg-4"] { padding-top: 40px !important; padding-right: 16px !important; padding-bottom: 40px !important; padding-left: 16px !important; height: min-content !important; }
      [data-id="div-mt9uiobn-7"] { width: 100% !important; height: min-content !important; }
      [data-id="div-mt9uiobo-v"] { width: 100% !important; height: 15px !important; }
      [data-id="div-mt9uiobo-x"] { height: min-content !important; }
      [data-id="div-mt9uiobo-k"] { width: 100% !important; }
      [data-id="div-mt9uiobo-a"] { width: 100% !important; }
      [data-id="div-mt9uiobn-8"] { width: 100% !important; }
      [data-id="div-mt9uiobo-p"] { width: 100% !important; }
      [data-id="div-mt9uiobg-5"] { height: min-content !important; }
      [data-id="div-mt9uiobo-2y"] { padding-top: 0px !important; padding-right: 16px !important; padding-bottom: 16px !important; padding-left: 16px !important; }
      [data-id="p-mt9uiobo-30"] { width: 100% !important; }
      [data-id="p-mt9uiobo-32"] { width: 100% !important; font-size: 68px !important; }
      [data-id="div-mt9uiobo-33"] { height: min-content !important; }
      [data-id="div-mt9uiobo-1l"] { height: min-content !important; padding-top: 0 !important; padding-right: 16px !important; padding-bottom: 0 !important; padding-left: 16px !important; }
      [data-id="div-mt9uiobo-1m"] { width: 100% !important; }
      [data-id="div-mt9uiobo-1p"] { flex-direction: column !important; height: min-content !important; }
      [data-id="div-mt9uiobo-1q"] { width: 100% !important; flex: 0 0 auto !important; }
      [data-id="div-mt9uiobo-1v"] { width: 100% !important; flex: 0 0 auto !important; }
      [data-id="div-mt9uiobo-20"] { width: 100% !important; flex: 0 0 auto !important; }
      [data-id="div-mt9uiobo-25"] { width: 100% !important; flex: 0 0 auto !important; }
      [data-id="div-mt9uiobo-1o"] { height: min-content !important; width: 100% !important; }
      [data-id="div-mt9uiobo-1k"] { height: min-content !important; padding-top: 40px !important; padding-right: 0 !important; padding-bottom: 40px !important; padding-left: 0 !important; }
    }
  \`}</style>
        
    <div data-id="div-mt9uiobg-1" data-name="Sleek Agency Portfolio Landing Page" style={{
      display: 'flex',
      width: '100%',
      height: 'min-content',
      flexDirection: 'column',
      alignItems: 'flex-start',
      backgroundColor: '#0A0A0A',
      position: 'relative',
      order: '2'
    }}>
        <div data-id="div-mt9uiobg-2" data-name="CaseStudy" style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        width: '100%',
        height: 'min-content',
        backgroundColor: '#0A0A0A',
        position: 'relative',
        flex: '0 0 auto',
        order: '0'
      }}>
          <div data-id="div-mt9uiobg-3" data-name="Placeholder for CaseStudy" style={{
          height: '681.695px',
          width: '100%',
          position: 'relative',
          flex: '0 0 auto',
          order: '0'
        }}></div>
          <div data-id="div-mt9uiobg-4" data-name="Section" style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          borderBottom: '1px solid rgba(245, 242, 236, 0.08)',
          width: '100%',
          height: '484px',
          position: 'relative',
          flex: '0 0 auto',
          order: '1',
          paddingTop: '112px',
          paddingRight: '80px',
          paddingBottom: '112px',
          paddingLeft: '80px'
        }}>
            <div data-id="div-mt9uiobg-5" data-name="Container" style={{
            display: 'flex',
            maxWidth: '1440px',
            flexDirection: 'column',
            alignItems: 'flex-start',
            width: '100%',
            height: '259px',
            position: 'relative',
            flex: '0 0 auto',
            order: '0',
            paddingTop: '0',
            paddingRight: '0px',
            paddingBottom: '0',
            paddingLeft: '0px'
          }}>
              <div data-id="div-mt9uiobg-6" data-name="Container" style={{
              display: 'flex',
              height: '259px',
              width: '100%',
              position: 'relative',
              flex: '0 0 auto',
              order: '0',
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center'
            }}>
                <div data-id="div-mt9uiobn-7" data-name="Container" data-pinned="true" style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-start',
                gridRow: '1 / span 1',
                gridColumn: '1 / span 4',
                justifySelf: 'stretch',
                height: '259.24200439453125px',
                position: 'relative',
                width: '369px'
              }}>
                  <div data-id="div-mt9uiobn-8" data-name="Paragraph" style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  width: '301px',
                  height: 'min-content',
                  position: 'relative',
                  flex: '0 0 auto',
                  order: '0'
                }}>
                    <p data-id="p-mt9uiobn-9" data-name="Scope of work" style={{
                    color: '#6B6864',
                    fontFamily: '"DM Mono", sans-serif',
                    fontSize: '10.88px',
                    fontStyle: 'normal',
                    fontWeight: '400',
                    lineHeight: '1.333',
                    letterSpacing: '1.741px',
                    textTransform: 'uppercase',
                    width: '106px',
                    margin: '0px',
                    height: 'auto',
                    position: 'relative',
                    flex: '0 0 auto',
                    order: '0'
                  }}>
                      Scope of work
                    </p>
                  </div>
                  <div data-id="div-mt9uiobo-a" data-name="Container:margin" style={{
                  display: 'flex',
                  paddingTop: '24px',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  width: 'min-content',
                  height: '89px',
                  position: 'relative',
                  flex: '0 0 auto',
                  order: '1'
                }}>
                    <div data-id="div-mt9uiobo-b" data-name="Container" style={{
                    height: '65px',
                    width: 'min-content',
                    position: 'relative',
                    flex: '0 0 auto',
                    order: '0',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    justifyContent: 'center',
                    display: 'flex',
                    gap: '8px'
                  }}>
                      
    <div data-id="frame-mt9vyfbs-3b" data-name="Frame" style={{
                      position: 'relative',
                      width: 'min-content',
                      height: 'min-content',
                      display: 'flex',
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'center',
                      backgroundColor: 'rgba(0, 0, 0, 0)',
                      overflow: 'visible',
                      gap: '8px',
                      flex: '0 0 auto'
                    }}>
    <div data-id="div-mt9uiobo-e" data-name="Text" data-pinned="true" style={{
                        display: 'flex',
                        padding: '6px 12px',
                        flexDirection: 'column',
                        alignItems: 'flex-start',
                        border: '1px solid rgba(245, 242, 236, 0.15)',
                        width: '126px',
                        height: '28px'
                      }}>
                        <p data-id="p-mt9uiobo-f" data-name="Art Direction" style={{
                          color: '#C8C4BC',
                          fontFamily: '"DM Mono", sans-serif',
                          fontSize: '10.88px',
                          fontStyle: 'normal',
                          fontWeight: '400',
                          lineHeight: '1.333',
                          letterSpacing: '1.306px',
                          textTransform: 'uppercase',
                          width: '101px',
                          margin: '0px',
                          height: 'auto',
                          position: 'relative',
                          flex: '0 0 auto',
                          order: '0',
                          whiteSpace: 'nowrap'
                        }}>{item.untitled20}</p>
                      </div>
  
    <div data-id="div-mt9uiobo-c" data-name="Text" data-pinned="true" style={{
                        display: 'flex',
                        padding: '6px 12px',
                        flexDirection: 'column',
                        alignItems: 'flex-start',
                        border: '1px solid rgba(245, 242, 236, 0.15)',
                        width: 'min-content',
                        height: 'min-content'
                      }}>
                        <p data-id="p-mt9uiobo-d" data-name="UX Strategy" style={{
                          color: '#C8C4BC',
                          fontFamily: '"DM Mono", sans-serif',
                          fontSize: '10.88px',
                          fontStyle: 'normal',
                          fontWeight: '400',
                          lineHeight: '1.333',
                          letterSpacing: '1.306px',
                          textTransform: 'uppercase',
                          width: 'min-content',
                          margin: '0px',
                          height: 'auto',
                          position: 'relative',
                          flex: '0 0 auto',
                          order: '0',
                          display: 'flex',
                          flexDirection: 'column',
                          whiteSpace: 'nowrap'
                        }}>{item.untitled21}</p>
                      </div>
  </div>
                      
    <div data-id="frame-mt9vxihy-3a" data-name="Frame" style={{
                      position: 'relative',
                      width: 'min-content',
                      height: 'min-content',
                      display: 'flex',
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'center',
                      backgroundColor: 'rgba(0, 0, 0, 0)',
                      overflow: 'visible',
                      gap: '8px',
                      flex: '0 0 auto'
                    }}>
    <div data-id="div-mt9uiobo-g" data-name="Text" data-pinned="true" style={{
                        display: 'flex',
                        padding: '6px 12px',
                        flexDirection: 'column',
                        alignItems: 'flex-start',
                        border: '1px solid rgba(245, 242, 236, 0.15)',
                        width: 'min-content',
                        height: 'min-content'
                      }}>
                        <p data-id="p-mt9uiobo-h" data-name="Web Design" style={{
                          color: '#C8C4BC',
                          fontFamily: '"DM Mono", sans-serif',
                          fontSize: '10.88px',
                          fontStyle: 'normal',
                          fontWeight: '400',
                          lineHeight: '1.333',
                          letterSpacing: '1.306px',
                          textTransform: 'uppercase',
                          width: 'min-content',
                          margin: '0px',
                          height: 'auto',
                          position: 'relative',
                          flex: '0 0 auto',
                          order: '0',
                          whiteSpace: 'nowrap'
                        }}>{item.untitled22}</p>
                      </div>
  
    <div data-id="div-mt9uiobo-i" data-name="Text" data-pinned="true" style={{
                        display: 'flex',
                        padding: '6px 12px',
                        flexDirection: 'column',
                        alignItems: 'flex-start',
                        border: '1px solid rgba(245, 242, 236, 0.15)',
                        width: 'min-content',
                        height: 'min-content'
                      }}>
                        <p data-id="p-mt9uiobo-j" data-name="Development" style={{
                          color: '#C8C4BC',
                          fontFamily: '"DM Mono", sans-serif',
                          fontSize: '10.88px',
                          fontStyle: 'normal',
                          fontWeight: '400',
                          lineHeight: '1.333',
                          letterSpacing: '1.306px',
                          textTransform: 'uppercase',
                          width: 'min-content',
                          margin: '0px',
                          height: 'auto',
                          position: 'relative',
                          flex: '0 0 auto',
                          order: '0',
                          whiteSpace: 'nowrap',
                          transform: 'rotate(0deg)'
                        }}>{item.untitled23}</p>
                      </div>
  </div>
                    </div>
                  </div>
                  <div data-id="div-mt9uiobo-k" data-name="Container" style={{
                  display: 'flex',
                  width: '301px',
                  height: 'min-content',
                  paddingTop: '24px',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  position: 'relative',
                  flex: '0 0 auto',
                  order: '2'
                }}>
                    <div data-id="div-mt9uiobo-l" data-name="Paragraph" style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    width: '301px',
                    height: '14px',
                    position: 'relative',
                    flex: '0 0 auto',
                    order: '0'
                  }}>
                      <p data-id="p-mt9uiobo-m" data-name="Client" style={{
                      color: '#6B6864',
                      fontFamily: '"DM Mono", sans-serif',
                      fontSize: '10.4px',
                      fontStyle: 'normal',
                      fontWeight: '400',
                      lineHeight: '1.333',
                      letterSpacing: '1.04px',
                      textTransform: 'uppercase',
                      width: '43px',
                      margin: '0px',
                      height: 'auto',
                      position: 'relative',
                      flex: '0 0 auto',
                      order: '0'
                    }}>
                        Client
                      </p>
                    </div>
                    <div data-id="div-mt9uiobo-n" data-name="Paragraph" style={{
                    display: 'flex',
                    width: '301px',
                    height: '32px',
                    paddingTop: '8px',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    position: 'relative',
                    flex: '0 0 auto',
                    order: '1'
                  }}>
                      <p data-id="p-mt9uiobo-o" data-name="Meridian Architects" style={{
                      color: '#F5F2EC',
                      fontFamily: 'Barlow, sans-serif',
                      fontSize: '16px',
                      fontStyle: 'normal',
                      fontWeight: '400',
                      lineHeight: '1.5',
                      width: '136px',
                      margin: '0px',
                      height: 'auto',
                      position: 'relative',
                      flex: '0 0 auto',
                      order: '0'
                    }}>{item.untitled4}</p>
                    </div>
                  </div>
                  <div data-id="div-mt9uiobo-p" data-name="Container" style={{
                  display: 'flex',
                  width: '301px',
                  height: '70px',
                  paddingTop: '24px',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  position: 'relative',
                  flex: '0 0 auto',
                  order: '3'
                }}>
                    <div data-id="div-mt9uiobo-q" data-name="Paragraph" style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    width: '301px',
                    height: '14px',
                    position: 'relative',
                    flex: '0 0 auto',
                    order: '0'
                  }}>
                      <p data-id="p-mt9uiobo-r" data-name="Year" style={{
                      color: '#6B6864',
                      fontFamily: '"DM Mono", sans-serif',
                      fontSize: '10.4px',
                      fontStyle: 'normal',
                      fontWeight: '400',
                      lineHeight: '1.333',
                      letterSpacing: '1.04px',
                      textTransform: 'uppercase',
                      width: '29px',
                      margin: '0px',
                      height: 'auto',
                      position: 'relative',
                      flex: '0 0 auto',
                      order: '0'
                    }}>
                        Year
                      </p>
                    </div>
                    <div data-id="div-mt9uiobo-s" data-name="Paragraph" style={{
                    display: 'flex',
                    width: '301px',
                    height: '32px',
                    paddingTop: '8px',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    position: 'relative',
                    flex: '0 0 auto',
                    order: '1'
                  }}>
                      <p data-id="p-mt9uiobo-t" data-name="2024" style={{
                      color: '#F5F2EC',
                      fontFamily: 'Barlow, sans-serif',
                      fontSize: '16px',
                      fontStyle: 'normal',
                      fontWeight: '400',
                      lineHeight: '1.5',
                      width: '36px',
                      margin: '0px',
                      height: 'auto',
                      position: 'relative',
                      flex: '0 0 auto',
                      order: '0'
                    }}>{item.untitled5}</p>
                    </div>
                  </div>
                </div>
                <div data-id="div-mt9uiobo-u" data-name="Container" data-pinned="true" style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-start',
                gridRow: '1 / span 1',
                gridColumn: '5 / span 8',
                justifySelf: 'stretch',
                height: '259.24200439453125px',
                position: 'relative',
                flex: '1 0 0px'
              }}>
                  <div data-id="div-mt9uiobo-v" data-name="Paragraph" style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  width: '666px',
                  height: '15px',
                  position: 'relative',
                  flex: '0 0 auto',
                  order: '0'
                }}>
                    <p data-id="p-mt9uiobo-w" data-name="Overview" style={{
                    color: '#6B6864',
                    fontFamily: '"DM Mono", sans-serif',
                    fontSize: '10.88px',
                    fontStyle: 'normal',
                    fontWeight: '400',
                    lineHeight: '1.333',
                    letterSpacing: '1.741px',
                    textTransform: 'uppercase',
                    width: 'min-content',
                    margin: '0px',
                    height: 'auto',
                    position: 'relative',
                    flex: '0 0 auto',
                    order: '0'
                  }}>
                      Overview
                    </p>
                  </div>
                  <div data-id="div-mt9uiobo-x" data-name="Paragraph" style={{
                  display: 'flex',
                  paddingTop: '24px',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  width: '100%',
                  height: '112px',
                  position: 'relative',
                  flex: '0 0 auto',
                  order: '1'
                }}>
                    <p data-id="p-mt9uiobo-y" data-name="Meridian Architects is a forty-person practice kno" style={{
                    width: '100%',
                    color: '#C8C4BC',
                    fontFamily: 'Barlow, sans-serif',
                    fontSize: '18.032px',
                    fontStyle: 'normal',
                    fontWeight: '400',
                    lineHeight: '1.625',
                    margin: '0px',
                    height: 'auto',
                    position: 'relative',
                    flex: '0 0 auto',
                    order: '0',
                    maxWidth: '666px'
                  }}>{item.untitled3}</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div data-id="div-mt9uiobo-z" data-name="Container" style={{
          display: 'flex',
          width: '100%',
          maxWidth: '100%',
          flexDirection: 'column',
          alignItems: 'flex-start',
          height: '1291px',
          position: 'relative',
          flex: '0 0 auto',
          order: '2',
          paddingTop: '112px',
          paddingRight: '80px',
          paddingBottom: '112px',
          paddingLeft: '80px'
        }}>
            <div data-id="div-mt9uiobo-10" data-name="Container" style={{
            display: 'flex',
            height: '139px',
            width: '100%',
            position: 'relative',
            flex: '0 0 auto',
            order: '0',
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-evenly',
            gap: '80px'
          }}>
              <div data-id="div-mt9uiobo-11" data-name="Container" data-pinned="true" style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-start',
              gridRow: '1 / span 1',
              gridColumn: '1 / span 1',
              justifySelf: 'stretch',
              height: '138.50799560546875px',
              position: 'relative',
              flex: '1 0 0px'
            }}>
                <div data-id="div-mt9uiobo-12" data-name="Paragraph" style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-start',
                width: '100%',
                height: 'min-content',
                position: 'relative',
                flex: '0 0 auto',
                order: '0'
              }}>
                  <p data-id="p-mt9uiobo-13" data-name="The challenge" style={{
                  color: '#E8FF47',
                  fontFamily: '"DM Mono", sans-serif',
                  fontSize: '10.88px',
                  fontStyle: 'normal',
                  fontWeight: '400',
                  lineHeight: '1.333',
                  letterSpacing: '1.958px',
                  textTransform: 'uppercase',
                  width: 'min-content',
                  margin: '0px',
                  height: 'auto',
                  position: 'relative',
                  flex: '0 0 auto',
                  order: '0',
                  whiteSpace: 'nowrap'
                }}>
                    The challenge
                  </p>
                </div>
                <div data-id="div-mt9uiobo-14" data-name="Paragraph" style={{
                display: 'flex',
                width: '100%',
                paddingTop: '20px',
                flexDirection: 'column',
                alignItems: 'flex-start',
                height: 'min-content',
                position: 'relative',
                flex: '0 0 auto',
                order: '1'
              }}>
                  <p data-id="p-mt9uiobo-15" data-name="Architecture practices are notoriously hard to dif" style={{
                  width: '100%',
                  color: '#C8C4BC',
                  fontFamily: 'Barlow, sans-serif',
                  fontSize: '16px',
                  fontStyle: 'normal',
                  fontWeight: '400',
                  lineHeight: '1.625',
                  margin: '0px',
                  height: 'auto',
                  position: 'relative',
                  flex: '0 0 auto',
                  order: '0'
                }}>{item.untitled6}</p>
                </div>
              </div>
              <div data-id="div-mt9uiobo-16" data-name="Container" data-pinned="true" style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-start',
              gridRow: '1 / span 1',
              gridColumn: '2 / span 1',
              justifySelf: 'stretch',
              height: '138.50799560546875px',
              position: 'relative',
              flex: '1 0 0px'
            }}>
                <div data-id="div-mt9uiobo-17" data-name="Paragraph" style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-start',
                width: '100%',
                height: 'min-content',
                position: 'relative',
                flex: '0 0 auto',
                order: '0'
              }}>
                  <p data-id="p-mt9uiobo-18" data-name="Our approach" style={{
                  color: '#E8FF47',
                  fontFamily: '"DM Mono", sans-serif',
                  fontSize: '10.88px',
                  fontStyle: 'normal',
                  fontWeight: '400',
                  lineHeight: '1.333',
                  letterSpacing: '1.958px',
                  textTransform: 'uppercase',
                  width: '100%',
                  margin: '0px',
                  height: 'auto',
                  position: 'relative',
                  flex: '0 0 auto',
                  order: '0',
                  whiteSpace: 'nowrap'
                }}>
                    Our approach
                  </p>
                </div>
                <div data-id="div-mt9uiobo-19" data-name="Paragraph" style={{
                display: 'flex',
                width: '100%',
                paddingTop: '20px',
                flexDirection: 'column',
                alignItems: 'flex-start',
                height: '124px',
                position: 'relative',
                flex: '0 0 auto',
                order: '1'
              }}>
                  <p data-id="p-mt9uiobo-1a" data-name="We led with their photography. A full-bleed editor" style={{
                  width: '100%',
                  color: '#C8C4BC',
                  fontFamily: 'Barlow, sans-serif',
                  fontSize: '16px',
                  fontStyle: 'normal',
                  fontWeight: '400',
                  lineHeight: '1.625',
                  margin: '0px',
                  height: 'auto',
                  position: 'relative',
                  flex: '0 0 auto',
                  order: '0'
                }}>{item.untitled7}</p>
                </div>
              </div>
            </div>
            <div data-id="div-mt9uiobo-1b" data-name="Container:margin" style={{
            display: 'flex',
            paddingTop: '80px',
            flexDirection: 'column',
            alignItems: 'flex-start',
            width: '100%',
            height: '531px',
            position: 'relative',
            flex: '0 0 auto',
            order: '1'
          }}>
              <div data-id="div-mt9uiobo-1c" data-name="Container" style={{
              display: 'flex',
              width: '100%',
              height: '451px',
              flexDirection: 'column',
              alignItems: 'flex-start',
              overflow: 'hidden',
              backgroundColor: '#1E1E1E',
              position: 'relative',
              flex: '0 0 auto',
              order: '0'
            }}>
                <div data-id="div-mt9uiobo-1d" data-name="Image (Project detail)" style={{
                height: '451px',
                width: '100%',
                overflow: 'hidden',
                backgroundImage: \`url(\${item.untitled8})\`,
                backgroundRepeat: 'no-repeat',
                backgroundSize: 'cover',
                backgroundPosition: 'center',
                position: 'relative',
                flex: '0 0 auto',
                order: '0'
              }}></div>
              </div>
            </div>
            <div data-id="div-mt9uiobo-1e" data-name="Container:margin" style={{
            display: 'flex',
            paddingTop: '16px',
            flexDirection: 'column',
            alignItems: 'flex-start',
            width: '100%',
            height: '397px',
            position: 'relative',
            flex: '0 0 auto',
            order: '2'
          }}>
              <div data-id="div-mt9uiobo-1f" data-name="Container" style={{
              display: 'flex',
              height: '381px',
              width: '100%',
              position: 'relative',
              flex: '0 0 auto',
              order: '0',
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '12px'
            }}>
                <div data-id="div-mt9uiobo-1g" data-name="Container" data-pinned="true" style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-start',
                gridRow: '1 / span 1',
                gridColumn: '1 / span 1',
                justifySelf: 'stretch',
                height: '380.625px',
                overflow: 'hidden',
                position: 'relative',
                backgroundColor: '#1E1E1E',
                flex: '1 0 0px'
              }}>
                  <div data-id="div-mt9uiobo-1h" data-name="Image (Project)" style={{
                  height: '381px',
                  width: '100%',
                  overflow: 'hidden',
                  backgroundImage: \`url(\${item.untitled9})\`,
                  backgroundRepeat: 'no-repeat',
                  backgroundSize: 'cover',
                  backgroundPosition: 'center',
                  position: 'relative',
                  flex: '0 0 auto',
                  order: '0'
                }}></div>
                </div>
                <div data-id="div-mt9uiobo-1i" data-name="Container" data-pinned="true" style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-start',
                gridRow: '1 / span 1',
                gridColumn: '2 / span 1',
                justifySelf: 'stretch',
                height: '380.625px',
                overflow: 'hidden',
                position: 'relative',
                backgroundColor: '#1E1E1E',
                flex: '1 0 0px'
              }}>
                  <div data-id="div-mt9uiobo-1j" data-name="Image (Project)" style={{
                  height: '381px',
                  width: '100%',
                  overflow: 'hidden',
                  backgroundImage: \`url(\${item.untitled10})\`,
                  backgroundRepeat: 'no-repeat',
                  backgroundSize: 'cover',
                  backgroundPosition: 'center',
                  position: 'relative',
                  flex: '0 0 auto',
                  order: '0'
                }}></div>
                </div>
              </div>
            </div>
          </div>
          <div data-id="div-mt9uiobo-1k" data-name="Section" style={{
          display: 'flex',
          padding: '112px 0',
          flexDirection: 'column',
          alignItems: 'flex-start',
          borderTop: '1px solid rgba(245, 242, 236, 0.08)',
          borderBottom: '1px solid rgba(245, 242, 236, 0.08)',
          width: '100%',
          height: '460px',
          backgroundColor: '#141414',
          position: 'relative',
          flex: '0 0 auto',
          order: '3'
        }}>
            <div data-id="div-mt9uiobo-1l" data-name="Container" style={{
            display: 'flex',
            maxWidth: '100%',
            flexDirection: 'column',
            alignItems: 'flex-start',
            width: '100%',
            height: '234px',
            position: 'relative',
            flex: '0 0 auto',
            order: '0',
            paddingTop: '0',
            paddingRight: '80px',
            paddingBottom: '0',
            paddingLeft: '80px'
          }}>
              <div data-id="div-mt9uiobo-1m" data-name="Paragraph" style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-start',
              width: '1031px',
              height: '15px',
              position: 'relative',
              flex: '0 0 auto',
              order: '0'
            }}>
                <p data-id="p-mt9uiobo-1n" data-name="Outcomes" style={{
                color: '#6B6864',
                fontFamily: '"DM Mono", sans-serif',
                fontSize: '10.88px',
                fontStyle: 'normal',
                fontWeight: '400',
                lineHeight: '1.333',
                letterSpacing: '1.958px',
                textTransform: 'uppercase',
                width: '66px',
                margin: '0px',
                height: 'auto',
                position: 'relative',
                flex: '0 0 auto',
                order: '0'
              }}>
                  Outcomes
                </p>
              </div>
              <div data-id="div-mt9uiobo-1o" data-name="Container:margin" style={{
              display: 'flex',
              paddingTop: '56px',
              flexDirection: 'column',
              alignItems: 'flex-start',
              width: '100%',
              height: '219px',
              position: 'relative',
              flex: '0 0 auto',
              order: '1'
            }}>
                <div data-id="div-mt9uiobo-1p" data-name="Container" style={{
                display: 'flex',
                height: '163px',
                borderLeft: '1px solid rgba(245, 242, 236, 0.08)',
                width: '100%',
                position: 'relative',
                flex: '0 0 auto',
                order: '0',
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center'
              }}>
                  <div data-id="div-mt9uiobo-1q" data-name="Container" data-pinned="true" style={{
                  display: 'flex',
                  padding: '40px 32px',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  gridRow: '1 / span 1',
                  gridColumn: '1 / span 1',
                  justifySelf: 'stretch',
                  borderRight: '1px solid rgba(245, 242, 236, 0.08)',
                  borderBottom: '1px solid rgba(245, 242, 236, 0.08)',
                  height: '163.21099853515625px',
                  position: 'relative',
                  flex: '1 0 0px', order: '0'
                }}>
                    <div data-id="div-mt9uiobo-1r" data-name="Container" style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    width: '192.5px',
                    height: '57px',
                    position: 'relative',
                    flex: '0 0 auto',
                    order: '0'
                  }}>
                      <p data-id="p-mt9uiobo-1s" data-name="+210%" style={{
                      color: '#E8FF47',
                      fontFamily: '"Barlow Condensed", sans-serif',
                      fontSize: '56.35px',
                      fontStyle: 'normal',
                      fontWeight: '400',
                      lineHeight: '1',
                      letterSpacing: '-1.127px',
                      width: '125px',
                      margin: '0px',
                      height: 'auto',
                      position: 'relative',
                      flex: '0 0 auto',
                      order: '0'
                    }}>
                        +210%
                      </p>
                    </div>
                    <div data-id="div-mt9uiobo-1t" data-name="Container" style={{
                    display: 'flex',
                    width: '192.5px',
                    height: 'min-content',
                    paddingTop: '12px',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    position: 'relative',
                    flex: '0 0 auto',
                    order: '1'
                  }}>
                      <p data-id="p-mt9uiobo-1u" data-name="Avg. session duration" style={{
                      color: '#6B6864',
                      fontFamily: '"DM Mono", sans-serif',
                      fontSize: '10.4px',
                      fontStyle: 'normal',
                      fontWeight: '400',
                      lineHeight: '1.333',
                      letterSpacing: '1.04px',
                      textTransform: 'uppercase',
                      width: '152px',
                      margin: '0px',
                      height: 'auto',
                      position: 'relative',
                      flex: '0 0 auto',
                      order: '0',
                      whiteSpace: 'nowrap'
                    }}>
                        Avg. session duration
                      </p>
                    </div>
                  </div>
                  <div data-id="div-mt9uiobo-1v" data-name="Container" data-pinned="true" style={{
                  display: 'flex',
                  padding: '40px 32px',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  gridRow: '1 / span 1',
                  gridColumn: '2 / span 1',
                  justifySelf: 'stretch',
                  borderRight: '1px solid rgba(245, 242, 236, 0.08)',
                  borderBottom: '1px solid rgba(245, 242, 236, 0.08)',
                  height: '163.21099853515625px',
                  position: 'relative',
                  flex: '1 0 0px', order: '1'
                }}>
                    <div data-id="div-mt9uiobo-1w" data-name="Container" style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    width: '192.5px',
                    height: '57px',
                    position: 'relative',
                    flex: '0 0 auto',
                    order: '0'
                  }}>
                      <p data-id="p-mt9uiobo-1x" data-name="4.2s" style={{
                      color: '#E8FF47',
                      fontFamily: '"Barlow Condensed", sans-serif',
                      fontSize: '56.35px',
                      fontStyle: 'normal',
                      fontWeight: '400',
                      lineHeight: '1',
                      letterSpacing: '-1.127px',
                      width: '75px',
                      margin: '0px',
                      height: 'auto',
                      position: 'relative',
                      flex: '0 0 auto',
                      order: '0'
                    }}>
                        4.2s
                      </p>
                    </div>
                    <div data-id="div-mt9uiobo-1y" data-name="Container" style={{
                    display: 'flex',
                    width: '192.5px',
                    height: 'min-content',
                    paddingTop: '12px',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    position: 'relative',
                    flex: '0 0 auto',
                    order: '1'
                  }}>
                      <p data-id="p-mt9uiobo-1z" data-name="Avg. time to first scroll" style={{
                      color: '#6B6864',
                      fontFamily: '"DM Mono", sans-serif',
                      fontSize: '10.4px',
                      fontStyle: 'normal',
                      fontWeight: '400',
                      lineHeight: '1.333',
                      letterSpacing: '1.04px',
                      textTransform: 'uppercase',
                      width: '181px',
                      margin: '0px',
                      height: 'auto',
                      position: 'relative',
                      flex: '0 0 auto',
                      order: '0',
                      whiteSpace: 'nowrap'
                    }}>
                        Avg. time to first scroll
                      </p>
                    </div>
                  </div>
                  <div data-id="div-mt9uiobo-20" data-name="Container" data-pinned="true" style={{
                  display: 'flex',
                  padding: '40px 32px',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  gridRow: '1 / span 1',
                  gridColumn: '3 / span 1',
                  justifySelf: 'stretch',
                  borderRight: '1px solid rgba(245, 242, 236, 0.08)',
                  borderBottom: '1px solid rgba(245, 242, 236, 0.08)',
                  height: '163.21099853515625px',
                  position: 'relative',
                  flex: '1 0 0px', order: '2'
                }}>
                    <div data-id="div-mt9uiobo-21" data-name="Container" style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    width: '192.5px',
                    height: '57px',
                    position: 'relative',
                    flex: '0 0 auto',
                    order: '0'
                  }}>
                      <p data-id="p-mt9uiobo-22" data-name="+61%" style={{
                      color: '#E8FF47',
                      fontFamily: '"Barlow Condensed", sans-serif',
                      fontSize: '56.35px',
                      fontStyle: 'normal',
                      fontWeight: '400',
                      lineHeight: '1',
                      letterSpacing: '-1.127px',
                      width: '102px',
                      margin: '0px',
                      height: 'auto',
                      position: 'relative',
                      flex: '0 0 auto',
                      order: '0'
                    }}>
                        +61%
                      </p>
                    </div>
                    <div data-id="div-mt9uiobo-23" data-name="Container" style={{
                    display: 'flex',
                    width: '192.5px',
                    height: 'min-content',
                    paddingTop: '12px',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    position: 'relative',
                    flex: '0 0 auto',
                    order: '1'
                  }}>
                      <p data-id="p-mt9uiobo-24" data-name="RFP submissions" style={{
                      color: '#6B6864',
                      fontFamily: '"DM Mono", sans-serif',
                      fontSize: '10.4px',
                      fontStyle: 'normal',
                      fontWeight: '400',
                      lineHeight: '1.333',
                      letterSpacing: '1.04px',
                      textTransform: 'uppercase',
                      width: '109px',
                      margin: '0px',
                      height: 'auto',
                      position: 'relative',
                      flex: '0 0 auto',
                      order: '0',
                      whiteSpace: 'nowrap'
                    }}>
                        RFP submissions
                      </p>
                    </div>
                  </div>
                  <div data-id="div-mt9uiobo-25" data-name="Container" data-pinned="true" style={{
                  display: 'flex',
                  padding: '40px 32px',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  gridRow: '1 / span 1',
                  gridColumn: '4 / span 1',
                  justifySelf: 'stretch',
                  borderRight: '1px solid rgba(245, 242, 236, 0.08)',
                  borderBottom: '1px solid rgba(245, 242, 236, 0.08)',
                  height: '163.21099853515625px',
                  position: 'relative',
                  flex: '1 0 0px', order: '3'
                }}>
                    <div data-id="div-mt9uiobo-26" data-name="Container" style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    width: '192.5px',
                    height: '57px',
                    position: 'relative',
                    flex: '0 0 auto',
                    order: '0'
                  }}>
                      <p data-id="p-mt9uiobo-27" data-name="D&AD" style={{
                      color: '#E8FF47',
                      fontFamily: '"Barlow Condensed", sans-serif',
                      fontSize: '56.35px',
                      fontStyle: 'normal',
                      fontWeight: '400',
                      lineHeight: '1',
                      letterSpacing: '-1.127px',
                      width: '103px',
                      margin: '0px',
                      height: 'auto',
                      position: 'relative',
                      flex: '0 0 auto',
                      order: '0'
                    }}>
                        D&AD
                      </p>
                    </div>
                    <div data-id="div-mt9uiobo-28" data-name="Container" style={{
                    display: 'flex',
                    width: '192.5px',
                    height: 'min-content',
                    paddingTop: '12px',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    position: 'relative',
                    flex: '0 0 auto',
                    order: '1'
                  }}>
                      <p data-id="p-mt9uiobo-29" data-name="Shortlisted 2024" style={{
                      color: '#6B6864',
                      fontFamily: '"DM Mono", sans-serif',
                      fontSize: '10.4px',
                      fontStyle: 'normal',
                      fontWeight: '400',
                      lineHeight: '1.333',
                      letterSpacing: '1.04px',
                      textTransform: 'uppercase',
                      width: '116px',
                      margin: '0px',
                      height: 'auto',
                      position: 'relative',
                      flex: '0 0 auto',
                      order: '0',
                      whiteSpace: 'nowrap'
                    }}>
                        Shortlisted 2024
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div data-id="div-mt9uiobo-2a" data-name="Section" style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          borderBottom: '1px solid rgba(245, 242, 236, 0.08)',
          width: '100%',
          height: '376.6640625px',
          position: 'relative',
          flex: '0 0 auto',
          order: '4'
        }}>
            <div data-id="div-mt9uiobo-2b" data-name="Link" style={{
            display: 'flex',
            height: '375.664px',
            flexDirection: 'column',
            alignItems: 'flex-start',
            width: '100%',
            overflow: 'hidden',
            position: 'relative',
            flex: '0 0 auto',
            order: '0'
          }}>
              <div data-id="div-mt9uiobo-2c" data-name="CaseStudy" style={{
              height: '375.664px',
              width: '100%',
              overflow: 'hidden',
              backgroundColor: '#1E1E1E',
              position: 'relative',
              flex: '0 0 auto',
              order: '0'
            }}>
                <div data-id="div-mt9uiobo-2d" data-name="Image (FORM STUDIO)" data-pinned="true" style={{
                width: '100%',
                height: '375.664px',
                opacity: '0.3',
                overflow: 'hidden',
                position: 'absolute',
                left: '0px',
                top: '0px',
                backgroundImage: 'url(https://assets.revyme.app/b072a507-4f93-11f1-a46a-920007cce419/055d350c-ac4d-11f1-b3b1-920007cce419/images/uploaded/bca362287f73a32f.webp)',
                backgroundRepeat: 'no-repeat',
                backgroundSize: 'cover',
                backgroundPosition: 'center'
              }}></div>
                <div data-id="div-mt9uiobo-2e" data-name="Container" data-pinned="true" style={{
                width: '100%',
                height: '375.664px',
                position: 'absolute',
                left: '0px',
                top: '0px',
                backgroundImage: 'linear-gradient(180deg, rgba(10, 10, 10, 0.30) 0%, rgba(10, 10, 10, 0.70) 100%)'
              }}></div>
                <div data-id="div-mt9uiobo-2f" data-name="Container" data-pinned="true" style={{
                display: 'flex',
                width: '100%',
                height: '375.664px',
                padding: '0 24px',
                flexDirection: 'column',
                justifyContent: 'center',
                alignItems: 'center',
                position: 'absolute',
                left: '0px',
                top: '0px'
              }}>
                  <div data-id="div-mt9uiobo-2g" data-name="Paragraph:margin" style={{
                  display: 'flex',
                  paddingBottom: '20px',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  width: '103px',
                  height: '35px',
                  position: 'relative',
                  flex: '0 0 auto',
                  order: '0'
                }}>
                    <p data-id="p-mt9uiobo-2h" data-name="Next project" style={{
                    color: '#E8FF47',
                    textAlign: 'center',
                    fontFamily: '"DM Mono", sans-serif',
                    fontSize: '11.2px',
                    fontStyle: 'normal',
                    fontWeight: '400',
                    lineHeight: '1.333',
                    letterSpacing: '2.016px',
                    textTransform: 'uppercase',
                    width: '103px',
                    margin: '0px',
                    height: 'auto',
                    position: 'relative',
                    flex: '0 0 auto',
                    order: '0',
                    whiteSpace: 'nowrap'
                  }}>Next project</p>
                  </div>
                  <div data-id="div-mt9uiobo-2i" data-name="Heading 2" style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  width: '384px',
                  height: '83px',
                  position: 'relative',
                  flex: '0 0 auto',
                  order: '1'
                }}>
                    <p data-id="p-mt9uiobo-2j" data-name="FORM STUDIO" style={{
                    color: '#F5F2EC',
                    textAlign: 'center',
                    fontFamily: '"Barlow Condensed", sans-serif',
                    fontSize: '90.16px',
                    fontStyle: 'normal',
                    fontWeight: '400',
                    lineHeight: '0.92',
                    letterSpacing: '-1.803px',
                    width: '384px',
                    margin: '0px',
                    height: 'auto',
                    position: 'relative',
                    flex: '0 0 auto',
                    order: '0'
                  }}>
                      FORM STUDIO
                    </p>
                  </div>
                  <div data-id="div-mt9uiobo-2k" data-name="Container:margin" style={{
                  display: 'flex',
                  paddingTop: '32px',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  width: '56px',
                  height: '88px',
                  position: 'relative',
                  flex: '0 0 auto',
                  order: '2'
                }}>
                    <div data-id="div-mt9uiobo-2l" data-name="Container" style={{
                    display: 'flex',
                    width: '56px',
                    height: '56px',
                    justifyContent: 'center',
                    alignItems: 'center',
                    borderRadius: '16777200px',
                    border: '1px solid rgba(245, 242, 236, 0.40)',
                    position: 'relative',
                    flex: '0 0 auto',
                    order: '0'
                  }}>
                      <p data-id="p-mt9uiobo-2m" data-name="→" style={{
                      color: '#F5F2EC',
                      textAlign: 'center',
                      fontFamily: 'Barlow, sans-serif',
                      fontSize: '20px',
                      fontStyle: 'normal',
                      fontWeight: '400',
                      lineHeight: '1.4',
                      width: '20px',
                      margin: '0px',
                      height: 'auto',
                      position: 'relative',
                      flex: '0 0 auto',
                      order: '0'
                    }}>
                        →
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
                  </div>
        <div data-id="div-mt9uiobo-2v" data-name="CaseStudy" data-pinned="true" style={{
        width: '100%',
        height: '681.695px',
        position: 'absolute',
        overflow: 'hidden',
        left: '0px',
        top: '0px',
        backgroundColor: '#141414',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        display: 'flex'
      }}>
          <div data-id="div-mt9uiobo-2w" data-name="Image (MERIDIAN ARCHITECTS)" data-pinned="true" style={{
          width: '100%',
          height: '681.695px',
          opacity: '0.35',
          overflow: 'hidden',
          position: 'absolute',
          backgroundImage: \`url(\${item.untitled19})\`,
          backgroundRepeat: 'no-repeat',
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          flex: '0 0 auto',
          left: '0px',
          top: '0.15354207397052733px'
        }}></div>
          <div data-id="div-mt9uiobo-2x" data-name="Container" data-pinned="true" style={{
          width: '100%',
          position: 'absolute',
          backgroundImage: 'linear-gradient(180deg, rgba(10, 10, 10, 0.20) 0%, rgba(10, 10, 10, 0.85) 100%)',
          left: '0px',
          top: '0px',
          height: '682px'
        }}></div>
          <div data-id="div-mt9uiobo-2y" data-name="Container" data-pinned="true" style={{
          display: 'flex',
          width: '100%',
          maxWidth: '100%',
          flexDirection: 'column',
          alignItems: 'flex-start',
          position: 'relative',
          flex: '1 0 0px',
          paddingTop: '0px',
          paddingRight: '48px',
          paddingBottom: '80px',
          paddingLeft: '48px',
          justifyContent: 'flex-end'
        }}>
            <div data-id="div-mt9uiobo-2z" data-name="Paragraph" style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-start',
            width: '100%',
            height: '15px',
            position: 'relative',
            flex: '0 0 auto',
            order: '0'
          }}>
              <p data-id="p-mt9uiobo-30" data-name="02 — Web Experience — 2024" style={{
              color: '#E8FF47',
              fontFamily: '"DM Mono", sans-serif',
              fontSize: '11.2px',
              fontStyle: 'normal',
              fontWeight: '400',
              lineHeight: '1.333',
              letterSpacing: '2.016px',
              textTransform: 'uppercase',
              width: '100%',
              margin: '0px',
              height: 'auto',
              position: 'relative',
              flex: '0 0 auto',
              order: '0'
            }}>{item.title}</p>
            </div>
            <div data-id="div-mt9uiobo-31" data-name="Heading 1" style={{
            display: 'flex',
            width: '100%',
            height: 'min-content',
            paddingTop: '16px',
            flexDirection: 'column',
            alignItems: 'flex-start',
            position: 'relative',
            flex: '0 0 auto',
            order: '1'
          }}>
              <p data-id="p-mt9uiobo-32" data-name="MERIDIAN ARCHITECTS" style={{
              color: '#F5F2EC',
              fontFamily: '"Barlow Condensed", sans-serif',
              fontSize: '101.43px',
              fontStyle: 'normal',
              fontWeight: '400',
              lineHeight: '0.92',
              letterSpacing: '-2.536px',
              width: '717px',
              margin: '0px',
              height: 'auto',
              position: 'relative',
              flex: '0 0 auto',
              order: '0'
            }}>{item.untitled}</p>
            </div>
            <div data-id="div-mt9uiobo-33" data-name="Paragraph" style={{
            display: 'flex',
            width: '100%',
            height: '58px',
            maxWidth: '672px',
            paddingTop: '24px',
            flexDirection: 'column',
            alignItems: 'flex-start',
            position: 'relative',
            flex: '0 0 auto',
            order: '2'
          }}>
              <p data-id="p-mt9uiobo-34" data-name="A digital portfolio that matches the ambition of t" style={{
              color: '#C8C4BC',
              fontFamily: 'Barlow, sans-serif',
              fontSize: '22.4px',
              fontStyle: 'normal',
              fontWeight: '400',
              lineHeight: '1.5',
              width: '100%',
              margin: '0px',
              height: 'auto',
              position: 'relative',
              flex: '0 0 auto',
              order: '0'
            }}>{item.untitled2}</p>
            </div>
          </div>
        </div>
        <div data-id="div-mt9uiobo-35" data-name="CaseStudy" data-pinned="true" style={{
        display: 'flex',
        width: '100%',
        height: '80px',
        padding: '0 48px',
        justifyContent: 'space-between',
        alignItems: 'center',
        position: 'absolute',
        borderBottom: '1px solid rgba(245, 242, 236, 0.06)',
        backdropFilter: 'blur(12px)',
        left: '0px',
        top: '0px',
        backgroundColor: 'rgba(10, 10, 10, 0.92)'
      }}>
          <div data-id="div-mt9uiobo-36" data-name="Link" style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          width: '55px',
          height: '28px',
          position: 'relative',
          flex: '0 0 auto',
          order: '0'
        }}>
            <p data-id="p-mt9uiobo-37" data-name="ATELIER." style={{
            color: '#E8FF47',
            fontFamily: '"Barlow Condensed", sans-serif',
            fontSize: '20px',
            fontStyle: 'normal',
            fontWeight: '400',
            lineHeight: '1.4',
            letterSpacing: '-0.5px',
            width: '55px',
            margin: '0px',
            height: 'auto',
            position: 'relative',
            flex: '0 0 auto',
            order: '0'
          }}>
              ATELIER.
            </p>
          </div>
          <div data-id="div-mt9uiobo-38" data-name="Button" style={{
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          width: '53px',
          height: '15px',
          position: 'relative',
          flex: '0 0 auto',
          order: '1'
        }}>
            <p data-id="p-mt9uiobo-39" data-name="← Back" style={{
            color: '#6B6864',
            textAlign: 'center',
            fontFamily: '"DM Mono", sans-serif',
            fontSize: '11.2px',
            fontStyle: 'normal',
            fontWeight: '400',
            lineHeight: '1.333',
            letterSpacing: '1.568px',
            textTransform: 'uppercase',
            width: '53px',
            margin: '0px',
            height: 'auto',
            position: 'relative',
            flex: '0 0 auto',
            order: '0'
          }}>
              ← Back
            </p>
          </div>
        </div>
      </div></div>;
}

const canvasNodes = (<>
  <BaRoLe data-id="BaRoLe-mtu5f85o-2" data-name="BaRoLe" data-canvas-node="true" style={{position: 'absolute', height: '81px', width: '1440px', flex: '0 0 auto', left: '-1117px', top: '346px'}}></BaRoLe>

  <div data-id="frame-mtuae9ay-1" data-name="Frame" data-canvas-node="true" style={{position: 'absolute', width: '167px', height: '108px', backgroundColor: '#97cffc', borderRadius: '0px', overflow: 'hidden', left: '-290px', top: '134px'}}></div>
</>);
`,
    'app/page.tsx': `import PageClient from './page.client';

export const metadata = {};

export default function Page() {
  return <PageClient />;
}
`,
    'app/page.client.tsx': `'use client';
export default function Page() { return <div data-id="root" style={{ width: '100%', minHeight: '400px' }}></div>; }
`,
    'components/BaRoLe.tsx': `'use client';
/** @label "BaRoLe" */
/** @comment "stub" */
/** @defaultWidth 1440 */
/** @defaultHeight 81 */
/** @controls {} */
import { withResponsiveProps } from '@revyme/runtime';
function BaRoLe({ ...props }: { [key: string]: any }) {
  return <div {...props} style={{ position: 'relative', width: '100%', height: '100%', background: '#222', ...props.style }} />;
}
export default withResponsiveProps(BaRoLe);
`,
    'cms/collection-1.schema.json': "{\"slug\": \"collection-1\", \"name\": \"Collection 1\", \"fields\": [{\"id\": \"title\", \"name\": \"title\", \"type\": \"text\"}, {\"id\": \"untitled\", \"name\": \"untitled\", \"type\": \"text\"}, {\"id\": \"untitled10\", \"name\": \"untitled10\", \"type\": \"image\"}, {\"id\": \"untitled19\", \"name\": \"untitled19\", \"type\": \"image\"}, {\"id\": \"untitled2\", \"name\": \"untitled2\", \"type\": \"text\"}, {\"id\": \"untitled20\", \"name\": \"untitled20\", \"type\": \"text\"}, {\"id\": \"untitled21\", \"name\": \"untitled21\", \"type\": \"text\"}, {\"id\": \"untitled22\", \"name\": \"untitled22\", \"type\": \"text\"}, {\"id\": \"untitled23\", \"name\": \"untitled23\", \"type\": \"text\"}, {\"id\": \"untitled3\", \"name\": \"untitled3\", \"type\": \"text\"}, {\"id\": \"untitled4\", \"name\": \"untitled4\", \"type\": \"text\"}, {\"id\": \"untitled5\", \"name\": \"untitled5\", \"type\": \"text\"}, {\"id\": \"untitled6\", \"name\": \"untitled6\", \"type\": \"text\"}, {\"id\": \"untitled7\", \"name\": \"untitled7\", \"type\": \"text\"}, {\"id\": \"untitled8\", \"name\": \"untitled8\", \"type\": \"image\"}, {\"id\": \"untitled9\", \"name\": \"untitled9\", \"type\": \"image\"}]}",
    'cms/collection-1.json': "[{\"_id\": \"i1\", \"_slug\": \"meridian\", \"_status\": \"published\", \"_createdAt\": \"2026-09-01T00:00:00.000Z\", \"_updatedAt\": \"2026-09-01T00:00:00.000Z\", \"title\": \"02 \\u2014 Web Experience \\u2014 2024\", \"untitled\": \"MERIDIAN ARCHITECTS\", \"untitled10\": \"https://images.unsplash.com/photo-1545897398-2aba891843b6?w=800\", \"untitled19\": \"https://images.unsplash.com/photo-1545897398-2aba891843b6?w=800\", \"untitled2\": \"A digital portfolio that matches the ambition of the practice.\", \"untitled20\": \"UNTITLED20\", \"untitled21\": \"UNTITLED21\", \"untitled22\": \"UNTITLED22\", \"untitled23\": \"UNTITLED23\", \"untitled3\": \"UNTITLED3\", \"untitled4\": \"UNTITLED4\", \"untitled5\": \"UNTITLED5\", \"untitled6\": \"UNTITLED6\", \"untitled7\": \"UNTITLED7\", \"untitled8\": \"https://images.unsplash.com/photo-1545897398-2aba891843b6?w=800\", \"untitled9\": \"https://images.unsplash.com/photo-1545897398-2aba891843b6?w=800\"}]",
  },
};

export const USER_HERO_AFTER: ProjectData = {
  format: 'revyme-v1',
  files: {
    'app/collection-1/[slug]/page.tsx': `import PageClient from './page.client';

export const metadata = {};

export default function Page() {
  return <PageClient />;
}
`,
    'app/collection-1/[slug]/page.client.tsx': `'use client';

/** @canvas {
  "viewports": [
    { "id": "desktop", "label": "Desktop", "width": 1440, "isPrimary": true, "order": 0 },
    { "id": "tablet", "label": "Tablet", "width": 768, "isPrimary": false, "order": 1 },
    { "id": "mobile", "label": "Mobile", "width": 375, "isPrimary": false, "order": 2 }
  ],
  "positions": {
    "desktop": { "x": 0, "y": 0 },
    "tablet": { "x": 1600, "y": 0 },
    "mobile": { "x": 2528, "y": 0 }
  }
} */
/** @cmsPage {
  "collection": "collection-1",
  "kind": "detail"
} */

import React, { useState, useRef, useLayoutEffect } from 'react';
import { useParams } from 'next/navigation';
import collection1 from '@/cms/collection-1.json';
import BaRoLe from '@/components/BaRoLe';

function useResponsiveText(primary, overrides, vpWidths) {
  const ref = useRef(null);
  const [w, setW] = useState(() => typeof window !== 'undefined' ? window.innerWidth : Infinity);
  useLayoutEffect(() => {
    if (typeof window === 'undefined') return;
    let host = ref.current && ref.current.parentElement;
    while (host && host !== document.body && !host.hasAttribute('data-viewport-width')) {
      host = host.parentElement;
    }
    if (host && host.hasAttribute && host.hasAttribute('data-viewport-width')) {
      const read = () => setW(parseInt(host.getAttribute('data-viewport-width'), 10) || window.innerWidth);
      read();
      const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(read) : null;
      if (ro) ro.observe(host);
      const mo = new MutationObserver(read);
      mo.observe(host, {
        attributes: true,
        attributeFilter: ['data-viewport-width']
      });
      return () => {
        if (ro) ro.disconnect();
        mo.disconnect();
      };
    }
    const onResize = () => setW(window.innerWidth);
    setW(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  // Bucket the current width into one of the configured viewports, then look
  // up that bucket's override. Smallest viewport width >= w wins. If no
  // viewport is wider than w, fall through to primary. Without the full
  // viewport list, we can't tell mobile (375) from tablet (768) when only
  // tablet has an override — both would resolve to tablet's text.
  const widths = (vpWidths || Object.keys(overrides || {}).map(Number)).filter(function (n) {
    return typeof n === 'number' && isFinite(n) && n > 0;
  }).slice().sort(function (a, b) {
    return a - b;
  });
  let bucket = null;
  for (let i = 0; i < widths.length; i++) {
    if (w <= widths[i]) {
      bucket = widths[i];
      break;
    }
  }
  let value = primary;
  if (bucket !== null && overrides && overrides[bucket] !== undefined) {
    value = overrides[bucket];
  }
  // Override values may contain rich-text marks emitted by TipTap on commit
  // (\`<span style="font-size: 14px">word</span>\` etc.). Plain string children
  // get escaped by React, so use dangerouslySetInnerHTML when the value looks
  // like HTML. Plain text falls through to the children path so React's text
  // diffing stays cheap.
  const isHtml = typeof value === 'string' && /<[a-z][^>]*>/i.test(value);
  return isHtml ? React.createElement('span', {
    ref: ref,
    style: {
      display: 'contents'
    },
    dangerouslySetInnerHTML: {
      __html: value
    }
  }) : React.createElement('span', {
    ref: ref,
    style: {
      display: 'contents'
    }
  }, value);
}
// @useResponsiveText-end

export default function Page() {
  const params = useParams();
  const item = collection1.find(i => i._slug === params?.slug) ?? collection1[0];
  return <div data-id="root" key={String(params?.slug ?? '')} data-name="Case study Detail" style={{
    position: 'relative',
    width: '100%',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    height: 'auto',
    overflowX: 'clip',
    backgroundColor: '#ffffff'
  }}>
      
  <style>{\`
    @media (max-width: 768px) and (min-width: 375.02px) {
      [data-id="div-mt9uiobo-10"] { flex-direction: column !important; height: min-content !important; gap: 32px !important; }
      [data-id="div-mt9uiobo-11"] { width: 100% !important; flex: 0 0 auto !important; }
      [data-id="div-mt9uiobo-16"] { width: 100% !important; flex: 0 0 auto !important; }
      [data-id="div-mt9uiobo-1l"] { padding-top: 0 !important; padding-right: 16px !important; padding-bottom: 0 !important; padding-left: 16px !important; height: min-content !important; }
      [data-id="div-mt9uiobg-6"] { flex-direction: column !important; height: min-content !important; }
      [data-id="div-mt9uiobo-u"] { width: 100% !important; flex: 0 0 auto !important; }
      [data-id="div-mt9uiobn-7"] { width: 100% !important; flex-direction: column !important; }
      [data-id="div-mt9uiobo-z"] { padding-top: 112px !important; padding-right: 16px !important; padding-bottom: 112px !important; padding-left: 16px !important; }
      [data-id="div-mt9uiobg-4"] { padding-top: 40px !important; padding-right: 16px !important; padding-bottom: 112px !important; padding-left: 16px !important; }
      [data-id="p-mt9uiobo-32"] { width: 100% !important; }
      [data-id="div-mt9uiobo-2y"] { padding-top: 0px !important; padding-right: 16px !important; padding-bottom: 16px !important; padding-left: 16px !important; }
      [data-id="div-mt9uiobo-1p"] { display: flex !important; height: min-content !important; gap: 32px !important; flex-direction: column !important; align-items: center !important; justify-content: center !important; }
      [data-id="div-mt9uiobo-1q"] { width: 100% !important; height: 100% !important; }
      [data-id="div-mt9uiobo-1v"] { width: 100% !important; height: 100% !important; }
      [data-id="div-mt9uiobo-20"] { width: 100% !important; height: 100% !important; }
      [data-id="div-mt9uiobo-25"] { width: 100% !important; height: 100% !important; }
      [data-id="div-mt9uiobo-1o"] { height: min-content !important; }
      [data-id="div-mt9uiobo-1m"] { width: 100% !important; }
      [data-id="div-mt9uiobo-1k"] { height: min-content !important; padding-top: 40px !important; padding-right: 0 !important; padding-bottom: 40px !important; padding-left: 0 !important; }
    }
    @media (max-width: 375px) {
      [data-id="div-mt9uiobo-10"] { flex-direction: column !important; height: min-content !important; gap: 40px !important; }
      [data-id="div-mt9uiobo-11"] { width: 100% !important; flex: 0 0 auto !important; height: min-content !important; }
      [data-id="div-mt9uiobo-16"] { width: 100% !important; flex: 0 0 auto !important; height: min-content !important; }
      [data-id="div-mt9uiobo-19"] { height: min-content !important; }
      [data-id="div-mt9uiobo-z"] { padding-top: 112px !important; padding-right: 16px !important; padding-bottom: 112px !important; padding-left: 16px !important; }
      [data-id="div-mt9uiobg-6"] { flex-direction: column !important; height: min-content !important; }
      [data-id="div-mt9uiobo-u"] { width: 100% !important; flex: 0 0 auto !important; height: min-content !important; }
      [data-id="div-mt9uiobg-4"] { padding-top: 40px !important; padding-right: 16px !important; padding-bottom: 40px !important; padding-left: 16px !important; height: min-content !important; }
      [data-id="div-mt9uiobn-7"] { width: 100% !important; height: min-content !important; }
      [data-id="div-mt9uiobo-v"] { width: 100% !important; height: 15px !important; }
      [data-id="div-mt9uiobo-x"] { height: min-content !important; }
      [data-id="div-mt9uiobo-k"] { width: 100% !important; }
      [data-id="div-mt9uiobo-a"] { width: 100% !important; }
      [data-id="div-mt9uiobn-8"] { width: 100% !important; }
      [data-id="div-mt9uiobo-p"] { width: 100% !important; }
      [data-id="div-mt9uiobg-5"] { height: min-content !important; }
      [data-id="div-mt9uiobo-2y"] { padding-top: 0px !important; padding-right: 16px !important; padding-bottom: 16px !important; padding-left: 16px !important; }
      [data-id="p-mt9uiobo-30"] { width: 100% !important; }
      [data-id="p-mt9uiobo-32"] { width: 100% !important; font-size: 68px !important; }
      [data-id="div-mt9uiobo-33"] { height: min-content !important; }
      [data-id="div-mt9uiobo-1l"] { height: min-content !important; padding-top: 0 !important; padding-right: 16px !important; padding-bottom: 0 !important; padding-left: 16px !important; }
      [data-id="div-mt9uiobo-1m"] { width: 100% !important; }
      [data-id="div-mt9uiobo-1p"] { flex-direction: column !important; height: min-content !important; }
      [data-id="div-mt9uiobo-1q"] { width: 100% !important; flex: 0 0 auto !important; }
      [data-id="div-mt9uiobo-1v"] { width: 100% !important; flex: 0 0 auto !important; }
      [data-id="div-mt9uiobo-20"] { width: 100% !important; flex: 0 0 auto !important; }
      [data-id="div-mt9uiobo-25"] { width: 100% !important; flex: 0 0 auto !important; }
      [data-id="div-mt9uiobo-1o"] { height: min-content !important; width: 100% !important; }
      [data-id="div-mt9uiobo-1k"] { height: min-content !important; padding-top: 40px !important; padding-right: 0 !important; padding-bottom: 40px !important; padding-left: 0 !important; }
    }
  \`}</style>
        
    <div data-id="div-mt9uiobg-1" data-name="Sleek Agency Portfolio Landing Page" style={{
      display: 'flex',
      width: '100%',
      height: 'min-content',
      flexDirection: 'column',
      alignItems: 'flex-start',
      backgroundColor: '#0A0A0A',
      position: 'relative',
      order: '2'
    }}>
        
    <div data-id="frame-mtuae9ay-1" data-name="Frame" style={{
        position: 'relative',
        width: '167px',
        height: '108px',
        backgroundColor: '#97cffc',
        borderRadius: '0px',
        overflow: 'hidden',
        flex: '0 0 auto', order: '0'
      }}></div><div data-id="div-mt9uiobg-2" data-name="CaseStudy" style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        width: '100%',
        height: 'min-content',
        backgroundColor: '#0A0A0A',
        position: 'relative',
        flex: '0 0 auto',
        order: '1'
      }}>
          <div data-id="div-mt9uiobg-3" data-name="Placeholder for CaseStudy" style={{
          height: '681.695px',
          width: '100%',
          position: 'relative',
          flex: '0 0 auto',
          order: '0'
        }}></div>
          <div data-id="div-mt9uiobg-4" data-name="Section" style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          borderBottom: '1px solid rgba(245, 242, 236, 0.08)',
          width: '100%',
          height: '484px',
          position: 'relative',
          flex: '0 0 auto',
          order: '1',
          paddingTop: '112px',
          paddingRight: '80px',
          paddingBottom: '112px',
          paddingLeft: '80px'
        }}>
            <div data-id="div-mt9uiobg-5" data-name="Container" style={{
            display: 'flex',
            maxWidth: '1440px',
            flexDirection: 'column',
            alignItems: 'flex-start',
            width: '100%',
            height: '259px',
            position: 'relative',
            flex: '0 0 auto',
            order: '0',
            paddingTop: '0',
            paddingRight: '0px',
            paddingBottom: '0',
            paddingLeft: '0px'
          }}>
              <div data-id="div-mt9uiobg-6" data-name="Container" style={{
              display: 'flex',
              height: '259px',
              width: '100%',
              position: 'relative',
              flex: '0 0 auto',
              order: '0',
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center'
            }}>
                <div data-id="div-mt9uiobn-7" data-name="Container" data-pinned="true" style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-start',
                gridRow: '1 / span 1',
                gridColumn: '1 / span 4',
                justifySelf: 'stretch',
                height: '259.24200439453125px',
                position: 'relative',
                width: '369px'
              }}>
                  <div data-id="div-mt9uiobn-8" data-name="Paragraph" style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  width: '301px',
                  height: 'min-content',
                  position: 'relative',
                  flex: '0 0 auto',
                  order: '0'
                }}>
                    <p data-id="p-mt9uiobn-9" data-name="Scope of work" style={{
                    color: '#6B6864',
                    fontFamily: '"DM Mono", sans-serif',
                    fontSize: '10.88px',
                    fontStyle: 'normal',
                    fontWeight: '400',
                    lineHeight: '1.333',
                    letterSpacing: '1.741px',
                    textTransform: 'uppercase',
                    width: '106px',
                    margin: '0px',
                    height: 'auto',
                    position: 'relative',
                    flex: '0 0 auto',
                    order: '0'
                  }}>
                      Scope of work
                    </p>
                  </div>
                  <div data-id="div-mt9uiobo-a" data-name="Container:margin" style={{
                  display: 'flex',
                  paddingTop: '24px',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  width: 'min-content',
                  height: '89px',
                  position: 'relative',
                  flex: '0 0 auto',
                  order: '1'
                }}>
                    <div data-id="div-mt9uiobo-b" data-name="Container" style={{
                    height: '65px',
                    width: 'min-content',
                    position: 'relative',
                    flex: '0 0 auto',
                    order: '0',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    justifyContent: 'center',
                    display: 'flex',
                    gap: '8px'
                  }}>
                      
    <div data-id="frame-mt9vyfbs-3b" data-name="Frame" style={{
                      position: 'relative',
                      width: 'min-content',
                      height: 'min-content',
                      display: 'flex',
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'center',
                      backgroundColor: 'rgba(0, 0, 0, 0)',
                      overflow: 'visible',
                      gap: '8px',
                      flex: '0 0 auto'
                    }}>
    <div data-id="div-mt9uiobo-e" data-name="Text" data-pinned="true" style={{
                        display: 'flex',
                        padding: '6px 12px',
                        flexDirection: 'column',
                        alignItems: 'flex-start',
                        border: '1px solid rgba(245, 242, 236, 0.15)',
                        width: '126px',
                        height: '28px'
                      }}>
                        <p data-id="p-mt9uiobo-f" data-name="Art Direction" style={{
                          color: '#C8C4BC',
                          fontFamily: '"DM Mono", sans-serif',
                          fontSize: '10.88px',
                          fontStyle: 'normal',
                          fontWeight: '400',
                          lineHeight: '1.333',
                          letterSpacing: '1.306px',
                          textTransform: 'uppercase',
                          width: '101px',
                          margin: '0px',
                          height: 'auto',
                          position: 'relative',
                          flex: '0 0 auto',
                          order: '0',
                          whiteSpace: 'nowrap'
                        }}>{item.untitled20}</p>
                      </div>
  
    <div data-id="div-mt9uiobo-c" data-name="Text" data-pinned="true" style={{
                        display: 'flex',
                        padding: '6px 12px',
                        flexDirection: 'column',
                        alignItems: 'flex-start',
                        border: '1px solid rgba(245, 242, 236, 0.15)',
                        width: 'min-content',
                        height: 'min-content'
                      }}>
                        <p data-id="p-mt9uiobo-d" data-name="UX Strategy" style={{
                          color: '#C8C4BC',
                          fontFamily: '"DM Mono", sans-serif',
                          fontSize: '10.88px',
                          fontStyle: 'normal',
                          fontWeight: '400',
                          lineHeight: '1.333',
                          letterSpacing: '1.306px',
                          textTransform: 'uppercase',
                          width: 'min-content',
                          margin: '0px',
                          height: 'auto',
                          position: 'relative',
                          flex: '0 0 auto',
                          order: '0',
                          display: 'flex',
                          flexDirection: 'column',
                          whiteSpace: 'nowrap'
                        }}>{item.untitled21}</p>
                      </div>
  </div>
                      
    <div data-id="frame-mt9vxihy-3a" data-name="Frame" style={{
                      position: 'relative',
                      width: 'min-content',
                      height: 'min-content',
                      display: 'flex',
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'center',
                      backgroundColor: 'rgba(0, 0, 0, 0)',
                      overflow: 'visible',
                      gap: '8px',
                      flex: '0 0 auto'
                    }}>
    <div data-id="div-mt9uiobo-g" data-name="Text" data-pinned="true" style={{
                        display: 'flex',
                        padding: '6px 12px',
                        flexDirection: 'column',
                        alignItems: 'flex-start',
                        border: '1px solid rgba(245, 242, 236, 0.15)',
                        width: 'min-content',
                        height: 'min-content'
                      }}>
                        <p data-id="p-mt9uiobo-h" data-name="Web Design" style={{
                          color: '#C8C4BC',
                          fontFamily: '"DM Mono", sans-serif',
                          fontSize: '10.88px',
                          fontStyle: 'normal',
                          fontWeight: '400',
                          lineHeight: '1.333',
                          letterSpacing: '1.306px',
                          textTransform: 'uppercase',
                          width: 'min-content',
                          margin: '0px',
                          height: 'auto',
                          position: 'relative',
                          flex: '0 0 auto',
                          order: '0',
                          whiteSpace: 'nowrap'
                        }}>{item.untitled22}</p>
                      </div>
  
    <div data-id="div-mt9uiobo-i" data-name="Text" data-pinned="true" style={{
                        display: 'flex',
                        padding: '6px 12px',
                        flexDirection: 'column',
                        alignItems: 'flex-start',
                        border: '1px solid rgba(245, 242, 236, 0.15)',
                        width: 'min-content',
                        height: 'min-content'
                      }}>
                        <p data-id="p-mt9uiobo-j" data-name="Development" style={{
                          color: '#C8C4BC',
                          fontFamily: '"DM Mono", sans-serif',
                          fontSize: '10.88px',
                          fontStyle: 'normal',
                          fontWeight: '400',
                          lineHeight: '1.333',
                          letterSpacing: '1.306px',
                          textTransform: 'uppercase',
                          width: 'min-content',
                          margin: '0px',
                          height: 'auto',
                          position: 'relative',
                          flex: '0 0 auto',
                          order: '0',
                          whiteSpace: 'nowrap',
                          transform: 'rotate(0deg)'
                        }}>{item.untitled23}</p>
                      </div>
  </div>
                    </div>
                  </div>
                  <div data-id="div-mt9uiobo-k" data-name="Container" style={{
                  display: 'flex',
                  width: '301px',
                  height: 'min-content',
                  paddingTop: '24px',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  position: 'relative',
                  flex: '0 0 auto',
                  order: '2'
                }}>
                    <div data-id="div-mt9uiobo-l" data-name="Paragraph" style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    width: '301px',
                    height: '14px',
                    position: 'relative',
                    flex: '0 0 auto',
                    order: '0'
                  }}>
                      <p data-id="p-mt9uiobo-m" data-name="Client" style={{
                      color: '#6B6864',
                      fontFamily: '"DM Mono", sans-serif',
                      fontSize: '10.4px',
                      fontStyle: 'normal',
                      fontWeight: '400',
                      lineHeight: '1.333',
                      letterSpacing: '1.04px',
                      textTransform: 'uppercase',
                      width: '43px',
                      margin: '0px',
                      height: 'auto',
                      position: 'relative',
                      flex: '0 0 auto',
                      order: '0'
                    }}>
                        Client
                      </p>
                    </div>
                    <div data-id="div-mt9uiobo-n" data-name="Paragraph" style={{
                    display: 'flex',
                    width: '301px',
                    height: '32px',
                    paddingTop: '8px',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    position: 'relative',
                    flex: '0 0 auto',
                    order: '1'
                  }}>
                      <p data-id="p-mt9uiobo-o" data-name="Meridian Architects" style={{
                      color: '#F5F2EC',
                      fontFamily: 'Barlow, sans-serif',
                      fontSize: '16px',
                      fontStyle: 'normal',
                      fontWeight: '400',
                      lineHeight: '1.5',
                      width: '136px',
                      margin: '0px',
                      height: 'auto',
                      position: 'relative',
                      flex: '0 0 auto',
                      order: '0'
                    }}>{item.untitled4}</p>
                    </div>
                  </div>
                  <div data-id="div-mt9uiobo-p" data-name="Container" style={{
                  display: 'flex',
                  width: '301px',
                  height: '70px',
                  paddingTop: '24px',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  position: 'relative',
                  flex: '0 0 auto',
                  order: '3'
                }}>
                    <div data-id="div-mt9uiobo-q" data-name="Paragraph" style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    width: '301px',
                    height: '14px',
                    position: 'relative',
                    flex: '0 0 auto',
                    order: '0'
                  }}>
                      <p data-id="p-mt9uiobo-r" data-name="Year" style={{
                      color: '#6B6864',
                      fontFamily: '"DM Mono", sans-serif',
                      fontSize: '10.4px',
                      fontStyle: 'normal',
                      fontWeight: '400',
                      lineHeight: '1.333',
                      letterSpacing: '1.04px',
                      textTransform: 'uppercase',
                      width: '29px',
                      margin: '0px',
                      height: 'auto',
                      position: 'relative',
                      flex: '0 0 auto',
                      order: '0'
                    }}>
                        Year
                      </p>
                    </div>
                    <div data-id="div-mt9uiobo-s" data-name="Paragraph" style={{
                    display: 'flex',
                    width: '301px',
                    height: '32px',
                    paddingTop: '8px',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    position: 'relative',
                    flex: '0 0 auto',
                    order: '1'
                  }}>
                      <p data-id="p-mt9uiobo-t" data-name="2024" style={{
                      color: '#F5F2EC',
                      fontFamily: 'Barlow, sans-serif',
                      fontSize: '16px',
                      fontStyle: 'normal',
                      fontWeight: '400',
                      lineHeight: '1.5',
                      width: '36px',
                      margin: '0px',
                      height: 'auto',
                      position: 'relative',
                      flex: '0 0 auto',
                      order: '0'
                    }}>{item.untitled5}</p>
                    </div>
                  </div>
                </div>
                <div data-id="div-mt9uiobo-u" data-name="Container" data-pinned="true" style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-start',
                gridRow: '1 / span 1',
                gridColumn: '5 / span 8',
                justifySelf: 'stretch',
                height: '259.24200439453125px',
                position: 'relative',
                flex: '1 0 0px'
              }}>
                  <div data-id="div-mt9uiobo-v" data-name="Paragraph" style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  width: '666px',
                  height: '15px',
                  position: 'relative',
                  flex: '0 0 auto',
                  order: '0'
                }}>
                    <p data-id="p-mt9uiobo-w" data-name="Overview" style={{
                    color: '#6B6864',
                    fontFamily: '"DM Mono", sans-serif',
                    fontSize: '10.88px',
                    fontStyle: 'normal',
                    fontWeight: '400',
                    lineHeight: '1.333',
                    letterSpacing: '1.741px',
                    textTransform: 'uppercase',
                    width: 'min-content',
                    margin: '0px',
                    height: 'auto',
                    position: 'relative',
                    flex: '0 0 auto',
                    order: '0'
                  }}>
                      Overview
                    </p>
                  </div>
                  <div data-id="div-mt9uiobo-x" data-name="Paragraph" style={{
                  display: 'flex',
                  paddingTop: '24px',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  width: '100%',
                  height: '112px',
                  position: 'relative',
                  flex: '0 0 auto',
                  order: '1'
                }}>
                    <p data-id="p-mt9uiobo-y" data-name="Meridian Architects is a forty-person practice kno" style={{
                    width: '100%',
                    color: '#C8C4BC',
                    fontFamily: 'Barlow, sans-serif',
                    fontSize: '18.032px',
                    fontStyle: 'normal',
                    fontWeight: '400',
                    lineHeight: '1.625',
                    margin: '0px',
                    height: 'auto',
                    position: 'relative',
                    flex: '0 0 auto',
                    order: '0',
                    maxWidth: '666px'
                  }}>{item.untitled3}</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div data-id="div-mt9uiobo-z" data-name="Container" style={{
          display: 'flex',
          width: '100%',
          maxWidth: '100%',
          flexDirection: 'column',
          alignItems: 'flex-start',
          height: '1291px',
          position: 'relative',
          flex: '0 0 auto',
          order: '2',
          paddingTop: '112px',
          paddingRight: '80px',
          paddingBottom: '112px',
          paddingLeft: '80px'
        }}>
            <div data-id="div-mt9uiobo-10" data-name="Container" style={{
            display: 'flex',
            height: '139px',
            width: '100%',
            position: 'relative',
            flex: '0 0 auto',
            order: '0',
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-evenly',
            gap: '80px'
          }}>
              <div data-id="div-mt9uiobo-11" data-name="Container" data-pinned="true" style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-start',
              gridRow: '1 / span 1',
              gridColumn: '1 / span 1',
              justifySelf: 'stretch',
              height: '138.50799560546875px',
              position: 'relative',
              flex: '1 0 0px'
            }}>
                <div data-id="div-mt9uiobo-12" data-name="Paragraph" style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-start',
                width: '100%',
                height: 'min-content',
                position: 'relative',
                flex: '0 0 auto',
                order: '0'
              }}>
                  <p data-id="p-mt9uiobo-13" data-name="The challenge" style={{
                  color: '#E8FF47',
                  fontFamily: '"DM Mono", sans-serif',
                  fontSize: '10.88px',
                  fontStyle: 'normal',
                  fontWeight: '400',
                  lineHeight: '1.333',
                  letterSpacing: '1.958px',
                  textTransform: 'uppercase',
                  width: 'min-content',
                  margin: '0px',
                  height: 'auto',
                  position: 'relative',
                  flex: '0 0 auto',
                  order: '0',
                  whiteSpace: 'nowrap'
                }}>
                    The challenge
                  </p>
                </div>
                <div data-id="div-mt9uiobo-14" data-name="Paragraph" style={{
                display: 'flex',
                width: '100%',
                paddingTop: '20px',
                flexDirection: 'column',
                alignItems: 'flex-start',
                height: 'min-content',
                position: 'relative',
                flex: '0 0 auto',
                order: '1'
              }}>
                  <p data-id="p-mt9uiobo-15" data-name="Architecture practices are notoriously hard to dif" style={{
                  width: '100%',
                  color: '#C8C4BC',
                  fontFamily: 'Barlow, sans-serif',
                  fontSize: '16px',
                  fontStyle: 'normal',
                  fontWeight: '400',
                  lineHeight: '1.625',
                  margin: '0px',
                  height: 'auto',
                  position: 'relative',
                  flex: '0 0 auto',
                  order: '0'
                }}>{item.untitled6}</p>
                </div>
              </div>
              <div data-id="div-mt9uiobo-16" data-name="Container" data-pinned="true" style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-start',
              gridRow: '1 / span 1',
              gridColumn: '2 / span 1',
              justifySelf: 'stretch',
              height: '138.50799560546875px',
              position: 'relative',
              flex: '1 0 0px'
            }}>
                <div data-id="div-mt9uiobo-17" data-name="Paragraph" style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-start',
                width: '100%',
                height: 'min-content',
                position: 'relative',
                flex: '0 0 auto',
                order: '0'
              }}>
                  <p data-id="p-mt9uiobo-18" data-name="Our approach" style={{
                  color: '#E8FF47',
                  fontFamily: '"DM Mono", sans-serif',
                  fontSize: '10.88px',
                  fontStyle: 'normal',
                  fontWeight: '400',
                  lineHeight: '1.333',
                  letterSpacing: '1.958px',
                  textTransform: 'uppercase',
                  width: '100%',
                  margin: '0px',
                  height: 'auto',
                  position: 'relative',
                  flex: '0 0 auto',
                  order: '0',
                  whiteSpace: 'nowrap'
                }}>
                    Our approach
                  </p>
                </div>
                <div data-id="div-mt9uiobo-19" data-name="Paragraph" style={{
                display: 'flex',
                width: '100%',
                paddingTop: '20px',
                flexDirection: 'column',
                alignItems: 'flex-start',
                height: '124px',
                position: 'relative',
                flex: '0 0 auto',
                order: '1'
              }}>
                  <p data-id="p-mt9uiobo-1a" data-name="We led with their photography. A full-bleed editor" style={{
                  width: '100%',
                  color: '#C8C4BC',
                  fontFamily: 'Barlow, sans-serif',
                  fontSize: '16px',
                  fontStyle: 'normal',
                  fontWeight: '400',
                  lineHeight: '1.625',
                  margin: '0px',
                  height: 'auto',
                  position: 'relative',
                  flex: '0 0 auto',
                  order: '0'
                }}>{item.untitled7}</p>
                </div>
              </div>
            </div>
            <div data-id="div-mt9uiobo-1b" data-name="Container:margin" style={{
            display: 'flex',
            paddingTop: '80px',
            flexDirection: 'column',
            alignItems: 'flex-start',
            width: '100%',
            height: '531px',
            position: 'relative',
            flex: '0 0 auto',
            order: '1'
          }}>
              <div data-id="div-mt9uiobo-1c" data-name="Container" style={{
              display: 'flex',
              width: '100%',
              height: '451px',
              flexDirection: 'column',
              alignItems: 'flex-start',
              overflow: 'hidden',
              backgroundColor: '#1E1E1E',
              position: 'relative',
              flex: '0 0 auto',
              order: '0'
            }}>
                <div data-id="div-mt9uiobo-1d" data-name="Image (Project detail)" style={{
                height: '451px',
                width: '100%',
                overflow: 'hidden',
                backgroundImage: \`url(\${item.untitled8})\`,
                backgroundRepeat: 'no-repeat',
                backgroundSize: 'cover',
                backgroundPosition: 'center',
                position: 'relative',
                flex: '0 0 auto',
                order: '0'
              }}></div>
              </div>
            </div>
            <div data-id="div-mt9uiobo-1e" data-name="Container:margin" style={{
            display: 'flex',
            paddingTop: '16px',
            flexDirection: 'column',
            alignItems: 'flex-start',
            width: '100%',
            height: '397px',
            position: 'relative',
            flex: '0 0 auto',
            order: '2'
          }}>
              <div data-id="div-mt9uiobo-1f" data-name="Container" style={{
              display: 'flex',
              height: '381px',
              width: '100%',
              position: 'relative',
              flex: '0 0 auto',
              order: '0',
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '12px'
            }}>
                <div data-id="div-mt9uiobo-1g" data-name="Container" data-pinned="true" style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-start',
                gridRow: '1 / span 1',
                gridColumn: '1 / span 1',
                justifySelf: 'stretch',
                height: '380.625px',
                overflow: 'hidden',
                position: 'relative',
                backgroundColor: '#1E1E1E',
                flex: '1 0 0px'
              }}>
                  <div data-id="div-mt9uiobo-1h" data-name="Image (Project)" style={{
                  height: '381px',
                  width: '100%',
                  overflow: 'hidden',
                  backgroundImage: \`url(\${item.untitled9})\`,
                  backgroundRepeat: 'no-repeat',
                  backgroundSize: 'cover',
                  backgroundPosition: 'center',
                  position: 'relative',
                  flex: '0 0 auto',
                  order: '0'
                }}></div>
                </div>
                <div data-id="div-mt9uiobo-1i" data-name="Container" data-pinned="true" style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-start',
                gridRow: '1 / span 1',
                gridColumn: '2 / span 1',
                justifySelf: 'stretch',
                height: '380.625px',
                overflow: 'hidden',
                position: 'relative',
                backgroundColor: '#1E1E1E',
                flex: '1 0 0px'
              }}>
                  <div data-id="div-mt9uiobo-1j" data-name="Image (Project)" style={{
                  height: '381px',
                  width: '100%',
                  overflow: 'hidden',
                  backgroundImage: \`url(\${item.untitled10})\`,
                  backgroundRepeat: 'no-repeat',
                  backgroundSize: 'cover',
                  backgroundPosition: 'center',
                  position: 'relative',
                  flex: '0 0 auto',
                  order: '0'
                }}></div>
                </div>
              </div>
            </div>
          </div>
          <div data-id="div-mt9uiobo-1k" data-name="Section" style={{
          display: 'flex',
          padding: '112px 0',
          flexDirection: 'column',
          alignItems: 'flex-start',
          borderTop: '1px solid rgba(245, 242, 236, 0.08)',
          borderBottom: '1px solid rgba(245, 242, 236, 0.08)',
          width: '100%',
          height: '460px',
          backgroundColor: '#141414',
          position: 'relative',
          flex: '0 0 auto',
          order: '3'
        }}>
            <div data-id="div-mt9uiobo-1l" data-name="Container" style={{
            display: 'flex',
            maxWidth: '100%',
            flexDirection: 'column',
            alignItems: 'flex-start',
            width: '100%',
            height: '234px',
            position: 'relative',
            flex: '0 0 auto',
            order: '0',
            paddingTop: '0',
            paddingRight: '80px',
            paddingBottom: '0',
            paddingLeft: '80px'
          }}>
              <div data-id="div-mt9uiobo-1m" data-name="Paragraph" style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-start',
              width: '1031px',
              height: '15px',
              position: 'relative',
              flex: '0 0 auto',
              order: '0'
            }}>
                <p data-id="p-mt9uiobo-1n" data-name="Outcomes" style={{
                color: '#6B6864',
                fontFamily: '"DM Mono", sans-serif',
                fontSize: '10.88px',
                fontStyle: 'normal',
                fontWeight: '400',
                lineHeight: '1.333',
                letterSpacing: '1.958px',
                textTransform: 'uppercase',
                width: '66px',
                margin: '0px',
                height: 'auto',
                position: 'relative',
                flex: '0 0 auto',
                order: '0'
              }}>
                  Outcomes
                </p>
              </div>
              <div data-id="div-mt9uiobo-1o" data-name="Container:margin" style={{
              display: 'flex',
              paddingTop: '56px',
              flexDirection: 'column',
              alignItems: 'flex-start',
              width: '100%',
              height: '219px',
              position: 'relative',
              flex: '0 0 auto',
              order: '1'
            }}>
                <div data-id="div-mt9uiobo-1p" data-name="Container" style={{
                display: 'flex',
                height: '163px',
                borderLeft: '1px solid rgba(245, 242, 236, 0.08)',
                width: '100%',
                position: 'relative',
                flex: '0 0 auto',
                order: '0',
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center'
              }}>
                  <div data-id="div-mt9uiobo-1q" data-name="Container" data-pinned="true" style={{
                  display: 'flex',
                  padding: '40px 32px',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  gridRow: '1 / span 1',
                  gridColumn: '1 / span 1',
                  justifySelf: 'stretch',
                  borderRight: '1px solid rgba(245, 242, 236, 0.08)',
                  borderBottom: '1px solid rgba(245, 242, 236, 0.08)',
                  height: '163.21099853515625px',
                  position: 'relative',
                  flex: '1 0 0px',
                  order: '0'
                }}>
                    <div data-id="div-mt9uiobo-1r" data-name="Container" style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    width: '192.5px',
                    height: '57px',
                    position: 'relative',
                    flex: '0 0 auto',
                    order: '0'
                  }}>
                      <p data-id="p-mt9uiobo-1s" data-name="+210%" style={{
                      color: '#E8FF47',
                      fontFamily: '"Barlow Condensed", sans-serif',
                      fontSize: '56.35px',
                      fontStyle: 'normal',
                      fontWeight: '400',
                      lineHeight: '1',
                      letterSpacing: '-1.127px',
                      width: '125px',
                      margin: '0px',
                      height: 'auto',
                      position: 'relative',
                      flex: '0 0 auto',
                      order: '0'
                    }}>
                        +210%
                      </p>
                    </div>
                    <div data-id="div-mt9uiobo-1t" data-name="Container" style={{
                    display: 'flex',
                    width: '192.5px',
                    height: 'min-content',
                    paddingTop: '12px',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    position: 'relative',
                    flex: '0 0 auto',
                    order: '1'
                  }}>
                      <p data-id="p-mt9uiobo-1u" data-name="Avg. session duration" style={{
                      color: '#6B6864',
                      fontFamily: '"DM Mono", sans-serif',
                      fontSize: '10.4px',
                      fontStyle: 'normal',
                      fontWeight: '400',
                      lineHeight: '1.333',
                      letterSpacing: '1.04px',
                      textTransform: 'uppercase',
                      width: '152px',
                      margin: '0px',
                      height: 'auto',
                      position: 'relative',
                      flex: '0 0 auto',
                      order: '0',
                      whiteSpace: 'nowrap'
                    }}>
                        Avg. session duration
                      </p>
                    </div>
                  </div>
                  <div data-id="div-mt9uiobo-1v" data-name="Container" data-pinned="true" style={{
                  display: 'flex',
                  padding: '40px 32px',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  gridRow: '1 / span 1',
                  gridColumn: '2 / span 1',
                  justifySelf: 'stretch',
                  borderRight: '1px solid rgba(245, 242, 236, 0.08)',
                  borderBottom: '1px solid rgba(245, 242, 236, 0.08)',
                  height: '163.21099853515625px',
                  position: 'relative',
                  flex: '1 0 0px',
                  order: '1'
                }}>
                    <div data-id="div-mt9uiobo-1w" data-name="Container" style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    width: '192.5px',
                    height: '57px',
                    position: 'relative',
                    flex: '0 0 auto',
                    order: '0'
                  }}>
                      <p data-id="p-mt9uiobo-1x" data-name="4.2s" style={{
                      color: '#E8FF47',
                      fontFamily: '"Barlow Condensed", sans-serif',
                      fontSize: '56.35px',
                      fontStyle: 'normal',
                      fontWeight: '400',
                      lineHeight: '1',
                      letterSpacing: '-1.127px',
                      width: '75px',
                      margin: '0px',
                      height: 'auto',
                      position: 'relative',
                      flex: '0 0 auto',
                      order: '0'
                    }}>
                        4.2s
                      </p>
                    </div>
                    <div data-id="div-mt9uiobo-1y" data-name="Container" style={{
                    display: 'flex',
                    width: '192.5px',
                    height: 'min-content',
                    paddingTop: '12px',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    position: 'relative',
                    flex: '0 0 auto',
                    order: '1'
                  }}>
                      <p data-id="p-mt9uiobo-1z" data-name="Avg. time to first scroll" style={{
                      color: '#6B6864',
                      fontFamily: '"DM Mono", sans-serif',
                      fontSize: '10.4px',
                      fontStyle: 'normal',
                      fontWeight: '400',
                      lineHeight: '1.333',
                      letterSpacing: '1.04px',
                      textTransform: 'uppercase',
                      width: '181px',
                      margin: '0px',
                      height: 'auto',
                      position: 'relative',
                      flex: '0 0 auto',
                      order: '0',
                      whiteSpace: 'nowrap'
                    }}>
                        Avg. time to first scroll
                      </p>
                    </div>
                  </div>
                  <div data-id="div-mt9uiobo-20" data-name="Container" data-pinned="true" style={{
                  display: 'flex',
                  padding: '40px 32px',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  gridRow: '1 / span 1',
                  gridColumn: '3 / span 1',
                  justifySelf: 'stretch',
                  borderRight: '1px solid rgba(245, 242, 236, 0.08)',
                  borderBottom: '1px solid rgba(245, 242, 236, 0.08)',
                  height: '163.21099853515625px',
                  position: 'relative',
                  flex: '1 0 0px',
                  order: '2'
                }}>
                    <div data-id="div-mt9uiobo-21" data-name="Container" style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    width: '192.5px',
                    height: '57px',
                    position: 'relative',
                    flex: '0 0 auto',
                    order: '0'
                  }}>
                      <p data-id="p-mt9uiobo-22" data-name="+61%" style={{
                      color: '#E8FF47',
                      fontFamily: '"Barlow Condensed", sans-serif',
                      fontSize: '56.35px',
                      fontStyle: 'normal',
                      fontWeight: '400',
                      lineHeight: '1',
                      letterSpacing: '-1.127px',
                      width: '102px',
                      margin: '0px',
                      height: 'auto',
                      position: 'relative',
                      flex: '0 0 auto',
                      order: '0'
                    }}>
                        +61%
                      </p>
                    </div>
                    <div data-id="div-mt9uiobo-23" data-name="Container" style={{
                    display: 'flex',
                    width: '192.5px',
                    height: 'min-content',
                    paddingTop: '12px',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    position: 'relative',
                    flex: '0 0 auto',
                    order: '1'
                  }}>
                      <p data-id="p-mt9uiobo-24" data-name="RFP submissions" style={{
                      color: '#6B6864',
                      fontFamily: '"DM Mono", sans-serif',
                      fontSize: '10.4px',
                      fontStyle: 'normal',
                      fontWeight: '400',
                      lineHeight: '1.333',
                      letterSpacing: '1.04px',
                      textTransform: 'uppercase',
                      width: '109px',
                      margin: '0px',
                      height: 'auto',
                      position: 'relative',
                      flex: '0 0 auto',
                      order: '0',
                      whiteSpace: 'nowrap'
                    }}>
                        RFP submissions
                      </p>
                    </div>
                  </div>
                  <div data-id="div-mt9uiobo-25" data-name="Container" data-pinned="true" style={{
                  display: 'flex',
                  padding: '40px 32px',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  gridRow: '1 / span 1',
                  gridColumn: '4 / span 1',
                  justifySelf: 'stretch',
                  borderRight: '1px solid rgba(245, 242, 236, 0.08)',
                  borderBottom: '1px solid rgba(245, 242, 236, 0.08)',
                  height: '163.21099853515625px',
                  position: 'relative',
                  flex: '1 0 0px',
                  order: '3'
                }}>
                    <div data-id="div-mt9uiobo-26" data-name="Container" style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    width: '192.5px',
                    height: '57px',
                    position: 'relative',
                    flex: '0 0 auto',
                    order: '0'
                  }}>
                      <p data-id="p-mt9uiobo-27" data-name="D&AD" style={{
                      color: '#E8FF47',
                      fontFamily: '"Barlow Condensed", sans-serif',
                      fontSize: '56.35px',
                      fontStyle: 'normal',
                      fontWeight: '400',
                      lineHeight: '1',
                      letterSpacing: '-1.127px',
                      width: '103px',
                      margin: '0px',
                      height: 'auto',
                      position: 'relative',
                      flex: '0 0 auto',
                      order: '0'
                    }}>
                        D&AD
                      </p>
                    </div>
                    <div data-id="div-mt9uiobo-28" data-name="Container" style={{
                    display: 'flex',
                    width: '192.5px',
                    height: 'min-content',
                    paddingTop: '12px',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    position: 'relative',
                    flex: '0 0 auto',
                    order: '1'
                  }}>
                      <p data-id="p-mt9uiobo-29" data-name="Shortlisted 2024" style={{
                      color: '#6B6864',
                      fontFamily: '"DM Mono", sans-serif',
                      fontSize: '10.4px',
                      fontStyle: 'normal',
                      fontWeight: '400',
                      lineHeight: '1.333',
                      letterSpacing: '1.04px',
                      textTransform: 'uppercase',
                      width: '116px',
                      margin: '0px',
                      height: 'auto',
                      position: 'relative',
                      flex: '0 0 auto',
                      order: '0',
                      whiteSpace: 'nowrap'
                    }}>
                        Shortlisted 2024
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div data-id="div-mt9uiobo-2a" data-name="Section" style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          borderBottom: '1px solid rgba(245, 242, 236, 0.08)',
          width: '100%',
          height: '376.6640625px',
          position: 'relative',
          flex: '0 0 auto',
          order: '4'
        }}>
            <div data-id="div-mt9uiobo-2b" data-name="Link" style={{
            display: 'flex',
            height: '375.664px',
            flexDirection: 'column',
            alignItems: 'flex-start',
            width: '100%',
            overflow: 'hidden',
            position: 'relative',
            flex: '0 0 auto',
            order: '0'
          }}>
              <div data-id="div-mt9uiobo-2c" data-name="CaseStudy" style={{
              height: '375.664px',
              width: '100%',
              overflow: 'hidden',
              backgroundColor: '#1E1E1E',
              position: 'relative',
              flex: '0 0 auto',
              order: '0'
            }}>
                <div data-id="div-mt9uiobo-2d" data-name="Image (FORM STUDIO)" data-pinned="true" style={{
                width: '100%',
                height: '375.664px',
                opacity: '0.3',
                overflow: 'hidden',
                position: 'absolute',
                left: '0px',
                top: '0px',
                backgroundImage: 'url(https://assets.revyme.app/b072a507-4f93-11f1-a46a-920007cce419/055d350c-ac4d-11f1-b3b1-920007cce419/images/uploaded/bca362287f73a32f.webp)',
                backgroundRepeat: 'no-repeat',
                backgroundSize: 'cover',
                backgroundPosition: 'center'
              }}></div>
                <div data-id="div-mt9uiobo-2e" data-name="Container" data-pinned="true" style={{
                width: '100%',
                height: '375.664px',
                position: 'absolute',
                left: '0px',
                top: '0px',
                backgroundImage: 'linear-gradient(180deg, rgba(10, 10, 10, 0.30) 0%, rgba(10, 10, 10, 0.70) 100%)'
              }}></div>
                <div data-id="div-mt9uiobo-2f" data-name="Container" data-pinned="true" style={{
                display: 'flex',
                width: '100%',
                height: '375.664px',
                padding: '0 24px',
                flexDirection: 'column',
                justifyContent: 'center',
                alignItems: 'center',
                position: 'absolute',
                left: '0px',
                top: '0px'
              }}>
                  <div data-id="div-mt9uiobo-2g" data-name="Paragraph:margin" style={{
                  display: 'flex',
                  paddingBottom: '20px',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  width: '103px',
                  height: '35px',
                  position: 'relative',
                  flex: '0 0 auto',
                  order: '0'
                }}>
                    <p data-id="p-mt9uiobo-2h" data-name="Next project" style={{
                    color: '#E8FF47',
                    textAlign: 'center',
                    fontFamily: '"DM Mono", sans-serif',
                    fontSize: '11.2px',
                    fontStyle: 'normal',
                    fontWeight: '400',
                    lineHeight: '1.333',
                    letterSpacing: '2.016px',
                    textTransform: 'uppercase',
                    width: '103px',
                    margin: '0px',
                    height: 'auto',
                    position: 'relative',
                    flex: '0 0 auto',
                    order: '0',
                    whiteSpace: 'nowrap'
                  }}>Next project</p>
                  </div>
                  <div data-id="div-mt9uiobo-2i" data-name="Heading 2" style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  width: '384px',
                  height: '83px',
                  position: 'relative',
                  flex: '0 0 auto',
                  order: '1'
                }}>
                    <p data-id="p-mt9uiobo-2j" data-name="FORM STUDIO" style={{
                    color: '#F5F2EC',
                    textAlign: 'center',
                    fontFamily: '"Barlow Condensed", sans-serif',
                    fontSize: '90.16px',
                    fontStyle: 'normal',
                    fontWeight: '400',
                    lineHeight: '0.92',
                    letterSpacing: '-1.803px',
                    width: '384px',
                    margin: '0px',
                    height: 'auto',
                    position: 'relative',
                    flex: '0 0 auto',
                    order: '0'
                  }}>
                      FORM STUDIO
                    </p>
                  </div>
                  <div data-id="div-mt9uiobo-2k" data-name="Container:margin" style={{
                  display: 'flex',
                  paddingTop: '32px',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  width: '56px',
                  height: '88px',
                  position: 'relative',
                  flex: '0 0 auto',
                  order: '2'
                }}>
                    <div data-id="div-mt9uiobo-2l" data-name="Container" style={{
                    display: 'flex',
                    width: '56px',
                    height: '56px',
                    justifyContent: 'center',
                    alignItems: 'center',
                    borderRadius: '16777200px',
                    border: '1px solid rgba(245, 242, 236, 0.40)',
                    position: 'relative',
                    flex: '0 0 auto',
                    order: '0'
                  }}>
                      <p data-id="p-mt9uiobo-2m" data-name="→" style={{
                      color: '#F5F2EC',
                      textAlign: 'center',
                      fontFamily: 'Barlow, sans-serif',
                      fontSize: '20px',
                      fontStyle: 'normal',
                      fontWeight: '400',
                      lineHeight: '1.4',
                      width: '20px',
                      margin: '0px',
                      height: 'auto',
                      position: 'relative',
                      flex: '0 0 auto',
                      order: '0'
                    }}>
                        →
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
                  </div>
        <div data-id="div-mt9uiobo-2v" data-name="CaseStudy" data-pinned="true" style={{
        width: '100%',
        height: '681.695px',
        position: 'absolute',
        overflow: 'hidden',
        left: '0px',
        top: '0px',
        backgroundColor: '#141414',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        display: 'flex', order: '1'
      }}>
          <div data-id="div-mt9uiobo-2w" data-name="Image (MERIDIAN ARCHITECTS)" data-pinned="true" style={{
          width: '100%',
          height: '681.695px',
          opacity: '0.35',
          overflow: 'hidden',
          position: 'absolute',
          backgroundImage: \`url(\${item.untitled19})\`,
          backgroundRepeat: 'no-repeat',
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          flex: '0 0 auto',
          left: '0px',
          top: '0.15354207397052733px'
        }}></div>
          <div data-id="div-mt9uiobo-2x" data-name="Container" data-pinned="true" style={{
          width: '100%',
          position: 'absolute',
          backgroundImage: 'linear-gradient(180deg, rgba(10, 10, 10, 0.20) 0%, rgba(10, 10, 10, 0.85) 100%)',
          left: '0px',
          top: '0px',
          height: '682px'
        }}></div>
          <div data-id="div-mt9uiobo-2y" data-name="Container" data-pinned="true" style={{
          display: 'flex',
          width: '100%',
          maxWidth: '100%',
          flexDirection: 'column',
          alignItems: 'flex-start',
          position: 'relative',
          flex: '1 0 0px',
          paddingTop: '0px',
          paddingRight: '48px',
          paddingBottom: '80px',
          paddingLeft: '48px',
          justifyContent: 'flex-end'
        }}>
            <div data-id="div-mt9uiobo-2z" data-name="Paragraph" style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-start',
            width: '100%',
            height: '15px',
            position: 'relative',
            flex: '0 0 auto',
            order: '0'
          }}>
              <p data-id="p-mt9uiobo-30" data-name="02 — Web Experience — 2024" style={{
              color: '#E8FF47',
              fontFamily: '"DM Mono", sans-serif',
              fontSize: '11.2px',
              fontStyle: 'normal',
              fontWeight: '400',
              lineHeight: '1.333',
              letterSpacing: '2.016px',
              textTransform: 'uppercase',
              width: '100%',
              margin: '0px',
              height: 'auto',
              position: 'relative',
              flex: '0 0 auto',
              order: '0'
            }}>{item.title}</p>
            </div>
            <div data-id="div-mt9uiobo-31" data-name="Heading 1" style={{
            display: 'flex',
            width: '100%',
            height: 'min-content',
            paddingTop: '16px',
            flexDirection: 'column',
            alignItems: 'flex-start',
            position: 'relative',
            flex: '0 0 auto',
            order: '1'
          }}>
              <p data-id="p-mt9uiobo-32" data-name="MERIDIAN ARCHITECTS" style={{
              color: '#F5F2EC',
              fontFamily: '"Barlow Condensed", sans-serif',
              fontSize: '101.43px',
              fontStyle: 'normal',
              fontWeight: '400',
              lineHeight: '0.92',
              letterSpacing: '-2.536px',
              width: '717px',
              margin: '0px',
              height: 'auto',
              position: 'relative',
              flex: '0 0 auto',
              order: '0'
            }}>{item.untitled}</p>
            </div>
            <div data-id="div-mt9uiobo-33" data-name="Paragraph" style={{
            display: 'flex',
            width: '100%',
            height: '58px',
            maxWidth: '672px',
            paddingTop: '24px',
            flexDirection: 'column',
            alignItems: 'flex-start',
            position: 'relative',
            flex: '0 0 auto',
            order: '2'
          }}>
              <p data-id="p-mt9uiobo-34" data-name="A digital portfolio that matches the ambition of t" style={{
              color: '#C8C4BC',
              fontFamily: 'Barlow, sans-serif',
              fontSize: '22.4px',
              fontStyle: 'normal',
              fontWeight: '400',
              lineHeight: '1.5',
              width: '100%',
              margin: '0px',
              height: 'auto',
              position: 'relative',
              flex: '0 0 auto',
              order: '0'
            }}>{item.untitled2}</p>
            </div>
          </div>
        </div>
        <div data-id="div-mt9uiobo-35" data-name="CaseStudy" data-pinned="true" style={{
        display: 'flex',
        width: '100%',
        height: '80px',
        padding: '0 48px',
        justifyContent: 'space-between',
        alignItems: 'center',
        position: 'absolute',
        borderBottom: '1px solid rgba(245, 242, 236, 0.06)',
        backdropFilter: 'blur(12px)',
        left: '0px',
        top: '0px',
        backgroundColor: 'rgba(10, 10, 10, 0.92)', order: '1'
      }}>
          <div data-id="div-mt9uiobo-36" data-name="Link" style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          width: '55px',
          height: '28px',
          position: 'relative',
          flex: '0 0 auto',
          order: '0'
        }}>
            <p data-id="p-mt9uiobo-37" data-name="ATELIER." style={{
            color: '#E8FF47',
            fontFamily: '"Barlow Condensed", sans-serif',
            fontSize: '20px',
            fontStyle: 'normal',
            fontWeight: '400',
            lineHeight: '1.4',
            letterSpacing: '-0.5px',
            width: '55px',
            margin: '0px',
            height: 'auto',
            position: 'relative',
            flex: '0 0 auto',
            order: '0'
          }}>
              ATELIER.
            </p>
          </div>
          <div data-id="div-mt9uiobo-38" data-name="Button" style={{
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          width: '53px',
          height: '15px',
          position: 'relative',
          flex: '0 0 auto',
          order: '1'
        }}>
            <p data-id="p-mt9uiobo-39" data-name="← Back" style={{
            color: '#6B6864',
            textAlign: 'center',
            fontFamily: '"DM Mono", sans-serif',
            fontSize: '11.2px',
            fontStyle: 'normal',
            fontWeight: '400',
            lineHeight: '1.333',
            letterSpacing: '1.568px',
            textTransform: 'uppercase',
            width: '53px',
            margin: '0px',
            height: 'auto',
            position: 'relative',
            flex: '0 0 auto',
            order: '0'
          }}>
              ← Back
            </p>
          </div>
        </div>
      </div></div>;
}
const canvasNodes = <>
  <BaRoLe data-id="BaRoLe-mtu5f85o-2" data-name="BaRoLe" data-canvas-node="true" style={{
    position: 'absolute',
    height: '81px',
    width: '1440px',
    flex: '0 0 auto',
    left: '-1117px',
    top: '346px'
  }}></BaRoLe>
</>;`,
    'app/page.tsx': `import PageClient from './page.client';

export const metadata = {};

export default function Page() {
  return <PageClient />;
}
`,
    'app/page.client.tsx': `'use client';
export default function Page() { return <div data-id="root" style={{ width: '100%', minHeight: '400px' }}></div>; }
`,
    'components/BaRoLe.tsx': `'use client';
/** @label "BaRoLe" */
/** @comment "stub" */
/** @defaultWidth 1440 */
/** @defaultHeight 81 */
/** @controls {} */
import { withResponsiveProps } from '@revyme/runtime';
function BaRoLe({ ...props }: { [key: string]: any }) {
  return <div {...props} style={{ position: 'relative', width: '100%', height: '100%', background: '#222', ...props.style }} />;
}
export default withResponsiveProps(BaRoLe);
`,
    'cms/collection-1.schema.json': "{\"slug\": \"collection-1\", \"name\": \"Collection 1\", \"fields\": [{\"id\": \"title\", \"name\": \"title\", \"type\": \"text\"}, {\"id\": \"untitled\", \"name\": \"untitled\", \"type\": \"text\"}, {\"id\": \"untitled10\", \"name\": \"untitled10\", \"type\": \"image\"}, {\"id\": \"untitled19\", \"name\": \"untitled19\", \"type\": \"image\"}, {\"id\": \"untitled2\", \"name\": \"untitled2\", \"type\": \"text\"}, {\"id\": \"untitled20\", \"name\": \"untitled20\", \"type\": \"text\"}, {\"id\": \"untitled21\", \"name\": \"untitled21\", \"type\": \"text\"}, {\"id\": \"untitled22\", \"name\": \"untitled22\", \"type\": \"text\"}, {\"id\": \"untitled23\", \"name\": \"untitled23\", \"type\": \"text\"}, {\"id\": \"untitled3\", \"name\": \"untitled3\", \"type\": \"text\"}, {\"id\": \"untitled4\", \"name\": \"untitled4\", \"type\": \"text\"}, {\"id\": \"untitled5\", \"name\": \"untitled5\", \"type\": \"text\"}, {\"id\": \"untitled6\", \"name\": \"untitled6\", \"type\": \"text\"}, {\"id\": \"untitled7\", \"name\": \"untitled7\", \"type\": \"text\"}, {\"id\": \"untitled8\", \"name\": \"untitled8\", \"type\": \"image\"}, {\"id\": \"untitled9\", \"name\": \"untitled9\", \"type\": \"image\"}]}",
    'cms/collection-1.json': "[{\"_id\": \"i1\", \"_slug\": \"meridian\", \"_status\": \"published\", \"_createdAt\": \"2026-09-01T00:00:00.000Z\", \"_updatedAt\": \"2026-09-01T00:00:00.000Z\", \"title\": \"02 \\u2014 Web Experience \\u2014 2024\", \"untitled\": \"MERIDIAN ARCHITECTS\", \"untitled10\": \"https://images.unsplash.com/photo-1545897398-2aba891843b6?w=800\", \"untitled19\": \"https://images.unsplash.com/photo-1545897398-2aba891843b6?w=800\", \"untitled2\": \"A digital portfolio that matches the ambition of the practice.\", \"untitled20\": \"UNTITLED20\", \"untitled21\": \"UNTITLED21\", \"untitled22\": \"UNTITLED22\", \"untitled23\": \"UNTITLED23\", \"untitled3\": \"UNTITLED3\", \"untitled4\": \"UNTITLED4\", \"untitled5\": \"UNTITLED5\", \"untitled6\": \"UNTITLED6\", \"untitled7\": \"UNTITLED7\", \"untitled8\": \"https://images.unsplash.com/photo-1545897398-2aba891843b6?w=800\", \"untitled9\": \"https://images.unsplash.com/photo-1545897398-2aba891843b6?w=800\"}]",
  },
};


// ─────────────────────────────────────────────────────────────────────────
// INSTANCE_CANVAS_3VP — three page viewports (desktop primary, tablet,
// mobile) and a DESIGN-COMPONENT INSTANCE (`components/Card.tsx`, flex root
// that forwards `{...rest}`) parked on the open canvas between the desktop and
// tablet tiles. Used for: dragging a component instance into a REPLICA must
// show it ONLY there — inline `display:'none'` on the tag (the primary-range
// hide no @media band can express), the entered band restoring the master
// ROOT's `flex`, the other replica hidden (2026-09-09: instances skipped the
// inline hide and stayed visible on desktop).
// ─────────────────────────────────────────────────────────────────────────
export const INSTANCE_CANVAS_3VP: ProjectData = {
  format: 'revyme-v1',
  files: {
    'app/page.tsx': `import PageClient from './page.client';\n\nexport const metadata = {};\n\nexport default function Page() {\n  return <PageClient />;\n}\n`,
    'app/page.client.tsx': `/** @canvas {
  "viewports": [
    { "id": "desktop", "label": "Desktop", "width": 1440, "isPrimary": true, "order": 0 },
    { "id": "tablet", "label": "Tablet", "width": 768, "isPrimary": false, "order": 1 },
    { "id": "mobile", "label": "Mobile", "width": 375, "isPrimary": false, "order": 2 }
  ],
  "positions": {
    "desktop": { "x": 0, "y": 0 },
    "tablet": { "x": 1960, "y": 0 },
    "mobile": { "x": 2860, "y": 0 }
  }
} */
'use client';
import Card from '@/components/Card';

export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{
      display: 'flex', flexDirection: 'column', gap: '24px',
      width: '100%', minHeight: '900px', position: 'relative',
      background: '#0d0d1a', padding: '40px',
    }}>
      <div data-id="hero" data-name="Hero" style={{
        width: '100%', height: '200px', background: '#1a1a3a',
        position: 'relative', flex: '0 0 auto',
      }}></div>
    </div>
  );
}
const canvasNodes = (<>
  <Card data-id="card-inst" data-name="Card" data-canvas-node="true" style={{
    position: 'absolute', left: '1540px', top: '120px', width: '300px', height: '200px',
  }} />
</>);
`,
    'components/Card.tsx': `'use client';

/** @name "Card" */

import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const variantConfig = [{ name: 'default', label: 'Card', x: 0, y: 0, isPrimary: true }];

function Card({ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  return <LayoutGroup>
    <motion.div layout={true} data-id="card-root" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Card" style={{
      position: 'absolute',
      display: 'flex',
      flexDirection: 'column',
      gap: '12px',
      width: '300px',
      height: '200px',
      padding: '24px',
      backgroundColor: '#97cffc',
      borderRadius: '12px',
      left: '0px',
      top: '0px',
      ...style
    }}>
      <motion.p layout={true} data-id="card-text" data-name="Text" style={{ fontSize: '24px', color: '#000000', position: 'relative' }}>Card</motion.p>
    </motion.div>
  </LayoutGroup>;
}
export default withResponsiveProps(Card);
`,
  },
};

export const SEEDS = {
  REPLICA_EXIT_TO_FRAME,
  NEGATIVE_MARGIN_ROW,
  HANDOFF_TWO_VP,
  COMPONENT_MASTER_2V,
  GHOST_SIBLING_COLUMN,
  FLEX_COLUMN,
  FLEX_COLUMN_GAP,
  FLEX_ROW,
  REORDERED_FLEX_COLUMN,
  CANVAS_NODE,
  CANVAS_NODE_SMALL,
  CANVAS_NODE_WITH_GAP,
  ABSOLUTE_IN_FRAME,
  ABSOLUTE_IN_TRANSFORMED_FRAME,
  CENTERED_ABS_SVG,
  ENCAPSULATE_MIXED,
  ENCAPSULATE_CANVAS_MIXED,
  PINNED_ABS_IN_FRAME,
  FLEX_COL_TALL,
  FLEX_COL_ORDERED,
  IMAGE_FILL_NODE,
  OVERLAY_ON_FLEX_CHILD,
  SHAPE_EDIT_TRIANGLE,
  SVG_GROUP_LETTERS,
  OSS_SMOKE,
  CANVAS_ENTRY,
  REPLICA_AUTO_HEIGHT,
  LOCALE_3VP,
  REPLICA_ABS_DRAG,
  LOCALE_TEXT,
  COMPONENT_MASTER,
  REPLICA_ABSOLUTE_EXIT,
  ROTATED_FLEX_FRAME,
  CMS_LIST_ROWS,
  FLEX_WITH_ABSOLUTE_HERO,
  USER_HERO_BEFORE,
  USER_HERO_AFTER,
  INSTANCE_CANVAS_3VP,
} as const;

export type SeedName = keyof typeof SEEDS;
