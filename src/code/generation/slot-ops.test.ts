import { describe, it, expect } from 'vitest';
import { connectSlotInCode, disconnectSlotInCode, getSlotConnections, reorderSlotInCode, slotConstName, removeSlotHoistedCanvasNodeInCode, isIndexInsideSlotConst, copySlotConnectionsInCode } from './slot-ops';
import { parseJSXToNodes } from '@/code/parsing/parser';

const BASE = `export default function Page() {
  return (
    <div data-id="root" style={{ width: '1440px' }}>
      <LensBox data-id="lens-1" data-name="LensBox"></LensBox>
      <LensBox data-id="lens-2" data-name="LensBox"></LensBox>
    </div>
  );
}

const canvasNodes = (<>
  <div data-id="frame-1" data-canvas-node="true" data-name="Frame" style={{ position: 'absolute', width: '200px', left: '-455px', top: '-317px' }}></div>
</>);
`;

describe('slot-ops (reference model)', () => {
  it('connectSlotInCode hoists the node to a const and references it', () => {
    const out = connectSlotInCode(BASE, 'lens-1', 'frame-1');
    // The node is hoisted to `const cn_frame_1`.
    expect(out).toMatch(/const cn_frame_1\s*=/);
    expect(out).toContain('data-id="frame-1"');
    // The component references it.
    expect(out).toContain('{cn_frame_1}');
    // It's no longer inline in the canvasNodes fragment.
    expect(out).not.toMatch(/const canvasNodes = \(<>\s*<div data-id="frame-1"/);
    expect(getSlotConnections(out, 'lens-1')).toEqual(['frame-1']);
  });

  it('connects ONE canvas node into MULTIPLE component slots', () => {
    let out = connectSlotInCode(BASE, 'lens-1', 'frame-1');
    out = connectSlotInCode(out, 'lens-2', 'frame-1');
    // Both components reference the node.
    expect(getSlotConnections(out, 'lens-1')).toEqual(['frame-1']);
    expect(getSlotConnections(out, 'lens-2')).toEqual(['frame-1']);
    // Still exactly ONE hoisted const.
    expect(out.match(/const cn_frame_1\s*=/g)?.length).toBe(1);
  });

  it('connecting a node already hoisted under a NON-cn_ name reuses it, never strips the const', () => {
    // Mirrors an MCP-authored node: `const tl_tool_6 = <div data-id="tl-tool-6"…>`
    // already referenced by lens-1; now also connected to lens-2.
    const CODE = `export default function Page() {
  return (
    <div data-id="root" style={{ width: '1440px' }}>
      <LensBox data-id="lens-1" data-name="LensBox">{tl_tool_6}</LensBox>
      <LensBox data-id="lens-2" data-name="LensBox"></LensBox>
    </div>
  );
}
const tl_tool_6 = <div data-id="tl-tool-6" data-canvas-node="true" data-name="Tool" style={{ position: 'absolute', left: '-460px', top: '400px' }} />;
`;
    const out = connectSlotInCode(CODE, 'lens-2', 'tl-tool-6');
    // The existing const keeps its initializer — NOT a broken `const tl_tool_6;`.
    expect(out).toMatch(/const tl_tool_6\s*=\s*</);
    expect(out).not.toMatch(/const tl_tool_6\s*;/);
    // No duplicate cn_-named const created.
    expect(out).not.toMatch(/const cn_tl_tool_6\s*=/);
    // Both slots reference the same node.
    expect(getSlotConnections(out, 'lens-1')).toEqual(['tl-tool-6']);
    expect(getSlotConnections(out, 'lens-2')).toEqual(['tl-tool-6']);
  });

  it('connecting the same node to the same slot twice is idempotent', () => {
    let out = connectSlotInCode(BASE, 'lens-1', 'frame-1');
    out = connectSlotInCode(out, 'lens-1', 'frame-1');
    expect(getSlotConnections(out, 'lens-1')).toEqual(['frame-1']);
  });

  it('disconnecting one slot keeps the node connected to others', () => {
    let out = connectSlotInCode(BASE, 'lens-1', 'frame-1');
    out = connectSlotInCode(out, 'lens-2', 'frame-1');
    out = disconnectSlotInCode(out, 'lens-1', 'frame-1');
    expect(getSlotConnections(out, 'lens-1')).toEqual([]);
    expect(getSlotConnections(out, 'lens-2')).toEqual(['frame-1']);
    // Const stays — still referenced by lens-2.
    expect(out).toMatch(/const cn_frame_1\s*=/);
  });

  it('disconnecting the last slot inlines the node back into canvasNodes', () => {
    let out = connectSlotInCode(BASE, 'lens-1', 'frame-1');
    out = disconnectSlotInCode(out, 'lens-1', 'frame-1');
    // Const removed.
    expect(out).not.toMatch(/const cn_frame_1\s*=/);
    // Back to a normal canvas node — the parser sees it again.
    const nodes = parseJSXToNodes(out);
    expect(nodes.get('frame-1')?.isCanvasNode).toBe(true);
    expect(nodes.get('frame-1')?.parentId).toBeNull();
  });

  it('reorderSlotInCode reorders a component’s slot references', () => {
    const TWO = `export default function Page() {
  return <div data-id="root"><LensBox data-id="lens-1" data-name="LensBox"></LensBox></div>;
}
const canvasNodes = (<>
  <div data-id="a" data-canvas-node="true"></div>
  <div data-id="b" data-canvas-node="true"></div>
</>);
`;
    let out = connectSlotInCode(TWO, 'lens-1', 'a');
    out = connectSlotInCode(out, 'lens-1', 'b');
    expect(getSlotConnections(out, 'lens-1')).toEqual(['a', 'b']);
    out = reorderSlotInCode(out, 'lens-1', 0, 1);
    expect(getSlotConnections(out, 'lens-1')).toEqual(['b', 'a']);
  });

  it('slotConstName sanitises ids into valid identifiers', () => {
    expect(slotConstName('frame-mph1-2')).toBe('cn_frame_mph1_2');
  });

  it('removeSlotHoistedCanvasNodeInCode strips decl + every {cn_X} reference', () => {
    // Wire frame-1 into BOTH lens slots so it's referenced twice.
    let c = connectSlotInCode(BASE, 'lens-1', 'frame-1');
    c = connectSlotInCode(c, 'lens-2', 'frame-1');
    expect(c).toContain('const cn_frame_1 =');
    expect(c.match(/\{cn_frame_1\}/g)?.length).toBe(2);

    // Delete the canvas node — both refs AND the hoist decl gone.
    const after = removeSlotHoistedCanvasNodeInCode(c, 'frame-1');
    expect(after).not.toContain('const cn_frame_1');
    expect(after).not.toContain('{cn_frame_1}');
    // Code still parses (no stray `const X = ;` left behind).
    expect(() => parseJSXToNodes(after)).not.toThrow();
  });

  it('removeSlotHoistedCanvasNodeInCode is a no-op when the node is not hoisted', () => {
    // No connect — frame-1 lives in canvasNodes, no cn_frame_1 const exists.
    const after = removeSlotHoistedCanvasNodeInCode(BASE, 'frame-1');
    expect(after).toBe(BASE);
  });

  // Regression: nested slot wiring (Marquee-inner connected into Marquee-outer,
  // Marquee-inner ALSO wired to a leaf canvas node). The naive insertion path
  // produced `const cn_marquee_inner = <Marquee>{cn_leaf}</Marquee>` BEFORE
  // `const cn_leaf = <div/>;`, hitting `cn_leaf`'s TDZ at module-load on the
  // live site and rendering the outer Marquee empty. Topo sort must place
  // every cn_ AFTER every cn_ it references.
  it('topo-sorts nested cn_ decls so dependencies come first', () => {
    const NESTED = `function Page() {
  return (
    <div data-id="root">
      <Marquee data-id="marquee-outer" data-name="Marquee"></Marquee>
    </div>
  );
}

const canvasNodes = (<>
  <Marquee data-id="marquee-inner" data-canvas-node="true" data-name="Marquee" style={{ width: '400px' }}></Marquee>
  <div data-id="leaf" data-canvas-node="true" style={{ width: '80px' }}></div>
</>);
`;
    // Wire marquee-inner into marquee-outer FIRST, then leaf into
    // marquee-inner — exact order the user followed.
    let out = connectSlotInCode(NESTED, 'marquee-outer', 'marquee-inner');
    out = connectSlotInCode(out, 'marquee-inner', 'leaf');

    // Both consts now exist…
    expect(out).toMatch(/const cn_marquee_inner\s*=/);
    expect(out).toMatch(/const cn_leaf\s*=/);
    // …and cn_leaf MUST come before cn_marquee_inner (it's referenced inside it).
    const leafIdx = out.indexOf('const cn_leaf');
    const innerIdx = out.indexOf('const cn_marquee_inner');
    expect(leafIdx).toBeGreaterThan(-1);
    expect(innerIdx).toBeGreaterThan(-1);
    expect(leafIdx).toBeLessThan(innerIdx);
    // Wiring intact.
    expect(getSlotConnections(out, 'marquee-outer')).toEqual(['marquee-inner']);
    expect(getSlotConnections(out, 'marquee-inner')).toEqual(['leaf']);
  });

  it('topo sort holds across deeper chains (3 levels)', () => {
    const THREE = `function Page() {
  return <div data-id="root"><Marquee data-id="m1"></Marquee></div>;
}
const canvasNodes = (<>
  <Marquee data-id="m2" data-canvas-node="true"></Marquee>
  <Marquee data-id="m3" data-canvas-node="true"></Marquee>
  <div data-id="leaf" data-canvas-node="true"></div>
</>);
`;
    let out = connectSlotInCode(THREE, 'm1', 'm2');
    out = connectSlotInCode(out, 'm2', 'm3');
    out = connectSlotInCode(out, 'm3', 'leaf');
    const i_leaf = out.indexOf('const cn_leaf');
    const i_m3 = out.indexOf('const cn_m3');
    const i_m2 = out.indexOf('const cn_m2');
    expect(i_leaf).toBeLessThan(i_m3);
    expect(i_m3).toBeLessThan(i_m2);
  });

  describe('isIndexInsideSlotConst', () => {
    const CODE = `import React from 'react';

const cn_frame_1 = <div data-id="frame-1" data-canvas-node="true" style={{ width: '100px' }}></div>;

const cn_frame_2 = <motion.div data-id="frame-2" data-canvas-node="true" variants={f2v}></motion.div>;

function Page() {
  return <div data-id="root"><Marquee>{cn_frame_1}</Marquee></div>;
}
`;

    it('returns true for indices inside a cn_ const decl', () => {
      const idx = CODE.indexOf('data-id="frame-1"');
      expect(isIndexInsideSlotConst(CODE, idx)).toBe(true);
    });

    it('returns true for a second cn_ const further down', () => {
      const idx = CODE.indexOf('data-id="frame-2"');
      expect(isIndexInsideSlotConst(CODE, idx)).toBe(true);
    });

    it('returns false for the in-function root JSX', () => {
      const idx = CODE.indexOf('data-id="root"');
      expect(isIndexInsideSlotConst(CODE, idx)).toBe(false);
    });

    it('returns false for the `{cn_frame_1}` reference inside JSX', () => {
      const idx = CODE.indexOf('{cn_frame_1}');
      expect(isIndexInsideSlotConst(CODE, idx)).toBe(false);
    });

    it('returns false for code with no slot consts at all', () => {
      const plain = 'function P() { return <div data-id="x" />; }';
      expect(isIndexInsideSlotConst(plain, plain.indexOf('data-id'))).toBe(false);
    });
  });

  // ─── Duplicating a section that holds a wired code component ──────────
  //
  // The paste engine rebuilds the copy's JSX from CLIPBOARD nodes, and a
  // `{cn_x}` slot ref is an expression child (not a node) — so the copy
  // arrives with an empty slot. The pass below re-points it at the SAME
  // hoisted canvas nodes (shared, never cloned) and must not touch the
  // source. User report 2026-07-25.
  describe('copySlotConnectionsInCode', () => {
    // Two floating canvas nodes, both wired into `lens-1`; `lens-2` stands in
    // for its pasted copy (the engine emits it with an empty slot).
    const TWO_NODES = BASE.replace(
      '</>);',
      '  <div data-id="frame-2" data-canvas-node="true" data-name="Frame" style={{ position: \'absolute\', width: \'200px\', left: \'-200px\', top: \'-317px\' }}></div>\n</>);',
    );
    const WIRED = connectSlotInCode(
      connectSlotInCode(TWO_NODES, 'lens-1', 'frame-1'),
      'lens-1', 'frame-2',
    );

    it('copies the source refs onto the pasted copy', () => {
      const out = copySlotConnectionsInCode(WIRED, [{ fromId: 'lens-1', toId: 'lens-2' }]);
      expect(getSlotConnections(out, 'lens-2')).toEqual(['frame-1', 'frame-2']);
    });

    it('leaves the SOURCE connections untouched', () => {
      const out = copySlotConnectionsInCode(WIRED, [{ fromId: 'lens-1', toId: 'lens-2' }]);
      expect(getSlotConnections(out, 'lens-1')).toEqual(['frame-1', 'frame-2']);
    });

    it('shares the existing consts — no clones are hoisted', () => {
      const out = copySlotConnectionsInCode(WIRED, [{ fromId: 'lens-1', toId: 'lens-2' }]);
      expect(out.match(/const cn_/g)?.length).toBe(2);
      expect(out.match(/\{cn_frame_1\}/g)?.length).toBe(2);
    });

    it('preserves ref ORDER (marquee item order)', () => {
      const reordered = reorderSlotInCode(WIRED, 'lens-1', 0, 1);
      const out = copySlotConnectionsInCode(reordered, [{ fromId: 'lens-1', toId: 'lens-2' }]);
      expect(getSlotConnections(out, 'lens-2')).toEqual(['frame-2', 'frame-1']);
    });

    it('wires a SELF-CLOSING pasted component (babel drops children otherwise)', () => {
      const selfClosing = WIRED.replace(
        '<LensBox data-id="lens-2" data-name="LensBox"></LensBox>',
        '<LensBox data-id="lens-2" data-name="LensBox" />',
      );
      const out = copySlotConnectionsInCode(selfClosing, [{ fromId: 'lens-1', toId: 'lens-2' }]);
      expect(getSlotConnections(out, 'lens-2')).toEqual(['frame-1', 'frame-2']);
    });

    it('is idempotent — a second run adds no duplicate refs', () => {
      const once = copySlotConnectionsInCode(WIRED, [{ fromId: 'lens-1', toId: 'lens-2' }]);
      const twice = copySlotConnectionsInCode(once, [{ fromId: 'lens-1', toId: 'lens-2' }]);
      expect(getSlotConnections(twice, 'lens-2')).toEqual(['frame-1', 'frame-2']);
    });

    it('returns the code UNCHANGED when the source has no slot refs', () => {
      const out = copySlotConnectionsInCode(WIRED, [{ fromId: 'lens-2', toId: 'lens-1' }]);
      expect(out).toBe(WIRED); // identical string — no babel reprint
    });

    it('returns the code unchanged when there are no hoisted canvas nodes', () => {
      const out = copySlotConnectionsInCode(BASE, [{ fromId: 'lens-1', toId: 'lens-2' }]);
      expect(out).toBe(BASE);
    });

    it('ignores a pair whose target is missing from the file', () => {
      const out = copySlotConnectionsInCode(WIRED, [{ fromId: 'lens-1', toId: 'nope-9' }]);
      expect(out).toBe(WIRED);
    });

    it('skips a self-pair (fromId === toId) so refs never double', () => {
      const out = copySlotConnectionsInCode(WIRED, [{ fromId: 'lens-1', toId: 'lens-1' }]);
      expect(out).toBe(WIRED);
    });

    it('parses the copy into a node tree with the shared canvas nodes intact', () => {
      const out = copySlotConnectionsInCode(WIRED, [{ fromId: 'lens-1', toId: 'lens-2' }]);
      const nodes = parseJSXToNodes(out);
      expect(nodes.get('frame-1')?.isCanvasNode).toBe(true);
      expect(nodes.get('frame-2')?.isCanvasNode).toBe(true);
      expect(nodes.get('lens-2')).toBeTruthy();
    });
  });
});
