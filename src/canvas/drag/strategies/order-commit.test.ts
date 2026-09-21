import { describe, it, expect, vi, beforeEach } from 'vitest';

const patchNodeStyles = vi.fn();

let mockActiveFilePath = 'pages/home.tsx';

vi.mock('@/canvas/node-ops', () => ({
  patchNodeStyles: (...args: unknown[]) => patchNodeStyles(...args),
  getViewportPrefix: (vpId: string) =>
    vpId === 'desktop' || vpId === 'default' ? '' : vpId + '-',
  isPrimaryViewport: (vpId: string) => vpId === 'desktop' || vpId === 'default',
  getActiveFilePath: () => mockActiveFilePath,
  findNodeComputedStyle: () => '0',
}));

vi.mock('@/code/stores/viewport-store', () => ({
  getViewportWidths: () => ({ desktop: 1280, tablet: 768 }),
}));

vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn(), dom: vi.fn() },
}));

let mockNodes: Record<string, any> = {};
vi.mock('@/code/stores/store', () => ({
  getNodeFromCache: (id: string) => mockNodes[id],
}));

import { commitOrderAssignments, computeLayoutBrackets } from './order-commit';

describe('computeLayoutBrackets', () => {
  it('brackets leading template section LOW and trailing HIGH (page sections slot between)', () => {
    const merged = ['layout::Header', 'hero', 'frame', 'faq', 'layout::CTA', 'layout::Footer'];
    const brackets = computeLayoutBrackets(merged);
    expect(brackets).toEqual([
      { id: 'layout::Header', order: -100000 }, // leading (idx 0) → far below page sections (0..N-1)
      { id: 'layout::CTA', order: 100004 },     // trailing (idx 4) → far above
      { id: 'layout::Footer', order: 100005 },  // trailing (idx 5), keeps DOM order vs CTA
    ]);
  });

  it('keeps the layout:: PREFIX (matches the canvas merge data-ids; dead no-op in deploy)', () => {
    const brackets = computeLayoutBrackets(['layout::Header', 'hero']);
    expect(brackets[0].id).toBe('layout::Header');
  });

  it('only-leading template section (no trailing)', () => {
    expect(computeLayoutBrackets(['layout::Header', 'hero', 'frame'])).toEqual([
      { id: 'layout::Header', order: -100000 },
    ]);
  });

  it('only-trailing template section (no leading)', () => {
    expect(computeLayoutBrackets(['hero', 'frame', 'layout::Footer'])).toEqual([
      { id: 'layout::Footer', order: 100002 },
    ]);
  });

  it('no page sections → no brackets', () => {
    expect(computeLayoutBrackets(['layout::Header', 'layout::Footer'])).toEqual([]);
  });

  it('no template sections (non-templated) → no brackets', () => {
    expect(computeLayoutBrackets(['hero', 'frame', 'faq'])).toEqual([]);
  });

  it('a template section BETWEEN page sections is left unbracketed (only leading/trailing slot)', () => {
    // Unusual shape; the standard template is Header-before / CTA-Footer-after.
    expect(computeLayoutBrackets(['hero', 'layout::Mid', 'frame'])).toEqual([]);
  });
});

describe('commitOrderAssignments', () => {
  const el = {} as HTMLElement;
  const assignments = [
    { nodeId: 'a', order: 0 },
    { nodeId: 'b', order: 1 },
  ];


  // A component master keeps a node's order in its `default` VARIANT object,
  // which framer-motion applies OVER the base style prop. Writing only the base
  // order produced a correct file and a canvas that never moved.
  // On a component master, `order` is ALWAYS written as a variant ternary — a
  // base write seeds `variants.default.order`, which framer-motion then applies
  // to every variant lacking its own entry, so the primary's order silently
  // becomes every variant's order. That seeding is what made the reported bug
  // intermittent: the first few primary reorders were fine, one of them seeded
  // the entry, and from then on Tablet followed Desktop (user, 2026-09-19).
  describe('component master — order always routes through the variant ternary', () => {
    it('uses setConditionalOrder even for a node with no variants at all', () => {
      mockActiveFilePath = 'components/Header.tsx';
      mockNodes = { a: { styles: { order: '4' } } };
      const updates = commitOrderAssignments([{ nodeId: 'a', order: 1 }], el, 'desktop');
      expect(updates).toContainEqual({ nodeId: 'a', type: 'setConditionalOrder', orderMap: { default: 1 } });
    });

    // The base write is what seeds the variants entry, so it must not happen.
    it('NEVER emits a base style write for order on a master', () => {
      mockActiveFilePath = 'components/Header.tsx';
      mockNodes = { a: {}, b: { conditionalStyles: { order: { default: '3' } } } };
      const updates = commitOrderAssignments(assignments, el, 'desktop');
      expect(updates.some(u => u.type === 'style' && u.styles?.order !== undefined)).toBe(false);
    });

    // MATERIALISE. A variant's branches are PARTIAL — only the children the user
    // moved on that tile have one, and the rest track the default. So renumbering
    // the primary walks into the variant's number space and a fall-through child
    // can COLLIDE with a sibling's explicit value; the tie breaks on DOM order and
    // the variant collapses onto the primary. Writing a COMPLETE branch set for
    // any independently-ordered variant makes its sequence self-contained.
    it('pins every child of an independently-ordered variant, not just the moved one', () => {
      mockActiveFilePath = 'components/Header.tsx';
      mockNodes = {
        a: { conditionalStyles: { order: { 'variant-1': '1', default: '2' } } },
        b: { styles: { order: '3' } },   // no branch — currently tracks default
      };
      const updates = commitOrderAssignments(
        [{ nodeId: 'a', order: 2 }, { nodeId: 'b', order: 1 }], el, 'desktop',
      );
      const byId = Object.fromEntries(
        updates.filter(u => u.type === 'setConditionalOrder').map(u => [u.nodeId, u]),
      ) as Record<string, { orderMap: Record<string, number>; pinVariants?: string[] }>;

      // Both children get an explicit variant-1 branch, and the SEQUENCE they
      // render on variant-1 today (a before b) is preserved. The values are
      // re-ranked to a strict 0..n-1 rather than copied, so no tie survives.
      expect(byId['a'].orderMap['variant-1']).toBe(0);
      expect(byId['b'].orderMap['variant-1']).toBe(1);
      // …and the default still moves.
      expect(byId['a'].orderMap.default).toBe(2);
      expect(byId['b'].orderMap.default).toBe(1);
    });

    // THE RESIDUE (user, 2026-09-19): the pink frame moved on Desktop and the
    // text frame moved with it on Tablet, while the blue one stayed put.
    //
    // Copying a variant's current VALUES preserves any TIE already in them,
    // and ties resolve on DOM order — which the primary's structural JSX
    // reorder then changes. Re-ranking to a strict 0..n-1 removes the tie, so
    // the variant's order is total and DOM-independent.
    it('breaks a tie in the variant\u2019s current values instead of copying it', () => {
      mockActiveFilePath = 'components/Header.tsx';
      mockNodes = {
        // Both render at 3 on variant-1 — a tie only DOM order resolves.
        a: { parentId: 'p', conditionalStyles: { order: { 'variant-1': '3', default: '1' } } },
        b: { parentId: 'p', conditionalStyles: { order: { default: '3' } } },
        p: { children: ['a', 'b'] },
      };
      const updates = commitOrderAssignments(
        [{ nodeId: 'a', order: 0 }, { nodeId: 'b', order: 1 }], el, 'desktop',
      );
      const v1 = Object.fromEntries(
        updates.filter(u => u.type === 'setConditionalOrder')
          .map(u => [u.nodeId, (u as { orderMap: Record<string, number> }).orderMap['variant-1']]),
      );
      // Distinct values — no tie left for a DOM reorder to flip.
      expect(v1['a']).not.toBe(v1['b']);
      expect(new Set(Object.values(v1)).size).toBe(2);
      // And the DOM-order tie-break is preserved as the ranking: a before b.
      expect(v1['a']).toBeLessThan(v1['b']);
    });

    it('marks the materialised variants as pinned so they survive pruning', () => {
      mockActiveFilePath = 'components/Header.tsx';
      mockNodes = { a: { conditionalStyles: { order: { 'variant-1': '1', default: '2' } } } };
      const updates = commitOrderAssignments([{ nodeId: 'a', order: 1 }], el, 'desktop');
      const cond = updates.find(u => u.type === 'setConditionalOrder') as { pinVariants?: string[] };
      expect(cond.pinVariants).toEqual(['variant-1']);
    });

    it('a parent with NO independently-ordered variant names only the default', () => {
      mockActiveFilePath = 'components/Header.tsx';
      mockNodes = { a: { styles: { order: '4' } } };
      const updates = commitOrderAssignments([{ nodeId: 'a', order: 1 }], el, 'desktop');
      const cond = updates.find(u => u.type === 'setConditionalOrder') as { orderMap: Record<string, number>; pinVariants?: string[] };
      expect(Object.keys(cond.orderMap)).toEqual(['default']);
      expect(cond.pinVariants).toBeUndefined();
    });

    it('order 0 routes the same way — a falsy value is not a skip', () => {
      mockActiveFilePath = 'components/Header.tsx';
      mockNodes = { a: {} };
      const updates = commitOrderAssignments([{ nodeId: 'a', order: 0 }], el, 'desktop');
      expect(updates).toContainEqual({ nodeId: 'a', type: 'setConditionalOrder', orderMap: { default: 0 } });
    });

    // A PAGE has no variants, so the plain inline write stays correct there.
    it('a PAGE still takes the plain base write', () => {
      mockActiveFilePath = 'app/page.client.tsx';
      mockNodes = { a: { conditionalStyles: { order: { default: '3' } } } };
      const updates = commitOrderAssignments([{ nodeId: 'a', order: 1 }], el, 'desktop');
      expect(updates).toContainEqual({ nodeId: 'a', type: 'style', styles: { order: '1' } });
      expect(updates.some(u => u.type === 'setConditionalOrder')).toBe(false);
    });
  });

  beforeEach(() => {
    patchNodeStyles.mockClear();
    mockActiveFilePath = 'pages/home.tsx';
    mockNodes = {};
  });

  it('primary viewport → inline style updates, patched without !important', () => {
    const updates = commitOrderAssignments(assignments, el, 'desktop');
    expect(updates).toEqual([
      { nodeId: 'a', type: 'style', styles: { order: '0' } },
      { nodeId: 'b', type: 'style', styles: { order: '1' } },
    ]);
    expect(patchNodeStyles).toHaveBeenCalledTimes(2);
    expect(patchNodeStyles).toHaveBeenCalledWith(el, 'a', '', { order: '0' });
  });

  it('page replica → updateContainerStyle, patched with !important', () => {
    const updates = commitOrderAssignments(assignments, el, 'tablet');
    expect(updates).toEqual([
      { nodeId: 'a', type: 'updateContainerStyle', maxWidth: 768, styles: { order: '0' } },
      { nodeId: 'b', type: 'updateContainerStyle', maxWidth: 768, styles: { order: '1' } },
    ]);
    expect(patchNodeStyles).toHaveBeenCalledWith(el, 'a', 'tablet-', { order: '0' }, true);
  });

  it('component master replica → setConditionalOrder', () => {
    mockActiveFilePath = 'components/Card.tsx';
    const updates = commitOrderAssignments(assignments, el, 'variant-1');
    expect(updates).toEqual([
      { nodeId: 'a', type: 'setConditionalOrder', orderMap: { default: 0, 'variant-1': 0 } },
      { nodeId: 'b', type: 'setConditionalOrder', orderMap: { default: 0, 'variant-1': 1 } },
    ]);
  });

  it('component master replica → default branch PRESERVES each node\'s model order (Layers-panel bug)', () => {
    // The Layers-panel reorder never warms the computed cache, so the old code
    // read findNodeComputedStyle → 0 for every node and collapsed the PRIMARY tile.
    // The default branch must come from the MODEL (plain inline order, or an
    // existing ternary's default), NOT the computed cache.
    mockActiveFilePath = 'components/Card.tsx';
    mockNodes = {
      a: { styles: { order: '2' } },                                    // plain inline order
      b: { conditionalStyles: { order: { default: '3', 'variant-1': '9' } } }, // existing ternary default
    };
    const updates = commitOrderAssignments(assignments, el, 'variant-1');
    expect(updates).toEqual([
      { nodeId: 'a', type: 'setConditionalOrder', orderMap: { default: 2, 'variant-1': 0 } },
      { nodeId: 'b', type: 'setConditionalOrder', orderMap: { default: 3, 'variant-1': 1 } },
    ]);
  });

  it('component master replica → defaultOrders (current visual index) drives the default branch', () => {
    // Children with NO inline order at all (pure flow order, the real Layers-panel
    // case): defaultOrders = each child's current visual index. The default branch
    // must keep that index so the PRIMARY tile is unchanged, while the variant gets
    // the new order. (No model node → without defaultOrders this would collapse to 0.)
    mockActiveFilePath = 'components/Card.tsx';
    const reordered = [{ nodeId: 'a', order: 2 }, { nodeId: 'b', order: 0 }, { nodeId: 'c', order: 1 }];
    const defaultOrders = new Map([['a', 0], ['b', 1], ['c', 2]]);
    const updates = commitOrderAssignments(reordered, el, 'variant-1', defaultOrders);
    expect(updates).toEqual([
      { nodeId: 'a', type: 'setConditionalOrder', orderMap: { default: 0, 'variant-1': 2 } },
      { nodeId: 'b', type: 'setConditionalOrder', orderMap: { default: 1, 'variant-1': 0 } },
      { nodeId: 'c', type: 'setConditionalOrder', orderMap: { default: 2, 'variant-1': 1 } },
    ]);
  });

  it('empty input → returns [] and patches nothing', () => {
    const updates = commitOrderAssignments([], el, 'desktop');
    expect(updates).toEqual([]);
    expect(patchNodeStyles).toHaveBeenCalledTimes(0);
  });

  it('page replica with unknown vpId → maxWidth falls back to 0', () => {
    const updates = commitOrderAssignments(assignments, el, 'mobile');
    expect(updates).toEqual([
      { nodeId: 'a', type: 'updateContainerStyle', maxWidth: 0, styles: { order: '0' } },
      { nodeId: 'b', type: 'updateContainerStyle', maxWidth: 0, styles: { order: '1' } },
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE ROUTING INVARIANT — every `order` write goes through commitOrderAssignments.
//
// `order` is the one style property whose correct DESTINATION depends on the
// viewport: inline on primary, @container CSS on a page replica, and a variant
// TERNARY on a component master's variant tile. Writing it as an ordinary style
// looks right and works on the primary viewport, which is why three separate
// call sites drifted into doing exactly that (ToolbarDragStrategy's insert-drop,
// CanvasDragStrategy's absolute→layout entry, and every draw-to-create creator).
//
// On a component master they all routed into `variants[X].order = N` — which
// CLAUDE.md forbids outright, because framer-motion tweens `order` as a float
// and overlays it on the inline value, parking the node at the wrong slot. The
// user hit it as "the titles went to the bottom, order 2 instead of 0/1"
// (2026-07-27).
//
// A source scan rather than five mock harnesses: the failure is *where the call
// is written*, and this states that directly. It fails loudly with the offending
// file:line so the next drift is a one-line fix, not another live-page autopsy.
// ─────────────────────────────────────────────────────────────────────────────
describe('order routing invariant', () => {
  it('no module writes `order` as a raw style update outside order-commit', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const url = await import('node:url');

    const SRC = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../../..');

    /** `order-commit` IS the router; the generator emits the final text. */
    const EXEMPT = [
      'canvas/drag/strategies/order-commit.ts',
      'code/generation/',        // the writers commitOrderAssignments routes TO
      'code/mutation/',          // the queue that applies them
      'code/oracle/',            // rule text mentioning `order:`
    ];

    /** A `type: 'style'` / `updateStyles` / `updateVariantStyle` update carrying an
     *  order VALUE. `order: ''` is excluded on purpose — that's a removal
     *  (clear back to the CSS default), which is correct from any viewport and
     *  needs no routing. */
    const ORDER_VALUE = /\border\s*:\s*(?:String\(|-?\d|'-?\d|"-?\d)/;
    const STYLE_UPDATE = /type:\s*'(?:style|updateStyles|updateVariantStyle)'/;

    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!/\.tsx?$/.test(e.name) || /\.test\.tsx?$/.test(e.name)) continue;
        const rel = path.relative(SRC, p).split(path.sep).join('/');
        if (EXEMPT.some(x => rel.startsWith(x) || rel === x)) continue;
        // Comments are prose about `order`, not writes of it — a line reading
        // "an orphan inline `order:10` on the slot" is documentation, not a bug.
        // Blank them out (keeping newlines so reported line numbers stay true).
        const text = fs.readFileSync(p, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
          .replace(/(^|[^:])\/\/[^\n]*/g, (m, lead) => lead + ' '.repeat(m.length - lead.length));
        const lines = text.split('\n');
        lines.forEach((_line, i) => {
          // A small window, so a multi-line object literal is seen whole.
          const window = lines.slice(i, i + 6).join('\n');
          if (STYLE_UPDATE.test(window) && ORDER_VALUE.test(window)) offenders.push(`${rel}:${i + 1}`);
        });
      }
    };
    walk(SRC);

    // De-dup overlapping windows down to one entry per file.
    const files = [...new Set(offenders.map(o => o.split(':')[0]))];
    expect(files, `raw \`order\` style writes — route these through commitOrderAssignments:\n${[...new Set(offenders)].join('\n')}`).toEqual([]);
  });
});

// ─── Template-chrome guard: reorders never renumber layout:: nodes ───────────
// The canvas's flat template merge makes chrome SIBLINGS of the page sections;
// a root reorder enumerated them and wrote section-space orders into the page
// replica band ([data-id="layout::TaWeNu-…"] { order: 2 !important }) — the
// template FOOTER rendered between page sections on that tile only
// (2026-08-06). Live can't express that (chrome lives outside the page root).

describe('commitOrderAssignments — template chrome excluded + healed', () => {
  beforeEach(() => {
    patchNodeStyles.mockClear();
    mockActiveFilePath = 'pages/home.tsx';
  });

  it('primary: chrome assignments are stripped (no patch, no update)', () => {
    const updates = commitOrderAssignments(
      [
        { nodeId: 'hero', order: 0 },
        { nodeId: 'layout::Footer', order: 1 },
        { nodeId: 'services', order: 2 },
        { nodeId: 'children-slot', order: 3 },
      ],
      document.createElement('div'), 'desktop',
    );
    expect(updates.map(u => u.nodeId)).toEqual(['hero', 'services']);
    const patchedIds = patchNodeStyles.mock.calls.map(c => c[1]);
    expect(patchedIds).not.toContain('layout::Footer');
    expect(patchedIds).not.toContain('children-slot');
  });

  it('page replica: chrome stripped AND healed with an order-removal band write', () => {
    const updates = commitOrderAssignments(
      [
        { nodeId: 'hero', order: 0 },
        { nodeId: 'layout::Footer', order: 2 },
      ],
      document.createElement('div'), 'tablet',
    );
    // Section gets the renumber…
    expect(updates).toContainEqual({
      nodeId: 'hero', type: 'updateContainerStyle', maxWidth: 768, styles: { order: '0' },
    });
    // …chrome gets a removal ('' deletes the key from the band) — never a value.
    expect(updates).toContainEqual({
      nodeId: 'layout::Footer', type: 'updateContainerStyle', maxWidth: 768, styles: { order: '' },
    });
    expect(updates.filter(u => u.nodeId === 'layout::Footer')).toHaveLength(1);
  });
});

describe('commitOrderAssignments — out-of-flow siblings get z-index 1 (Chrome paints them as order 0)', () => {
  beforeEach(() => {
    patchNodeStyles.mockClear();
    mockActiveFilePath = 'pages/home.tsx';
    mockNodes = {
      wrap: { id: 'wrap', parentId: 'root', children: ['hdr', 'body', 'hero', 'bar'], styles: { display: 'flex' } },
      hdr: { id: 'hdr', parentId: null, children: [], styles: {} }, // dragged canvas node: cache still parentless
      body: { id: 'body', parentId: 'wrap', children: [], styles: { position: 'relative', order: '0' } },
      hero: { id: 'hero', parentId: 'wrap', children: [], styles: { position: 'absolute' } },
      bar: { id: 'bar', parentId: 'wrap', children: [], styles: { position: 'fixed', zIndex: '3' } },
    };
  });
  it('primary: overlays after the renumbered section get zIndex 1; an authored z-index is kept', () => {
    const updates = commitOrderAssignments([{ nodeId: 'hdr', order: 0 }, { nodeId: 'body', order: 1 }], document.createElement('div'), 'desktop');
    const styles = updates.map(u => [u.nodeId, (u as any).styles]);
    expect(styles).toEqual([['hdr', { order: '0' }], ['body', { order: '1' }], ['hero', { zIndex: '1' }]]);
  });
  it('page replica: the z-index rides the same band as the orders', () => {
    const updates = commitOrderAssignments([{ nodeId: 'hdr', order: 0 }, { nodeId: 'body', order: 1 }], document.createElement('div'), 'tablet');
    const hero = updates.find(u => u.nodeId === 'hero') as any;
    expect(hero?.type).toBe('updateContainerStyle');
    expect(hero?.styles).toEqual({ zIndex: '1' });
  });
});
