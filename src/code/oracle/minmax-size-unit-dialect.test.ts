import { describe, it, expect, vi } from 'vitest';
vi.mock('@/shared/debug-trace', () => ({ trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn() } }));
import { checkFile } from './check-file';

// The Size tool's min/max secondary controls only offer a px/% unit toggle
// (unlike the primary width/height which also do Fit/Fill). So a committed
// minWidth/maxWidth/minHeight/maxHeight must be a plain px or % length — a
// viewport unit ('100vh'), em/rem/ch, calc() or a keyword reads as unset and is
// lost on the next edit (live find 2026-07-04: a full-height hero shipped
// minHeight: '100vh', which the panel could not represent).

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

const sel = (code: string) => checkFile(code, { kind: 'page' }).filter((x) => x.code === 'MINMAX_SIZE_UNIT');

const node = (style: string) => PAGE(`  <div data-id="a" data-name="A" style={{ position: 'relative', width: 'auto', height: 'auto', ${style} }}>x</div>`);

describe('min/max size unit dialect', () => {
  it("minHeight: '100vh' bounces and names the value + key", () => {
    const out = sel(node("minHeight: '100vh'"));
    expect(out.length).toBe(1);
    expect(out[0].message).toContain('100vh');
    expect(out[0].message).toContain('minHeight');
  });

  it('px and % pass on every min/max key', () => {
    expect(sel(node("minHeight: '800px'"))).toEqual([]);
    expect(sel(node("maxHeight: '90%'"))).toEqual([]);
    expect(sel(node("minWidth: '320px'"))).toEqual([]);
    expect(sel(node("maxWidth: '100%'"))).toEqual([]);
  });

  it("bare '0' and a cleared '' pass", () => {
    expect(sel(node("minWidth: '0'"))).toEqual([]);
    expect(sel(node("maxWidth: ''"))).toEqual([]);
  });

  it('decimal px/% pass', () => {
    expect(sel(node("minHeight: '12.5px'"))).toEqual([]);
    expect(sel(node("maxWidth: '33.33%'"))).toEqual([]);
  });

  it('viewport/relative units and calc all bounce', () => {
    for (const bad of ['100vw', '80vmin', '50vmax', '20em', '4rem', '10ch', 'calc(100vh - 80px)']) {
      const out = sel(node(`maxWidth: '${bad}'`));
      expect(out.length, bad).toBe(1);
      expect(out[0].message, bad).toContain(bad);
    }
  });

  it('keywords auto/none/min-content bounce (min/max panel has no keyword slot)', () => {
    expect(sel(node("maxWidth: 'none'")).length).toBe(1);
    expect(sel(node("minWidth: 'auto'")).length).toBe(1);
    expect(sel(node("minHeight: 'min-content'")).length).toBe(1);
  });

  it('all four keys are covered in one file', () => {
    const out = sel(PAGE(`  <div data-id="a" data-name="A" style={{ position: 'relative', width: 'auto', height: 'auto', minWidth: '10vh', maxWidth: '10vh', minHeight: '10vh', maxHeight: '10vh' }}>x</div>`));
    expect(out.length).toBe(4);
  });

  it('a ternary branch with a bad unit bounces (responsive/per-variant value)', () => {
    const out = sel(node("minHeight: variant === 'x' ? '100vh' : '800px'"));
    expect(out.length).toBe(1);
    expect(out[0].message).toContain('100vh');
  });

  it('a ternary with px/% in both branches passes', () => {
    expect(sel(node("minHeight: variant === 'x' ? '600px' : '800px'"))).toEqual([]);
  });
});
