// svg-gen.test.ts — Tests for SVG child operations and multi-shape attr updates.

import { describe, test, expect } from 'vitest';
import {
  updateSvgAttrsInCode,
  addSvgChildInCode,
  removeSvgChildInCode,
  replaceSvgInnerInCode,
} from './generator-attrs';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SVG_SINGLE_CHILD = `export default function Page() {
return (
  <div data-id="root" style={{position: 'relative'}}>
    <svg data-id="shape1" viewBox="0 0 100 100" style={{width: '100px', height: '100px'}}>
      <path d="M0,0 L100,0 L100,100 Z" fill="red" />
    </svg>
  </div>
);
}`;

const SVG_MULTI_CHILD = `export default function Page() {
return (
  <div data-id="root" style={{position: 'relative'}}>
    <svg data-id="multi" viewBox="0 0 200 200" style={{width: '200px', height: '200px'}}>
      <circle cx="50" cy="50" r="30" fill="blue" />
      <rect x="100" y="100" width="50" height="50" fill="green" />
      <line x1="0" y1="0" x2="200" y2="200" stroke="black" />
    </svg>
  </div>
);
}`;

const SVG_WITH_DEFS = `export default function Page() {
return (
  <div data-id="root" style={{position: 'relative'}}>
    <svg data-id="defs-svg" viewBox="0 0 100 100">
      <defs>
        <linearGradient id="grad1" />
      </defs>
      <circle cx="50" cy="50" r="40" fill="url(#grad1)" />
      <rect x="10" y="10" width="20" height="20" fill="red" />
    </svg>
  </div>
);
}`;

const SVG_SELF_CLOSING = `export default function Page() {
return (
  <div data-id="root" style={{position: 'relative'}}>
    <svg data-id="empty-svg" viewBox="0 0 100 100" style={{width: '100px'}} />
  </div>
);
}`;

// ─── updateSvgAttrsInCode ─────────────────────────────────────────────────────

describe('updateSvgAttrsInCode — single shape', () => {
  test('updates existing attribute on the first (only) child', () => {
    const result = updateSvgAttrsInCode(SVG_SINGLE_CHILD, 'shape1', { fill: 'blue' });
    expect(result).toContain('fill="blue"');
    expect(result).not.toContain('fill="red"');
  });

  test('updates d attribute', () => {
    const result = updateSvgAttrsInCode(SVG_SINGLE_CHILD, 'shape1', { d: 'M0,0 L50,50 Z' });
    expect(result).toContain('d="M0,0 L50,50 Z"');
  });

  test('writing d on a STAMPED child does not corrupt its data-id (the `d` in `-id`)', () => {
    // Regression: the update regex `(d=)"…"` matched the `d=` inside `data-id="…"`
    // when data-id preceded d (stamped children), overwriting the node id with the
    // path → x10 geometry / viewBox-doubling cascade.
    const code = `<svg data-id="w-1"><path data-id="w-1-g0" d="M0,0 L1,1" fill="#000" /></svg>`;
    const result = updateSvgAttrsInCode(code, 'w-1', { d: 'M9,9 L8,8' }, 0);
    expect(result).toContain('data-id="w-1-g0"');
    expect(result).toContain('d="M9,9 L8,8"');
    expect(result).not.toContain('data-id="M9,9');
  });

  test('adds new attribute', () => {
    const result = updateSvgAttrsInCode(SVG_SINGLE_CHILD, 'shape1', { stroke: 'black' });
    expect(result).toContain('stroke="black"');
  });

  test('removes attribute with empty string value', () => {
    const result = updateSvgAttrsInCode(SVG_SINGLE_CHILD, 'shape1', { fill: '' });
    // The fill attribute should be removed
    expect(result).not.toMatch(/fill="[^"]*"/);
    // But d should still exist
    expect(result).toContain('d="M0,0 L100,0 L100,100 Z"');
  });

  test('no-op for non-existent node', () => {
    const result = updateSvgAttrsInCode(SVG_SINGLE_CHILD, 'nonexistent', { fill: 'blue' });
    expect(result).toContain('fill="red"');
  });
});

describe('updateSvgAttrsInCode — childIndex targeting', () => {
  test('childIndex=0 targets first shape child', () => {
    const result = updateSvgAttrsInCode(SVG_MULTI_CHILD, 'multi', { fill: 'yellow' }, 0);
    // First child (circle) should be updated
    expect(result).toContain('fill="yellow"');
    // Second child (rect) should remain green
    expect(result).toContain('fill="green"');
  });

  test('childIndex=1 targets second shape child', () => {
    const result = updateSvgAttrsInCode(SVG_MULTI_CHILD, 'multi', { fill: 'yellow' }, 1);
    // First child (circle) should remain blue
    expect(result).toContain('fill="blue"');
    // Second child (rect) should be updated
    expect(result).toContain('fill="yellow"');
    // Third child (line) should remain
    expect(result).toContain('stroke="black"');
  });

  test('childIndex=2 targets third shape child', () => {
    const result = updateSvgAttrsInCode(SVG_MULTI_CHILD, 'multi', { stroke: 'red' }, 2);
    // Third child (line) should be updated
    expect(result).toContain('stroke="red"');
    // First two should be unchanged
    expect(result).toContain('fill="blue"');
    expect(result).toContain('fill="green"');
  });

  test('out-of-range childIndex is a no-op', () => {
    const result = updateSvgAttrsInCode(SVG_MULTI_CHILD, 'multi', { fill: 'pink' }, 99);
    // Nothing should change
    expect(result).toContain('fill="blue"');
    expect(result).toContain('fill="green"');
  });
});

describe('updateSvgAttrsInCode — skips non-shape children', () => {
  test('childIndex counts only shape tags, skipping defs', () => {
    // childIndex=0 should target the circle (first shape), not <defs>
    const result = updateSvgAttrsInCode(SVG_WITH_DEFS, 'defs-svg', { fill: 'orange' }, 0);
    expect(result).toContain('fill="orange"');
    // defs should be preserved
    expect(result).toContain('<defs>');
    expect(result).toContain('linearGradient');
  });

  test('childIndex=1 targets second shape after defs', () => {
    const result = updateSvgAttrsInCode(SVG_WITH_DEFS, 'defs-svg', { fill: 'purple' }, 1);
    // rect (second shape) should be updated
    expect(result).toContain('fill="purple"');
    // circle (first shape) should still have url(#grad1)
    expect(result).toContain('url(#grad1)');
  });
});

// ─── addSvgChildInCode ────────────────────────────────────────────────────────

describe('addSvgChildInCode', () => {
  test('adds child to existing SVG with children', () => {
    const childJSX = '<line x1="0" y1="0" x2="50" y2="50" stroke="red" />';
    const result = addSvgChildInCode(SVG_SINGLE_CHILD, 'shape1', childJSX);
    expect(result).toContain('x1="0"');
    expect(result).toContain('x2="50"');
    expect(result).toContain('stroke="red"');
    // Original child should still exist
    expect(result).toContain('d="M0,0 L100,0 L100,100 Z"');
  });

  test('converts self-closing SVG to open/close when adding child', () => {
    const childJSX = '<circle cx="50" cy="50" r="20" fill="blue" />';
    const result = addSvgChildInCode(SVG_SELF_CLOSING, 'empty-svg', childJSX);
    expect(result).toContain('cx="50"');
    expect(result).toContain('</svg>');
    // Should no longer be self-closing
    expect(result).not.toMatch(/viewBox="0 0 100 100"[^>]*\/>/);
  });

  test('no-op for non-existent node', () => {
    const childJSX = '<rect x="0" y="0" width="10" height="10" />';
    const result = addSvgChildInCode(SVG_SINGLE_CHILD, 'nonexistent', childJSX);
    expect(result).toBe(SVG_SINGLE_CHILD);
  });

  test('adds to multi-child SVG', () => {
    const childJSX = '<ellipse cx="150" cy="150" rx="20" ry="10" fill="pink" />';
    const result = addSvgChildInCode(SVG_MULTI_CHILD, 'multi', childJSX);
    expect(result).toContain('fill="pink"');
    // All original children should still exist
    expect(result).toContain('fill="blue"');
    expect(result).toContain('fill="green"');
    expect(result).toContain('stroke="black"');
  });
});

// ─── removeSvgChildInCode ─────────────────────────────────────────────────────

describe('removeSvgChildInCode', () => {
  test('removes first shape child (index 0)', () => {
    const result = removeSvgChildInCode(SVG_MULTI_CHILD, 'multi', 0);
    // circle (first shape) should be removed
    expect(result).not.toContain('cx="50"');
    expect(result).not.toContain('cy="50"');
    // rect and line should remain
    expect(result).toContain('x="100"');
    expect(result).toContain('x1="0"');
  });

  test('removes second shape child (index 1)', () => {
    const result = removeSvgChildInCode(SVG_MULTI_CHILD, 'multi', 1);
    // rect (second shape) should be removed
    expect(result).not.toContain('width="50"');
    expect(result).not.toContain('height="50"');
    // circle and line should remain
    expect(result).toContain('cx="50"');
    expect(result).toContain('x1="0"');
  });

  test('removes third shape child (index 2)', () => {
    const result = removeSvgChildInCode(SVG_MULTI_CHILD, 'multi', 2);
    // line (third shape) should be removed
    expect(result).not.toContain('x1="0"');
    expect(result).not.toContain('x2="200"');
    // circle and rect should remain
    expect(result).toContain('cx="50"');
    expect(result).toContain('x="100"');
  });

  test('out-of-range childIndex is a no-op', () => {
    const result = removeSvgChildInCode(SVG_MULTI_CHILD, 'multi', 99);
    // Everything should still be there
    expect(result).toContain('cx="50"');
    expect(result).toContain('x="100"');
    expect(result).toContain('x1="0"');
  });

  test('skips non-shape children when counting', () => {
    // childIndex=0 should remove circle (first shape), not <defs>
    const result = removeSvgChildInCode(SVG_WITH_DEFS, 'defs-svg', 0);
    // circle should be removed
    expect(result).not.toContain('r="40"');
    // defs should be preserved
    expect(result).toContain('<defs>');
    expect(result).toContain('linearGradient');
    // rect should remain
    expect(result).toContain('x="10"');
  });

  test('no-op for non-existent node', () => {
    const result = removeSvgChildInCode(SVG_MULTI_CHILD, 'nonexistent', 0);
    expect(result).toContain('cx="50"');
    expect(result).toContain('x="100"');
  });

  test('removes the last remaining shape child (single child SVG)', () => {
    const result = removeSvgChildInCode(SVG_SINGLE_CHILD, 'shape1', 0);
    // The path child should be removed
    expect(result).not.toContain('d="M0,0 L100,0 L100,100 Z"');
    // The SVG wrapper should still exist
    expect(result).toContain('data-id="shape1"');
  });

  test('removes all children one by one (middle first, then edges)', () => {
    // Remove middle child (index 1 = rect)
    const step1 = removeSvgChildInCode(SVG_MULTI_CHILD, 'multi', 1);
    expect(step1).not.toContain('width="50"');
    expect(step1).toContain('cx="50"');
    expect(step1).toContain('x1="0"');

    // Remove new index 1 (was line, now at index 1 after rect was removed)
    const step2 = removeSvgChildInCode(step1, 'multi', 1);
    expect(step2).not.toContain('x1="0"');
    expect(step2).toContain('cx="50"');

    // Remove last remaining (circle at index 0)
    const step3 = removeSvgChildInCode(step2, 'multi', 0);
    expect(step3).not.toContain('cx="50"');
    expect(step3).toContain('data-id="multi"');
  });
});

// ─── addSvgChildInCode — additional edge cases ──────────────────────────────

describe('addSvgChildInCode — additional formats', () => {
  test('adds child with style attribute (JSX curly braces)', () => {
    const childJSX = '<path d="M0,0 L50,50" stroke="red" fill="none" />';
    const result = addSvgChildInCode(SVG_SINGLE_CHILD, 'shape1', childJSX);
    expect(result).toContain('stroke="red"');
    expect(result).toContain('fill="none"');
    // Original path child should still exist
    expect(result).toContain('d="M0,0 L100,0 L100,100 Z"');
  });

  test('adds polygon child', () => {
    const childJSX = '<polygon points="50,0 100,100 0,100" fill="yellow" />';
    const result = addSvgChildInCode(SVG_MULTI_CHILD, 'multi', childJSX);
    expect(result).toContain('points="50,0 100,100 0,100"');
    // All original children should remain
    expect(result).toContain('fill="blue"');
    expect(result).toContain('fill="green"');
    expect(result).toContain('stroke="black"');
  });

  test('adds child to SVG with defs (preserves defs)', () => {
    const childJSX = '<line x1="0" y1="0" x2="100" y2="100" stroke="purple" />';
    const result = addSvgChildInCode(SVG_WITH_DEFS, 'defs-svg', childJSX);
    expect(result).toContain('stroke="purple"');
    // defs should be preserved
    expect(result).toContain('<defs>');
    expect(result).toContain('linearGradient');
  });
});

// ─── updateSvgAttrsInCode — additional edge cases ────────────────────────────

describe('updateSvgAttrsInCode — multi-attribute updates', () => {
  test('updates multiple attributes at once on same child', () => {
    const result = updateSvgAttrsInCode(SVG_MULTI_CHILD, 'multi', { cx: '75', cy: '75', r: '40' }, 0);
    expect(result).toContain('cx="75"');
    expect(result).toContain('cy="75"');
    expect(result).toContain('r="40"');
    // Other children should be unchanged
    expect(result).toContain('fill="green"');
  });

  test('updates d attribute on specific childIndex in multi-child SVG', () => {
    // SVG_SINGLE_CHILD has one path child — update it with childIndex=0
    const result = updateSvgAttrsInCode(SVG_SINGLE_CHILD, 'shape1', { d: 'M0,0 L50,0 L50,50 Z' }, 0);
    expect(result).toContain('d="M0,0 L50,0 L50,50 Z"');
    expect(result).not.toContain('d="M0,0 L100,0 L100,100 Z"');
  });
});

// ─── replaceSvgInnerInCode — used by the src/svg-editor/ round-trip ──────────

describe('replaceSvgInnerInCode', () => {
  test('replaces inner JSX of an open SVG', () => {
    const result = replaceSvgInnerInCode(
      SVG_SINGLE_CHILD,
      'shape1',
      '<path d="M10,10 L90,90" fill="blue" />',
    );
    expect(result).toContain('d="M10,10 L90,90"');
    expect(result).toContain('fill="blue"');
    expect(result).not.toContain('M0,0 L100,0 L100,100 Z');
  });

  // Regression: a framer-motion-wrapped shape closes with `</motion.svg>`, not
  // `</svg>`. Hardcoding `</svg>` made the geometry replace silently fail
  // (no-closing-tag) so a reshape reverted the path while the viewBox updated →
  // the shape offset on commit (icon-set / vector-set motion shapes).
  test('replaces inner JSX of a motion.svg (framer-motion shape)', () => {
    const motionSvg = `const x = <motion.svg layout={true} data-id="ell" viewBox="70 0 95 126" style={{}}>
      <ellipse cx="50%" cy="50%" rx="50%" ry="50%" fill="#3b82f6" />
    </motion.svg>;`;
    const result = replaceSvgInnerInCode(motionSvg, 'ell', '<path d="M5,5 L9,9" fill="red" />');
    expect(result).toContain('d="M5,5 L9,9"');
    expect(result).not.toContain('<ellipse');
    // Outer wrapper tag untouched (still motion.svg, closing intact).
    expect(result).toContain('<motion.svg');
    expect(result).toContain('</motion.svg>');
  });

  test('converts kebab-case SVG attrs to camelCase', () => {
    const result = replaceSvgInnerInCode(
      SVG_SINGLE_CHILD,
      'shape1',
      '<path d="M0,0 L10,10" stroke="red" stroke-width="2" stroke-linecap="round" fill-opacity="0.5" />',
    );
    expect(result).toContain('strokeWidth="2"');
    expect(result).toContain('strokeLinecap="round"');
    expect(result).toContain('fillOpacity="0.5"');
    // Should NOT contain kebab forms (JSX rejects those)
    expect(result).not.toContain('stroke-width=');
    expect(result).not.toContain('stroke-linecap=');
    expect(result).not.toContain('fill-opacity=');
  });

  // Regression: `replaceSvgInnerInCode` previously camelCased EVERY kebab
  // attribute, including `data-*` and `aria-*`. That broke sketch
  // animations because `data-points="..."` — which the runtime
  // `playSketchDraw` queries via `path[data-points]` — was being
  // rewritten to `dataPoints="..."`, an invalid DOM attribute that
  // React DOM logs a warning for and that the CSS selector misses.
  test('preserves kebab-case for data-* attributes', () => {
    const result = replaceSvgInnerInCode(
      SVG_SINGLE_CHILD,
      'shape1',
      '<path d="M0,0 L10,10" fill="red" data-points="0,0,0.5 1,1,0.5" data-anim-id="abc" />',
    );
    expect(result).toContain('data-points="0,0,0.5 1,1,0.5"');
    expect(result).toContain('data-anim-id="abc"');
    expect(result).not.toContain('dataPoints=');
    expect(result).not.toContain('dataAnimId=');
  });

  test('preserves kebab-case for aria-* attributes', () => {
    const result = replaceSvgInnerInCode(
      SVG_SINGLE_CHILD,
      'shape1',
      '<path d="M0,0 L10,10" fill="red" aria-label="my path" aria-hidden="true" />',
    );
    expect(result).toContain('aria-label="my path"');
    expect(result).toContain('aria-hidden="true"');
    expect(result).not.toContain('ariaLabel=');
    expect(result).not.toContain('ariaHidden=');
  });

  test('camelCases SVG attrs while preserving data-* / aria-* in the same path', () => {
    const result = replaceSvgInnerInCode(
      SVG_SINGLE_CHILD,
      'shape1',
      '<path d="M0,0" stroke="red" stroke-width="2" data-points="0,0,0.5" aria-label="x" />',
    );
    // SVG presentation attrs: camelCased (existing behaviour).
    expect(result).toContain('strokeWidth="2"');
    expect(result).not.toContain('stroke-width=');
    // data-* / aria-* preserved as kebab.
    expect(result).toContain('data-points="0,0,0.5"');
    expect(result).toContain('aria-label="x"');
  });

  test('replaces inner JSX with multiple shapes', () => {
    const result = replaceSvgInnerInCode(
      SVG_SINGLE_CHILD,
      'shape1',
      '<path d="M0,0 L10,10" fill="red" /><circle cx="50" cy="50" r="20" fill="blue" />',
    );
    expect(result).toContain('d="M0,0 L10,10"');
    expect(result).toContain('cx="50"');
    expect(result).toContain('r="20"');
  });

  test('returns code unchanged when nodeId not found', () => {
    const result = replaceSvgInnerInCode(SVG_SINGLE_CHILD, 'nonexistent', '<path d="M0,0" />');
    expect(result).toBe(SVG_SINGLE_CHILD);
  });

  test('expands self-closing <svg ... /> wrapper', () => {
    const selfClosed = `export default function Page() {
return (
  <div data-id="root" style={{position: 'relative'}}>
    <svg data-id="empty" viewBox="0 0 50 50" style={{width: '50px', height: '50px'}} />
  </div>
);
}`;
    const result = replaceSvgInnerInCode(selfClosed, 'empty', '<rect width="100%" height="100%" fill="blue" />');
    expect(result).toContain('<rect width="100%" height="100%" fill="blue" />');
    expect(result).toContain('</svg>');
    // No more self-closing form
    expect(result).not.toMatch(/<svg data-id="empty"[^>]*\/>/);
    // Opening tag preserved, body inserted between > and </svg>
    expect(result).toMatch(/<svg data-id="empty"[^>]*?>\s*<rect/);
  });

  test('preserves SVG opening tag attributes', () => {
    const result = replaceSvgInnerInCode(
      SVG_SINGLE_CHILD,
      'shape1',
      '<rect width="100%" height="100%" fill="green" />',
    );
    // Original SVG tag attrs (viewBox, style) must survive
    expect(result).toContain('data-id="shape1"');
    expect(result).toContain('viewBox="0 0 100 100"');
    expect(result).toContain("width: '100px'");
  });
});
