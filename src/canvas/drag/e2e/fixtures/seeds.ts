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

export const SEEDS = {
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
} as const;

export type SeedName = keyof typeof SEEDS;
