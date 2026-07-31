/** @vitest-environment jsdom */
import { describe, it, expect } from 'vitest';
import { serializeSlotChildren, buildSlotChildren, collectAncestorIds, isEligibleSlotTarget } from './slot-children';
import type { CanvasNode } from '@/code/parsing/parser';

function node(partial: Partial<CanvasNode>): CanvasNode {
  return {
    id: '', type: 'div', name: '', styles: {}, attrs: {},
    children: [], parentId: null, isCanvasNode: false,
    ...partial,
  } as CanvasNode;
}

describe('slot-children', () => {
  it('serializeSlotChildren serializes the given connected node ids', () => {
    const nodes = new Map<string, CanvasNode>();
    nodes.set('frame', node({
      id: 'frame', isCanvasNode: true,
      styles: { width: '100px', backgroundColor: '#fff' },
    }));

    const out = serializeSlotChildren(['frame'], nodes);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('div');
    expect(out[0].styles.width).toBe('100px');
  });

  it('serializeSlotChildren recurses into the connected subtree', () => {
    const nodes = new Map<string, CanvasNode>();
    nodes.set('frame', node({ id: 'frame', isCanvasNode: true, children: ['inner'] }));
    nodes.set('inner', node({ id: 'inner', type: 'p', textContent: 'hi' }));

    const out = serializeSlotChildren(['frame'], nodes);
    expect(out[0].children).toHaveLength(1);
    expect(out[0].children[0].type).toBe('p');
    expect(out[0].children[0].textContent).toBe('hi');
  });

  it('buildSlotChildren keeps a nested child’s in-frame positioning', () => {
    const els = buildSlotChildren([{
      type: 'div',
      styles: { position: 'absolute', left: '342px', top: '12px' },
      attrs: {},
      children: [{
        type: 'div',
        styles: { position: 'absolute', left: '20px', top: '30px', width: '50px' },
        attrs: {},
        children: [],
      }],
    }]);
    const root = els[0] as any;
    // Root: workspace positioning stripped.
    expect(root.props.style.left).toBeUndefined();
    // Nested child: in-frame positioning preserved.
    const child = root.props.children[0];
    expect(child.props.style.left).toBe('20px');
    expect(child.props.style.top).toBe('30px');
  });

  // Regression: nested slot wiring. A slot-bearing canvas-node (e.g. a
  // Marquee on the canvas) wired into another Marquee's slot must serialize
  // its OWN slot children too, not just its inline JSX children. Without
  // this, the inner Marquee ghosts as an empty shell on the canvas (live
  // site works because React composition resolves `{cn_leaf}` natively).
  it('serializeSlotChildren recurses through slot-connection wiring', () => {
    const nodes = new Map<string, CanvasNode>();
    // Outer page marquee (not serialized here — the host wires its slot)
    nodes.set('marquee-outer', node({ id: 'marquee-outer', type: 'Marquee' }));
    // Inner marquee — lives on the canvas as a slot-hoisted const.
    nodes.set('marquee-inner', node({
      id: 'marquee-inner', type: 'Marquee', isCanvasNode: true,
      styles: { width: '300px' },
    }));
    // Leaf — wired into marquee-inner's slot. Carries canvas-workspace
    // positioning (-260px, -20px) from when it lived in canvasNodes;
    // those must be STRIPPED when serialized as a slot-resolved descendant,
    // otherwise the leaf ghost renders off-screen inside its parent.
    nodes.set('leaf', node({
      id: 'leaf', type: 'div', isCanvasNode: true,
      styles: {
        width: '80px', backgroundColor: '#fcc',
        position: 'absolute', left: '-260px', top: '-20px',
      },
    }));

    const slotConnections = new Map<string, string[]>([
      ['marquee-outer', ['marquee-inner']],
      ['marquee-inner', ['leaf']],
    ]);

    const out = serializeSlotChildren(['marquee-inner'], nodes, slotConnections);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('Marquee');
    // The inner Marquee's own slot connection (leaf) appears as a child.
    expect(out[0].children).toHaveLength(1);
    expect(out[0].children[0].type).toBe('div');
    // Non-positioning styles preserved…
    expect(out[0].children[0].styles.backgroundColor).toBe('#fcc');
    expect(out[0].children[0].styles.width).toBe('80px');
    // …but workspace-positioning stripped (would push it off-screen inside
    // the ghost — the leaf is a slot-resolved descendant, not an inline
    // child with real in-frame positioning).
    expect(out[0].children[0].styles.position).toBeUndefined();
    expect(out[0].children[0].styles.left).toBeUndefined();
    expect(out[0].children[0].styles.top).toBeUndefined();
  });

  it('serializeSlotChildren handles cycles without infinite recursion', () => {
    // Authoring error: cn_a inside cn_b inside cn_a. Live site would
    // infinite-render; serialization should at least terminate.
    const nodes = new Map<string, CanvasNode>();
    nodes.set('a', node({ id: 'a', type: 'Marquee', isCanvasNode: true }));
    nodes.set('b', node({ id: 'b', type: 'Marquee', isCanvasNode: true }));
    const slotConnections = new Map<string, string[]>([
      ['a', ['b']],
      ['b', ['a']],
    ]);
    const out = serializeSlotChildren(['a'], nodes, slotConnections);
    expect(out).toHaveLength(1);
    // Both nodes touched once, no second-level recursion.
    expect(out[0].type).toBe('Marquee');
  });

  it('buildSlotChildren strips workspace positioning + data-* attrs', () => {
    const els = buildSlotChildren([{
      type: 'div',
      styles: { position: 'absolute', left: '342px', top: '12px', width: '100px' },
      attrs: { 'data-id': 'frame', 'data-canvas-node': 'true', src: 'x.png' },
      children: [],
    }]);
    expect(els).toHaveLength(1);
    const el = els[0] as any;
    expect(el.props.style.position).toBeUndefined();
    expect(el.props.style.left).toBeUndefined();
    expect(el.props.style.top).toBeUndefined();
    expect(el.props.style.width).toBe('100px');
    expect(el.props['data-id']).toBeUndefined();
    expect(el.props['data-canvas-node']).toBeUndefined();
    expect(el.props.src).toBe('x.png');
  });
});

// A code component's slot must NOT be connectable to its own container/ancestor
// (it would render its own parent → a cycle). Regression for the reported bug:
// a Marquee inside a Frame could be wired to that Frame.
describe('slot-target eligibility — block the component\'s own hierarchy', () => {
  const build = () => {
    const nodes = new Map<string, CanvasNode>();
    // Top-level canvas Frame that CONTAINS the code component (the ancestor).
    nodes.set('frame-parent', node({ id: 'frame-parent', isCanvasNode: true, parentId: null }));
    // The code component lives inside that Frame.
    nodes.set('marquee', node({ id: 'marquee', type: 'Marquee', parentId: 'frame-parent' }));
    // A separate top-level canvas Frame — a legitimate target.
    nodes.set('frame-other', node({ id: 'frame-other', isCanvasNode: true, parentId: null }));
    // A nested (non-canvas) node — never a slot target.
    nodes.set('inner', node({ id: 'inner', parentId: 'frame-other' }));
    return nodes;
  };

  it('collectAncestorIds walks the parent chain (and is cycle-safe)', () => {
    const nodes = build();
    expect(collectAncestorIds(nodes, 'marquee')).toEqual(new Set(['frame-parent']));
    // nested: inner → frame-other
    expect(collectAncestorIds(nodes, 'inner')).toEqual(new Set(['frame-other']));
    // cyclic parent chain doesn't loop forever
    const cyc = new Map<string, CanvasNode>();
    cyc.set('a', node({ id: 'a', parentId: 'b' }));
    cyc.set('b', node({ id: 'b', parentId: 'a' }));
    expect(collectAncestorIds(cyc, 'a')).toEqual(new Set(['b', 'a']));
  });

  it('the containing ancestor Frame is NOT an eligible target (the bug)', () => {
    const nodes = build();
    const ancestorIds = collectAncestorIds(nodes, 'marquee');
    expect(isEligibleSlotTarget(nodes.get('frame-parent'), {
      componentId: 'marquee', ancestorIds, connectedIds: [], isSingleSlot: true,
    })).toBe(false);
  });

  it('a separate top-level canvas Frame IS eligible', () => {
    const nodes = build();
    const ancestorIds = collectAncestorIds(nodes, 'marquee');
    expect(isEligibleSlotTarget(nodes.get('frame-other'), {
      componentId: 'marquee', ancestorIds, connectedIds: [], isSingleSlot: true,
    })).toBe(true);
  });

  it('rejects the component itself and nested (non-canvas) nodes', () => {
    const nodes = build();
    const ancestorIds = collectAncestorIds(nodes, 'marquee');
    const opts = { componentId: 'marquee', ancestorIds, connectedIds: [] as string[], isSingleSlot: true };
    expect(isEligibleSlotTarget(nodes.get('marquee'), opts)).toBe(false); // itself
    expect(isEligibleSlotTarget(nodes.get('inner'), opts)).toBe(false);   // has a parent
    expect(isEligibleSlotTarget(undefined, opts)).toBe(false);            // missing
  });

  it('an already-connected node is blocked for a multi-slot but re-draggable for a single slot', () => {
    const nodes = build();
    const ancestorIds = collectAncestorIds(nodes, 'marquee');
    expect(isEligibleSlotTarget(nodes.get('frame-other'), {
      componentId: 'marquee', ancestorIds, connectedIds: ['frame-other'], isSingleSlot: false,
    })).toBe(false);
    expect(isEligibleSlotTarget(nodes.get('frame-other'), {
      componentId: 'marquee', ancestorIds, connectedIds: ['frame-other'], isSingleSlot: true,
    })).toBe(true);
  });

  // ─── Rich text inside a slot-connected canvas node ────────────────────────
  //
  // For a mixed-content node `textContent` is RAW INNER JSX
  // (`<span style={{ color: 'rgb(255,255,255)' }}>hi</span>`), not plain text.
  // Handed to React as a text child it was escaped and the ghost painted the
  // source verbatim inside the code component — a wall of black `<span style=…`
  // where the styled text should be (user report 2026-07-26). It renders as
  // MARKUP now, same as the Renderer's shouldUseInnerHTML branch.
  it('serializeSlotChildren carries the hasMixedContent flag', () => {
    const nodes = new Map<string, CanvasNode>();
    nodes.set('rich', node({
      id: 'rich', type: 'p', isCanvasNode: true, hasMixedContent: true,
      textContent: `<span style={{ color: 'rgb(255, 255, 255)' }}>hi</span>`,
    }));
    const out = serializeSlotChildren(['rich'], nodes);
    expect(out[0].hasMixedContent).toBe(true);
    expect(out[0].textContent).toContain('<span');
  });

  it('buildSlotChildren renders rich text as MARKUP, not escaped source', () => {
    const els = buildSlotChildren([{
      type: 'p', styles: {}, attrs: {}, children: [],
      hasMixedContent: true,
      textContent: `<span style={{ color: 'rgb(255, 255, 255)' }}>hi</span>`,
    }]);
    const el = els[0] as any;
    expect(el.props.dangerouslySetInnerHTML).toBeDefined();
    // JSX style syntax converted to real HTML for the ghost.
    expect(el.props.dangerouslySetInnerHTML.__html).toContain('color: rgb(255, 255, 255)');
    expect(el.props.dangerouslySetInnerHTML.__html).toContain('>hi<');
    // Must NOT also pass children — React forbids the combination.
    expect(el.props.children).toBeUndefined();
  });

  it('buildSlotChildren still renders PLAIN text as a text child', () => {
    const els = buildSlotChildren([{
      type: 'p', styles: {}, attrs: {}, children: [], textContent: 'just words',
    }]);
    const el = els[0] as any;
    expect(el.props.dangerouslySetInnerHTML).toBeUndefined();
    expect(el.props.children).toBe('just words');
  });
});
