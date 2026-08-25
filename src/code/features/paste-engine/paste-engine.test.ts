// paste-engine.test.ts — Smoke tests for the rule engine, conditions,
// position calc, and target resolver. Doesn't exercise the executor's
// queueMutation side effects — that's covered by integration tests.

import { describe, expect, test, vi, beforeEach } from 'vitest';
import { findMatchingRule, getRuleById, conditionCheckers } from './paste';
import { calculatePosition, findRootNodes } from './core/position';
import { resolveTargets } from './core/target-resolver';
import { createIdMapper } from './core/id-mapper';
import { ensureDefaultAnchors } from './core/node-creator';
import type { CanvasNode } from '@/code/parsing/parser';
import type { ClipboardNode, PasteContext } from './types';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeCanvasNode(id: string, overrides: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id,
    type: 'div',
    name: id,
    parentId: null,
    children: [],
    styles: {},
    attrs: {},
    textContent: '',
    hasMixedContent: false,
    order: 0,
    isCanvasNode: false,
    componentFile: null,
    componentInstanceId: null,
    isComponentRoot: false,
    motionVariants: null,
    motionVariantsRef: null,
    responsiveVariantMap: null,
    conditionalStyles: null,
    motionProps: null,
    ...overrides,
  } as CanvasNode;
}

function makeClipboardNode(id: string, overrides: Partial<ClipboardNode> = {}): ClipboardNode {
  return {
    id,
    type: 'div',
    parentId: null,
    children: [],
    order: 0,
    styles: {},
    ...overrides,
  };
}

function makeContext(opts: Partial<PasteContext>): PasteContext {
  return {
    selectedIds: [],
    clipboardNodes: [],
    nodes: new Map(),
    ...opts,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Conditions ──────────────────────────────────────────────────────────────

describe('conditions', () => {
  test('NO_SELECTION + HAS_SELECTION are mutually exclusive', () => {
    const empty = makeContext({});
    const populated = makeContext({ selectedIds: ['a'] });
    expect(conditionCheckers.NO_SELECTION(empty)).toBe(true);
    expect(conditionCheckers.HAS_SELECTION(empty)).toBe(false);
    expect(conditionCheckers.NO_SELECTION(populated)).toBe(false);
    expect(conditionCheckers.HAS_SELECTION(populated)).toBe(true);
  });

  test('CANVAS_NODE_SELECTED matches when selected has isCanvasNode', () => {
    const ctx = makeContext({
      selectedIds: ['c'],
      nodes: new Map([['c', makeCanvasNode('c', { isCanvasNode: true })]]),
    });
    expect(conditionCheckers.CANVAS_NODE_SELECTED(ctx)).toBe(true);
    expect(conditionCheckers.NOT_CANVAS_NODE_SELECTED(ctx)).toBe(false);
  });

  test('PAGE_ROOT_HAS_LAYOUT detects flex root', () => {
    const ctx = makeContext({
      selectedIds: ['root'],
      nodes: new Map([['root', makeCanvasNode('root', { styles: { display: 'flex' } })]]),
    });
    expect(conditionCheckers.PAGE_ROOT_SELECTED(ctx)).toBe(true);
    expect(conditionCheckers.PAGE_ROOT_HAS_LAYOUT(ctx)).toBe(true);
    expect(conditionCheckers.PAGE_ROOT_NO_LAYOUT(ctx)).toBe(false);
  });

  test('CHILD_NODE_SELECTED requires parent in nodes map', () => {
    const ctx = makeContext({
      selectedIds: ['c'],
      nodes: new Map([
        ['p', makeCanvasNode('p', { children: ['c'] })],
        ['c', makeCanvasNode('c', { parentId: 'p' })],
      ]),
    });
    expect(conditionCheckers.CHILD_NODE_SELECTED(ctx)).toBe(true);
  });

  test('NO_LAYOUT_PARENT detects parent without flex/grid', () => {
    const ctx = makeContext({
      selectedIds: ['c'],
      nodes: new Map([
        ['p', makeCanvasNode('p', { children: ['c'] })], // no display
        ['c', makeCanvasNode('c', { parentId: 'p' })],
      ]),
    });
    expect(conditionCheckers.NO_LAYOUT_PARENT(ctx)).toBe(true);
    expect(conditionCheckers.HAS_LAYOUT_PARENT(ctx)).toBe(false);
  });

  test('TEXT_IN_CLIPBOARD only matches text-tagged ROOT clipboard nodes', () => {
    const ctx = makeContext({
      clipboardNodes: [makeClipboardNode('t', { type: 'p' })],
    });
    expect(conditionCheckers.TEXT_IN_CLIPBOARD(ctx)).toBe(true);
  });

  test('CANVAS_NODE_IN_CLIPBOARD detects isCanvasNode flag', () => {
    const withCanvas = makeContext({
      clipboardNodes: [makeClipboardNode('a', { isCanvasNode: true })],
    });
    const withoutCanvas = makeContext({
      clipboardNodes: [makeClipboardNode('a')],
    });
    expect(conditionCheckers.CANVAS_NODE_IN_CLIPBOARD(withCanvas)).toBe(true);
    expect(conditionCheckers.CANVAS_NODE_IN_CLIPBOARD(withoutCanvas)).toBe(false);
  });

  test('NOT_TEXT_INTO_FRAME guards out text-into-frame', () => {
    const ctx = makeContext({
      selectedIds: ['f'],
      nodes: new Map([['f', makeCanvasNode('f', { type: 'div' })]]),
      clipboardNodes: [makeClipboardNode('t', { type: 'p' })],
    });
    expect(conditionCheckers.NOT_TEXT_INTO_FRAME(ctx)).toBe(false);
  });

  test('HAS_FORCE_INSERT_INDEX flips with ctx.forceInsertIndex', () => {
    expect(conditionCheckers.HAS_FORCE_INSERT_INDEX(makeContext({}))).toBe(false);
    expect(conditionCheckers.HAS_FORCE_INSERT_INDEX(makeContext({ forceInsertIndex: 0 }))).toBe(true);
  });
});

// ─── Rule matcher ────────────────────────────────────────────────────────────

describe('findMatchingRule', () => {
  test('no clipboard nodes still picks a rule based on selection', () => {
    const ctx = makeContext({});
    const rule = findMatchingRule(ctx);
    // Empty selection + empty clipboard → no-selection rule
    expect(rule?.id).toBe('paste-on-canvas-no-selection');
  });

  test('canvas node selected → paste-with-canvas-node-selected', () => {
    const ctx = makeContext({
      selectedIds: ['c'],
      nodes: new Map([['c', makeCanvasNode('c', { isCanvasNode: true })]]),
      clipboardNodes: [makeClipboardNode('a')],
    });
    expect(findMatchingRule(ctx)?.id).toBe('paste-with-canvas-node-selected');
  });

  test('child of flex parent + non-text clipboard → paste-child-as-sibling', () => {
    const ctx = makeContext({
      selectedIds: ['c'],
      nodes: new Map([
        ['p', makeCanvasNode('p', { children: ['c'], styles: { display: 'flex' } })],
        ['c', makeCanvasNode('c', { parentId: 'p' })],
      ]),
      clipboardNodes: [makeClipboardNode('a', { type: 'div' })],
    });
    expect(findMatchingRule(ctx)?.id).toBe('paste-child-as-sibling');
  });

  test('child of no-layout parent → paste-child-as-sibling-no-layout', () => {
    const ctx = makeContext({
      selectedIds: ['c'],
      nodes: new Map([
        ['p', makeCanvasNode('p', { children: ['c'] })], // no flex/grid
        ['c', makeCanvasNode('c', { parentId: 'p' })],
      ]),
      clipboardNodes: [makeClipboardNode('a', { type: 'div' })],
    });
    expect(findMatchingRule(ctx)?.id).toBe('paste-child-as-sibling-no-layout');
  });

  test('text + frame → paste-text-into-frame', () => {
    const ctx = makeContext({
      selectedIds: ['f'],
      nodes: new Map([['f', makeCanvasNode('f', { type: 'div' })]]),
      clipboardNodes: [makeClipboardNode('t', { type: 'p' })],
    });
    expect(findMatchingRule(ctx)?.id).toBe('paste-text-into-frame');
  });

  test('text + absolute frame → paste-text-into-absolute-frame', () => {
    const ctx = makeContext({
      selectedIds: ['f'],
      nodes: new Map([
        ['f', makeCanvasNode('f', { type: 'div', styles: { isAbsoluteFrame: 'true' } })],
      ]),
      clipboardNodes: [makeClipboardNode('t', { type: 'p' })],
    });
    expect(findMatchingRule(ctx)?.id).toBe('paste-text-into-absolute-frame');
  });

  test('forceInsertIndex + frame → drop-into-layout-frame', () => {
    const ctx = makeContext({
      selectedIds: ['f'],
      nodes: new Map([['f', makeCanvasNode('f', { type: 'div' })]]),
      forceInsertIndex: 2,
    });
    expect(findMatchingRule(ctx)?.id).toBe('drop-into-layout-frame');
  });

  test('forceNoLayoutPosition + frame → drop-into-no-layout-frame', () => {
    const ctx = makeContext({
      selectedIds: ['f'],
      nodes: new Map([['f', makeCanvasNode('f', { type: 'div' })]]),
      forceNoLayoutPosition: { x: 50, y: 30 },
    });
    expect(findMatchingRule(ctx)?.id).toBe('drop-into-no-layout-frame');
  });

  test('absolute child of a positioned parent (no synthetic flag) → paste-at-abs-in-frame', () => {
    // Regression: `isAbsoluteInFrame` is never persisted to code, so an
    // absolute-in-frame node used to fail ABSOLUTE_IN_FRAME_SELECTED and fall
    // through to a force-relative rule — pasting as RELATIVE. Now derived from
    // position:absolute + positioned parent.
    const ctx = makeContext({
      selectedIds: ['c'],
      nodes: new Map([
        ['p', makeCanvasNode('p', { children: ['c'], styles: { position: 'relative', display: 'flex' } })],
        ['c', makeCanvasNode('c', { parentId: 'p', styles: { position: 'absolute', top: '10px', left: '5px' } })],
      ]),
      clipboardNodes: [makeClipboardNode('c', { type: 'div' })],
    });
    expect(findMatchingRule(ctx)?.id).toBe('paste-at-abs-in-frame');
  });

  test('data-pinned node → paste-at-abs-in-frame (pastes IN PLACE, not to canvas)', () => {
    // The pinned→canvas divert was removed 2026-07-24: duplicate/paste of a
    // pinned absolute-in-frame node must stay in the SAME parent at the SAME
    // position, exactly like a non-pinned one.
    const ctx = makeContext({
      selectedIds: ['c'],
      nodes: new Map([
        ['p', makeCanvasNode('p', { children: ['c'], styles: { position: 'relative', display: 'flex' } })],
        ['c', makeCanvasNode('c', { parentId: 'p', styles: { position: 'absolute', top: '5px', right: '5px' }, attrs: { 'data-pinned': 'true' } })],
      ]),
      clipboardNodes: [makeClipboardNode('c', { type: 'div' })],
    });
    // Same rule a NON-pinned abs-in-frame node gets → in-place sibling.
    expect(findMatchingRule(ctx)?.id).toBe('paste-at-abs-in-frame');
  });

  test('rule priority — drop-into-no-layout-frame beats drop-into-layout-frame', () => {
    const r1 = getRuleById('drop-into-no-layout-frame');
    const r2 = getRuleById('drop-into-layout-frame');
    expect(r1!.priority).toBeLessThan(r2!.priority);
  });
});

// ─── Position calculator ─────────────────────────────────────────────────────

describe('calculatePosition', () => {
  test('visible-center uses transform + container size', () => {
    const ctx = makeContext({
      transform: { x: -100, y: -50, scale: 2 },
      containerWidth: 1000,
      containerHeight: 600,
    });
    const pos = calculatePosition(ctx, 'visible-center', { defaultPosition: { x: 0, y: 0 } });
    // (1000/2 - (-100)) / 2 = 300, (600/2 - (-50)) / 2 = 175
    expect(pos.x).toBe(300);
    expect(pos.y).toBe(175);
  });

  test('visible-center falls back to default when no transform', () => {
    const ctx = makeContext({});
    const pos = calculatePosition(ctx, 'visible-center', { defaultPosition: { x: 100, y: 100 } });
    expect(pos).toEqual({ x: 100, y: 100 });
  });

  test('forcePosition wins over visible-center', () => {
    const ctx = makeContext({
      forcePosition: { x: 99, y: 88 },
      transform: { x: 0, y: 0, scale: 1 },
      containerWidth: 1000,
      containerHeight: 600,
    });
    const pos = calculatePosition(ctx, 'visible-center');
    expect(pos).toEqual({ x: 99, y: 88 });
  });

  test('smart-right with selected canvas node positions to the right', () => {
    const ctx = makeContext({
      selectedIds: ['s'],
      nodes: new Map([
        ['s', makeCanvasNode('s', {
          isCanvasNode: true,
          styles: { left: '100px', top: '50px', width: '200px', height: '100px' },
        })],
      ]),
      clipboardNodes: [makeClipboardNode('a', { styles: { width: '50px', height: '50px' } })],
    });
    const pos = calculatePosition(ctx, 'smart-right', { gap: 20 });
    // selected.left + selected.width + gap = 100 + 200 + 20 = 320
    expect(pos.x).toBe(320);
    expect(pos.y).toBe(50);
  });

  test('at-selected-position copies left/top from selected', () => {
    const ctx = makeContext({
      selectedIds: ['s'],
      nodes: new Map([
        ['s', makeCanvasNode('s', { styles: { left: '40px', top: '80px' } })],
      ]),
    });
    const pos = calculatePosition(ctx, 'at-selected-position');
    expect(pos).toEqual({ x: 40, y: 80 });
  });

  test('center-in-parent centers child within parent dimensions', () => {
    const ctx = makeContext({
      selectedIds: ['p'],
      nodes: new Map([
        ['p', makeCanvasNode('p', { styles: { width: '400px', height: '200px' } })],
      ]),
      clipboardNodes: [makeClipboardNode('a', { styles: { width: '100px', height: '50px' } })],
    });
    const pos = calculatePosition(ctx, 'center-in-parent');
    expect(pos).toEqual({ x: 150, y: 75 });
  });

  test('at-origin returns 0,0 unless forcePosition set', () => {
    const ctx = makeContext({});
    expect(calculatePosition(ctx, 'at-origin')).toEqual({ x: 0, y: 0 });
    expect(calculatePosition(ctx, 'at-origin', { forcePosition: { x: 5, y: 7 } })).toEqual({ x: 5, y: 7 });
  });
});

// ─── findRootNodes ───────────────────────────────────────────────────────────

describe('findRootNodes', () => {
  test('node without parent is a root', () => {
    const nodes = [makeClipboardNode('a')];
    expect(findRootNodes(nodes).map(n => n.id)).toEqual(['a']);
  });

  test('node whose parent is also in clipboard is NOT a root', () => {
    const nodes = [
      makeClipboardNode('p', { children: ['c'] }),
      makeClipboardNode('c', { parentId: 'p' }),
    ];
    expect(findRootNodes(nodes).map(n => n.id)).toEqual(['p']);
  });

  test('node whose parent is NOT in clipboard IS a root (orphan)', () => {
    const nodes = [makeClipboardNode('c', { parentId: 'detached-parent' })];
    expect(findRootNodes(nodes).map(n => n.id)).toEqual(['c']);
  });

  test('multi-select with mixed parents', () => {
    const nodes = [
      makeClipboardNode('a'),
      makeClipboardNode('b', { parentId: 'a', children: ['c'] }),
      makeClipboardNode('c', { parentId: 'b' }),
      makeClipboardNode('d'),
    ];
    expect(findRootNodes(nodes).map(n => n.id).sort()).toEqual(['a', 'd']);
  });
});

// ─── Target resolver ─────────────────────────────────────────────────────────

describe('resolveTargets', () => {
  test('canvas mode → single null-parent target', () => {
    const ctx = makeContext({});
    expect(resolveTargets(ctx, 'canvas')).toEqual([{ parentId: null, isPrimary: true }]);
  });

  test('sibling mode resolves parent + insertIndex', () => {
    const ctx = makeContext({
      selectedIds: ['c'],
      nodes: new Map([
        ['p', makeCanvasNode('p', { children: ['c'] })],
        ['c', makeCanvasNode('c', { parentId: 'p' })],
      ]),
    });
    expect(resolveTargets(ctx, 'sibling')).toEqual([
      { parentId: 'p', insertIndex: 1, isPrimary: true },
    ]);
  });

  test('frame-children appends at end by default', () => {
    const ctx = makeContext({
      selectedIds: ['f'],
      nodes: new Map([['f', makeCanvasNode('f', { children: ['x', 'y'] })]]),
    });
    expect(resolveTargets(ctx, 'frame-children')).toEqual([
      { parentId: 'f', insertIndex: 2, isPrimary: true },
    ]);
  });

  test('forceInsertIndex overrides default index', () => {
    const ctx = makeContext({
      selectedIds: ['f'],
      nodes: new Map([['f', makeCanvasNode('f', { children: ['x', 'y', 'z'] })]]),
      forceInsertIndex: 1,
    });
    expect(resolveTargets(ctx, 'frame-children')[0].insertIndex).toBe(1);
  });

  test('canvas-frame-children: selected child of canvas node → uses canvas node as parent', () => {
    const ctx = makeContext({
      selectedIds: ['child'],
      nodes: new Map([
        ['canvas', makeCanvasNode('canvas', { isCanvasNode: true, children: ['child'] })],
        ['child', makeCanvasNode('child', { parentId: 'canvas' })],
      ]),
    });
    expect(resolveTargets(ctx, 'canvas-frame-children')[0].parentId).toBe('canvas');
  });

  test('viewport-children only resolves when page root selected', () => {
    const root = makeCanvasNode('root');
    const notRoot = makeCanvasNode('a');
    const a = makeContext({
      selectedIds: ['root'],
      nodes: new Map([['root', root]]),
    });
    const b = makeContext({
      selectedIds: ['a'],
      nodes: new Map([['a', notRoot]]),
    });
    expect(resolveTargets(a, 'viewport-children')).toHaveLength(1);
    expect(resolveTargets(b, 'viewport-children')).toHaveLength(0);
  });
});

// ─── IdMapper ────────────────────────────────────────────────────────────────

describe('IdMapper', () => {
  test('maps clipboard → new and supports multi-paste arrays', () => {
    const m = createIdMapper();
    m.mapClipboardToNew('old', 'new1');
    m.mapClipboardToNew('old', 'new2');
    expect(m.getNewIdsForClipboard('old')).toEqual(['new1', 'new2']);
    expect(m.hasMapping('old')).toBe(true);
    expect(m.hasMapping('missing')).toBe(false);
  });

  test('reset clears all mappings', () => {
    const m = createIdMapper();
    m.mapClipboardToNew('a', 'b');
    m.reset();
    expect(m.hasMapping('a')).toBe(false);
  });
});

describe('ensureDefaultAnchors (abs-in-frame paste position)', () => {
  test('keeps a right-anchored node anchored (no left:0 snap to edge)', () => {
    const out: Record<string, string> = { position: 'absolute', top: '332px', right: '-102px', width: '303px' };
    ensureDefaultAnchors(out);
    expect(out.left).toBeUndefined();   // was the bug: left:'0px' overrode right
    expect(out.right).toBe('-102px');
    expect(out.top).toBe('332px');
  });

  test('keeps a bottom-anchored node anchored', () => {
    const out: Record<string, string> = { position: 'absolute', bottom: '10px', left: '5px' };
    ensureDefaultAnchors(out);
    expect(out.top).toBeUndefined();
    expect(out.bottom).toBe('10px');
  });

  test('adds default 0 only on a fully UNANCHORED axis', () => {
    const out: Record<string, string> = { position: 'absolute' };
    ensureDefaultAnchors(out);
    expect(out.left).toBe('0px');
    expect(out.top).toBe('0px');
  });
});

// ─── makeRelative — the shared "this node now flows" conversion ──────────────
// Every relative-conversion path in the paste engine funnels here: the
// `strip-absolute` and `force-relative` style transforms, and the flex/grid
// parent fixup.
//
// The translate is the part that was missing. A percentage-pinned absolute node
// carries `translate(-50%, -50%)` purely to compensate for `left/top` being its
// CENTRE. Once it flows in a flex/grid parent those anchors are gone, so the
// translate has nothing to compensate for and just shoves the element half its
// own size up and left — copying a centred absolute frame and pasting it as a
// flex sibling did exactly that (live find 2026-07-25).
import { makeRelative } from './core/node-creator';

describe('makeRelative (paste → relative conversion)', () => {
  test('strips the centring translate that only works with absolute pins', () => {
    const out: Record<string, string> = {
      position: 'absolute', left: '50%', top: '50%',
      transform: 'translate(-50%, -50%)', width: '365px',
    };
    makeRelative(out);
    expect(out.position).toBe('relative');
    expect(out.transform).toBeUndefined(); // nothing visual left → property removed
    expect(out.left).toBeUndefined();
    expect(out.top).toBeUndefined();
    expect(out.width).toBe('365px'); // untouched
  });

  test('KEEPS rotate/scale/skew — only the translate goes', () => {
    const out: Record<string, string> = {
      position: 'absolute', left: '50%', top: '50%',
      transform: 'translate(-50%, -50%) rotate(39.5deg) scale(1.2)',
    };
    makeRelative(out);
    expect(out.transform).toBe('rotate(39.5deg) scale(1.2)');
  });

  test('strips every translate form (translateX/Y/Z/3d)', () => {
    for (const t of ['translateX(-50%)', 'translateY(-50%)', 'translateZ(10px)', 'translate3d(1px, 2px, 3px)']) {
      const out: Record<string, string> = { position: 'absolute', transform: `${t} rotate(10deg)` };
      makeRelative(out);
      expect(out.transform).toBe('rotate(10deg)');
    }
  });

  test('clears the pin anchors and the abs-in-frame marker', () => {
    const out: Record<string, string> = {
      position: 'absolute', left: '10px', top: '20px', right: '30px', bottom: '40px',
      isAbsoluteInFrame: 'true',
    };
    makeRelative(out);
    expect(out).toEqual({ position: 'relative' });
  });

  test('a node with no transform is left without one', () => {
    const out: Record<string, string> = { position: 'absolute', left: '0px' };
    makeRelative(out);
    expect('transform' in out).toBe(false);
  });

  test('idempotent', () => {
    const out: Record<string, string> = {
      position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%) rotate(10deg)',
    };
    makeRelative(out);
    const once = { ...out };
    makeRelative(out);
    expect(out).toEqual(once);
  });
});

// ─── Duplicate keeps the source's pin configuration ─────────────────────────
//
// Reported 2026-08-24: a node pinned TOP + LEFT-in-PERCENT came back from
// Cmd+D as `left: '32.5826px'` — same number, wrong unit — and the panel read
// it as a px pin.
//
// `at-selected-position` rebuilds the position as NUMERIC left/top from
// `parseFloat(sel.styles.left|top)`, which discards both the unit and the
// anchor SIDE (a right/bottom-anchored node has no `left` at all, so it
// resolved to 0). The clone already carries the source's own anchors, and for
// a duplicate-in-place those ARE the answer.
describe('paste-at-abs-in-canvas-frame keeps the source anchors', () => {
  test('THE BUG: the rule no longer rebuilds the position numerically', () => {
    const rule = getRuleById('paste-at-abs-in-canvas-frame');
    expect(rule).toBeTruthy();
    expect(rule!.config.positioning).not.toBe('at-selected-position');
    // `preserve` computes no override, so the node's own left/top pass through.
    expect(rule!.config.positioning).toBe('preserve');
  });

  test('its viewport twin already avoided the same trap', () => {
    // Fixed earlier for the right/bottom-anchor half of the defect; the canvas
    // variant was missed. Pinned here so they can't drift apart again.
    expect(getRuleById('paste-at-abs-in-frame')!.config.positioning).not.toBe('at-selected-position');
  });

  test('`preserve` yields no position override for a frame-child target', () => {
    // The override is computed ONLY for at-selected-position / center-in-parent
    // (executor.ts). This pins the pairing the rule now depends on.
    const sel = makeCanvasNode('kid', {
      parentId: 'frame',
      styles: { position: 'absolute', left: '32.5826%', top: '77px' },
    });
    const ctx = makeContext({
      selectedIds: ['kid'],
      nodes: new Map([['kid', sel]]),
      clipboardNodes: [makeClipboardNode('kid', {
        styles: { position: 'absolute', left: '32.5826%', top: '77px' },
      })],
    });
    // The old mode flattens the percent to a bare number — the actual defect.
    expect(calculatePosition(ctx, 'at-selected-position').x).toBe(32.5826);
    // `preserve` reads the CLIPBOARD root, and nothing consumes it for a
    // frame-child target, so the styles survive verbatim.
    expect(calculatePosition(ctx, 'preserve').x).toBe(32.5826);
  });

  test('ensureDefaultAnchors leaves a percent anchor alone', () => {
    // The one thing `to-absolute-in-frame` still does to the styles. It may
    // only fill an axis with NO anchor on either side.
    const out: Record<string, string> = { position: 'absolute', left: '32.5826%', top: '77px' };
    ensureDefaultAnchors(out);
    expect(out.left).toBe('32.5826%');
    expect(out.top).toBe('77px');
  });

  test('and leaves a RIGHT/BOTTOM anchored node on its own sides', () => {
    const out: Record<string, string> = { position: 'absolute', right: '10%', bottom: '20px' };
    ensureDefaultAnchors(out);
    expect('left' in out).toBe(false);
    expect('top' in out).toBe(false);
    expect(out.right).toBe('10%');
  });
});
