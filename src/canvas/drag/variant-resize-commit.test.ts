import { describe, it, expect, vi } from 'vitest';

vi.mock('@/shared/debug-trace', () => ({ trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn() } }));
vi.mock('@/canvas/node-ops', () => ({ isPrimaryViewport: (v: string) => v === 'desktop' || v === 'default' }));
vi.mock('@/code/project/active-file-store', () => ({ isComponentFilePath: (p: string) => p.startsWith('components/') }));
vi.mock('@/code/project/project-fs', () => ({ projectFS: { readFile: () => '' } }));
vi.mock('@/code/variants/variant-config', () => ({ parseVariantConfig: () => [] }));
vi.mock('@/code/stores/store', () => ({ getNodeFromCache: vi.fn() }));
import { getNodeFromCache } from '@/code/stores/store';
import { getReplicaContext, svgChildCarrierOrigin, compensateGroupChildVariantsForBaseBox } from '@/canvas/drag/replica-context';
import { updateVariantStyleInCode } from '@/code/generation/generator-styles';

// Regression pin for the variant-resize channel of an svg GROUP CHILD:
// width/height must become scaleX/scaleY (relative to base attrs), left/top
// become x/y deltas COMPENSATED for the fill-box center origin, and the
// carrier (transformBox/transformOrigin) is emitted on first scale. CSS
// width/height on a nested <svg> are NOT painted by Chromium (probe
// 2026-06-12) — the scale transform is the only channel both the canvas fold
// and live motion paint. Stale width/height px entries are cleared.
describe('variant resize commit of an svg group child', () => {
  const mockNodes = (motionVariants?: Record<string, Record<string, string | number>>) => {
    vi.mocked(getNodeFromCache).mockImplementation(((id: string) => {
      if (id === 'shape-1') {
        return {
          type: 'svg', parentId: 'group-1',
          attrs: { x: '0', y: '0', width: '199', height: '130' },
          styles: {},
          motionVariants,
        };
      }
      if (id === 'group-1') return { type: 'svg' };
      return null;
    }) as any);
  };

  it('converts the box to scale + compensated deltas, emits the carrier, persists via generator', () => {
    mockNodes();
    const ctx = getReplicaContext('variant-1', 'components/Card.tsx', { default: 400, 'variant-1': 400 });
    const updates = ctx.styleUpdate('shape-1', { width: '300px', height: '196px', left: '0px', top: '0px' });

    // view-box + PX origin at the attr-box centre — NOT fill-box, which
    // Chrome resolves without the x/y attr offset on a nested svg (probe
    // 2026-06-12; the LeDaJo rotation orbit).
    const carrier = updates.find(u => u.type === 'updateStyles') as any;
    expect(carrier?.styles?.transformBox).toBe('view-box');
    expect(carrier?.styles?.transformOrigin).toBe('99.5px 65px');

    const vu = updates.find(u => u.type === 'updateVariantStyle') as any;
    // sx = 300/199, sy = 196/130
    expect(parseFloat(vu.styles.scaleX)).toBeCloseTo(300 / 199, 3);
    expect(parseFloat(vu.styles.scaleY)).toBeCloseTo(196 / 130, 3);
    // center-origin compensation: x = (L − baseX) + baseW·(sx − 1)/2
    expect(parseFloat(vu.styles.x)).toBeCloseTo(0 + 199 * (300 / 199 - 1) / 2, 2);
    expect(parseFloat(vu.styles.y)).toBeCloseTo(0 + 130 * (196 / 130 - 1) / 2, 2);
    // the dead CSS channel is cleared
    expect(vu.styles.width).toBe('');
    expect(vu.styles.height).toBe('');

    const CODE = `import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const variantConfig = [{ name: 'default', label: 'A', x: 0, y: 0, isPrimary: true }, { name: 'variant-1', label: 'B', x: 600, y: 0 }];

function Card({ style, initialVariant = 'default' }) {
  return <LayoutGroup>
    <motion.div layout={true} data-id="root-frame" data-name="Frame" style={{ position: 'absolute', width: '848px', height: '431px', ...style }}>
      <motion.svg data-id="group-1" data-name="Group" viewBox="0 0 610 259" style={{ position: 'absolute', left: '87px', top: '86px', width: '610px', height: '259px', overflow: 'visible' }}><motion.svg data-id="shape-1" data-name="Triangle" x="0" y="0" width="199" height="130" viewBox="0 0 199 130" overflow="visible">
        <polygon points="99.5,0 199,130 0,130" fill="#3b82f6" />
      </motion.svg></motion.svg>
    </motion.div>
  </LayoutGroup>;
}

export default withResponsiveProps(Card);
`;
    const out = updateVariantStyleInCode(CODE, 'shape-1', 'variant-1', vu.styles);
    const entry = out.match(/shape1Variants = \{[\s\S]*?'variant-1': \{([^}]*)\}/)?.[1] ?? 'ENTRY NOT FOUND';
    expect(entry).toContain('scaleX');
    expect(entry).toContain('scaleY');
    expect(entry).not.toContain('width');
    // default entry gets the neutral scale return path (animate-back law)
    const def = out.match(/shape1Variants = \{[\s\S]*?default: \{([^}]*)\}/)?.[1] ?? '';
    expect(def).toContain('scaleX: 1');
  });

  it('width-only write keeps the painted left anchored via the prev entry', () => {
    mockNodes({ 'variant-1': { x: 35, y: 0, scaleX: 1.2 } });
    const ctx = getReplicaContext('variant-1', 'components/Card.tsx', { default: 400, 'variant-1': 400 });
    const updates = ctx.styleUpdate('shape-1', { width: '341px' });
    const vu = updates.find(u => u.type === 'updateVariantStyle') as any;
    const sx = 341 / 199;
    expect(parseFloat(vu.styles.scaleX)).toBeCloseTo(sx, 3);
    // dx' = prevDx + baseW·(sx − prevSx)/2
    expect(parseFloat(vu.styles.x)).toBeCloseTo(35 + 199 * (sx - 1.2) / 2, 2);
    // height untouched
    expect(vu.styles.scaleY).toBeUndefined();
    expect(vu.styles.y).toBeUndefined();
  });

  it('position-only drag of an unscaled child keeps plain delta semantics', () => {
    mockNodes();
    const ctx = getReplicaContext('variant-1', 'components/Card.tsx', { default: 400, 'variant-1': 400 });
    const updates = ctx.styleUpdate('shape-1', { left: '35px', top: '10px' });
    const vu = updates.find(u => u.type === 'updateVariantStyle') as any;
    expect(vu.styles.x).toBe('35');
    expect(vu.styles.y).toBe('10');
    expect(vu.styles.attrX).toBe('');
    expect(vu.styles.scaleX).toBeUndefined();
    // no carrier for a pure move
    expect(updates.find(u => u.type === 'updateStyles')).toBeUndefined();
  });

  it('carrier origin: the LeDaJo orbit case (x=84, y=74) pivots at the attr-box centre', () => {
    // Real-Chromium probe (transform-box-probe, 2026-06-12): fill-box + 50%
    // painted the rotated path at (45, 15) instead of (195, 180) — Chrome
    // ignores the x/y attr offset. view-box + this px origin was pixel-exact.
    const carrier = svgChildCarrierOrigin(
      { x: '84', y: '74', width: '68', height: '153' },
      '0 0 152 227',
    );
    expect(carrier.transformBox).toBe('view-box');
    expect(carrier.transformOrigin).toBe('118px 150.5px');
    // Non-normalized parent viewBox shifts the px space.
    const shifted = svgChildCarrierOrigin(
      { x: '84', y: '74', width: '68', height: '153' },
      '10 20 152 227',
    );
    expect(shifted.transformOrigin).toBe('128px 170.5px');
  });

  it('INHERITANCE MODEL: a variant write stays SPARSE — no seeding into other variants', () => {
    // The responsive-system parity (2026-06-12): variant entries carry ONLY
    // independently-touched values, like @media overrides. Untouched variants
    // INHERIT the default at paint/compile time (resolveVariantStyles merge +
    // the preview's babel-boundary completion) — the earlier write-time
    // neutral seeding detached every variant and broke primary→replica sync.
    const CODE3 = `import React from 'react';
import { motion } from 'framer-motion';
const variantConfig = [{ name: 'default', label: 'A', x: 0, y: 0, isPrimary: true }, { name: 'variant-1', label: 'B', x: 313, y: 0 }, { name: 'variant-2', label: 'C', x: 626, y: 0 }];
const shape1Variants = {
  default: { x: 0, y: 0 },
  'variant-1': { x: 26, y: 69 },
};
function Card({ initialVariant = 'default' }) {
  return <motion.svg data-id="group-1" viewBox="0 0 152 227" style={{ position: 'absolute', left: '39px', top: '43px', width: '152px', height: '227px' }}>
    <motion.svg data-id="shape-1" variants={shape1Variants} initial={initialVariant} x="84" y="74" width="68" height="153" viewBox="0 0 68 153" overflow="visible">
      <path d="M0 0 L10 10z" />
    </motion.svg>
  </motion.svg>;
}
export default Card;
`;
    const out = updateVariantStyleInCode(CODE3, 'shape-1', 'variant-1', { rotate: '-167.4', x: '38', y: '-14' });
    // the touched variant gets the write
    expect(out.match(/'variant-1': \{([^}]*)\}/)?.[1]).toContain('rotate: -167.4');
    // NO entry materializes for the untouched variant — it inherits
    const constSlice = out.match(/shape1Variants = \{[\s\S]*?\n\};/)?.[0] ?? '';
    expect(constSlice).not.toContain("'variant-2'");
  });

  it('migration helper: scale+rotate entry converts to geometry with painted box unchanged', async () => {
    vi.mocked(getNodeFromCache).mockImplementation(((id: string) => {
      if (id === 'shape-1') {
        return {
          type: 'svg', parentId: 'group-1', children: ['shape-1-g0'],
          attrs: { x: '92', y: '49', width: '147', height: '115' },
          styles: {},
          motionVariants: { 'variant-1': { x: 8.5, y: 71, rotate: 30, scaleX: 1.0748, scaleY: 1.7304 } },
        };
      }
      if (id === 'shape-1-g0') return { type: 'path', attrs: { d: 'M0 0 L147 0 L147 115 L0 115 z' }, motionVariants: {} };
      if (id === 'group-1') return { type: 'svg', attrs: { viewBox: '0 0 400 300' } };
      return null;
    }) as any);
    const { groupChildScaleToGeometryUpdates } = await import('@/canvas/drag/replica-context');
    const updates = groupChildScaleToGeometryUpdates('shape-1', 'variant-1', 'components/Card.tsx');
    const wrapper = updates.find(u => u.nodeId === 'shape-1') as any;
    expect(wrapper.styles.scaleX).toBe('');
    // metadata = the previously painted size: 147·1.0748 ≈ 158, 115·1.7304 ≈ 199
    expect(parseFloat(wrapper.styles.width)).toBeCloseTo(147 * 1.0748, 1);
    expect(parseFloat(wrapper.styles.height)).toBeCloseTo(115 * 1.7304, 1);
    // painted position unchanged by the migration — deltas absent or re-emitted verbatim
    if (wrapper.styles.x !== undefined) expect(parseFloat(wrapper.styles.x)).toBeCloseTo(8.5, 3);
    if (wrapper.styles.y !== undefined) expect(parseFloat(wrapper.styles.y)).toBeCloseTo(71, 3);
  });

  it('NON-1:1 geometry: inner d scales about the VIEWBOX centre, not the box centre', () => {
    // The user's broken file (2026-06-12): a primary resize leaves box attrs
    // 184.123x96.464 with the SHARED viewBox still "0 0 118 76". The `d`
    // lives in viewBox units — scaling it about the BOX centre (92, 48)
    // shifted the shape's local centre as it grew and the replica resize
    // anchor crept ~7.5px/gesture. About the VB centre (59, 38) the anchor
    // pins exactly (live: e2e/replica-rotated-child-resize.live.mjs).
    vi.mocked(getNodeFromCache).mockImplementation(((id: string) => {
      if (id === 'shape-1') {
        return {
          type: 'svg', parentId: 'group-1', children: ['shape-1-g0'],
          attrs: { x: '232.197', y: '67.322', width: '184.123', height: '96.464', viewBox: '0 0 118 76' },
          styles: { transformBox: 'view-box' },
          motionVariants: { default: { x: 0, y: 0, rotate: 126.8 }, 'variant-1': { x: -231.197, y: 11.678, rotate: -213.2 } },
        };
      }
      if (id === 'shape-1-g0') return { type: 'path', attrs: { d: 'M59,0 L118,76 L0,76 Z' }, motionVariants: {} };
      if (id === 'group-1') return { type: 'svg', attrs: { viewBox: '0 0 330 155' } };
      return null;
    }) as any);
    const ctx = getReplicaContext('variant-1', 'components/Card.tsx', { default: 400, 'variant-1': 400 });
    const updates = ctx.styleUpdate('shape-1', { width: '238.743px', height: '127.128px' });
    const dWrite = updates.find(u => (u as any).styles?.d && (u as any).variantName === 'variant-1') as any;
    expect(dWrite).toBeTruthy();
    // sx = 238.743/184.123 = 1.2966, sy = 127.128/96.464 = 1.3179 about (59, 38):
    // M59,0 -> x stays 59 (on the centre line), y -> 38 + (0-38)*1.3179 = -12.08
    const m = dWrite.styles.d.match(/M\s*(-?[\d.]+)[ ,]+(-?[\d.]+)/);
    expect(parseFloat(m[1])).toBeCloseTo(59, 1);
    expect(parseFloat(m[2])).toBeCloseTo(-12.08, 1);
  });

  it('compensation d-centre: cache d about the VIEWBOX centre, fresh (bake) d about newBox/2', () => {
    // The BiNuWe break (2026-06-12): the gated primary commit passed CACHE
    // d's as newBaseDs — compensation treated them as bake-fresh (1:1 space)
    // and rescaled the replica's geometry about newBox/2 instead of the
    // unchanged viewBox centre → the independent replica jumped −40px.
    const mock = (vb: string) => vi.mocked(getNodeFromCache).mockImplementation(((id: string) => {
      if (id === 'shape-1') {
        return {
          type: 'svg', parentId: 'group-1', children: ['shape-1-g0'],
          attrs: { x: '263.502', y: '-36.449', width: '150.686', height: '179.148', viewBox: vb },
          styles: { transformBox: 'view-box' },
          motionVariants: { 'variant-1': { rotate: 139, width: '124.891', height: '95.925', x: 0.3875, y: -60.4945 } },
        };
      }
      if (id === 'shape-1-g0') return { type: 'path', attrs: { d: 'M62,0 L124,85 L0,85 Z' }, motionVariants: { 'variant-1': { d: 'M 62 19.74 L 113.39 65.26 L 10.61 65.26 Z' } } };
      if (id === 'group-1') return { type: 'svg', attrs: { viewBox: '0 0 357 115' } };
      return null;
    }) as any);
    const oldBox = { x: 263.502, y: -36.449, w: 150.686, h: 179.148 };
    const newBox = { x: 276.458, y: -60.064, w: 180.775, h: 226.378 };
    // CACHE d (gated branch: newBaseDs = {}): centre = viewBox centre (62, 42.5)
    mock('0 0 124 85');
    const cacheUpd = compensateGroupChildVariantsForBaseBox('shape-1', oldBox, newBox, {});
    const cacheD = (cacheUpd.find(u => (u as any).nodeId === 'shape-1-g0' && (u as any).variantName === 'variant-1') as any).styles.d;
    expect(parseFloat(cacheD.match(/M\s*(-?[\d.]+)/)[1])).toBeCloseTo(62, 1);
    // FRESH d (bake branch): the variant's CURRENT d is mapped from the old
    // vb space into the bake's renormalized 1:1 space — the old vb centre
    // (62, 42.5) lands on newBox/2 (90.3875, 113.189). curD's M x=62 sits ON
    // the centre line → it translates to exactly 90.3875.
    const freshUpd = compensateGroupChildVariantsForBaseBox('shape-1', oldBox, newBox, { 'shape-1-g0': 'M90,0 L181,226 L0,226 Z' });
    const freshD = (freshUpd.find(u => (u as any).nodeId === 'shape-1-g0' && (u as any).variantName === 'variant-1') as any).styles.d;
    expect(parseFloat(freshD.match(/M\s*(-?[\d.]+)/)[1])).toBeCloseTo(90.39, 1);
  });

  it('CONST-BOUNDED entry search: a missing entry must NOT leak into the NEXT const', () => {
    // BiNuWe 2026-06-12: the replica GROUP resize targeted vector…Variants
    // (default-only) — the unbounded entry regex matched the NEXT const's
    // 'variant-1' (the grandchild path's) and wrote width/height/left/top
    // beside its d; the group never got its entry and snapped back on
    // mouseup.
    const CODE = `import { motion } from 'framer-motion';
const vectorVariants = {
  default: { left: '71px', top: '69px' }
};
const innerG0Variants = {
  default: { d: 'M62,0 L124,85 L0,85 Z' },
  'variant-1': { d: 'M 62 11.5 L 194.4 73.4 L -70.4 73.4 Z' }
};
function Card({ initialVariant = 'default' }) {
  return <motion.svg data-id="vector-1" variants={vectorVariants} initial={['default', initialVariant]} style={{ position: 'absolute', left: '71px', top: '69px', width: '357px', height: '115px' }}>
    <motion.svg data-id="shape-1" x="0" y="0" width="124" height="85" viewBox="0 0 124 85" overflow="visible">
      <motion.path data-id="shape-1-g0" variants={innerG0Variants} initial={['default', initialVariant]} d="M62,0 L124,85 L0,85 Z" />
    </motion.svg>
  </motion.svg>;
}
export default Card;
`;
    const out = updateVariantStyleInCode(CODE, 'vector-1', 'variant-1', { width: '146px', height: '112px' });
    // the GROUP's const gets the new entry
    const vec = out.match(/vectorVariants = \{[\s\S]*?\n\};/)?.[0] ?? '';
    expect(vec).toContain("'variant-1'");
    expect(vec).toContain("width: '146px'");
    // the inner path's const is UNTOUCHED
    const g0 = out.match(/innerG0Variants = \{[\s\S]*?\n\};/)?.[0] ?? '';
    expect(g0).not.toContain('width');
    expect(g0).not.toContain('left');
  });

  it('size reset (empty string) clears the scale override', () => {
    mockNodes({ 'variant-1': { scaleX: 1.5, x: 50 } });
    const ctx = getReplicaContext('variant-1', 'components/Card.tsx', { default: 400, 'variant-1': 400 });
    const updates = ctx.styleUpdate('shape-1', { width: '' });
    const vu = updates.find(u => u.type === 'updateVariantStyle') as any;
    expect(vu.styles.scaleX).toBe('');
    expect(vu.styles.width).toBe('');
  });
});
