import { describe, it, expect, vi } from 'vitest';
vi.mock('@/shared/debug-trace', () => ({ trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn() } }));
import { checkFile } from './check-file';

// FLEX_ROW_CHILD_FULL_WIDTH — width: '100%' on a flex-ROW child that shares
// the row overflows sideways (no-shrink dialect makes each 100% literal).
// Sharing a row = FILL: flex '1 0 0px' with NO width. Live find 2026-08-30:
// an MCP-built card grid rendered every card page-wide.

const PAGE = (body: string) => `'use client';

/** @canvas { "viewports": [{ "id": "desktop", "label": "Desktop", "width": 1440, "isPrimary": true, "order": 0 }], "positions": { "desktop": { "x": 0, "y": 0 } } } */

import React from 'react';

export default function Page() {
  return (
<div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%', height: '900px' }}>
${body}
</div>
  );
}`;

const fw = (code: string) => checkFile(code, { kind: 'page' }).filter((x) => x.code === 'FLEX_ROW_CHILD_FULL_WIDTH');

const card = (id: string, style: string) =>
  `<div data-id="${id}" data-name="${id}" style={{ position: 'relative', ${style} }}></div>`;

describe('flex row fill dialect', () => {
  it('two width-100% children in a row bounce (one violation per container)', () => {
    const out = fw(PAGE(`  <div data-id="row" data-name="Row" style={{ position: 'relative', display: 'flex', flexDirection: 'row', gap: '24px' }}>
    ${card('a', "flex: '0 0 auto', order: '0', width: '100%'")}
    ${card('b', "flex: '0 0 auto', order: '1', width: '100%'")}
  </div>`));
    expect(out).toHaveLength(1);
    expect(out[0].elementId).toBe('row');
    expect(out[0].message).toContain('a, b');
    expect(out[0].message).toContain("flex: '1 0 0px'");
  });

  it('missing flexDirection IS row — still bounces', () => {
    const out = fw(PAGE(`  <div data-id="row" data-name="Row" style={{ position: 'relative', display: 'flex' }}>
    ${card('a', "flex: '0 0 auto', order: '0', width: '100%'")}
    ${card('b', "flex: '0 0 auto', order: '1', width: '100%'")}
  </div>`));
    expect(out).toHaveLength(1);
  });

  it('Fill children (flex 1 0 0px, no width) pass', () => {
    const out = fw(PAGE(`  <div data-id="row" data-name="Row" style={{ position: 'relative', display: 'flex', flexDirection: 'row', gap: '24px' }}>
    ${card('a', "flex: '1 0 0px', order: '0'")}
    ${card('b', "flex: '1 0 0px', order: '1'")}
  </div>`));
    expect(out).toEqual([]);
  });

  it('explicit px widths pass', () => {
    const out = fw(PAGE(`  <div data-id="row" data-name="Row" style={{ position: 'relative', display: 'flex', flexDirection: 'row', gap: '24px' }}>
    ${card('a', "flex: '0 0 auto', order: '0', width: '238px'")}
    ${card('b', "flex: '0 0 auto', order: '1', width: '238px'")}
  </div>`));
    expect(out).toEqual([]);
  });

  it('a COLUMN with width-100% children passes (the normal fill-x form)', () => {
    const out = fw(PAGE(`  <div data-id="col" data-name="Col" style={{ position: 'relative', display: 'flex', flexDirection: 'column' }}>
    ${card('a', "flex: '0 0 auto', order: '0', width: '100%'")}
    ${card('b', "flex: '0 0 auto', order: '1', width: '100%'")}
  </div>`));
    expect(out).toEqual([]);
  });

  it('a single width-100% child in a row passes (nothing to share with)', () => {
    const out = fw(PAGE(`  <div data-id="row" data-name="Row" style={{ position: 'relative', display: 'flex', flexDirection: 'row' }}>
    ${card('a', "flex: '0 0 auto', order: '0', width: '100%'")}
  </div>`));
    expect(out).toEqual([]);
  });

  it('an absolute width-100% child does not count toward the row', () => {
    const out = fw(PAGE(`  <div data-id="row" data-name="Row" style={{ position: 'relative', display: 'flex', flexDirection: 'row' }}>
    <div data-id="deco" data-name="Deco" data-pinned="true" style={{ position: 'absolute', left: '0px', top: '0px', width: '100%' }}></div>
    ${card('a', "flex: '0 0 auto', order: '0', width: '320px'")}
    ${card('b', "flex: '0 0 auto', order: '1', width: '100%'")}
  </div>`));
    expect(out).toHaveLength(1);
    expect(out[0].message).toContain('b');
    expect(out[0].message).not.toContain('deco');
  });
});

describe('flex row fill dialect — maxWidth cap exemption', () => {
  const PAGE2 = (body: string) => `'use client';

/** @canvas { "viewports": [{ "id": "desktop", "label": "Desktop", "width": 1440, "isPrimary": true, "order": 0 }], "positions": { "desktop": { "x": 0, "y": 0 } } } */

import React from 'react';

export default function Page() {
  return (
<div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%', height: '900px' }}>
${body}
</div>
  );
}`;
  const fw2 = (code: string) => checkFile(code, { kind: 'page' }).filter((x) => x.code === 'FLEX_ROW_CHILD_FULL_WIDTH');

  it('width 100% capped by a px maxWidth passes (fluid-up-to-N child)', () => {
    const out = fw2(PAGE2(`  <div data-id="row" data-name="Row" style={{ position: 'relative', display: 'flex', flexDirection: 'row', justifyContent: 'space-between' }}>
    <div data-id="brand" data-name="Brand" style={{ position: 'relative', flex: '0 0 auto', order: '0', width: '100%', maxWidth: '340px' }}></div>
    <div data-id="cols" data-name="Cols" style={{ position: 'relative', flex: '0 0 auto', order: '1', width: '320px' }}></div>
  </div>`));
    expect(out).toEqual([]);
  });
});
