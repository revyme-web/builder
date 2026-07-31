// Tests for the foreign-SVG → native-editable-shapes transpiler.
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), dom: vi.fn(), error: vi.fn() },
}));

import {
  convertSvgToEditableShapes,
  normalizePathD,
  arcToCubics,
  parseTransformList,
} from './svg-import';

const OPTS = { iconId: 'icon-1', displayName: 'Test Icon', cardW: 240, cardH: 240 };

describe('arcToCubics', () => {
  it('approximates a quarter circle within tolerance', () => {
    // Quarter of a circle r=10 centered at (0,0): (10,0) → (0,10), sweep 1.
    const segs = arcToCubics(10, 0, 10, 10, 0, 0, 1, 0, 10);
    expect(segs).toHaveLength(1);
    const [c1x, c1y, c2x, c2y, ex, ey] = segs[0];
    expect(ex).toBeCloseTo(0, 6);
    expect(ey).toBeCloseTo(10, 6);
    // Sample the cubic midpoint — must sit on the circle (|p| ≈ 10).
    const mid = (a: number, b: number, c: number, d: number) =>
      0.125 * a + 0.375 * b + 0.375 * c + 0.125 * d;
    const mx = mid(10, c1x, c2x, ex);
    const my = mid(0, c1y, c2y, ey);
    expect(Math.hypot(mx, my)).toBeCloseTo(10, 1);
  });

  it('splits large arcs into ≤90° segments', () => {
    // Full half circle (180°) → 2 segments.
    const segs = arcToCubics(10, 0, 10, 10, 0, 0, 1, -10, 0);
    expect(segs).toHaveLength(2);
    expect(segs[1][4]).toBeCloseTo(-10, 6);
    expect(segs[1][5]).toBeCloseTo(0, 6);
  });
});

describe('normalizePathD', () => {
  it('expands H/V/relative commands to absolute L', () => {
    const cmds = normalizePathD('M10 10h20v5l-5 5z');
    expect(cmds).toEqual([
      ['M', 10, 10],
      ['L', 30, 10],
      ['L', 30, 15],
      ['L', 25, 20],
      ['Z'],
    ]);
  });

  it('converts Q to cubic and resolves S semantics', () => {
    const cmds = normalizePathD('M0 0Q10 0 10 10S20 30 30 30');
    expect(cmds[1][0]).toBe('C');
    expect(cmds[2][0]).toBe('C');
    // Per spec, S after a NON-cubic command starts its first control point at
    // the current point (reflection only applies after C/S) — c1 = (10,10).
    const s = cmds[2] as [string, ...number[]];
    expect(s[1]).toBeCloseTo(10, 3);
    expect(s[2]).toBeCloseTo(10, 3);
    // …and a true C→S reflection: c1 = 2·cur − prev c2.
    const refl = normalizePathD('M0 0C0 10 10 10 10 0S30 -10 30 0');
    const s2 = refl[2] as [string, ...number[]];
    expect(s2[1]).toBeCloseTo(10, 3);  // 2·10 − 10
    expect(s2[2]).toBeCloseTo(-10, 3); // 2·0 − 10
  });

  it('converts arcs to cubics', () => {
    const cmds = normalizePathD('M8 48a40 40 0 1 0 80 0');
    expect(cmds.every(c => c[0] === 'M' || c[0] === 'C')).toBe(true);
    const last = cmds[cmds.length - 1];
    expect(last[last.length - 2]).toBeCloseTo(88, 3);
    expect(last[last.length - 1]).toBeCloseTo(48, 3);
  });
});

describe('parseTransformList', () => {
  it('composes translate/rotate/scale', () => {
    const m = parseTransformList('translate(10 20) scale(2)');
    expect(m).toEqual([2, 0, 0, 2, 10, 20]);
    const r = parseTransformList('rotate(90 10 10)');
    // (10,0) rotated 90° about (10,10) → (20,10)
    const x = r[0] * 10 + r[2] * 0 + r[4];
    const y = r[1] * 10 + r[3] * 0 + r[5];
    expect(x).toBeCloseTo(20, 6);
    expect(y).toBeCloseTo(10, 6);
  });
});

describe('convertSvgToEditableShapes', () => {
  it('emits a single native shape wrapper with 1:1 viewBox and no transforms', () => {
    const res = convertSvgToEditableShapes(
      '<svg viewBox="0 0 24 24"><path d="M2 2L22 2L22 22L2 22Z" fill="#ff0000"/></svg>', OPTS);
    expect(res).not.toBeNull();
    expect(res!.shapeCount).toBe(1);
    // Scaled ×10 into the 240 card: bbox 20..220.
    expect(res!.jsx).toContain('viewBox="0 0 200 200"');
    expect(res!.jsx).toContain('left: "20px", top: "20px", width: "200px", height: "200px"');
    expect(res!.jsx).toContain('preserveAspectRatio="none"');
    expect(res!.jsx).toContain('fill="#ff0000"');
    expect(res!.jsx).not.toContain('transform');
    expect(res!.jsx).not.toContain('data-graphic');
    // Geometry shifted to a 0,0 origin.
    expect(res!.jsx).toContain('d="M0 0L200 0L200 200L0 0Z"'.replace('L200 200L0 0Z', 'L200 200L0 200Z'));
  });

  it('bakes rotate transforms into coordinates', () => {
    const res = convertSvgToEditableShapes(
      '<svg viewBox="0 0 96 96"><rect x="40" y="8" width="16" height="16" transform="rotate(90 48 48)"/></svg>', OPTS);
    expect(res).not.toBeNull();
    expect(res!.jsx).not.toContain('transform');
    // rect (40..56, 8..24) rotated 90° about (48,48) → x 72..112? No: (x,y)→(48-(y-48), 48+(x-48))
    // corners: (40,8)→(88,40), (56,24)→(72,56) ⇒ bbox 72..88 × 40..56, ×2.5 = 180..220 × 100..140
    expect(res!.jsx).toContain('left: "180px", top: "100px", width: "40px", height: "40px"');
  });

  it('converts primitives — rounded rect corners become cubics', () => {
    const res = convertSvgToEditableShapes(
      '<svg viewBox="0 0 96 96"><rect x="10" y="40" width="76" height="16" rx="8"/><circle cx="48" cy="20" r="10"/></svg>', OPTS);
    expect(res).not.toBeNull();
    expect(res!.shapeCount).toBe(2);
    const cCount = (res!.jsx.match(/C/g) ?? []).length;
    expect(cCount).toBeGreaterThanOrEqual(8); // 4 corners + 4 circle segments
    expect(res!.jsx).not.toContain('<rect');
    expect(res!.jsx).not.toContain('<circle');
  });

  it('turns <g> structure into editor groups — nested svg children with x/y', () => {
    const res = convertSvgToEditableShapes(
      `<svg viewBox="0 0 96 96">
        <g fill="#D92D20">
          <path d="M10 10L30 10L30 30L10 30Z"/>
          <g>
            <path d="M60 10L80 10L80 30Z"/>
            <path d="M60 60L80 60L80 80Z"/>
          </g>
        </g>
      </svg>`, OPTS);
    expect(res).not.toBeNull();
    expect(res!.shapeCount).toBe(3);
    expect(res!.groupCount).toBe(2);
    // Outer wrapper is a style-positioned group; children are x/y-attr svgs.
    const outer = res!.jsx.slice(0, res!.jsx.indexOf('>') + 1);
    expect(outer).toContain('style={{ position: "absolute"');
    expect(res!.jsx).toContain(' x="');
    expect(res!.jsx).toContain(' y="');
    // Inherited fill lands on every leaf path.
    expect((res!.jsx.match(/fill="#D92D20"/g) ?? []).length).toBe(3);
    // 5 wrappers total: root group + top shape + inner group + its 2 shapes.
    expect((res!.jsx.match(/<svg /g) ?? []).length).toBe(5);
    // Exactly ONE is style-positioned (the root); nested ones use x/y attrs.
    expect((res!.jsx.match(/style=\{\{/g) ?? []).length).toBe(1);
  });

  it('resolves presentation: currentColor pinned, stroke-width scaled, evenodd kept', () => {
    const res = convertSvgToEditableShapes(
      '<svg viewBox="0 0 24 24"><path d="M2 2L22 22" stroke="currentColor" stroke-width="2" fill="none" fill-rule="evenodd" stroke-linecap="round"/></svg>', OPTS);
    expect(res).not.toBeNull();
    expect(res!.jsx).toContain('stroke="#000000"');
    expect(res!.jsx).toContain('stroke-width="20"'); // ×10 scale into 240 card
    expect(res!.jsx).toContain('fill="none"');
    expect(res!.jsx).toContain('fill-rule="evenodd"');
    expect(res!.jsx).toContain('stroke-linecap="round"');
  });

  it('inlines plain-class <style> rules before converting', () => {
    const res = convertSvgToEditableShapes(
      '<svg viewBox="0 0 24 24"><style>.a{fill:#00ff00}</style><path class="a" d="M2 2L22 2L12 22Z"/></svg>', OPTS);
    expect(res).not.toBeNull();
    expect(res!.jsx).toContain('fill="#00ff00"');
  });

  it('falls back (null) on masks, gradients, clip-path attrs, use, and text', () => {
    const bail = (svg: string) => expect(convertSvgToEditableShapes(svg, OPTS)).toBeNull();
    bail('<svg viewBox="0 0 24 24"><mask id="m"><rect/></mask><path d="M0 0L2 2" mask="url(#m)"/></svg>');
    bail('<svg viewBox="0 0 24 24"><linearGradient id="g"/><path d="M0 0L2 2" fill="url(#g)"/></svg>');
    bail('<svg viewBox="0 0 24 24"><clipPath id="c"><circle r="4"/></clipPath><g clip-path="url(#c)"><path d="M0 0L2 2"/></g></svg>');
    bail('<svg viewBox="0 0 24 24"><defs><path id="p" d="M0 0L2 2"/></defs><use href="#p"/></svg>');
    bail('<svg viewBox="0 0 24 24"><text x="2" y="12">hi</text></svg>');
  });

  it('centers content when the card aspect differs from the source', () => {
    // Source 100×50 → card forced square 240×240 → scale 2.4, y offset 60.
    const res = convertSvgToEditableShapes(
      '<svg viewBox="0 0 100 50"><rect x="0" y="0" width="100" height="50"/></svg>',
      { ...OPTS, cardW: 240, cardH: 240 });
    expect(res).not.toBeNull();
    expect(res!.jsx).toContain('left: "0px", top: "60px", width: "240px", height: "120px"');
  });
});
