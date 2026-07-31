import { describe, it, expect, vi } from 'vitest';
vi.mock('@/shared/debug-trace', () => ({ trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn() } }));
import { checkFile } from './check-file';

// HARD user rule (2026-07-21): lineHeight is NEVER px (or any length unit) —
// only a unitless ratio ('1.2') or 'normal'. A px line-height freezes the
// leading; when the font size changes (responsive tier / user edit) the text
// overlaps or gaps out. Tightened from the old LINE_HEIGHT_FORMAT which
// still allowed px.

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

const sel = (code: string) => checkFile(code, { kind: 'page' }).filter((x) => x.code === 'LINE_HEIGHT_FORMAT');
const node = (style: string) => PAGE(`  <p data-id="a" data-name="A" style={{ position: 'relative', width: '100%', height: 'auto', margin: '0px', ${style} }}>x</p>`);

describe('line-height unitless dialect', () => {
  it("px bounces with the conversion hint", () => {
    const out = sel(node("fontSize: '40px', lineHeight: '48px'"));
    expect(out.length).toBe(1);
    expect(out[0].message).toContain('UNITLESS');
    expect(out[0].message).toContain('48px');
  });

  it('em/rem/percent bounce too', () => {
    expect(sel(node("lineHeight: '1.2em'")).length).toBe(1);
    expect(sel(node("lineHeight: '110%'")).length).toBe(1);
  });

  it("unitless ratios, 'normal' and var() refs pass", () => {
    expect(sel(node("lineHeight: '1.2'"))).toEqual([]);
    expect(sel(node("lineHeight: '1.495'"))).toEqual([]);
    expect(sel(node("lineHeight: 'normal'"))).toEqual([]);
    expect(sel(node("lineHeight: 'var(--typo-body-line-height)'"))).toEqual([]);
  });
});
