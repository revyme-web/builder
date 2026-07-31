// CanvasRulers.test.ts — Source-level regression guards for the ruler
// corner square's z-stack contract and glass-blur visual treatment.
//
// We don't render the component (it depends on transformManager,
// activeFilePathAtom, ruler-guides-store, the bridge, etc. — far more
// setup than the bug surface justifies). Instead we read the source
// once and assert the corner square's style block has:
//
//   1. zIndex >= 4906  → above selection bands (4903), drag-preview
//      (4905), and position-indicator pills (4902). Below the right
//      panel chrome (5000+).
//   2. A `backdropFilter` rule that includes `blur(`            → the
//      glass effect from `../../builder` is intact.
//   3. A translucent backgroundColor                            → the
//      blur has something to actually blur (an opaque bg defeats it).
//
// Catches both known regressions:
//   - someone reverts the corner z to 4901 (selection bands paint over
//     it again);
//   - someone drops the backdrop-filter (corner goes flat / loses the
//     glass look).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE = readFileSync(
  join(__dirname, 'CanvasRulers.tsx'),
  'utf8',
);

/**
 * Extract the JSX style object that follows the "Corner square" comment.
 * Greedy-match up to the next closing `}` of the same depth. Brittle by
 * design — if the corner block moves the test should fail loudly so a
 * human re-points it, rather than silently pass on the wrong block.
 */
function extractCornerStyleBlock(): string {
  const markerIdx = SOURCE.indexOf('Corner square');
  expect(markerIdx, 'corner square comment marker missing').toBeGreaterThan(-1);

  // Find the next `style={{` after the marker — that's the corner div's
  // style prop.
  const styleStart = SOURCE.indexOf('style={{', markerIdx);
  expect(styleStart, 'corner style={{ block missing').toBeGreaterThan(-1);

  // Walk forward counting braces from the opening `{{` until depth=0.
  let depth = 0;
  let i = styleStart + 'style={'.length;
  for (; i < SOURCE.length; i++) {
    const ch = SOURCE[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return SOURCE.slice(styleStart, i + 1);
}

describe('CanvasRulers corner square — z-stack + glass', () => {
  const block = extractCornerStyleBlock();

  it('declares zIndex above selection bands and drag preview (>= 4906)', () => {
    const m = block.match(/zIndex:\s*(\d+)/);
    expect(m, 'corner zIndex declaration missing').not.toBeNull();
    const z = Number(m![1]);
    // Selection bands sit at 4903, drag-preview at 4905. Anything <=
    // 4905 means the bug is back.
    expect(z).toBeGreaterThanOrEqual(4906);
    // Right-panel chrome at 5000+ must stay above the ruler — corner
    // shouldn't punch through it.
    expect(z).toBeLessThan(5000);
  });

  it('uses backdropFilter: blur(...) for the glass effect', () => {
    expect(block).toMatch(/backdropFilter:\s*['"`][^'"`]*\bblur\(/);
  });

  it('also sets WebkitBackdropFilter for Safari', () => {
    expect(block).toMatch(/WebkitBackdropFilter:\s*['"`][^'"`]*\bblur\(/);
  });

  it('uses a translucent backgroundColor (so the blur has something to blur)', () => {
    // Either color-mix(... transparent) or rgba/hsla — anything that
    // resolves to <1.0 alpha. A plain `var(--bg-canvas)` (opaque)
    // would defeat the blur.
    const bgMatch = block.match(/backgroundColor:\s*(['"`])([^'"`]+)\1/);
    expect(bgMatch, 'backgroundColor declaration missing').not.toBeNull();
    const bg = bgMatch![2];
    const isTranslucent =
      bg.includes('transparent') ||
      /rgba\(/.test(bg) ||
      /hsla\(/.test(bg) ||
      bg.includes('color-mix');
    expect(isTranslucent, `corner bg "${bg}" should be translucent`).toBe(true);
  });

  it('keeps pointerEvents: none so the corner does not eat ruler drags', () => {
    expect(block).toMatch(/pointerEvents:\s*['"`]none['"`]/);
  });
});
