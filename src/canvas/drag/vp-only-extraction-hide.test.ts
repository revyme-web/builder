// vp-only-extraction-hide.test.ts — the extraction must NOT stamp per-viewport
// hides onto the canvas clone.
//
// User report 2026-08-09, in three rounds: a frame dragged mobile → canvas →
// tablet → canvas → primary in one gesture ended up either invisible mid-drag
// or permanently hidden on one viewport after landing in the primary.
//
// The extraction hid the clone on every non-source viewport so its
// viewport-only-ness would survive a drop back in. Two things were wrong:
//
//   · The PRIMARY has no @media band — its values ARE the inline base — so that
//     write hid the canvas clone outright, the instant it left the viewport.
//   · The remaining bands outlived the gesture. Entering the primary writes no
//     per-viewport hides, so a clone dropped there kept its extraction hide and
//     stayed invisible on that viewport forever.
//
// Neither was needed: the bands are inert while the node is a canvas node, and
// the ENTRY path writes the full solo state itself on re-entry.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const SRC = readFileSync('src/canvas/drag/strategies/AbsoluteInFrameStrategy.ts', 'utf8');

describe('vp-only extraction — no per-viewport hides on the clone', () => {
  it('THE BUG: no updateContainerStyle hides the CLONE', () => {
    // Hides targeting `originalSourceId` are correct and must stay — the source
    // really is leaving that viewport. Only clone-targeted ones were the bug.
    const region = SRC.slice(
      SRC.indexOf('cloneCanvasOverlay'),
      SRC.indexOf('// 6. Swap dragged identity to the clone'),
    );
    const cloneHides = [...region.matchAll(
      /type:\s*'updateContainerStyle',[\s\S]{0,200}?nodeId:\s*cloneRoot\.id[\s\S]{0,200}?display:\s*'none'/g,
    )];
    expect(cloneHides).toHaveLength(0);
  });

  it('the SOURCE is still hidden on the viewport it left', () => {
    const region = SRC.slice(
      SRC.indexOf('cloneCanvasOverlay'),
      SRC.indexOf('// 6. Swap dragged identity to the clone'),
    );
    expect(region).toMatch(/nodeId:\s*originalSourceId,[\s\S]{0,120}?display:\s*'none'/);
  });

  it('records WHY, so it is not reintroduced', () => {
    expect(SRC).toMatch(/5\. \(removed\)/);
  });

  it('the clone still gets its solo teardown', () => {
    // Removing the hides must not remove the guard that clears an inherited
    // `display:none` off the clone — a separate fix, same symptom.
    const region = SRC.slice(
      SRC.indexOf('REPLICA-SOLO TEARDOWN'),
      SRC.indexOf('// 1. Revert SOURCE'),
    );
    expect(region).toMatch(/cloneRoot\.styles\.display = ''/);
    expect(region).toMatch(/'data-replica-solo': ''/);
  });
});
