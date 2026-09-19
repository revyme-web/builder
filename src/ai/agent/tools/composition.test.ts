// src/ai/agent/tools/composition.test.ts
//
// Chantier Q5-A — the pure structural-perception building blocks: region
// detection, horizontal balance, sibling alignment, column proportions, the
// type scale, and empty gaps. Every analysis is tested with a triggering
// fixture and a boundary case that must NOT trigger — same discipline as
// design-audit.test.ts. No store, no bridge, no DOM: the analyses only ever
// see the flat AuditNode fixture that collectLayoutSnapshot produces.

import { describe, expect, it } from 'vitest';
import {
  ALIGNMENT_TOLERANCE_PX,
  BALANCE_TOLERANCE_RATIO,
  TYPE_SCALE_MIN_STEP,
  alignmentAnalysis,
  balanceAnalysis,
  detectRegions,
  formatCompositionReport,
  gapAnalysis,
  proportionAnalysis,
  typeHierarchy,
  type RegionInfo,
} from './composition';
import type { AuditNode, LayoutRect } from './design-audit';

function rect(x: number, y: number, width: number, height: number): LayoutRect {
  return { x, y, width, height };
}

function makeNode(overrides: Partial<AuditNode> = {}): AuditNode {
  return {
    id: 'n',
    parentId: null,
    children: [],
    text: '',
    rect: null,
    computed: {},
    ...overrides,
  };
}

/** A child of `regionId` with a rect — the common fixture shape. */
function child(id: string, regionId: string, r: LayoutRect, computed: Record<string, string> = {}): AuditNode {
  return makeNode({ id, parentId: regionId, rect: r, computed });
}

/** The region's own AuditNode (with its children array wired) plus the
 *  children — the shape childrenWithRects needs. */
function regionNodes(regionId: string, r: LayoutRect, kids: AuditNode[]): AuditNode[] {
  return [
    makeNode({ id: regionId, parentId: 'root', rect: r, children: kids.map((k) => k.id) }),
    ...kids,
  ];
}

function regionOf(id: string, r: LayoutRect): RegionInfo {
  return {
    id,
    rect: r,
    topPct: 0,
    bottomPct: 100,
    heightPct: 100,
  };
}

/** The stable landing-page fixture: hero (centered) + 2-column features
 *  (50/50) + footer, 56 → 18 → 14 type scale, tight gaps. */
function landingNodes(): AuditNode[] {
  const root = makeNode({ id: 'root', rect: rect(0, 0, 1440, 900), children: ['hero', 'features', 'footer'] });
  const hero = makeNode({ id: 'hero', parentId: 'root', rect: rect(0, 0, 1440, 300), children: ['hero-title', 'hero-sub', 'hero-cta'] });
  const features = makeNode({ id: 'features', parentId: 'root', rect: rect(0, 300, 1440, 300), children: ['feature-a', 'feature-b'] });
  const footer = makeNode({ id: 'footer', parentId: 'root', rect: rect(0, 600, 1440, 300) });
  return [
    root,
    hero,
    features,
    footer,
    { ...child('hero-title', 'hero', rect(470, 40, 500, 56), { fontSize: '56px' }), text: 'Build the future, visually.' },
    { ...child('hero-sub', 'hero', rect(560, 140, 320, 28), { fontSize: '18px' }), text: 'A code-first editor.' },
    { ...child('hero-cta', 'hero', rect(700, 220, 140, 40), {}), text: 'Get Started' },
    { ...child('feature-a', 'features', rect(0, 320, 720, 200), { fontSize: '14px' }), text: 'Code First' },
    { ...child('feature-b', 'features', rect(720, 320, 720, 200), { fontSize: '14px' }), text: 'Visual Canvas' },
  ];
}

describe('detectRegions', () => {
  it('lists root children with their page share, top-down', () => {
    const regions = detectRegions(landingNodes());
    expect(regions.map((r) => r.id)).toEqual(['hero', 'features', 'footer']);
    expect(regions[0]).toMatchObject({ id: 'hero', topPct: 0, bottomPct: 33, heightPct: 33 });
    expect(regions[2]).toMatchObject({ id: 'footer', topPct: 67, heightPct: 33 });
  });

  it('ignores decorations, unmeasured nodes and grand-children', () => {
    const nodes = [
      makeNode({ id: 'root', rect: rect(0, 0, 1440, 900), children: ['tall', 'tiny', 'no-rect', 'nested'] }),
      makeNode({ id: 'tall', parentId: 'root', rect: rect(0, 0, 1440, 500) }),
      makeNode({ id: 'tiny', parentId: 'root', rect: rect(0, 500, 10, 10) }),
      makeNode({ id: 'no-rect', parentId: 'root' }),
      makeNode({ id: 'nested', parentId: 'root', children: ['deep'] }),
      makeNode({ id: 'deep', parentId: 'nested', rect: rect(0, 600, 1440, 300) }),
    ];
    const regions = detectRegions(nodes);
    expect(regions.map((r) => r.id)).toEqual(['tall']);
  });

  it('returns an empty list for an empty or unmeasured snapshot', () => {
    expect(detectRegions([])).toEqual([]);
    expect(detectRegions([makeNode({ id: 'root', rect: null, parentId: null })])).toEqual([]);
  });
});

describe('balanceAnalysis', () => {
  it('calls a region centered when the children mass around its center', () => {
    const regions = [regionOf('hero', rect(0, 0, 1440, 300))];
    const nodes = regionNodes('hero', rect(0, 0, 1440, 300), [
      child('t', 'hero', rect(470, 40, 500, 56)),
      child('s', 'hero', rect(560, 140, 320, 28)),
      child('c', 'hero', rect(700, 220, 140, 40)),
    ]);
    const findings = balanceAnalysis(nodes, regions);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toBe('hero centered');
  });

  it('flags a left-heavy region with the COM vs center numbers', () => {
    const regions = [regionOf('features', rect(0, 300, 1440, 300))];
    const nodes = regionNodes('features', rect(0, 300, 1440, 300), [
      child('a', 'features', rect(0, 320, 480, 200)),
      child('b', 'features', rect(480, 320, 120, 200)),
    ]);
    const findings = balanceAnalysis(nodes, regions);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toBe('features left-heavy (COM ~300px vs center 720px)');
  });

  it('flags a right-heavy region', () => {
    const regions = [regionOf('r', rect(0, 0, 800, 300))];
    const nodes = regionNodes('r', rect(0, 0, 800, 300), [
      child('a', 'r', rect(640, 10, 160, 200)),
      child('b', 'r', rect(600, 10, 160, 200)),
    ]);
    const findings = balanceAnalysis(nodes, regions);
    expect(findings[0].message).toContain('right-heavy');
  });

  it('skips regions without measurable children', () => {
    const regions = [regionOf('empty', rect(0, 0, 1440, 300))];
    expect(balanceAnalysis(regionNodes('empty', rect(0, 0, 1440, 300), []), regions)).toEqual([]);
  });

  it('is centered again at exactly the tolerance boundary', () => {
    const regions = [regionOf('r', rect(0, 0, 1000, 300))];
    // COM sits exactly BALANCE_TOLERANCE_RATIO of the width from the center.
    const center = 500;
    const driftPx = 1000 * BALANCE_TOLERANCE_RATIO;
    const nodes = regionNodes('r', rect(0, 0, 1000, 300), [
      child('a', 'r', rect(center + driftPx - 50, 10, 100, 100)),
    ]);
    const findings = balanceAnalysis(nodes, regions);
    expect(findings[0].message).toBe('r centered');
  });
});

describe('alignmentAnalysis', () => {
  it('reports an aligned row: same top edge, same heights', () => {
    const regions = [regionOf('cards', rect(0, 0, 900, 300))];
    const nodes = regionNodes('cards', rect(0, 0, 900, 300), [
      child('a', 'cards', rect(0, 10, 400, 200)),
      child('b', 'cards', rect(420, 12, 400, 200)),
    ]);
    const findings = alignmentAnalysis(nodes, regions);
    const messages = findings.map((f) => f.message);
    expect(messages).toContain('cards share the same top edge (aligned row)');
    expect(messages).toContain('cards equal-height siblings');
    expect(messages).toContain('cards equal-width siblings (400px)');
  });

  it('reports an aligned column: same left edge', () => {
    const regions = [regionOf('stack', rect(0, 0, 300, 900))];
    const nodes = regionNodes('stack', rect(0, 0, 300, 900), [
      child('a', 'stack', rect(24, 0, 240, 100)),
      child('b', 'stack', rect(24, 120, 240, 100)),
    ]);
    const findings = alignmentAnalysis(nodes, regions);
    expect(findings.map((f) => f.message)).toContain('stack share the same left edge (aligned column)');
  });

  it('reports staggered children when no edge or size is shared', () => {
    const regions = [regionOf('hero', rect(0, 0, 1440, 300))];
    const nodes = regionNodes('hero', rect(0, 0, 1440, 300), [
      child('t', 'hero', rect(470, 40, 500, 56)),
      child('s', 'hero', rect(560, 140, 320, 28)),
      child('c', 'hero', rect(700, 220, 140, 40)),
    ]);
    const findings = alignmentAnalysis(nodes, regions);
    expect(findings.map((f) => f.message)).toContain('hero share no edge — staggered children');
  });

  it('skips regions with fewer than two children and rows within the tolerance', () => {
    const regions = [regionOf('solo', rect(0, 0, 300, 300))];
    expect(alignmentAnalysis(regionNodes('solo', rect(0, 0, 300, 300), [child('a', 'solo', rect(0, 0, 100, 100))]), regions)).toEqual([]);
    const onEdge = [regionOf('row', rect(0, 0, 600, 200))];
    const nodes = regionNodes('row', rect(0, 0, 600, 200), [
      child('a', 'row', rect(0, 0, 200, 100)),
      child('b', 'row', rect(220, ALIGNMENT_TOLERANCE_PX, 200, 100)),
    ]);
    expect(alignmentAnalysis(nodes, onEdge).map((f) => f.message)).toContain('row share the same top edge (aligned row)');
  });
});

describe('proportionAnalysis', () => {
  it('calls a 50/50 row balanced', () => {
    const regions = [regionOf('features', rect(0, 300, 1440, 300))];
    const nodes = regionNodes('features', rect(0, 300, 1440, 300), [
      child('a', 'features', rect(0, 320, 720, 200)),
      child('b', 'features', rect(720, 320, 720, 200)),
    ]);
    const findings = proportionAnalysis(nodes, regions);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toBe('features columns 50/50 — balanced (a 720px vs b 720px)');
  });

  it('calls a 33/33/33 grid balanced', () => {
    const regions = [regionOf('grid', rect(0, 0, 900, 300))];
    const nodes = regionNodes('grid', rect(0, 0, 900, 300), [
      child('a', 'grid', rect(0, 0, 300, 200)),
      child('b', 'grid', rect(300, 0, 300, 200)),
      child('c', 'grid', rect(600, 0, 300, 200)),
    ]);
    const findings = proportionAnalysis(nodes, regions);
    expect(findings[0].message).toContain('33/33/33 — balanced');
  });

  it('flags an 80/20 row as imbalanced, naming the offenders', () => {
    const regions = [regionOf('features', rect(0, 300, 1440, 300))];
    const nodes = regionNodes('features', rect(0, 300, 1440, 300), [
      child('big', 'features', rect(0, 320, 480, 200)),
      child('small', 'features', rect(480, 320, 120, 200)),
    ]);
    const findings = proportionAnalysis(nodes, regions);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toBe('features columns 80/20 — imbalanced (big 480px vs small 120px)');
  });

  it('is balanced again at exactly the tolerance boundary', () => {
    const regions = [regionOf('r', rect(0, 0, 700, 300))];
    // 65/35 → each 15% off the equal share → exactly PROPORTION_TOLERANCE.
    const nodes = regionNodes('r', rect(0, 0, 700, 300), [
      child('a', 'r', rect(0, 0, 455, 200)),
      child('b', 'r', rect(455, 0, 245, 200)),
    ]);
    expect(proportionAnalysis(nodes, regions)[0].message).toContain('balanced');
  });

  it('skips rows that are a single column', () => {
    const regions = [regionOf('stack', rect(0, 0, 300, 900))];
    const nodes = regionNodes('stack', rect(0, 0, 300, 900), [
      child('a', 'stack', rect(0, 0, 300, 100)),
      child('b', 'stack', rect(0, 110, 300, 100)),
    ]);
    expect(proportionAnalysis(nodes, regions)).toEqual([]);
  });
});

describe('typeHierarchy', () => {
  it('calls a 56 → 32 → 18 → 14 scale healthy', () => {
    const nodes = [
      child('h1', 'a', rect(0, 0, 10, 10), { fontSize: '56px' }),
      child('h2', 'b', rect(0, 0, 10, 10), { fontSize: '32px' }),
      child('b1', 'c', rect(0, 0, 10, 10), { fontSize: '18px' }),
      child('b2', 'd', rect(0, 0, 10, 10), { fontSize: '14px' }),
    ].map((n) => ({ ...n, text: 'x' }));
    const findings = typeHierarchy(nodes);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toBe('healthy scale 56 → 32 → 18 → 14 (each step ≥ 1.2×)');
  });

  it('flags an all-16px page as FLAT', () => {
    const nodes = [
      { ...child('t1', 'a', rect(0, 0, 10, 10), { fontSize: '16px' }), text: 'Title' },
      { ...child('t2', 'b', rect(0, 0, 10, 10), { fontSize: '16px' }), text: 'Body' },
    ];
    const findings = typeHierarchy(nodes);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toBe('FLAT — every text node is 16 (no size contrast at all)');
  });

  it('flags a compressed scale when a step is under the minimum', () => {
    const nodes = [
      { ...child('h', 'a', rect(0, 0, 10, 10), { fontSize: '48px' }), text: 'H' },
      { ...child('b', 'b', rect(0, 0, 10, 10), { fontSize: '42px' }), text: 'B' },
    ];
    const findings = typeHierarchy(nodes);
    expect(findings[0].message).toContain(`compressed scale 48 → 42 (steps under ${TYPE_SCALE_MIN_STEP}×)`);
  });

  it('reports nothing when no text node has a measurable fontSize', () => {
    const nodes = [
      { ...child('t', 'a', rect(0, 0, 10, 10), {}), text: 'Title' },
      { ...child('c', 'b', rect(0, 0, 10, 10), { fontSize: '' }), text: 'CTA' },
      child('btn', 'c', rect(0, 0, 10, 10), { fontSize: '16px' }), // no text
    ];
    expect(typeHierarchy(nodes)).toEqual([]);
  });
});

describe('gapAnalysis', () => {
  it('flags a 25% empty gap between two regions', () => {
    const regions = [
      { ...regionOf('hero', rect(0, 0, 1440, 300)) },
      { ...regionOf('features', rect(0, 600, 1440, 300)) },
    ];
    const nodes = [
      makeNode({ id: 'hero', parentId: 'root', rect: rect(0, 0, 1440, 300) }),
      makeNode({ id: 'features', parentId: 'root', rect: rect(0, 600, 1440, 300) }),
      makeNode({ id: 'root', parentId: null, rect: rect(0, 0, 1440, 900) }),
    ];
    const findings = gapAnalysis(nodes, regions);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toBe('300px empty gap (33% of page height) between hero and features');
  });

  it('reports no gap when regions stack tightly (0px) or within the threshold', () => {
    const regions = [
      { ...regionOf('hero', rect(0, 0, 1440, 300)) },
      { ...regionOf('features', rect(0, 300, 1440, 300)) },
    ];
    const nodes = [
      makeNode({ id: 'hero', parentId: 'root', rect: rect(0, 0, 1440, 300) }),
      makeNode({ id: 'features', parentId: 'root', rect: rect(0, 300, 1440, 300) }),
      makeNode({ id: 'root', parentId: null, rect: rect(0, 0, 1440, 900) }),
    ];
    expect(gapAnalysis(nodes, regions)).toEqual([]);

    // A gap just under GAP_MAX_RATIO of the page (900 × 0.15 = 135) is fine.
    const regions2 = [
      { ...regionOf('hero', rect(0, 0, 1440, 300)) },
      { ...regionOf('features', rect(0, 430, 1440, 300)) },
    ];
    const nodes2 = [
      makeNode({ id: 'hero', parentId: 'root', rect: rect(0, 0, 1440, 300) }),
      makeNode({ id: 'features', parentId: 'root', rect: rect(0, 430, 1440, 300) }),
      makeNode({ id: 'root', parentId: null, rect: rect(0, 0, 1440, 900) }),
    ];
    expect(gapAnalysis(nodes2, regions2)).toEqual([]);
  });
});

describe('formatCompositionReport', () => {
  it('renders one line per constat for the landing-page fixture', () => {
    expect(formatCompositionReport(landingNodes())).toEqual([
      'regions: hero y:0-300 (33%), features y:300-600 (33%), footer y:600-900 (33%)',
      'balance: hero centered',
      'balance: features centered',
      'alignment: hero share no edge — staggered children',
      'alignment: features share the same top edge (aligned row)',
      'alignment: features equal-width siblings (720px)',
      'alignment: features equal-height siblings',
      'proportion: features columns 50/50 — balanced (feature-a 720px vs feature-b 720px)',
      'type: healthy scale 56 → 18 → 14 (each step ≥ 1.2×)',
    ]);
  });

  it('reports the diagnostic constats of an unbalanced page', () => {
    const nodes = [
      makeNode({ id: 'root', parentId: null, rect: rect(0, 0, 1440, 600), children: ['hero', 'features'] }),
      makeNode({ id: 'hero', parentId: 'root', rect: rect(0, 0, 1440, 300), children: ['hero-title'] }),
      makeNode({ id: 'features', parentId: 'root', rect: rect(0, 300, 1440, 300), children: ['big', 'small'] }),
      { ...child('hero-title', 'hero', rect(470, 40, 500, 56), { fontSize: '16px' }), text: 'Title' },
      { ...child('big', 'features', rect(0, 320, 480, 200), { fontSize: '16px' }), text: 'Big' },
      { ...child('small', 'features', rect(480, 320, 120, 200), { fontSize: '16px' }), text: 'Small' },
    ];
    const lines = formatCompositionReport(nodes).join('\n');
    expect(lines).toContain('balance: features left-heavy (COM ~300px vs center 720px)');
    expect(lines).toContain('proportion: features columns 80/20 — imbalanced (big 480px vs small 120px)');
    expect(lines).toContain('type: FLAT — every text node is 16 (no size contrast at all)');
  });

  it('degrades to a single note when the snapshot has no rects yet', () => {
    expect(formatCompositionReport([])).toEqual(['regions: none (no measured sections with rects)']);
  });

  it('caps the regions line on very long pages', () => {
    const root = makeNode({ id: 'root', parentId: null, rect: rect(0, 0, 1440, 2000) });
    const nodes = [root];
    for (let i = 0; i < 7; i++) {
      const id = `sec-${i}`;
      root.children.push(id);
      nodes.push(makeNode({ id, parentId: 'root', rect: rect(0, i * 200, 1440, 200) }));
    }
    const lines = formatCompositionReport(nodes);
    expect(lines[0]).toContain('…(+2 more)');
  });
});