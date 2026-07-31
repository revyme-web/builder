// Tests for normalizeShapeWrapperViewBoxInCode — zero-origin viewBox
// normalization for the per-variant rotation carrier (transform-box: fill-box
// is only deterministic on a zero-origin viewBox; see the CeSuGa orbit bug).
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn(), dom: vi.fn() },
}));

import { normalizeShapeWrapperViewBoxInCode } from './generator-attrs';

// The EXACT live shape that orbited: pen-tool path wrapper with a shifted
// viewBox origin (650, 386), rotated per-variant via the fill-box carrier.
const PATH_WRAPPER_FIXTURE = `import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';

const pathMqa2sv924Variants = {
  default: { x: 0, y: 0, rotate: 0 },
  'variant-1': { x: -166, y: 67, rotate: 35.8 }
};

function CeSuGa({ style, initialVariant = 'default' }) {
  return <LayoutGroup>
    <motion.svg data-id="path-mqa2sv92-4" variants={pathMqa2sv924Variants} initial={initialVariant} data-name="Path" x="377" y="63" width="233" height="196" viewBox="650 386 233 196" preserveAspectRatio="none" overflow="visible" style={{ transformBox: "fill-box", transformOrigin: "50% 50%" }}>
      <path data-id="path-mqa2sv92-4-g0" d="M677 515L682.1074877560537 387.51895906428024L811.7269318712268 386.42369635510113C811.7269318712268 386.42369635510113 884.1701007372997 482.5886526785175 883.5022576219466 489.066730897443C883.5022576219466 489.066730897443 811.3930103135503 582.115086015878 798.156359767251 582.9075931794305C798.156359767251 582.9075931794305 653.6173004550889 580.3742416285243 650.3092508903729 580.7037108987652z" fill="none" stroke="#c12525" strokeWidth="15"></path>
    </motion.svg>
  </LayoutGroup>;
}
export default CeSuGa;
`;

describe('normalizeShapeWrapperViewBoxInCode', () => {
  it('shifts the geometry and zeroes the viewBox origin (CeSuGa live fixture)', () => {
    const out = normalizeShapeWrapperViewBoxInCode(PATH_WRAPPER_FIXTURE, 'path-mqa2sv92-4');
    expect(out).toContain('viewBox="0 0 233 196"');
    // First point: M677 515 → M27 129 (shift by −650, −386).
    expect(out).toMatch(/d="M 27 129/);
    // No coordinate should remain in the old 600+ range on the x axis start.
    expect(out).not.toContain('M677');
    // Wrapper box attrs (group-space) are untouched.
    expect(out).toContain('x="377"');
    expect(out).toContain('y="63"');
    expect(out).toContain('width="233"');
    // Variant entries (deltas + rotate) are untouched.
    expect(out).toContain('rotate: 35.8');
    expect(out).toContain('x: -166');
  });

  it('round-trips the painting: shifted d + zero origin = same painted coords', () => {
    const out = normalizeShapeWrapperViewBoxInCode(PATH_WRAPPER_FIXTURE, 'path-mqa2sv92-4');
    // Painted position of a content point = (coord − viewBoxOrigin) — invariant.
    // Old: 677 − 650 = 27. New: 27 − 0 = 27. (Whitespace-anchored match — a bare
    // /d="/ matches inside data-id="…", the substring trap from the lessons.)
    const d = out.match(/\sd="([^"]+)"/)?.[1] ?? '';
    expect(d.startsWith('M 27 129')).toBe(true);
    // Last command's z is preserved (lowercase z passes through).
    expect(d.trim().endsWith('z')).toBe(true);
  });

  it('is a no-op on zero-origin wrappers', () => {
    const code = PATH_WRAPPER_FIXTURE.replace('viewBox="650 386 233 196"', 'viewBox="0 0 233 196"');
    expect(normalizeShapeWrapperViewBoxInCode(code, 'path-mqa2sv92-4')).toBe(code);
  });

  it('bails on groups (nested <svg> children)', () => {
    const code = PATH_WRAPPER_FIXTURE.replace(
      '<path data-id="path-mqa2sv92-4-g0"',
      '<svg data-id="nested-vp" viewBox="0 0 10 10"><rect x="1" y="1" width="2" height="2" /></svg><path data-id="path-mqa2sv92-4-g0"',
    );
    expect(normalizeShapeWrapperViewBoxInCode(code, 'path-mqa2sv92-4')).toBe(code);
  });

  it('shifts per-tile variant d overrides (raw and CSS path() forms) in the same units', () => {
    const code = `import React from 'react';
import { motion } from 'framer-motion';
const innerVariants = {
  default: {},
  'variant-1': { d: 'M660 390L670 400z' },
  'variant-2': { d: "path('M 660 390 L 670 400 z')" },
};
function X({ initialVariant = 'default' }) {
  return <motion.svg data-id="w-1" x="0" y="0" width="100" height="100" viewBox="650 386 100 100">
    <motion.path data-id="w-1-g0" variants={innerVariants} initial={initialVariant} d="M650 386L750 486z" />
  </motion.svg>;
}
export default X;
`;
    const out = normalizeShapeWrapperViewBoxInCode(code, 'w-1');
    expect(out).toContain('viewBox="0 0 100 100"');
    expect(out).toMatch(/d="M 0 0 L 100 100 z"/);
    // Quote style is babel's choice — match quote-agnostically.
    expect(out).toMatch(/d: ["']M 10 4 L 20 14 z["']/);
    expect(out).toContain(`path('M 10 4 L 20 14 z')`);
  });

  it('shifts inner rotate-attr pivots (primary rotation storage)', () => {
    const code = `import React from 'react';
function X() {
  return <svg data-id="w-2" x="5" y="5" width="100" height="100" viewBox="650 386 100 100">
    <path data-id="w-2-g0" transform="rotate(30 700 436)" d="M650 386L750 486z" />
  </svg>;
}
export default X;
`;
    const out = normalizeShapeWrapperViewBoxInCode(code, 'w-2');
    expect(out).toContain('transform="rotate(30 50 50)"');
  });

  it('shifts polygon points and circle centers', () => {
    const code = `import React from 'react';
function X() {
  return <svg data-id="w-3" width="100" height="100" viewBox="10 20 100 100">
    <polygon data-id="w-3-g0" points="10,20 110,20 60,120" />
    <circle data-id="w-3-g1" cx="60" cy="70" r="5" />
  </svg>;
}
export default X;
`;
    const out = normalizeShapeWrapperViewBoxInCode(code, 'w-3');
    expect(out).toContain('points="0,0 100,0 50,100"');
    expect(out).toContain('cx="50"');
    expect(out).toContain('cy="50"');
    expect(out).toContain('viewBox="0 0 100 100"');
  });
});
