// Duplicate/paste must carry per-breakpoint @media overrides (BUG 6,
// 2026-09-05): the band rules live in the page's <style> block keyed by
// data-id, so the clipboard tree alone lost them — a node styled yellow on
// the tablet band duplicated as base-blue on every tile, and so did its
// descendants. Round-trip here goes through the REAL band writer so the
// capture stays in lockstep with what the generator actually emits.

import { describe, it, expect } from 'vitest';
import { updateContainerQueryStyle } from '@/code/generation/generator-styles';
import { captureResponsiveBands } from './copy/index';
import type { ClipboardNode } from './types';

const cnode = (id: string): ClipboardNode => ({ id, type: 'div', parentId: null, children: [], order: 0, styles: {} } as unknown as ClipboardNode);

const PAGE = `import React from 'react';
export default function Page() {
  return <div data-id="root" style={{ position: 'relative' }}>
    <style>{\`\`}</style>
    <div data-id="box-1" style={{ backgroundColor: '#4a6f9c' }}>
      <div data-id="child-1" style={{ backgroundColor: '#f2b8c0' }}></div>
    </div>
  </div>;
}`;

describe('responsive band capture ↔ writer round-trip', () => {
  it('what the writer emits, the capture parses back verbatim (minus !important)', async () => {
    // Write bands with the REAL generator: parent yellow on tablet, child
    // green on tablet, parent narrower on mobile.
    let code = updateContainerQueryStyle(PAGE, 'box-1', 768, { backgroundColor: '#e8c464', paddingTop: '12px' });
    code = updateContainerQueryStyle(code, 'child-1', 768, { backgroundColor: '#7ed321' });
    code = updateContainerQueryStyle(code, 'box-1', 375, { width: '291px' });

    // Import the capture through the module under test (not exported — go
    // through the public copy path? The parse logic is what matters, so
    // replicate the minimal contract: rules must exist in the emitted CSS.)
    expect(code).toContain('max-width: 768px');
    expect(code).toMatch(/\[data-id="box-1"\]\s*\{[^}]*background-color: #e8c464 !important/);
    expect(code).toMatch(/\[data-id="child-1"\]\s*\{[^}]*#7ed321 !important/);
    expect(code).toMatch(/\[data-id="box-1"\]\s*\{[^}]*width: 291px !important/);

    // Now the CAPTURE side: parse those bands back off the source.
    const box = cnode('box-1');
    const child = cnode('child-1');
    const other = cnode('no-overrides');
    captureResponsiveBands([box, child, other], code);

    expect(box.responsiveBands).toEqual([
      { maxWidth: 768, styles: { backgroundColor: '#e8c464', paddingTop: '12px' } },
      { maxWidth: 375, styles: { width: '291px' } },
    ]);
    // DESCENDANTS are their own clipboard entries and get their own bands.
    expect(child.responsiveBands).toEqual([
      { maxWidth: 768, styles: { backgroundColor: '#7ed321' } },
    ]);
    // A node with no band rules carries nothing.
    expect(other.responsiveBands).toBeUndefined();
  });
});
