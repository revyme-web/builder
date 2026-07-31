import { describe, it, expect, vi } from 'vitest';
vi.mock('@/shared/debug-trace', () => ({ trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn() } }));
import { checkFile } from './check-file';

// MEDIA_COLUMN_FLIP_MISSING_REBASE — an @media rule flipping a flex row to
// column must re-base row-fill children (flex '1 0 0px'): in column
// direction the basis-0 governs HEIGHT and a child of absolute-only content
// collapses to a 0-height strip (the "HOW WE WORK gray sliver" find).

const PAGE = (css: string, childFlex: string) => `'use client';
import React from 'react';
export default function Page() {
  return <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%', height: 'auto', display: 'flex', flexDirection: 'column' }}>
  <style>{\`${css}\`}</style>
  <div data-id="cards-row" data-name="Cards" style={{ position: 'relative', width: '100%', height: 'auto', display: 'flex', flexDirection: 'row', gap: '24px', flex: '0 0 auto', order: '0' }}>
    <div data-id="card-a" data-name="Card A" style={{ position: 'relative', width: 'auto', height: '380px', flex: '${childFlex}', order: '0' }}>
      <div data-id="card-a-bg" data-name="Base" data-pinned="true" style={{ position: 'absolute', left: '0px', top: '0px', width: '100%', height: '380px', backgroundColor: '#eee' }}></div>
    </div>
    <div data-id="card-b" data-name="Card B" style={{ position: 'relative', width: '300px', height: '380px', flex: '0 0 auto', order: '1' }}></div>
  </div>
</div>;
}`;

const hits = (code: string) =>
  checkFile(code, { kind: 'page' }).filter((x) => x.code === 'MEDIA_COLUMN_FLIP_MISSING_REBASE');

describe('MEDIA_COLUMN_FLIP_MISSING_REBASE', () => {
  it('bounces a column flip whose row-fill child is not re-based', () => {
    const vs = hits(PAGE(
      '@media (max-width: 768px){ [data-id="cards-row"]{ flex-direction: column !important; } }',
      '1 0 0px'));
    expect(vs.length).toBe(1);
    expect(vs[0].elementId).toBe('card-a');
    expect(vs[0].message).toContain('flex: 0 0 auto');
  });

  it('a height override in the media block does NOT count as a fix (basis outranks height)', () => {
    const vs = hits(PAGE(
      '@media (max-width: 768px){ [data-id="cards-row"]{ flex-direction: column !important; } [data-id="card-a"]{ height: 240px !important; } }',
      '1 0 0px'));
    expect(vs.length).toBe(1);
  });

  it('passes when the same block re-bases the child to flex: 0 0 auto', () => {
    const vs = hits(PAGE(
      '@media (max-width: 768px){ [data-id="cards-row"]{ flex-direction: column !important; } [data-id="card-a"]{ flex: 0 0 auto !important; width: 100% !important; } }',
      '1 0 0px'));
    expect(vs.length).toBe(0);
  });

  it('passes for children that are not row-fill (0 0 auto)', () => {
    const vs = hits(PAGE(
      '@media (max-width: 768px){ [data-id="cards-row"]{ flex-direction: column !important; } }',
      '0 0 auto'));
    expect(vs.length).toBe(0);
  });

  it('ignores blocks that never flip direction', () => {
    const vs = hits(PAGE(
      '@media (max-width: 768px){ [data-id="cards-row"]{ gap: 12px !important; } }',
      '1 0 0px'));
    expect(vs.length).toBe(0);
  });
});
