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
