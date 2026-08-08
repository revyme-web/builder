// layout-injection.test.ts — Coverage for the shared "inject flex layout +
// reflow children" helper used by both LayoutTool's `+` button and SizeTool's
// width/height → auto path.
//
// The helper itself is thin glue around node-ops, so we mock those and assert
// on the calls (no real DOM needed).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CanvasNode } from '@/code/parsing/parser';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const updateNodeStyles = vi.fn();
const findNodeSize = vi.fn();
const getContentRoot = vi.fn();

vi.mock('@/canvas/node-ops', () => ({
  updateNodeStyles: (args: unknown) => updateNodeStyles(args),
  findNodeSize: (id: string, vp: string) => findNodeSize(id, vp),
  // Cold computed cache in tests → measureCssPx falls back to
  // findNodeSize / scale (scale mocked to 1 below).
  findNodeComputedStyle: () => '',
  getContentRoot: () => getContentRoot(),
}));

vi.mock('@/canvas/transform', () => ({
  transformManager: { getTransform: () => ({ x: 0, y: 0, scale: 1 }) },
}));

vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn(), dom: vi.fn() },
}));

// ── Direction-flip re-base deps. `styleUpdate` is the ROUTER under test here:
// we assert the re-base is handed to it (so it lands in whatever scope the
// parent's own direction write went to), not that it re-implements routing. ──
const queueMutation = vi.fn();
const styleUpdate = vi.fn((nodeId: string, styles: Record<string, string>) => [
  { nodeId, type: 'updateContainerStyle', maxWidth: 768, styles },
]);

vi.mock('@/code/mutation/mutation-queue', () => ({
  queueMutation: (u: unknown) => queueMutation(u),
}));

vi.mock('@/canvas/drag/replica-context', () => ({
  getReplicaContext: (vpId: string, filePath: string, vpWidths: Record<string, number>) => {
    replicaCtxArgs.push({ vpId, filePath, vpWidths });
    return { styleUpdate };
  },
}));

const replicaCtxArgs: Array<{ vpId: string; filePath: string; vpWidths: Record<string, number> }> = [];

// Import AFTER mocks so the module picks up the mocked node-ops.
import { injectFlexLayoutOnFrame, shouldInjectLayoutOnAuto, rebaseChildrenForDirectionFlip } from './layout-injection';

// ─── Fixtures ───────────────────────────────────────────────────────────────

function makeNode(id: string, children: string[], styles: Record<string, string> = {}): CanvasNode {
  return { id, type: 'div', children, styles, attrs: {} } as unknown as CanvasNode;
}

function makeNodes(...nodes: CanvasNode[]): Map<string, CanvasNode> {
  return new Map(nodes.map(n => [n.id, n]));
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('injectFlexLayoutOnFrame', () => {
  beforeEach(() => {
    updateNodeStyles.mockClear();
    findNodeSize.mockClear();
    getContentRoot.mockClear();
    getContentRoot.mockReturnValue(document.createElement('div'));
    findNodeSize.mockReturnValue({ width: 200, height: 100 });
  });

  it('no-ops when content root is null', () => {
    getContentRoot.mockReturnValue(null);
    const nodes = makeNodes(makeNode('parent', ['c1']));
    injectFlexLayoutOnFrame('parent', nodes);
    expect(updateNodeStyles).not.toHaveBeenCalled();
  });

  it('no-ops when node not found', () => {
    const nodes = makeNodes(makeNode('other', []));
    injectFlexLayoutOnFrame('missing', nodes);
    expect(updateNodeStyles).not.toHaveBeenCalled();
  });

  it('writes parent flex column with center/center alignment', () => {
    const nodes = makeNodes(makeNode('parent', []));
    injectFlexLayoutOnFrame('parent', nodes);
    const parentCall = updateNodeStyles.mock.calls.find(c => c[0].id === 'parent');
    expect(parentCall?.[0].styles).toMatchObject({
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
    });
  });

  it('writes the PARENT before any child — ordering is load-bearing', () => {
    // A child's inset removal synchronously flushes + force-renders the code
    // as queued so far. Children-first shipped a half-converted frame (child
    // position:relative inside a not-yet-flex parent) and the child flashed
    // at the parent's 0,0 before centering (user trace 2026-08-05).
    const nodes = makeNodes(
      makeNode('parent', ['c1', 'c2']),
      makeNode('c1', [], { position: 'absolute', left: '10px', top: '20px' }),
      makeNode('c2', [], { position: 'absolute', left: '30px', top: '40px' }),
    );
    injectFlexLayoutOnFrame('parent', nodes);
    const order = updateNodeStyles.mock.calls.map(c => c[0].id);
    expect(order[0]).toBe('parent');
    expect(order).toEqual(['parent', 'c1', 'c2']);
  });

  it('makes each child a flow child: position relative + cleared insets + flex 0 0 auto', () => {
    const nodes = makeNodes(
      makeNode('parent', ['c1']),
      makeNode('c1', [], { position: 'absolute', left: '10px', top: '20px' }),
    );
    injectFlexLayoutOnFrame('parent', nodes);
    const childCall = updateNodeStyles.mock.calls.find(c => c[0].id === 'c1');
    expect(childCall?.[0].styles).toMatchObject({
      position: 'relative',
      left: '',
      top: '',
      right: '',
      bottom: '',
      flex: '0 0 auto',
    });
  });

  it('resolves non-px width/height to integer px (only for non-auto, non-px values)', () => {
    findNodeSize.mockReturnValue({ width: 234.7, height: 99.2 });
    const nodes = makeNodes(
      makeNode('parent', ['c1']),
      makeNode('c1', [], { width: '50%', height: '20vh' }),
    );
    injectFlexLayoutOnFrame('parent', nodes);
    const childCall = updateNodeStyles.mock.calls.find(c => c[0].id === 'c1');
    expect(childCall?.[0].styles.width).toBe('235px');
    expect(childCall?.[0].styles.height).toBe('99px');
  });

  it('leaves px width/height alone (no resolve)', () => {
    const nodes = makeNodes(
      makeNode('parent', ['c1']),
      makeNode('c1', [], { width: '300px', height: '150px' }),
    );
    injectFlexLayoutOnFrame('parent', nodes);
    const childCall = updateNodeStyles.mock.calls.find(c => c[0].id === 'c1');
    // No width/height key written = they stay as-is in the source.
    expect(childCall?.[0].styles.width).toBeUndefined();
    expect(childCall?.[0].styles.height).toBeUndefined();
  });

  it('leaves auto width/height alone', () => {
    const nodes = makeNodes(
      makeNode('parent', ['c1']),
      makeNode('c1', [], { width: 'auto', height: 'auto' }),
    );
    injectFlexLayoutOnFrame('parent', nodes);
    const childCall = updateNodeStyles.mock.calls.find(c => c[0].id === 'c1');
    expect(childCall?.[0].styles.width).toBeUndefined();
    expect(childCall?.[0].styles.height).toBeUndefined();
  });

  it('clears child flex shorthands and alignSelf if previously set', () => {
    const nodes = makeNodes(
      makeNode('parent', ['c1']),
      makeNode('c1', [], {
        flex: '1 1 0',
        flexGrow: '1',
        flexShrink: '1',
        flexBasis: '0',
        alignSelf: 'stretch',
      }),
    );
    injectFlexLayoutOnFrame('parent', nodes);
    const childCall = updateNodeStyles.mock.calls.find(c => c[0].id === 'c1');
    // flex shorthand is overwritten by the final '0 0 auto'.
    expect(childCall?.[0].styles.flex).toBe('0 0 auto');
    expect(childCall?.[0].styles.flexGrow).toBe('');
    expect(childCall?.[0].styles.flexShrink).toBe('');
    expect(childCall?.[0].styles.flexBasis).toBe('');
    expect(childCall?.[0].styles.alignSelf).toBe('');
  });

  it('strips translate / translateX / translateY / translate3d but keeps other transforms', () => {
    const nodes = makeNodes(
      makeNode('parent', ['c1']),
      makeNode('c1', [], { transform: 'rotate(45deg) translate(10px, 20px) scale(1.5)' }),
    );
    injectFlexLayoutOnFrame('parent', nodes);
    const childCall = updateNodeStyles.mock.calls.find(c => c[0].id === 'c1');
    expect(childCall?.[0].styles.transform).toMatch(/rotate\(45deg\)/);
    expect(childCall?.[0].styles.transform).toMatch(/scale\(1\.5\)/);
    expect(childCall?.[0].styles.transform).not.toMatch(/translate/);
  });

  it('clears transform entirely if it was only translate', () => {
    const nodes = makeNodes(
      makeNode('parent', ['c1']),
      makeNode('c1', [], { transform: 'translate3d(0, 0, 0)' }),
    );
    injectFlexLayoutOnFrame('parent', nodes);
    const childCall = updateNodeStyles.mock.calls.find(c => c[0].id === 'c1');
    expect(childCall?.[0].styles.transform).toBe('');
  });

  it('handles multiple children — all get reflowed, parent gets one write', () => {
    const nodes = makeNodes(
      makeNode('parent', ['a', 'b', 'c']),
      makeNode('a', [], { position: 'absolute' }),
      makeNode('b', [], { position: 'absolute' }),
      makeNode('c', [], { position: 'absolute' }),
    );
    injectFlexLayoutOnFrame('parent', nodes);
    const childCalls = updateNodeStyles.mock.calls.filter(c =>
      ['a', 'b', 'c'].includes(c[0].id),
    );
    expect(childCalls).toHaveLength(3);
    const parentCalls = updateNodeStyles.mock.calls.filter(c => c[0].id === 'parent');
    expect(parentCalls).toHaveLength(1);
  });

  it('skips children that no longer exist in the node map', () => {
    const nodes = makeNodes(makeNode('parent', ['ghost', 'real']), makeNode('real', []));
    injectFlexLayoutOnFrame('parent', nodes);
    const ghostCall = updateNodeStyles.mock.calls.find(c => c[0].id === 'ghost');
    expect(ghostCall).toBeUndefined();
    const realCall = updateNodeStyles.mock.calls.find(c => c[0].id === 'real');
    expect(realCall).toBeDefined();
  });

  it('passes the supplied vpId through to findNodeSize', () => {
    const nodes = makeNodes(
      makeNode('parent', ['c1']),
      makeNode('c1', [], { width: '50%' }),
    );
    injectFlexLayoutOnFrame('parent', nodes, 'tablet');
    expect(findNodeSize).toHaveBeenCalledWith('c1', 'tablet');
  });

  it('defaults to "desktop" vpId when omitted', () => {
    const nodes = makeNodes(
      makeNode('parent', ['c1']),
      makeNode('c1', [], { width: '50%' }),
    );
    injectFlexLayoutOnFrame('parent', nodes);
    expect(findNodeSize).toHaveBeenCalledWith('c1', 'desktop');
  });

  // ── Replica neutralization ────────────────────────────────────────────────
  // On a NON-PRIMARY viewport, '' clears only delete this vp's band override —
  // the primary's absolute left/top/transform cascade back into the
  // now-relative child (insets/translate offset `position: relative` elements
  // too) and shove it out of the injected layout (tablet-only layout bug,
  // 2026-08-05). Base-carried properties must get explicit NEUTRAL overrides.

  it('replica: base insets become explicit "auto" overrides, not removals', () => {
    const nodes = makeNodes(
      makeNode('parent', ['c1']),
      makeNode('c1', [], { position: 'absolute', left: '50%', top: '120px' }),
    );
    injectFlexLayoutOnFrame('parent', nodes, 'tablet');
    const childCall = updateNodeStyles.mock.calls.find(c => c[0].id === 'c1');
    expect(childCall?.[0].styles).toMatchObject({
      position: 'relative',
      left: 'auto',
      top: 'auto',
      flex: '0 0 auto',
    });
  });

  it('replica: insets the base does NOT carry stay "" (no band noise)', () => {
    const nodes = makeNodes(
      makeNode('parent', ['c1']),
      makeNode('c1', [], { position: 'absolute', left: '10px' }),
    );
    injectFlexLayoutOnFrame('parent', nodes, 'tablet');
    const childCall = updateNodeStyles.mock.calls.find(c => c[0].id === 'c1');
    expect(childCall?.[0].styles.left).toBe('auto');
    expect(childCall?.[0].styles.top).toBe('');
    expect(childCall?.[0].styles.right).toBe('');
    expect(childCall?.[0].styles.bottom).toBe('');
  });

  it('replica: translate-only base transform becomes "none" to mask the base', () => {
    const nodes = makeNodes(
      makeNode('parent', ['c1']),
      makeNode('c1', [], { position: 'absolute', left: '50%', transform: 'translateX(-50%)' }),
    );
    injectFlexLayoutOnFrame('parent', nodes, 'tablet');
    const childCall = updateNodeStyles.mock.calls.find(c => c[0].id === 'c1');
    expect(childCall?.[0].styles.transform).toBe('none');
  });

  it('replica: residual rotate/scale survives the translate strip (not "none")', () => {
    const nodes = makeNodes(
      makeNode('parent', ['c1']),
      makeNode('c1', [], { transform: 'translateX(-50%) rotate(5deg)' }),
    );
    injectFlexLayoutOnFrame('parent', nodes, 'tablet');
    const childCall = updateNodeStyles.mock.calls.find(c => c[0].id === 'c1');
    expect(childCall?.[0].styles.transform).toMatch(/rotate\(5deg\)/);
    expect(childCall?.[0].styles.transform).not.toMatch(/translate/);
  });

  it('replica: base alignSelf is masked with "auto"', () => {
    const nodes = makeNodes(
      makeNode('parent', ['c1']),
      makeNode('c1', [], { alignSelf: 'center' }),
    );
    injectFlexLayoutOnFrame('parent', nodes, 'tablet');
    const childCall = updateNodeStyles.mock.calls.find(c => c[0].id === 'c1');
    expect(childCall?.[0].styles.alignSelf).toBe('auto');
  });

  it('primary keeps plain removals ("" clears) — behavior unchanged', () => {
    const nodes = makeNodes(
      makeNode('parent', ['c1']),
      makeNode('c1', [], { position: 'absolute', left: '50%', top: '120px', transform: 'translateX(-50%)', alignSelf: 'center' }),
    );
    injectFlexLayoutOnFrame('parent', nodes, 'desktop');
    const childCall = updateNodeStyles.mock.calls.find(c => c[0].id === 'c1');
    expect(childCall?.[0].styles.left).toBe('');
    expect(childCall?.[0].styles.top).toBe('');
    expect(childCall?.[0].styles.transform).toBe('');
    expect(childCall?.[0].styles.alignSelf).toBe('');
  });
});

// ─── shouldInjectLayoutOnAuto ──────────────────────────────────────────────

describe('shouldInjectLayoutOnAuto', () => {
  it('returns false for missing node (selection mid-deletion)', () => {
    expect(shouldInjectLayoutOnAuto(undefined, '')).toBe(false);
  });

  it('returns false when frame has zero children (nothing to reflow)', () => {
    expect(shouldInjectLayoutOnAuto(makeNode('a', []), '')).toBe(false);
  });

  it('returns true for a div with children and no layout (the happy path)', () => {
    const n = makeNode('a', ['b']);
    expect(shouldInjectLayoutOnAuto(n, '')).toBe(true);
  });

  it('returns false when display is already flex / inline-flex', () => {
    const n = makeNode('a', ['b']);
    expect(shouldInjectLayoutOnAuto(n, 'flex')).toBe(false);
    expect(shouldInjectLayoutOnAuto(n, 'inline-flex')).toBe(false);
  });

  it('returns false when display is already grid / inline-grid', () => {
    const n = makeNode('a', ['b']);
    expect(shouldInjectLayoutOnAuto(n, 'grid')).toBe(false);
    expect(shouldInjectLayoutOnAuto(n, 'inline-grid')).toBe(false);
  });

  it('trims whitespace on display value', () => {
    expect(shouldInjectLayoutOnAuto(makeNode('a', ['b']), '  flex  ')).toBe(false);
  });

  it.each(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'span', 'a', 'li', 'label', 'blockquote'])(
    'returns false for text-like tag <%s>',
    (tag) => {
      const n = { id: 'a', type: tag, children: ['b'], styles: {}, attrs: {} } as unknown as CanvasNode;
      expect(shouldInjectLayoutOnAuto(n, '')).toBe(false);
    },
  );

  it('is case-insensitive on tag name (defensive — parser may emit "DIV")', () => {
    const n = { id: 'a', type: 'P', children: ['b'], styles: {}, attrs: {} } as unknown as CanvasNode;
    expect(shouldInjectLayoutOnAuto(n, '')).toBe(false);
  });

  it('treats `block` / `inline-block` / arbitrary other display as injectable', () => {
    const n = makeNode('a', ['b']);
    expect(shouldInjectLayoutOnAuto(n, 'block')).toBe(true);
    expect(shouldInjectLayoutOnAuto(n, 'inline-block')).toBe(true);
    expect(shouldInjectLayoutOnAuto(n, 'contents')).toBe(true);
  });

  it('returns false for a component instance (componentFile set) — master owns layout', () => {
    // A `<StartTrialButton/>`-style instance: has expanded children + an empty
    // wrapper display, so without the guard it would be injected. Injecting
    // would override the master root's own row layout → vertical-stack collapse.
    const instance = {
      id: 'StartTrialButton-x', type: 'div', children: ['cta'],
      styles: {}, attrs: {}, componentFile: '@/components/StartTrialButton',
    } as unknown as CanvasNode;
    expect(shouldInjectLayoutOnAuto(instance, '')).toBe(false);
  });

  it('still injects for a plain frame whose componentFile is null', () => {
    const n = {
      id: 'a', type: 'div', children: ['b'], styles: {}, attrs: {}, componentFile: null,
    } as unknown as CanvasNode;
    expect(shouldInjectLayoutOnAuto(n, '')).toBe(true);
  });
});

// ─── Multi-select fan-out ───────────────────────────────────────────────────
// `injectFlexLayoutOnFrame` does BOTH the container's flex props AND its
// children's absolute→relative reflow, so it does NOT fan out through
// ControlProvider the way a plain style write does. Adding layout with several
// frames selected laid out only the PRIMARY's children and left every other
// frame's children absolutely positioned inside a flex box. Live find 2026-07-25.
import { resolveLayoutInjectionTargets } from './layout-injection';

describe('resolveLayoutInjectionTargets', () => {
  const nodes = makeNodes(
    makeNode('f1', ['a']),
    makeNode('f2', ['b']),
    makeNode('a', []),
    makeNode('b', []),
  );

  it('single-select → just the primary', () => {
    expect(resolveLayoutInjectionTargets('f1', ['f1'], nodes)).toEqual(['f1']);
  });

  it('multi-select → every selected frame', () => {
    expect(resolveLayoutInjectionTargets('f1', ['f1', 'f2'], nodes)).toEqual(['f1', 'f2']);
  });

  it('de-duplicates and keeps the primary first', () => {
    expect(resolveLayoutInjectionTargets('f2', ['f1', 'f2', 'f1'], nodes)).toEqual(['f2', 'f1']);
  });

  it('drops ids missing from the snapshot', () => {
    expect(resolveLayoutInjectionTargets('f1', ['f1', 'ghost', 'f2'], nodes)).toEqual(['f1', 'f2']);
  });

  it('includes the primary even if the selection array is stale', () => {
    expect(resolveLayoutInjectionTargets('f1', ['f2', 'ghost'], nodes)).toEqual(['f1', 'f2']);
  });
});

describe('injectFlexLayoutOnFrame across a multi-selection', () => {
  beforeEach(() => {
    updateNodeStyles.mockClear();
    findNodeSize.mockClear();
    getContentRoot.mockReturnValue(document.createElement('div'));
    findNodeSize.mockReturnValue({ width: 100, height: 50 });
  });

  it('reflows the children of EVERY targeted frame, not only the primary', () => {
    const nodes = makeNodes(
      makeNode('f1', ['a1', 'a2']),
      makeNode('f2', ['b1']),
      makeNode('a1', [], { position: 'absolute', left: '10px', top: '20px' }),
      makeNode('a2', [], { position: 'absolute', left: '30px', top: '40px' }),
      makeNode('b1', [], { position: 'absolute', left: '50px', top: '60px' }),
    );

    for (const id of resolveLayoutInjectionTargets('f1', ['f1', 'f2'], nodes)) {
      injectFlexLayoutOnFrame(id, nodes, 'desktop');
    }

    const relativised = updateNodeStyles.mock.calls
      .map((c) => c[0] as { id: string; styles: Record<string, string> })
      .filter((u) => u.styles.position === 'relative')
      .map((u) => u.id);
    // f2's child was the one silently left absolute before the fix.
    expect(relativised).toEqual(expect.arrayContaining(['a1', 'a2', 'b1']));
  });
});

// ─── rebaseChildrenForDirectionFlip ─────────────────────────────────────────
//
// Reported bug: on the TABLET replica the band held
//   [data-id="div-ms0qgj6f-5"] { flex-direction: column !important; }   ← parent flip
//   [data-id="div-ms0qgj6f-m"] { height: 213px !important; }            ← child, no re-base
// while the child's BASE kept `flex: '1 0 0px'` from the desktop row. basis 0
// rotated onto the height and outranked the 213px, so the Height input was inert
// at every value (2026-07-26). The flip must emit the re-base itself.

/** Build the override map shape `containerOverridesAtom` produces:
 *  nodeId → maxWidth → prop → value. */
function makeOverrides(
  entries: Record<string, Record<number, Record<string, string>>>,
): Map<string, Map<number, Map<string, string>>> {
  const out = new Map<string, Map<number, Map<string, string>>>();
  for (const [nodeId, byWidth] of Object.entries(entries)) {
    const w = new Map<number, Map<string, string>>();
    for (const [width, props] of Object.entries(byWidth)) {
      w.set(Number(width), new Map(Object.entries(props)));
    }
    out.set(nodeId, w);
  }
  return out;
}

const VP_WIDTHS = { desktop: 1440, tablet: 768, mobile: 375 };

describe('rebaseChildrenForDirectionFlip', () => {
  beforeEach(() => {
    queueMutation.mockClear();
    styleUpdate.mockClear();
    replicaCtxArgs.length = 0;
  });

  function flip(over: Parameters<typeof makeOverrides>[0] = {}, vpId = 'tablet') {
    const parent = makeNode('parent', ['card'], { display: 'flex', flexDirection: 'row' });
    const card = makeNode('card', [], { flex: '1 0 0px', height: '326px', position: 'relative' });
    return rebaseChildrenForDirectionFlip({
      nodeId: 'parent',
      fromDirection: 'row',
      toDirection: 'column',
      vpId,
      nodes: makeNodes(parent, card),
      overrides: makeOverrides(over),
      vpWidths: VP_WIDTHS,
      activeFilePath: 'app/page.client.tsx',
    });
  }

  it('re-bases the reported child and queues it through the scope router', () => {
    expect(flip()).toBe(1);
    expect(styleUpdate).toHaveBeenCalledWith('card', { width: '100%', flex: '0 0 auto' });
    // Routed for the TABLET tile → the same band the direction write went to.
    expect(replicaCtxArgs[0]).toEqual({
      vpId: 'tablet', filePath: 'app/page.client.tsx', vpWidths: VP_WIDTHS,
    });
    expect(queueMutation).toHaveBeenCalledTimes(1);
    expect(queueMutation.mock.calls[0][0]).toMatchObject({
      nodeId: 'card', type: 'updateContainerStyle', maxWidth: 768,
    });
  });

  it('reads the EFFECTIVE flex so an already-re-based band is left alone', () => {
    // Sibling `div-ms0qgj6f-6` in the reported file: the band already carries
    // `flex: 0 0 auto`. Re-basing off the stale BASE fill would clobber it.
    expect(flip({ card: { 768: { flex: '0 0 auto', width: '100%' } } })).toBe(0);
    expect(queueMutation).not.toHaveBeenCalled();
  });

  it('ignores a DIFFERENT viewport band (that tile is not being edited)', () => {
    expect(flip({ card: { 375: { flex: '0 0 auto' } } })).toBe(1);
    expect(styleUpdate).toHaveBeenCalledWith('card', { width: '100%', flex: '0 0 auto' });
  });

  it('on the PRIMARY reads base styles only, ignoring every band', () => {
    expect(flip({ card: { 768: { flex: '0 0 auto' } } }, 'desktop')).toBe(1);
    expect(replicaCtxArgs[0].vpId).toBe('desktop');
  });

  it('queues nothing when no child needs re-basing', () => {
    const parent = makeNode('parent', ['fixed'], { display: 'flex', flexDirection: 'row' });
    const fixed = makeNode('fixed', [], { flex: '0 0 auto', width: '104px', height: '104px' });
    const n = rebaseChildrenForDirectionFlip({
      nodeId: 'parent', fromDirection: 'row', toDirection: 'column', vpId: 'tablet',
      nodes: makeNodes(parent, fixed), overrides: makeOverrides({}),
      vpWidths: VP_WIDTHS, activeFilePath: 'app/page.client.tsx',
    });
    expect(n).toBe(0);
    expect(styleUpdate).not.toHaveBeenCalled();
    expect(queueMutation).not.toHaveBeenCalled();
  });

  it('survives a missing node / missing child without throwing', () => {
    const base = {
      fromDirection: 'row', toDirection: 'column', vpId: 'tablet',
      overrides: makeOverrides({}), vpWidths: VP_WIDTHS, activeFilePath: 'app/page.client.tsx',
    };
    expect(rebaseChildrenForDirectionFlip({ ...base, nodeId: 'ghost', nodes: makeNodes() })).toBe(0);
    // Parent references a child that isn't in the snapshot.
    const orphan = makeNode('parent', ['gone'], { display: 'flex' });
    expect(rebaseChildrenForDirectionFlip({ ...base, nodeId: 'parent', nodes: makeNodes(orphan) })).toBe(0);
    expect(queueMutation).not.toHaveBeenCalled();
  });

  it('fans out to EVERY re-basable child in one flip', () => {
    const parent = makeNode('parent', ['a', 'b', 'c'], { display: 'flex', flexDirection: 'row' });
    const n = rebaseChildrenForDirectionFlip({
      nodeId: 'parent', fromDirection: 'row', toDirection: 'column', vpId: 'tablet',
      nodes: makeNodes(
        parent,
        makeNode('a', [], { flex: '1 0 0px' }),
        makeNode('b', [], { flex: '2 0 0px' }),
        makeNode('c', [], { flex: '0 0 auto', width: '50px' }),  // fixed → untouched
      ),
      overrides: makeOverrides({}), vpWidths: VP_WIDTHS, activeFilePath: 'app/page.client.tsx',
    });
    expect(n).toBe(2);
    expect(styleUpdate.mock.calls.map(c => c[0])).toEqual(['a', 'b']);
    expect(queueMutation).toHaveBeenCalledTimes(2);
  });
});

// ─── planChildAutoFreeze — parent → auto must not collapse %/fill children ──
// EMPIRICAL PIN, live find 2026-07-29: a 1440px flex parent with a 90%-wide
// child collapsed completely when the parent's width was switched to auto
// (90% of auto = 0 → circular). Children sized in % (or FILL grow-flex on the
// frame's own main axis) freeze to their rendered px before the auto write.
import { planChildAutoFreeze } from './layout-injection';

describe('planChildAutoFreeze', () => {
  const measure = (px: Record<string, number>) => (id: string) => px[id] ?? null;

  it('freezes a % child to its rendered px (the collapse repro)', () => {
    const plan = planChildAutoFreeze({
      axis: 'width',
      frameFlexDirection: 'column',
      children: [{ id: 'bar', styles: { width: '90%', height: '70px', position: 'relative' } }],
      measure: measure({ bar: 1296 }),
    });
    expect(plan).toEqual([{ id: 'bar', styles: { width: '1296px' } }]);
  });

  it('freezes a FILL child on the frame\'s own main axis and neutralises the grow flex', () => {
    const plan = planChildAutoFreeze({
      axis: 'width',
      frameFlexDirection: 'row',
      children: [{ id: 'fill', styles: { flex: '1 0 0px', position: 'relative' } }],
      measure: measure({ fill: 640 }),
    });
    expect(plan).toEqual([{ id: 'fill', styles: { width: '640px', flex: '0 0 auto' } }]);
  });

  it('a grow flex on the CROSS axis is not a width fill (column frame)', () => {
    const plan = planChildAutoFreeze({
      axis: 'width',
      frameFlexDirection: 'column',
      children: [{ id: 'a', styles: { flex: '1 0 0px', position: 'relative' } }],
      measure: measure({ a: 640 }),
    });
    expect(plan).toEqual([]);
  });

  it('px, auto and viewport-relative children are untouched', () => {
    const plan = planChildAutoFreeze({
      axis: 'width',
      frameFlexDirection: 'column',
      children: [
        { id: 'px', styles: { width: '320px' } },
        { id: 'auto', styles: {} },
        { id: 'vw', styles: { width: '50vw' } },
      ],
      measure: measure({ px: 320, auto: 100, vw: 700 }),
    });
    expect(plan).toEqual([]);
  });

  it('absolute/fixed children never freeze (they do not size the parent)', () => {
    const plan = planChildAutoFreeze({
      axis: 'width',
      frameFlexDirection: 'column',
      children: [
        { id: 'abs', styles: { width: '90%', position: 'absolute' } },
        { id: 'fix', styles: { width: '100%', position: 'fixed' } },
      ],
      measure: measure({ abs: 500, fix: 500 }),
    });
    expect(plan).toEqual([]);
  });

  it('height axis works symmetrically', () => {
    const plan = planChildAutoFreeze({
      axis: 'height',
      frameFlexDirection: 'column',
      children: [{ id: 'tall', styles: { height: '100%', position: 'relative' } }],
      measure: measure({ tall: 163 }),
    });
    expect(plan).toEqual([{ id: 'tall', styles: { height: '163px' } }]);
  });

  it('unmeasurable children are skipped rather than frozen to garbage', () => {
    const plan = planChildAutoFreeze({
      axis: 'width',
      frameFlexDirection: 'column',
      children: [{ id: 'ghost', styles: { width: '90%' } }],
      measure: () => null,
    });
    expect(plan).toEqual([]);
  });
});

// ─── The other tiles ────────────────────────────────────────────────────────
//
// User report 2026-08-08. Injecting on the PRIMARY converts the children to
// flow in every tile — layout cascades to the replicas — but the '' inset
// clears only ever deleted the primary's inline values. A replica that had
// positioned the child independently kept its own banded `left`, which offsets
// a `position: relative` box just as it does an absolute one. Worse, the panel
// hides inset controls for a flow child, so there was no way back from the UI.
describe('injectFlexLayoutOnFrame — sheds the other tiles placement overrides', () => {
  beforeEach(() => {
    updateNodeStyles.mockClear();
    queueMutation.mockClear();
    getContentRoot.mockReturnValue(document.createElement('div'));
    findNodeSize.mockReturnValue({ width: 200, height: 100 });
  });

  const stripCalls = () =>
    queueMutation.mock.calls
      .map(c => c[0])
      .filter((m: { type: string }) => m.type === 'stripPositionalTileOverrides');

  it('queues one strip per child when injecting on the primary', () => {
    const nodes = makeNodes(
      makeNode('parent', ['c1', 'c2']),
      makeNode('c1', [], { position: 'absolute', left: '10px', top: '4px' }),
      makeNode('c2', [], { position: 'absolute', left: '80px' }),
    );
    injectFlexLayoutOnFrame('parent', nodes, 'desktop');
    expect(stripCalls().map((m: { nodeId: string }) => m.nodeId)).toEqual(['c1', 'c2']);
  });

  it('does NOT strip when injecting on a REPLICA', () => {
    // A replica-local layout is that tile's decision — the other tiles' children
    // are still absolute there, and their insets are still correct.
    const nodes = makeNodes(
      makeNode('parent', ['c1']),
      makeNode('c1', [], { position: 'absolute', left: '10px' }),
    );
    injectFlexLayoutOnFrame('parent', nodes, 'mobile');
    expect(stripCalls()).toHaveLength(0);
  });

  it('a replica injection still neutralizes the base insets in its own band', () => {
    // The pre-existing half of the behaviour, unchanged by this addition.
    const nodes = makeNodes(
      makeNode('parent', ['c1']),
      makeNode('c1', [], { position: 'absolute', left: '10px', top: '4px' }),
    );
    injectFlexLayoutOnFrame('parent', nodes, 'mobile');
    const childCall = updateNodeStyles.mock.calls.find(c => c[0].id === 'c1');
    expect(childCall?.[0].styles).toMatchObject({ left: 'auto', top: 'auto' });
  });

  it('strips for a child that carries no inline inset of its own', () => {
    // The inline style is the PRIMARY's truth only — a replica can hold an
    // inset the primary never had, which is exactly the reported page.
    const nodes = makeNodes(
      makeNode('parent', ['c1']),
      makeNode('c1', [], { position: 'absolute' }),
    );
    injectFlexLayoutOnFrame('parent', nodes, 'desktop');
    expect(stripCalls()).toHaveLength(1);
  });

  it('a childless frame queues nothing', () => {
    injectFlexLayoutOnFrame('parent', makeNodes(makeNode('parent', [])), 'desktop');
    expect(stripCalls()).toHaveLength(0);
  });
});
