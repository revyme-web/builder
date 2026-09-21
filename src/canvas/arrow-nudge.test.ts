import { describe, it, expect, vi, beforeEach } from 'vitest';

// queuePendingUpdates is a pure-ish PendingUpdate[] → queueMutation transform.
// Mock the mutation queue so we can spy on queueMutation, and the trace system
// so trace.error is a spy. These two are the only modules queuePendingUpdates
// touches at runtime; the rest of arrow-nudge.ts's imports are pulled in at
// module load but are not exercised by these tests.
vi.mock('@/code/mutation/mutation-queue', () => ({
  queueMutation: vi.fn(),
  flushNow: vi.fn(),
}));
vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), dom: vi.fn(), error: vi.fn() },
}));

import { computeAbsoluteNudge, computeOrderNudge, computeFlowSiblingOrder, queuePendingUpdates, computeOverlayNudge } from './arrow-nudge';
import { queueMutation } from '@/code/mutation/mutation-queue';
import { trace } from '@/shared/debug-trace';
import type { PendingUpdate } from '@/shared/types';

const parent = { width: 200, height: 100 };

describe('computeAbsoluteNudge', () => {
  it('left-only pin: ArrowRight increases left', () => {
    expect(computeAbsoluteNudge({ left: '50px' }, 'right', 1, parent)).toEqual({ left: '51px' });
  });

  it('left-only pin: ArrowLeft decreases left', () => {
    expect(computeAbsoluteNudge({ left: '50px' }, 'left', 1, parent)).toEqual({ left: '49px' });
  });

  it('right-only pin: ArrowRight decreases right', () => {
    expect(computeAbsoluteNudge({ right: '30px' }, 'right', 1, parent)).toEqual({ right: '29px' });
  });

  it('top-only pin: ArrowDown increases top', () => {
    expect(computeAbsoluteNudge({ top: '10px' }, 'down', 1, parent)).toEqual({ top: '11px' });
  });

  it('bottom-only pin: ArrowUp increases bottom', () => {
    expect(computeAbsoluteNudge({ bottom: '10px' }, 'up', 1, parent)).toEqual({ bottom: '11px' });
  });

  it('full horizontal inset: ArrowRight shifts the whole element right', () => {
    expect(computeAbsoluteNudge({ left: '20px', right: '40px' }, 'right', 1, parent))
      .toEqual({ left: '21px', right: '39px' });
  });

  it('full vertical inset: ArrowDown shifts the whole element down', () => {
    expect(computeAbsoluteNudge({ top: '5px', bottom: '15px' }, 'down', 1, parent))
      .toEqual({ top: '6px', bottom: '14px' });
  });

  it('cross-axis arrow on a horizontal-only pin → no patch', () => {
    expect(computeAbsoluteNudge({ left: '50px' }, 'up', 1, parent)).toEqual({});
  });

  it('skips auto and empty values', () => {
    expect(computeAbsoluteNudge({ left: 'auto', right: '' }, 'right', 1, parent)).toEqual({});
  });

  it('honors the step argument', () => {
    expect(computeAbsoluteNudge({ left: '50px' }, 'right', 10, parent)).toEqual({ left: '60px' });
    expect(computeAbsoluteNudge({ left: '50px' }, 'right', 100, parent)).toEqual({ left: '150px' });
  });

  it('percentage value: nudges by the px-equivalent percentage', () => {
    // 10px of 200px parent width = 5% → 10% + 5% = 15%
    expect(computeAbsoluteNudge({ left: '10%' }, 'right', 10, parent)).toEqual({ left: '15%' });
  });

  it('percentage value with zero parent size → skipped', () => {
    expect(computeAbsoluteNudge({ left: '10%' }, 'right', 10, { width: 0, height: 0 })).toEqual({});
  });

  it('unitless value treated as px', () => {
    expect(computeAbsoluteNudge({ top: '8' }, 'down', 1, parent)).toEqual({ top: '9px' });
  });

  it('skips unsupported units (em / rem / vw / calc)', () => {
    expect(computeAbsoluteNudge({ left: '2em' }, 'right', 1, parent)).toEqual({});
    expect(computeAbsoluteNudge({ top: '3rem' }, 'down', 1, parent)).toEqual({});
    expect(computeAbsoluteNudge({ left: '10vw' }, 'right', 1, parent)).toEqual({});
    expect(computeAbsoluteNudge({ left: 'calc(100% - 20px)' }, 'right', 1, parent)).toEqual({});
  });

  it('allows negative result values', () => {
    expect(computeAbsoluteNudge({ left: '2px' }, 'left', 10, { width: 200, height: 100 }))
      .toEqual({ left: '-8px' });
  });

  it('cross-axis arrow on a full-inset element → no patch', () => {
    expect(computeAbsoluteNudge({ top: '5px', bottom: '15px' }, 'left', 1, { width: 200, height: 100 }))
      .toEqual({});
  });
});

describe('computeOrderNudge', () => {
  it('row layout: ArrowRight moves the node one slot later', () => {
    expect(computeOrderNudge('b', ['a', 'b', 'c'], 'right', 'row')).toEqual([
      { nodeId: 'a', order: 0 },
      { nodeId: 'c', order: 1 },
      { nodeId: 'b', order: 2 },
    ]);
  });

  it('row layout: ArrowLeft moves the node one slot earlier', () => {
    expect(computeOrderNudge('b', ['a', 'b', 'c'], 'left', 'row')).toEqual([
      { nodeId: 'b', order: 0 },
      { nodeId: 'a', order: 1 },
      { nodeId: 'c', order: 2 },
    ]);
  });

  it('column layout: ArrowDown moves the node one slot later', () => {
    expect(computeOrderNudge('b', ['a', 'b', 'c'], 'down', 'column')).toEqual([
      { nodeId: 'a', order: 0 },
      { nodeId: 'c', order: 1 },
      { nodeId: 'b', order: 2 },
    ]);
  });

  it('row layout: cross-axis arrow → null', () => {
    expect(computeOrderNudge('b', ['a', 'b', 'c'], 'up', 'row')).toBeNull();
  });

  it('column layout: cross-axis arrow → null', () => {
    expect(computeOrderNudge('b', ['a', 'b', 'c'], 'left', 'column')).toBeNull();
  });

  it('already first, ArrowLeft → null', () => {
    expect(computeOrderNudge('a', ['a', 'b', 'c'], 'left', 'row')).toBeNull();
  });

  it('already last, ArrowRight → null', () => {
    expect(computeOrderNudge('c', ['a', 'b', 'c'], 'right', 'row')).toBeNull();
  });

  it('selected id not among siblings → null', () => {
    expect(computeOrderNudge('z', ['a', 'b', 'c'], 'right', 'row')).toBeNull();
  });
});

describe('queuePendingUpdates', () => {
  const queueMutationMock = vi.mocked(queueMutation);
  const traceErrorMock = vi.mocked(trace.error);

  beforeEach(() => {
    queueMutationMock.mockClear();
    traceErrorMock.mockClear();
  });

  it("type 'style' → queues updateStyles mutation", () => {
    const update: PendingUpdate = {
      type: 'style', nodeId: 'n1', styles: { left: '10px' },
    };
    queuePendingUpdates([update]);
    expect(queueMutationMock).toHaveBeenCalledTimes(1);
    expect(queueMutationMock).toHaveBeenCalledWith({
      type: 'updateStyles', nodeId: 'n1', styles: { left: '10px' },
    });
    expect(traceErrorMock).not.toHaveBeenCalled();
  });

  it("type 'updateContainerStyle' → queues updateContainerStyle mutation", () => {
    const update: PendingUpdate = {
      type: 'updateContainerStyle', nodeId: 'n2',
      maxWidth: 768, styles: { top: '5px' },
    };
    queuePendingUpdates([update]);
    expect(queueMutationMock).toHaveBeenCalledTimes(1);
    expect(queueMutationMock).toHaveBeenCalledWith({
      type: 'updateContainerStyle', nodeId: 'n2',
      maxWidth: 768, styles: { top: '5px' },
    });
    expect(traceErrorMock).not.toHaveBeenCalled();
  });

  it("type 'updateVariantStyle' → queues updateVariantStyle mutation", () => {
    const update: PendingUpdate = {
      type: 'updateVariantStyle', nodeId: 'n3',
      variantName: 'hover', styles: { right: '20px' },
    };
    queuePendingUpdates([update]);
    expect(queueMutationMock).toHaveBeenCalledTimes(1);
    expect(queueMutationMock).toHaveBeenCalledWith({
      type: 'updateVariantStyle', nodeId: 'n3',
      variantName: 'hover', styles: { right: '20px' },
    });
    expect(traceErrorMock).not.toHaveBeenCalled();
  });

  it("type 'setConditionalOrder' → queues setConditionalOrder mutation", () => {
    const orderMap = { n4: 1, n5: 0 };
    const update: PendingUpdate = {
      type: 'setConditionalOrder', nodeId: 'n4', orderMap,
    };
    queuePendingUpdates([update]);
    expect(queueMutationMock).toHaveBeenCalledTimes(1);
    expect(queueMutationMock).toHaveBeenCalledWith({
      type: 'setConditionalOrder', nodeId: 'n4', orderMap,
    });
    expect(traceErrorMock).not.toHaveBeenCalled();
  });

  it('unroutable update type → no mutation, traces an error', () => {
    const update = { type: 'move', nodeId: 'n6' } as unknown as PendingUpdate;
    queuePendingUpdates([update]);
    expect(queueMutationMock).not.toHaveBeenCalled();
    expect(traceErrorMock).toHaveBeenCalledTimes(1);
    expect(traceErrorMock).toHaveBeenCalledWith('arrow-nudge:unroutable-update', { update });
  });

  it('batch of multiple updates → one mutation per routable update, in order', () => {
    const updates: PendingUpdate[] = [
      { type: 'style', nodeId: 'a', styles: { left: '1px' } },
      { type: 'updateVariantStyle', nodeId: 'b', variantName: 'v1', styles: { top: '2px' } },
      { type: 'setConditionalOrder', nodeId: 'c', orderMap: { c: 0 } },
    ];
    queuePendingUpdates(updates);
    expect(queueMutationMock).toHaveBeenCalledTimes(3);
    expect(queueMutationMock).toHaveBeenNthCalledWith(1, {
      type: 'updateStyles', nodeId: 'a', styles: { left: '1px' },
    });
    expect(queueMutationMock).toHaveBeenNthCalledWith(2, {
      type: 'updateVariantStyle', nodeId: 'b', variantName: 'v1', styles: { top: '2px' },
    });
    expect(queueMutationMock).toHaveBeenNthCalledWith(3, {
      type: 'setConditionalOrder', nodeId: 'c', orderMap: { c: 0 },
    });
    expect(traceErrorMock).not.toHaveBeenCalled();
  });
});

// ─── mergeVariantEffectiveStyles — nudge must read the TILE's truth ─────────
// Reading node.styles (the primary's values) meant every nudge computed
// `base ± step`: the first press jumped to a wrong value and repeats emitted
// the IDENTICAL patch → "arrows do nothing on replicas/variants"
// (user trace 2026-08-06: `top: 478px` on consecutive presses).

import { mergeVariantEffectiveStyles } from './arrow-nudge';
import type { CanvasNode } from '@/code/parsing/parser';

function nodeWith(partial: Partial<CanvasNode>): CanvasNode {
  return {
    id: 'n', type: 'div', name: 'n', parentId: null, children: [],
    styles: {}, attrs: {}, textContent: '', hasMixedContent: false,
    ...partial,
  } as unknown as CanvasNode;
}

describe('mergeVariantEffectiveStyles', () => {
  it('variant entry wins over default entry wins over base', () => {
    const node = nodeWith({
      styles: { left: '1px', top: '388px', position: 'absolute' },
      motionVariants: {
        default: { top: '400px' },
        'variant-5': { top: '573px', left: '-9px' },
      } as any,
    });
    const eff = mergeVariantEffectiveStyles(node, 'variant-5');
    expect(eff.top).toBe('573px');
    expect(eff.left).toBe('-9px');
    // Nudge from the tile's truth: up 10 → 563, not base 388−10.
    const patch = computeAbsoluteNudge(eff, 'up', 10, { width: 768, height: 900 });
    expect(patch.top).toBe('563px');
  });

  it("default tile = base + always-on 'default' entry", () => {
    const node = nodeWith({
      styles: { top: '388px' },
      motionVariants: { default: { top: '400px' } } as any,
    });
    expect(mergeVariantEffectiveStyles(node, 'default').top).toBe('400px');
  });

  it('conditionalStyles resolve per variant on top of the merge', () => {
    const node = nodeWith({
      styles: { left: '10px' },
      conditionalStyles: { left: { 'variant-2': '50px', default: '10px' } } as any,
    });
    expect(mergeVariantEffectiveStyles(node, 'variant-2').left).toBe('50px');
    expect(mergeVariantEffectiveStyles(node, 'variant-1').left).toBe('10px');
  });

  it('no variant data → plain base styles', () => {
    const node = nodeWith({ styles: { top: '5px' } });
    expect(mergeVariantEffectiveStyles(node, 'variant-1')).toEqual({ top: '5px' });
  });
});


describe('computeFlowSiblingOrder', () => {
  it('main-axis TIES (zero-width squeezed siblings) fall back to CSS order, then source index', () => {
    // A row: a code component whose min-content width fills the parent squeezes
    // both pink frames to 0px. Source order is [code, frameA, frameB]; after a
    // right-arrow the orders are frameA=0, code=1, frameB=2 — but frameA (0px)
    // and code share left=100. Sorting by left alone kept source order and the
    // code component read as still first, forever (live find 2026-09-06).
    const row = (id: string, left: number, order: number) => ({ id, rect: { left, top: 0 }, position: 'relative', order });
    expect(computeFlowSiblingOrder([row('code', 100, 1), row('frameA', 100, 0), row('frameB', 1500, 2)], 'row'))
      .toEqual(['frameA', 'code', 'frameB']);
    // equal order too → source index decides (CSS placement rule)
    expect(computeFlowSiblingOrder([row('a', 100, 0), row('b', 100, 0)], 'row')).toEqual(['a', 'b']);
    // sub-pixel jitter is still a tie; a real gap is not
    expect(computeFlowSiblingOrder([row('x', 100.3, 5), row('y', 100, 0)], 'row')).toEqual(['y', 'x']);
    expect(computeFlowSiblingOrder([row('x', 100, 5), row('y', 120, 0)], 'row')).toEqual(['x', 'y']);
  });

  const at = (id: string, top: number, position: string | null = 'relative') =>
    ({ id, rect: { left: 0, top }, position });

  it('drops absolutely-positioned siblings — they occupy no flow slot', () => {
    // The reported page: a Hero column whose first flow child (`fk`) had a
    // rotated absolute label (`d9`) landing between it and the next section.
    const children = [
      at('fk', 160),
      at('d9', 226, 'absolute'),
      at('d6', 300),
      at('df', 700),
      at('marquee', 900),
    ];
    expect(computeFlowSiblingOrder(children, 'column')).toEqual(['fk', 'd6', 'df', 'marquee']);
  });

  it('drops fixed siblings too', () => {
    expect(computeFlowSiblingOrder([at('a', 0), at('nav', 10, 'fixed'), at('b', 20)], 'column'))
      .toEqual(['a', 'b']);
  });

  it('keeps relative, static and sticky — those are in flow', () => {
    const children = [at('a', 0, 'static'), at('b', 10, 'sticky'), at('c', 20, 'relative')];
    expect(computeFlowSiblingOrder(children, 'column')).toEqual(['a', 'b', 'c']);
  });

  it('still excludes template chrome and the children slot', () => {
    const children = [at('layout::footer', 0), at('children-slot', 5), at('real', 10)];
    expect(computeFlowSiblingOrder(children, 'column')).toEqual(['real']);
  });

  it('sorts by left on a row, by top on a column', () => {
    const row = [
      { id: 'r', rect: { left: 300, top: 0 }, position: 'relative' },
      { id: 'l', rect: { left: 100, top: 0 }, position: 'relative' },
    ];
    expect(computeFlowSiblingOrder(row, 'row')).toEqual(['l', 'r']);
    expect(computeFlowSiblingOrder(row, 'column')).toEqual(['r', 'l']);
  });

  it('REGRESSION: the first flow child can move down past an absolute label', () => {
    // Before the fix the list was [fk, d9, d6, …]; nudging `fk` down swapped
    // it with the out-of-flow `d9` and renumbered to exactly the orders the
    // page already had (d9:0, fk:1, d6:2 …) — zero visual change, forever.
    const children = [
      at('fk', 160),
      at('d9', 226, 'absolute'),
      at('d6', 300),
      at('df', 700),
    ];
    const ids = computeFlowSiblingOrder(children, 'column');
    expect(ids[0]).toBe('fk');

    const assignments = computeOrderNudge('fk', ids, 'down', 'column');
    expect(assignments).not.toBeNull();
    // fk actually ends up AFTER d6 now, not merely renumbered around d9.
    const orderOf = (id: string) => assignments!.find(a => a.nodeId === id)!.order;
    expect(orderOf('fk')).toBeGreaterThan(orderOf('d6'));
    // …and the out-of-flow node is not renumbered at all.
    expect(assignments!.some(a => a.nodeId === 'd9')).toBe(false);
  });

  it('the first flow child still cannot move up past the start', () => {
    const ids = computeFlowSiblingOrder([at('fk', 160), at('d6', 300)], 'column');
    expect(computeOrderNudge('fk', ids, 'up', 'column')).toBeNull();
  });
});

// ─── overlay offset nudge ────────────────────────────────────────────────────
describe('computeOverlayNudge', () => {
  const cfg: any = { type: 'relative', triggerId: 't', side: 'top', align: 'center', offsetX: 0, offsetY: -11,
    responsiveVariant: { 'default-hover': { offsetX: 5, offsetY: 5 } }, responsive: { 768: { offsetX: 2, offsetY: 2 } }, responsiveBp: [768, 375] };
  it('primary tile: nudges the BASE offset, routed to base', () => {
    const r = computeOverlayNudge(cfg, 'left', 10, { vpId: 'desktop', vpWidth: 1440, isPrimary: true, isComponentFile: true });
    expect(r).toEqual({ patch: { offsetX: -10, offsetY: -11 }, vpWidth: null, variant: null });
  });
  it('component variant tile: starts from that variant override and routes per-variant', () => {
    const r = computeOverlayNudge(cfg, 'down', 1, { vpId: 'default-hover', vpWidth: 0, isPrimary: false, isComponentFile: true });
    expect(r).toEqual({ patch: { offsetX: 5, offsetY: 6 }, vpWidth: null, variant: 'default-hover' });
  });
  it('page replica: starts from the width override and routes per-width', () => {
    const r = computeOverlayNudge(cfg, 'right', 10, { vpId: 'tablet', vpWidth: 768, isPrimary: false, isComponentFile: false });
    expect(r).toEqual({ patch: { offsetX: 12, offsetY: 2 }, vpWidth: 768, variant: null });
  });
  it('replica WITHOUT its own override starts from the base (inherits) and still routes per-width', () => {
    const r = computeOverlayNudge(cfg, 'up', 1, { vpId: 'mobile', vpWidth: 375, isPrimary: false, isComponentFile: false });
    expect(r.patch).toEqual({ offsetX: 0, offsetY: -12 });
    expect(r.vpWidth).toBe(375);
  });
});

// A HIDDEN sibling has no usable geometry: its rect is (0,0,0,0), the iframe's
// top-left, so it sorts before every laid-out sibling and never reaches the
// tie-break. The caller renumbers this sequence 0..n-1, so it was rewritten to
// `order: 0` on every nudge — its authored position was destroyed and it
// reappeared at the front of the parent when unhidden (user report 2026-09-19).
// The shift was uniform, so the VISIBLE result stayed correct, which is why it
// went unnoticed. These pin both halves: visible order still right, hidden
// sibling still where the user put it.
describe('computeFlowSiblingOrder — hidden siblings', () => {
  // Hidden nodes get the degenerate rect the real cache hands back.
  const kid = (id: string, left: number, order: number, hidden = false) => ({
    id, rect: { left: hidden ? 0 : left, top: 0 }, position: 'relative', order, hidden,
  });

  it('keeps a hidden sibling in its authored slot instead of sorting it first', () => {
    // visible a(0) … hidden h(1) … visible b(2), c(3)
    const out = computeFlowSiblingOrder([
      kid('a', 10, 0), kid('h', 0, 1, true), kid('b', 200, 2), kid('c', 300, 3),
    ], 'row');
    expect(out).toEqual(['a', 'h', 'b', 'c']);
  });

  it('a hidden sibling ordered first still comes first', () => {
    const out = computeFlowSiblingOrder([
      kid('h', 0, 0, true), kid('a', 10, 1), kid('b', 200, 2),
    ], 'row');
    expect(out).toEqual(['h', 'a', 'b']);
  });

  it('a hidden sibling ordered last still comes last', () => {
    const out = computeFlowSiblingOrder([
      kid('a', 10, 0), kid('b', 200, 1), kid('h', 0, 9, true),
    ], 'row');
    expect(out).toEqual(['a', 'b', 'h']);
  });

  it('several hidden siblings keep their relative order', () => {
    const out = computeFlowSiblingOrder([
      kid('a', 10, 0), kid('h1', 0, 1, true), kid('h2', 0, 2, true), kid('b', 200, 3),
    ], 'row');
    expect(out).toEqual(['a', 'h1', 'h2', 'b']);
  });

  // The whole point: visible siblings must be unaffected by the hidden one.
  it('the visible sequence is identical with and without the hidden sibling', () => {
    const withHidden = computeFlowSiblingOrder([
      kid('a', 10, 0), kid('h', 0, 1, true), kid('b', 200, 2), kid('c', 300, 3),
    ], 'row').filter(id => id !== 'h');
    const without = computeFlowSiblingOrder([
      kid('a', 10, 0), kid('b', 200, 2), kid('c', 300, 3),
    ], 'row');
    expect(withHidden).toEqual(without);
  });

  it('works on the column axis too', () => {
    const out = computeFlowSiblingOrder([
      { id: 'a', rect: { left: 0, top: 10 }, position: 'relative', order: 0 },
      { id: 'h', rect: { left: 0, top: 0 }, position: 'relative', order: 1, hidden: true },
      { id: 'b', rect: { left: 0, top: 200 }, position: 'relative', order: 2 },
    ], 'column');
    expect(out).toEqual(['a', 'h', 'b']);
  });

  it('a hidden sibling is still excluded when it is absolute or template chrome', () => {
    const out = computeFlowSiblingOrder([
      kid('a', 10, 0),
      { id: 'abs', rect: { left: 0, top: 0 }, position: 'absolute', order: 1, hidden: true },
      { id: 'layout::Header', rect: { left: 0, top: 0 }, position: 'relative', order: 1, hidden: true },
      kid('b', 200, 2),
    ], 'row');
    expect(out).toEqual(['a', 'b']);
  });

  it('nothing changes when no sibling is hidden', () => {
    const out = computeFlowSiblingOrder([
      kid('b', 200, 1), kid('a', 10, 0), kid('c', 300, 2),
    ], 'row');
    expect(out).toEqual(['a', 'b', 'c']);
  });
});
