import { describe, it, expect, vi } from 'vitest';
vi.mock('@/shared/debug-trace', () => ({ trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn() } }));
import { checkFile } from './check-file';

// The Fill control reads/writes `backgroundColor` for a solid colour and
// reserves `background`/`backgroundImage` for gradients & images. So a solid
// colour put on the `background` shorthand renders but shows as an EMPTY,
// uneditable fill in the panel (same "reads as unset" class as MINMAX_SIZE_UNIT).

const PAGE = (body: string) => `'use client';

/** @canvas { "viewports": [{ "id": "desktop", "label": "Desktop", "width": 1440, "isPrimary": true, "order": 0 }], "positions": { "desktop": { "x": 0, "y": 0 } } } */

export default function Page() {
  return (
<div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%' }}>
${body}
</div>
  );
}`;

const sel = (code: string) => checkFile(code, { kind: 'page' }).filter((x) => x.code === 'BACKGROUND_SOLID_SHORTHAND');
const node = (style: string) => PAGE(`  <div data-id="a" data-name="A" style={{ position: 'relative', width: 'auto', height: 'auto', ${style} }}>x</div>`);

describe('solid background shorthand dialect', () => {
  it('flags a solid hex on the background shorthand + names the fix', () => {
    const out = sel(node("background: '#0a0c11'"));
    expect(out.length).toBe(1);
    expect(out[0].message).toContain('backgroundColor');
    expect(out[0].message).toContain('#0a0c11');
  });

  it('flags rgb/rgba solids too', () => {
    expect(sel(node("background: 'rgba(255,255,255,0.1)'")).length).toBe(1);
    expect(sel(node("background: 'rgb(20, 20, 20)'")).length).toBe(1);
  });

  it('backgroundColor for a solid passes', () => {
    expect(sel(node("backgroundColor: '#0a0c11'"))).toEqual([]);
  });

  it('gradients and images stay on background/backgroundImage', () => {
    expect(sel(node("background: 'linear-gradient(#fff, #000)'"))).toEqual([]);
    expect(sel(node("background: 'radial-gradient(circle, #fff, #000)'"))).toEqual([]);
    expect(sel(node("backgroundImage: 'url(https://x.com/a.png)'"))).toEqual([]);
  });
});
