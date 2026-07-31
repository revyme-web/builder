// heal-data-ids.test.ts — self-heal for instance tags without data-id (the
// auto_N silent-no-op class) + corrupted bare `data-` attribute stripping.

import { describe, it, expect } from 'vitest';
import { healMissingInstanceDataIds } from './heal-data-ids';

describe('healMissingInstanceDataIds', () => {
  it('stamps a data-id on a PascalCase instance missing one (the corrupted-tag shape)', () => {
    // The wild corruption: `data-id="X"` split into bare `data-` + `id="X"`.
    const code = `<div data-id="root"><ZaPoKa data- curveRadius={18} id="ZaPoKa-1" data-name="ZaPoKa" style={{ left: '409px' }}></ZaPoKa></div>`;
    const r = healMissingInstanceDataIds(code);
    expect(r.healed).toBe(1);
    expect(r.strippedJunk).toBe(1);
    expect(r.code).toMatch(/<ZaPoKa data-id="ZaPoKa-[a-z0-9-]+" curveRadius=\{18\}/);
    expect(r.code).not.toContain(' data- ');
    // The stray `id=` prop is left alone — `id` is a legitimate anchor prop.
    expect(r.code).toContain('id="ZaPoKa-1"');
  });

  it('strips `data-="true"` junk from pasted copies (keeps their real data-id)', () => {
    const code = `<ZaPoKa data-id="ZaPoKa-ok-1" data-name="ZaPoKa" id="ZaPoKa-1" data-="true" style={{}}></ZaPoKa>`;
    const r = healMissingInstanceDataIds(code);
    expect(r.healed).toBe(0);
    expect(r.strippedJunk).toBe(1);
    expect(r.code).toContain('data-id="ZaPoKa-ok-1"');
    expect(r.code).not.toContain('data-="true"');
  });

  it('does not touch healthy instances, transparent wrappers, or lowercase tags', () => {
    const code = `<LayoutGroup><MotionConfig transition={{ duration: 0.3 }}>
      <Hero data-id="hero-1" />
      <div style={{ left: '4px' }}><span>data- text</span></div>
    </MotionConfig></LayoutGroup>`;
    const r = healMissingInstanceDataIds(code);
    expect(r.healed).toBe(0);
    expect(r.strippedJunk).toBe(0);
    expect(r.code).toBe(code);
  });

  it('heals multiple instances and keeps ids unique', () => {
    const code = `<div data-id="root"><Card style={{}} /><Card style={{}} /></div>`;
    const r = healMissingInstanceDataIds(code);
    expect(r.healed).toBe(2);
    const ids = [...r.code.matchAll(/<Card data-id="([^"]+)"/g)].map(x => x[1]);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('ignores `[data-id=...]` CSS selectors in style strings', () => {
    const code = `<div data-id="root"><style>{\`[data-id="x"]::after { content: ''; }\`}</style><Card data-id="c-1" /></div>`;
    const r = healMissingInstanceDataIds(code);
    expect(r.code).toBe(code);
  });

  it('handles self-closing instances with arrow-function props', () => {
    const code = `<Nav style={{}} onOpen={() => setOpen(v => !v)} />`;
    const r = healMissingInstanceDataIds(code);
    expect(r.healed).toBe(1);
    expect(r.code).toMatch(/^<Nav data-id="Nav-[a-z0-9-]+" style/);
    expect(r.code).toContain('onOpen={() => setOpen(v => !v)} />');
  });
});
