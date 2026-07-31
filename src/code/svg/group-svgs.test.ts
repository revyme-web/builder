import { describe, it, expect } from 'vitest';
import { parseChildSvgs, ungroupSvgsInSource } from './group-svgs';
import { rotatedRefitPosition, parseGroupRotation, normalizeGroupChildrenInSource, scaleGroupChildrenInSource, snapshotGroupChildrenForResize, refitGroupBoundsInSource, stretchGroupChildrenInSource, groupContentPaintedBoundsInSource } from './refit-group';
import { computeScaledChildPatches } from './group-resize-bake';
import type { CanvasNode } from '../parsing/parser';

// A group SVG mirroring `buildGroupedSvg` output: a top-level <svg> whose
// children are nested <svg> wrappers positioned via x/y attrs.
const GROUP =
  '<svg data-id="vector-1" data-name="Vector" viewBox="0 0 600 400" preserveAspectRatio="none" style={{ position: "absolute", left: "100px", top: "50px", width: "600px", height: "400px", overflow: "visible" }}>' +
  '<svg data-id="shape-a" data-name="Triangle" x="0" y="0" width="200" height="150" viewBox="0 0 200 150" preserveAspectRatio="none" overflow="visible"><polygon points="100,0 200,150 0,150" fill="#3b82f6" /></svg>' +
  '<svg data-id="shape-b" data-name="Triangle" x="300" y="200" width="250" height="180" viewBox="0 0 250 180" preserveAspectRatio="none" overflow="visible"><polygon points="125,0 250,180 0,180" fill="#3b82f6" /></svg>' +
  '</svg>';

const minimalNode = { styles: {} } as unknown as CanvasNode;

describe('parseChildSvgs', () => {
  it('parses each direct child <svg> with its attrs + inner content', () => {
    const inner = GROUP.slice(GROUP.indexOf('>') + 1, GROUP.lastIndexOf('</svg>'));
    const kids = parseChildSvgs(inner);
    expect(kids).toHaveLength(2);
    expect(kids[0]).toMatchObject({
      x: 0, y: 0, width: 200, height: 150,
      viewBox: '0 0 200 150', preserveAspectRatio: 'none',
      dataId: 'shape-a', dataName: 'Triangle',
    });
    expect(kids[0].inner).toBe('<polygon points="100,0 200,150 0,150" fill="#3b82f6" />');
    expect(kids[1]).toMatchObject({ x: 300, y: 200, width: 250, height: 180, dataId: 'shape-b' });
  });

  it('defaults missing x/y to 0', () => {
    const kids = parseChildSvgs('<svg data-id="c" width="10" height="10"><path d="M0,0Z"/></svg>');
    expect(kids[0]).toMatchObject({ x: 0, y: 0, width: 10, height: 10, dataId: 'c' });
  });

  it('returns [] when there are no child <svg> elements', () => {
    expect(parseChildSvgs('<polygon points="0,0 1,1 2,2" />')).toEqual([]);
  });
});

describe('ungroupSvgsInSource', () => {
  it('replaces the group with independent top-level SVGs at absolute positions', () => {
    const result = ungroupSvgsInSource(GROUP, 'vector-1', minimalNode);
    expect(result).not.toBeNull();
    const { code, resultIds } = result!;

    expect(resultIds).toEqual(['shape-a', 'shape-b']);
    // group wrapper is gone
    expect(code).not.toContain('data-id="vector-1"');
    // children lifted to absolute positions: groupOrigin (100,50) + child x/y
    expect(code).toContain('data-id="shape-a"');
    expect(code).toContain('left: "100px", top: "50px", width: "200px", height: "150px"');
    expect(code).toContain('data-id="shape-b"');
    expect(code).toContain('left: "400px", top: "250px", width: "250px", height: "180px"');
    // x/y positioning attrs dropped (top-level SVGs use CSS), viewBox kept
    expect(code).not.toMatch(/\sx="/);
    expect(code).not.toMatch(/\sy="/);
    expect(code).toContain('viewBox="0 0 200 150"');
    // inner geometry preserved verbatim
    expect(code).toContain('<polygon points="100,0 200,150 0,150" fill="#3b82f6" />');
  });

  it('scales child positions by a non-1:1 group viewBox', () => {
    // group box 600×400, viewBox 0 0 300 200 → 2× scale
    const scaled = GROUP.replace('viewBox="0 0 600 400"', 'viewBox="0 0 300 200"');
    const result = ungroupSvgsInSource(scaled, 'vector-1', minimalNode);
    expect(result).not.toBeNull();
    // shape-b: x=300 y=200 → left = 100 + 300·2 = 700, top = 50 + 200·2 = 450
    expect(result!.code).toContain('left: "700px", top: "450px", width: "500px", height: "360px"');
  });

  it('returns null for a plain SVG shape (children are not nested <svg>)', () => {
    const plain =
      '<svg data-id="tri-1" viewBox="0 0 100 100" style={{ width: "100px", height: "100px" }}>' +
      '<polygon points="50,0 100,100 0,100" /></svg>';
    expect(ungroupSvgsInSource(plain, 'tri-1', minimalNode)).toBeNull();
  });
});

describe('rotatedRefitPosition', () => {
  it('angle 0 collapses to a plain translation by (minX, minY)', () => {
    const p = rotatedRefitPosition(100, 50, 30, 20, 300, 200, 285, 190, 0);
    expect(p.left).toBeCloseTo(130);
    expect(p.top).toBeCloseTo(70);
  });

  it('90 deg with no pivot change maps a local-x child shift to a canvas-y box move', () => {
    const p = rotatedRefitPosition(0, 0, 10, 0, 50, 50, 50, 50, 90);
    expect(p.left).toBeCloseTo(0);
    expect(p.top).toBeCloseTo(10);
  });

  it('pivot move alone is compensated by (I-R)*(O_old-O_new)', () => {
    const p = rotatedRefitPosition(0, 0, 0, 0, 100, 100, 60, 60, 180);
    expect(p.left).toBeCloseTo(80);
    expect(p.top).toBeCloseTo(80);
  });

  it('parseGroupRotation reads angle + px origin, null when unrotated', () => {
    const open = '<svg style={{ transform: "rotate(33.3deg)", transformBox: "border-box", transformOrigin: "1155px 562px" }}>';
    expect(parseGroupRotation(open)).toEqual({ angleDeg: 33.3, originX: 1155, originY: 562 });
    expect(parseGroupRotation('<svg style={{ left: "0px" }}>')).toBeNull();
    expect(parseGroupRotation('<svg style={{ transform: "rotate(0deg)" }}>')).toBeNull();
  });
});

describe('normalizeGroupChildrenInSource', () => {
  it('wraps a child box around geometry that spills outside its viewBox', () => {
    // Child box 300x300, viewBox 0 0 300 300, but the polygon spills to (-100..400, -50..350).
    const src =
      '<svg data-id="grp" style={{ position: "absolute", left: "0px", top: "0px", width: "300px", height: "300px" }} viewBox="0 0 300 300">' +
      '<svg data-id="c1" x="100" y="100" width="300" height="300" viewBox="0 0 300 300">' +
      '<polygon points="-100,-50 400,-50 400,350" fill="#000" /></svg>' +
      '</svg>';
    const out = normalizeGroupChildrenInSource(src, 'grp');
    // geometry bbox = (-100,-50,500,400); scale = 300/300 = 1 → box grows to 500x400,
    // moves to x=100+(-100)=0, y=100+(-50)=50; viewBox becomes 0 0 500 400.
    const c1 = out.match(/data-id="c1"[^>]*/)![0];
    expect(c1).toContain('x="0"');
    expect(c1).toContain('y="50"');
    expect(c1).toContain('width="500"');
    expect(c1).toContain('height="400"');
    expect(c1).toContain('viewBox="0 0 500 400"');
    // geometry re-based to origin: (-100,-50)->(0,0), (400,350)->(500,400).
    expect(out).toContain('points="0,0 500,0 500,400"');
  });

  it('is a no-op when the child box already wraps its geometry', () => {
    const src =
      '<svg data-id="grp" style={{ left: "0px", top: "0px", width: "200px", height: "150px" }} viewBox="0 0 200 150">' +
      '<svg data-id="c1" x="0" y="0" width="200" height="150" viewBox="0 0 200 150">' +
      '<polygon points="100,0 200,150 0,150" fill="#000" /></svg>' +
      '</svg>';
    expect(normalizeGroupChildrenInSource(src, 'grp')).toBe(src);
  });
});

describe('normalizeGroupChildrenInSource — rotated shape child', () => {
  it('fits the UN-rotated bbox (resize convention); already-tight is a no-op', () => {
    // A rotated child whose UN-rotated geometry already fills its viewBox is the
    // post-resize state — normalize must NOT touch it (else it fights the resize
    // convention and the child explodes on the next resize).
    const src =
      '<svg data-id="grp" style={{ left: "0px", top: "0px", width: "100px", height: "100px" }} viewBox="0 0 100 100">' +
      '<svg data-id="c1" x="0" y="0" width="100" height="100" viewBox="0 0 100 100">' +
      '<polygon points="0,0 100,0 0,100" transform="rotate(90 50 50)" fill="#000" /></svg>' +
      '</svg>';
    expect(normalizeGroupChildrenInSource(src, 'grp')).toBe(src);
  });

  it('re-bases a rotated child to its un-rotated bbox + shifts the pivot (no jump)', () => {
    // Un-rotated geometry bbox (10,10,100,100) spills a 50x50 viewBox → re-fit to
    // the UN-rotated bbox, re-base geometry to origin, and move the rotate pivot
    // by (-gb.x,-gb.y) so the painted result only translates.
    const src =
      '<svg data-id="grp" style={{ left: "0px", top: "0px", width: "50px", height: "50px" }} viewBox="0 0 50 50">' +
      '<svg data-id="c1" x="0" y="0" width="50" height="50" viewBox="0 0 50 50">' +
      '<polygon points="10,10 110,10 10,110" transform="rotate(45 60 60)" fill="#000" /></svg>' +
      '</svg>';
    const out = normalizeGroupChildrenInSource(src, 'grp');
    const c1 = out.match(/data-id="c1"[^>]*/)![0];
    // gb = (10,10,100,100); sx=sy=50/50=1 → width/height 100; x=0+(10-0)=10, y=10; viewBox 0 0 100 100
    expect(c1).toContain('x="10"');
    expect(c1).toContain('y="10"');
    expect(c1).toContain('width="100"');
    expect(c1).toContain('viewBox="0 0 100 100"');
    // geometry re-based by (-10,-10): (10,10)->(0,0), (110,10)->(100,0), (10,110)->(0,100)
    expect(out).toContain('points="0,0 100,0 0,100"');
    // pivot moved by (-10,-10): rotate(45 60 60) -> rotate(45 50 50)
    expect(out).toContain('transform="rotate(45 50 50)"');
  });
});

describe('scaleGroupChildrenInSource (group resize keeps children 1:1, no shear)', () => {
  it('scales box + viewBox + geometry so a child stays 1:1', () => {
    const src =
      '<svg data-id="grp" style={{ width: "200px", height: "300px" }} viewBox="0 0 200 300">' +
      '<svg data-id="c1" x="20" y="40" width="100" height="200" viewBox="0 0 100 200">' +
      '<polygon points="0,0 100,0 0,200" fill="#000" /></svg>' +
      '</svg>';
    // vertical squish only: sx=1, sy=0.5
    const out = scaleGroupChildrenInSource(src, 'grp', 1, 0.5);
    const c1 = out.match(/data-id="c1"[^>]*/)![0];
    expect(c1).toContain('y="20"');          // 40 * 0.5
    expect(c1).toContain('height="100"');    // 200 * 0.5
    expect(c1).toContain('viewBox="0 0 100 100"'); // vb height 200*0.5 -> box stays 1:1
    expect(out).toContain('points="0,0 100,0 0,100"'); // geometry y scaled by 0.5
  });

  it('rotated child: scale applied in GROUP frame (M=R(-θ)·S·R(θ)), pivot at box centre', () => {
    const src =
      '<svg data-id="grp" style={{ width: "200px", height: "300px" }} viewBox="0 0 200 300">' +
      '<svg data-id="c1" x="0" y="0" width="100" height="200" viewBox="0 0 100 200">' +
      '<path d="M0 0 L100 0 L0 200 z" transform="rotate(30 50 100)" fill="#000" /></svg>' +
      '</svg>';
    const out = scaleGroupChildrenInSource(src, 'grp', 1, 0.5);
    const c1 = out.match(/data-id="c1"[^>]*/)![0];
    // The box is re-fit to the un-rotated bbox of the M-transformed geometry and
    // stays 1:1 (width == viewBox width), and the rotate pivot sits at its centre.
    const w = c1.match(/width="([\d.]+)"/)![1];
    const h = c1.match(/height="([\d.]+)"/)![1];
    expect(c1).toContain(`viewBox="0 0 ${w} ${h}"`);
    const piv = out.match(/transform="rotate\(30 ([\d.]+) ([\d.]+)\)"/)!;
    expect(parseFloat(piv[1])).toBeCloseTo(parseFloat(w) / 2, 2);
    expect(parseFloat(piv[2])).toBeCloseTo(parseFloat(h) / 2, 2);
  });
});

describe('live group-resize baking == commit (no mouseup snap)', () => {
  const SRC =
    '<svg data-id="grp" style={{ width: "200px", height: "300px" }} viewBox="0 0 200 300">' +
    '<svg data-id="c1" x="40" y="0" width="160" height="120" viewBox="0 0 160 120">' +
    '<polygon data-id="g1" points="0,0 160,0 0,120" transform="rotate(30 80 60)" fill="#000" /></svg>' +
    '</svg>';

  it('the live patches are byte-identical to the commit (no mouseup snap)', () => {
    const snap = snapshotGroupChildrenForResize(SRC, 'grp')!;
    expect(snap.origVbW).toBe(200);
    const patches = computeScaledChildPatches(snap, 0.5, 1);
    const p = patches[0];
    expect(p.childId).toBe('c1');
    // The committed source must contain every value the live patch produced.
    const committed = scaleGroupChildrenInSource(SRC, 'grp', 0.5, 1);
    for (const [k, v] of Object.entries(p.childAttrs)) expect(committed).toContain(`${k}="${v}"`);
    for (const [k, v] of Object.entries(p.geomAttrs)) expect(committed).toContain(`${k}="${v}"`);
  });

  it('snapshot returns null for a non-group', () => {
    expect(snapshotGroupChildrenForResize('<svg data-id="x" viewBox="0 0 10 10"><polygon points="0,0 1,1 2,2"/></svg>', 'x')).toBeNull();
  });
});

describe('rotated-child group resize reproduces the reference output', () => {
  it('matches the reference M=R(-θ)·S·R(θ) geometry + centre pivot for a real example', () => {
    // the reference's rotated child (θ=136, pivot=bbox centre) inside a group resized
    // vertically: 1100 -> 420, so sy = 420/1100 = 0.381818..., sx = 1.
    const snap = {
      origVbW: 852, origVbH: 1100,
      children: [{
        childId: 'c', x: 494.498, y: 68.119, width: 375.65, height: 425.53,
        vbx: 0, vby: 0, vbw: 375.65, vbh: 425.53,
        geomId: 'g', geomTag: 'polygon',
        geomAttrs: { points: '157.41,0 0,421.85 375.65,425.53' },
        rotate: { angle: 136, cx: 187.75, cy: 212.75 },
      }],
    };
    const [p] = computeScaledChildPatches(snap, 1, 420 / 1100);
    const pts = p.geomAttrs.points!.split(' ').map(s => s.split(',').map(Number));
    // the reference's re-based output: 0,0 / 19.85,238.28 / 284.58,356.82
    expect(pts[0][0]).toBeCloseTo(0, 0); expect(pts[0][1]).toBeCloseTo(0, 0);
    expect(pts[1][0]).toBeCloseTo(19.85, 0); expect(pts[1][1]).toBeCloseTo(238.28, 0);
    expect(pts[2][0]).toBeCloseTo(284.58, 0); expect(pts[2][1]).toBeCloseTo(356.82, 0);
    // pivot at the new bbox centre (the reference: 142.25, 178.5)
    const piv = p.geomAttrs.transform!.match(/rotate\(136 ([\d.]+) ([\d.]+)\)/)!;
    expect(parseFloat(piv[1])).toBeCloseTo(142.25, 0);
    expect(parseFloat(piv[2])).toBeCloseTo(178.5, 0);
  });
});

describe('group refit uses ROTATED painted bounds (rotated child)', () => {
  it('wraps the rotated child by its painted bbox, not its un-rotated box', () => {
    // Thin wide child (box 100x20) with the geometry rotated 90deg around its
    // centre → painted bbox is TALL (20 wide x 100 tall). The group must refit
    // to the rotated painted bounds (20x100), NOT the un-rotated box (100x20).
    const src =
      '<svg data-id="grp" style={{ position: "absolute", left: "0px", top: "0px", width: "100px", height: "20px" }} viewBox="0 0 100 20">' +
      '<svg data-id="c1" x="0" y="0" width="100" height="20" viewBox="0 0 100 20">' +
      '<polygon points="0,0 100,0 50,20" transform="rotate(90 50 10)" fill="#000" /></svg>' +
      '</svg>';
    const out = refitGroupBoundsInSource(src, 'grp');
    expect(out).toContain('viewBox="0 0 20 100"');
    expect(out).toMatch(/width: ["']20px["']/);
    expect(out).toMatch(/height: ["']100px["']/);
  });
});

describe('group refit handles a NESTED group (box in x/y/width/height attributes)', () => {
  it('grows a nested group\'s attribute box to wrap children outside it', () => {
    // Outer group contains an INNER group whose box (136x172) does NOT contain
    // its second child (at y=488, spanning to y=659). Refitting the inner group
    // must grow its ATTRIBUTE box to the union (258x659) — NOT no-op (the old
    // code read/wrote the box from `style`, which a nested group lacks).
    const src =
      '<svg data-id="outer" data-name="Group" viewBox="0 0 728 196" style={{ position: "absolute", left: "2192px", top: "2743px", width: "728px", height: "196px", overflow: "visible" }}>' +
      '<svg data-id="inner" data-name="Group" x="592" y="24" width="136" height="172" viewBox="0 0 136 172" preserveAspectRatio="none" overflow="visible" style={{ transform: "rotate(17.1deg)", transformBox: "border-box", transformOrigin: "129px 329.5px" }}>' +
      '<svg data-id="b" x="0" y="0" width="136" height="172" viewBox="0 0 136 172"><polygon points="68,0 136,172 0,172" fill="#3b82f6" /></svg>' +
      '<svg data-id="c" x="88" y="488" width="170" height="171" viewBox="0 0 170 171"><polygon points="85,0 170,171 0,171" fill="#3b82f6" /></svg>' +
      '</svg></svg>';
    const out = refitGroupBoundsInSource(src, 'inner');
    // Inner group's box grows to the union (258 wide x 659 tall), written to the
    // ATTRIBUTES + viewBox (NOT style — a nested group has no style box).
    const innerOpen = out.slice(out.indexOf('data-id="inner"'));
    const innerTag = innerOpen.slice(0, innerOpen.indexOf('>') + 1);
    expect(innerTag).toMatch(/width="258"/);
    expect(innerTag).toMatch(/height="659"/);
    expect(innerTag).toContain('viewBox="0 0 258 659"');
    // x/y unchanged — content already starts at the box origin (0,0).
    expect(innerTag).toMatch(/\sx="592"/);
    expect(innerTag).toMatch(/\sy="24"/);
    // Rotation pivot refreshed to the new content centre (258/2, 659/2).
    expect(innerTag).toContain('transformOrigin: "129px 329.5px"');
  });

  it('recursive chain: refit inner THEN outer grows BOTH levels (refitGroupChain order)', () => {
    // Outer (top-level, style box 200x200) contains ONE nested group `inner`
    // (attr box 136x172) whose child `c` sits at y=488 → content spans 258x659.
    // Refitting bottom-up (inner, then outer) — exactly what refitGroupChain
    // does — must grow the inner ATTR box AND then the outer STYLE box to wrap
    // the now-larger inner. A single-level refit would leave the outer stale.
    const src =
      '<svg data-id="outer" data-name="Group" viewBox="0 0 200 200" style={{ position: "absolute", left: "1000px", top: "1000px", width: "200px", height: "200px", overflow: "visible" }}>' +
      '<svg data-id="inner" data-name="Group" x="10" y="10" width="136" height="172" viewBox="0 0 136 172" preserveAspectRatio="none" overflow="visible">' +
      '<svg data-id="b" x="0" y="0" width="136" height="172" viewBox="0 0 136 172"><polygon points="68,0 136,172 0,172" fill="#3b82f6" /></svg>' +
      '<svg data-id="c" x="88" y="488" width="170" height="171" viewBox="0 0 170 171"><polygon points="85,0 170,171 0,171" fill="#3b82f6" /></svg>' +
      '</svg></svg>';
    // Bottom-up: inner first, then outer (refitGroupChain composes these in one tx).
    const afterInner = refitGroupBoundsInSource(src, 'inner');
    const afterOuter = refitGroupBoundsInSource(afterInner, 'outer');
    // Inner attr box grew to the union 258x659.
    const innerTag = afterOuter.slice(afterOuter.indexOf('data-id="inner"'));
    const innerOpen = innerTag.slice(0, innerTag.indexOf('>') + 1);
    expect(innerOpen).toMatch(/width="258"/);
    expect(innerOpen).toMatch(/height="659"/);
    // Outer STYLE box grew to wrap the (now 258x659) inner.
    const outerOpen = afterOuter.slice(0, afterOuter.indexOf('>') + 1);
    expect(outerOpen).toContain('viewBox="0 0 258 659"');
    expect(outerOpen).toMatch(/width: ["']258px["']/);
    expect(outerOpen).toMatch(/height: ["']659px["']/);
  });

  it('shifts a rotated nested-group child\'s transform pivot when the refit re-origins', () => {
    // Outer group's only child is a ROTATED nested group at (50,50) — refit
    // shifts every child by (-50,-50) so the union sits at the origin. The
    // child's `transform="rotate(30 100 100)"` pivot (parent-space) must shift
    // to (50,50), else its rotation orbits the stale centre.
    const src =
      '<svg data-id="outer" data-name="Group" viewBox="0 0 200 200" style={{ position: "absolute", left: "0px", top: "0px", width: "200px", height: "200px", overflow: "visible" }}>' +
      '<svg data-id="inner" data-name="Group" x="50" y="50" width="100" height="100" viewBox="0 0 100 100" transform="rotate(30 100 100)" overflow="visible">' +
      '<svg data-id="s" x="0" y="0" width="100" height="100" viewBox="0 0 100 100"><polygon points="50,0 100,100 0,100" fill="#3b82f6" /></svg>' +
      '</svg></svg>';
    const out = refitGroupBoundsInSource(src, 'outer');
    const innerOpen = out.slice(out.indexOf('data-id="inner"'));
    const innerTag = innerOpen.slice(0, innerOpen.indexOf('>') + 1);
    // Outer wraps the ROTATED extent of `inner`, so the refit re-origins by the
    // rotated AABB min (not the unrotated box). `inner`'s box keeps its size; its
    // pivot follows to the new box centre (the key invariant — no orbit).
    expect(innerTag).toMatch(/width="100"/);
    expect(innerTag).toMatch(/height="100"/);
    const nx = parseFloat(innerTag.match(/\sx="(-?[\d.]+)"/)![1]);
    const ny = parseFloat(innerTag.match(/\sy="(-?[\d.]+)"/)![1]);
    const pm = innerTag.match(/transform="rotate\(30 (-?[\d.]+) (-?[\d.]+)\)"/)!;
    expect(parseFloat(pm[1])).toBeCloseTo(nx + 50, 0);
    expect(parseFloat(pm[2])).toBeCloseTo(ny + 50, 0);
  });

  it('rotated nested group: parent box wraps the rotated PAINTED content, not the box AABB (no gap)', () => {
    // The bug: a rotated nested group's BOX has empty corners (triangles don't
    // fill it); rotating the box AABB over-reaches into those corners → the
    // parent box gets a ~50px gap on one side. The refit must rotate each leaf
    // shape INDIVIDUALLY. Outer 644-wide; the rotated inner group's leftmost
    // PAINTED point is ~x=50, so the outer should refit to ~593, not 644.
    const src =
      '<svg data-id="outer" data-name="Group" viewBox="0 0 644 419" style={{ position: "relative", width: "644px", height: "419px", overflow: "visible" }}>' +
      '<svg data-id="s8" data-name="Triangle" x="430" y="-16" width="293" height="206" viewBox="0 0 293 206"><polygon points="146.27,0 292.5,206 0,206" fill="#3b82f6" transform="rotate(32.6 146.27 103.07)" /></svg>' +
      '<svg data-id="inner" data-name="Group" x="-5" y="196" width="248" height="157" viewBox="0 0 248 157" transform="rotate(112 119 274.5)">' +
      '<svg data-id="s6" x="0" y="91" width="112" height="66" viewBox="0 0 112 66"><polygon points="56,0 112,66 0,66" fill="#3b82f6" /></svg>' +
      '<svg data-id="s7" x="154" y="0" width="94" height="86" viewBox="0 0 94 86"><polygon points="47,0 94,86 0,86" fill="#3b82f6" /></svg>' +
      '</svg></svg>';
    const out = refitGroupBoundsInSource(src, 'outer');
    const outerTag = out.slice(0, out.indexOf('>') + 1);
    const w = parseFloat(outerTag.match(/width: ["'](\d+)px["']/)![1]);
    // TIGHT to the rotated painted content (~593), NOT the loose rotated-box (~644).
    expect(w).toBeGreaterThan(560);
    expect(w).toBeLessThan(620);
  });

  it('stretch bake reproduces the flex viewBox stretch (S·R) — rotations preserved, no gap', () => {
    // Resizing a FLEX group stretches its content to fill the box (S applied in
    // the group frame). For a rotated nested group this SHEARS the content to fill
    // (no gap), unlike the plain per-frame scale (R·S, which gaps). The stretch
    // bake must reproduce it EXACTLY at 1:1: every painted point p → (p·sx, p·sy),
    // while KEEPING every rotation. Top group → rotated nested group → a plain
    // shape AND a shape with its OWN rotation (the doubly-rotated hard case).
    const src =
      '<svg data-id="top" data-name="Group" viewBox="0 0 600 400" style={{ position: "relative", width: "600px", height: "400px", overflow: "visible" }}>' +
      '<svg data-id="inner" data-name="Group" x="40" y="30" width="500" height="320" viewBox="0 0 500 320" transform="rotate(35 290 190)">' +
      '<svg data-id="a" x="20" y="10" width="200" height="150" viewBox="0 0 200 150"><polygon points="100,0 200,150 0,150" fill="#000" /></svg>' +
      '<svg data-id="b" x="260" y="120" width="180" height="160" viewBox="0 0 180 160"><polygon points="90,0 180,160 0,160" fill="#000" transform="rotate(48 90 80)" /></svg>' +
      '</svg></svg>';
    for (const [sx, sy] of [[0.5, 1], [1, 1.6], [0.67, 1.4], [2, 0.6]] as const) {
      const orig = groupContentPaintedBoundsInSource(src, 'top')!;
      const baked = stretchGroupChildrenInSource(src, 'top', sx, sy);
      const after = groupContentPaintedBoundsInSource(baked, 'top')!;
      // Painted extent == S·(original extent) — fills the scaled box, no gap.
      expect(after.minX).toBeCloseTo(orig.minX * sx, 0);
      expect(after.maxX).toBeCloseTo(orig.maxX * sx, 0);
      expect(after.minY).toBeCloseTo(orig.minY * sy, 0);
      expect(after.maxY).toBeCloseTo(orig.maxY * sy, 0);
      // The nested group keeps its rotation; the inner shape keeps its 48°.
      expect(baked).toMatch(/data-id="inner"[^>]*transform="rotate\(35 /);
      expect(baked).toMatch(/data-id="b"[\s\S]*?<polygon[^>]*transform="rotate\(48 /);
    }
  });

  it('rotated group ▸ ROTATED-leaf: outer box wraps the doubly-rotated painted content (no big gap)', () => {
    // The hard case (group ▸ rotated group ▸ rotated shape): the leaf's geometry
    // is rotated AND the nested group is rotated. Collapsing the leaf to its AABB
    // then rotating that AABB by the group's rotation over-reaches into the AABB's
    // empty corners → the outer box inflates by hundreds of px (a big one-sided
    // gap). The refit must carry ACTUAL vertices through BOTH rotations.
    // Numbers from a real debug snapshot: with the AABB bug the outer fits to
    // ~1083 wide / ~1175 tall; the true painted content is ~743 × ~910.
    const src =
      '<svg data-id="outer" data-name="Group" viewBox="0 0 1206 1175" style={{ position: "relative", width: "1206px", height: "1175px", overflow: "visible" }}>' +
      '<svg data-id="inner" data-name="Group" x="100" y="108" width="1000" height="867" viewBox="0 0 1000 867" transform="rotate(-245.8 600 541.5)">' +
      '<svg data-id="s4" x="0" y="424" width="130.567" height="218.48" viewBox="0 0 130.567 218.48"><polygon points="65.283343,0 130.566684,218.480132 0,218.480132" fill="#3b82f6" /></svg>' +
      '<svg data-id="s3" x="263" y="250" width="933" height="583" viewBox="0 0 933 583"><polygon points="466.348094,0 932.696193,582.958788 0,582.958788" fill="#3b82f6" transform="rotate(111.7 466.31 291.48)" /></svg>' +
      '</svg></svg>';
    const out = refitGroupBoundsInSource(src, 'outer');
    const outerTag = out.slice(0, out.indexOf('>') + 1);
    const w = parseFloat(outerTag.match(/width: ["'](\d+)px["']/)![1]);
    const h = parseFloat(outerTag.match(/height: ["'](\d+)px["']/)![1]);
    // TIGHT to the doubly-rotated painted content (~743 × ~910), NOT the inflated
    // AABB-of-AABB (~1083 × ~1175). The bug would put w well over 1000.
    expect(w).toBeGreaterThan(700);
    expect(w).toBeLessThan(820);
    expect(h).toBeGreaterThan(860);
    expect(h).toBeLessThan(960);
  });


  it('group-resize scaling RECURSES into a nested group child (content follows the resize)', () => {
    // Outer group with a NESTED group N (containing shape S) and a direct shape D.
    // Scaling outer's children by (2,3) must scale N's box AND recurse to scale S,
    // so the nested content follows — not just N's box while S stays put.
    const src =
      '<svg data-id="outer" data-name="Group" viewBox="0 0 200 100" style={{ position: "absolute", left: "0px", top: "0px", width: "200px", height: "100px", overflow: "visible" }}>' +
      '<svg data-id="N" data-name="Group" x="10" y="10" width="100" height="50" viewBox="0 0 100 50" overflow="visible">' +
      '<svg data-id="S" x="5" y="5" width="40" height="20" viewBox="0 0 40 20"><polygon points="20,0 40,20 0,20" fill="#3b82f6" /></svg>' +
      '</svg>' +
      '<svg data-id="D" x="150" y="10" width="30" height="30" viewBox="0 0 30 30"><polygon points="15,0 30,30 0,30" fill="#3b82f6" /></svg>' +
      '</svg>';
    const out = scaleGroupChildrenInSource(src, 'outer', 2, 3);
    const tag = (id: string) => { const s = out.slice(out.indexOf(`data-id="${id}"`)); return s.slice(0, s.indexOf('>') + 1); };
    // Nested group N's box scaled (2,3).
    expect(tag('N')).toMatch(/\sx="20"/);
    expect(tag('N')).toMatch(/\sy="30"/);
    expect(tag('N')).toMatch(/width="200"/);
    expect(tag('N')).toMatch(/height="150"/);
    expect(tag('N')).toContain('viewBox="0 0 200 150"');
    // S (inside N) ALSO scaled (2,3) — the recursion.
    expect(tag('S')).toMatch(/\sx="10"/);
    expect(tag('S')).toMatch(/\sy="15"/);
    expect(tag('S')).toMatch(/width="80"/);
    expect(tag('S')).toMatch(/height="60"/);
    // Direct shape D scaled (2,3) as before.
    expect(tag('D')).toMatch(/\sx="300"/);
    expect(tag('D')).toMatch(/width="60"/);
    expect(tag('D')).toMatch(/height="90"/);
  });

  it('refit of a ROTATED nested group (attr rotation) keeps the pivot at the box centre', () => {
    // Nested group N rotated via its `transform` ATTRIBUTE, child smaller than
    // the box → refit shrinks N. The refit must be rotation-aware (not plain
    // translation → jump) AND move the rotate pivot to the NEW box centre.
    const src =
      '<svg data-id="N" data-name="Group" x="100" y="100" width="200" height="200" viewBox="0 0 200 200" transform="rotate(30 200 200)" overflow="visible">' +
      '<svg data-id="s" x="50" y="50" width="60" height="60" viewBox="0 0 60 60"><polygon points="30,0 60,60 0,60" fill="#000" /></svg>' +
      '</svg>';
    const out = refitGroupBoundsInSource(src, 'N');
    const tag = out.slice(0, out.indexOf('>') + 1);
    expect(tag).toMatch(/width="60"/);
    expect(tag).toMatch(/height="60"/);
    const nx = parseFloat(tag.match(/\sx="(-?[\d.]+)"/)![1]);
    const ny = parseFloat(tag.match(/\sy="(-?[\d.]+)"/)![1]);
    const pm = tag.match(/transform="rotate\(30 (-?[\d.]+) (-?[\d.]+)\)"/)!;
    // Pivot == new box centre (x + 60/2, y + 60/2).
    expect(parseFloat(pm[1])).toBeCloseTo(nx + 30, 1);
    expect(parseFloat(pm[2])).toBeCloseTo(ny + 30, 1);
  });
});

import { groupSvgs } from './group-svgs';
import { projectFS, resetProjectFS } from '@/code/project/project-fs';

describe('groupSvgs — motion.svg shapes inside a component', () => {
  const COMP = `'use client';
function C({ initialVariant = 'default' }) {
  return <LayoutGroup>
    <motion.div data-id="frame-1" style={{ position: 'absolute' }}>
    <motion.svg layout={true} data-id="shape-2" data-name="Triangle" viewBox="0 0 132 95" preserveAspectRatio="none" style={{ position: 'absolute', width: '132px', height: '95px', overflow: 'visible', left: '99px', top: '70px' }}>
        <polygon points="66,0 132,95 0,95" fill="#3b82f6" stroke="#000000" stroke-width="0" />
      </motion.svg>
    <motion.svg layout={true} data-id="shape-3" data-name="Triangle" viewBox="0 0 110 60" preserveAspectRatio="none" style={{ position: 'absolute', width: '110px', height: '60px', overflow: 'visible', left: '364px', top: '67px' }}>
        <polygon points="55,0 110,60 0,60" fill="#3b82f6" stroke="#000000" stroke-width="0" />
      </motion.svg>
    </motion.div>
  </LayoutGroup>;
}`;

  it('groups two <motion.svg> shapes (was a silent no-op — extractSvgPart only matched plain <svg>)', () => {
    resetProjectFS(new Map([['app/x.tsx', COMP]]));
    const nodes = new Map<string, CanvasNode>([
      ['shape-2', { id: 'shape-2', type: 'svg', parentId: 'frame-1', styles: { left: '99px', top: '70px', width: '132px', height: '95px' } } as any],
      ['shape-3', { id: 'shape-3', type: 'svg', parentId: 'frame-1', styles: { left: '364px', top: '67px', width: '110px', height: '60px' } } as any],
    ]);
    const newId = groupSvgs(['shape-2', 'shape-3'], nodes, 'app/x.tsx');
    expect(newId).not.toBeNull();
    const out = projectFS.readFile('app/x.tsx') ?? '';
    expect(out).toContain('data-name="Group"');
    expect(out).toMatch(/<svg data-id="shape-2"[^>]*x="0" y="3"/);
    expect(out).not.toContain('<motion.svg layout');
  });
});

// ─── MOTION-AWARE refit scanning (regression, 2026-06-12) ────────────────────
// A group child can be a `<motion.svg>` wrapper (per-variant rotation wiring).
// The refit module's scanners used plain '<svg' literals: parseChildren SKIPPED
// motion children (the union shrink-wrapped the group to only the plain ones —
// "completely shrinks in all the wrong directions"), and setChildAttrsInSource
// walked back onto the plain SIBLING's tag and resized the wrong shape.
describe('motion-aware group scanning', () => {
  const MOTION_GROUP = `const shapeVariants = {
  default: { rotate: 143.1 }
};
function Card({ initialVariant = 'default' }) {
  return <svg data-id="group-1" data-name="Group" viewBox="0 0 263 146" style={{ position: 'absolute', left: '109px', top: '57px', width: '263px', height: '146px', overflow: 'visible' }}><svg data-id="shape-plain" x="0" y="0" width="77" height="66" viewBox="0 0 77 66" overflow="visible">
    <polygon points="38.5,0 77,66 0,66" fill="#3b82f6" />
  </svg><motion.svg data-id="shape-motion" variants={shapeVariants} initial={['default', initialVariant]} animate={['default', initialVariant]} x="204" y="107" width="59" height="39" viewBox="0 0 59 39" overflow="visible" style={{ transformBox: 'view-box', transformOrigin: '233.5px 126.5px' }}>
    <path data-id="shape-motion-g0" fill="#3b82f6" d="M29.5,0 L59,39 L0,39 Z" />
  </motion.svg></svg>;
}
export default Card;
`;

  it('scaleGroupChildrenInSource targets the motion child, NOT its plain sibling', () => {
    // setChildAttrsInSource is exercised through the snapshot+scale seam:
    // scale the group and check BOTH children moved (motion child included).
    const out = scaleGroupChildrenInSource(MOTION_GROUP, 'group-1', 2, 1);
    // plain sibling scaled
    expect(out).toMatch(/data-id="shape-plain"[^>]*width="154"/);
    // motion child scaled too — it was previously INVISIBLE to parseChildren
    expect(out).toMatch(/data-id="shape-motion"[^>]*x="408"/);
    expect(out).toMatch(/data-id="shape-motion"[^>]*width="118"/);
    // and its carrier origin re-pinned to the new box centre (408 + 118/2)
    expect(out).toMatch(/data-id="shape-motion"[^>]*transformOrigin: '467px 126.5px'/);
  });

  it('snapshotGroupChildrenForResize sees motion children and motion.path inners', () => {
    const snap = snapshotGroupChildrenForResize(MOTION_GROUP, 'group-1');
    expect(snap?.children.map(c => c.childId)).toEqual(['shape-plain', 'shape-motion']);
  });

  it('painted bounds include the motion child ROTATED via its default entry + carrier', () => {
    const b = groupContentPaintedBoundsInSource(MOTION_GROUP, 'group-1');
    // Triangle vertices (29.5,0)(59,39)(0,39)+offset(204,107), rotated 143.1°
    // about the carrier (233.5, 126.5) — hand-computed rotated vertices:
    // (245.2, 142.1), (198.2, 128.6), (245.38, 93.2). WITHOUT the motion
    // fallback these came out un-rotated (maxX 263, minY 107).
    expect(b).not.toBeNull();
    expect(b!.maxX).toBeCloseTo(245.38, 1);
    expect(b!.maxY).toBeCloseTo(142.1, 1); // sibling tops out at 66 — this is the rotated child
  });

  it('canvas-node channel: style rotate + carrier rotates the painted bounds too', () => {
    const CANVAS_GROUP = `const canvasNodes = <>
  <svg data-id="group-2" viewBox="0 0 414 120" style={{ position: "absolute", left: "307px", top: "251px", width: "414px", height: "120px", overflow: "visible" }}><svg data-id="c-plain" x="0" y="0" width="108" height="78" viewBox="0 0 108 78" overflow="visible">
    <polygon points="54,0 108,78 0,78" fill="#3b82f6" />
  </svg><svg data-id="c-rot" x="369" y="60" width="45" height="60" viewBox="0 0 114 85" overflow="visible" style={{ transformBox: 'view-box', transformOrigin: '391.5px 90px', rotate: '141.6' }}>
    <path data-id="c-rot-g0" fill="#3b82f6" d="M57,0 L114,85 L0,85 Z" />
  </svg></svg>
</>;
`;
    const b = groupContentPaintedBoundsInSource(CANVAS_GROUP, 'group-2');
    // Triangle scaled into the 45×60 box at (369,60), rotated 141.6° about
    // the carrier (391.5, 90): rotated vertices (410.1, 113.5), (355.2, 80.5),
    // (390.5, 52.5). Un-rotated the maxY would be 120 / minY 60.
    expect(b).not.toBeNull();
    expect(b!.maxX).toBeCloseTo(410.1, 0);
    expect(b!.maxY).toBeCloseTo(113.5, 0); // sibling tops out at 78 — this is the rotated child
  });
});
