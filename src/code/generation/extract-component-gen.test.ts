// extract-component-gen.test.ts — pure generator tests (no FS, no store).
// The load-bearing assertion is the PRIME RULE: every master this generator
// emits must pass the REAL oracle (checkFile, kind 'component') with zero
// violations — builder output always passes, so generated output must too.

import { describe, it, expect } from 'vitest';
import {
  buildExtractedMaster,
  propNameForDataId,
  convertRootStyleForMaster,
} from './extract-component-gen';
import { checkFile } from '@/code/oracle/check-file';

const HERO_PAGE = `export default function Page() {
  return (
    <div data-id="root">
      <section
        data-id="hero-section"
        style={{
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          padding: '96px 24px',
        }}
      >
        <div data-id="hero-eyebrow" style={{ order: '0', flex: '0 0 auto' }}>Builder visuel</div>
        <h1 data-id="hero-title" style={{ order: '1', flex: '0 0 auto' }}>
          <span data-id="hero-title-line-1">Dessinez votre site.</span>{' '}
          <span data-id="hero-title-line-2">Revyme écrit le code.</span>
        </h1>
        <p data-id="hero-subtitle" style={{ order: '2', flex: '0 0 auto' }}>Concevez chaque section sur le canvas.</p>
      </section>
    </div>
  );
}
`;

describe('propNameForDataId', () => {
  it('camelCases data-ids and dedupes', () => {
    const used = new Set<string>();
    expect(propNameForDataId('hero-title', used)).toBe('heroTitle');
    expect(propNameForDataId('hero-title', used)).toBe('heroTitle2');
    expect(propNameForDataId('42-cta', used)).toBe('t42Cta');
  });
});

describe('buildExtractedMaster', () => {
  it('authors an oracle-canonical master with props for every text leaf', () => {
    const r = buildExtractedMaster(HERO_PAGE, 'hero-section', 'Hero');
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.props.map((p) => p.name)).toEqual([
      'heroEyebrow',
      'heroTitleLine1',
      'heroTitleLine2',
      'heroSubtitle',
    ]);
    expect(r.props[0]).toMatchObject({ defaultValue: 'Builder visuel', dataId: 'hero-eyebrow' });
    const code = r.masterCode;
    expect(code).toContain('function Hero({');
    expect(code).toContain('export default withResponsiveProps(Hero);');
    expect(code).toContain('/** @name "Hero" */');
    expect(code).toContain('export const variantConfig = [');
    expect(code).toContain("name: 'default'");
    // Root keeps its data-id, loses position, ends the style with ...style.
    expect(code).toContain('data-id="hero-section"');
    expect(code).not.toMatch(/position:\s*'relative'/);
    expect(code).toMatch(/\.\.\.style,\s*\n\s*\}\}/);
    // Texts became prop bindings with defaults in the signature.
    expect(code).toContain('{heroTitleLine1}');
    expect(code).toContain('heroSubtitle = "Concevez chaque section sur le canvas."');
  });

  it('PRIME RULE: the emitted master passes the real oracle with zero violations', () => {
    const r = buildExtractedMaster(HERO_PAGE, 'hero-section', 'Hero');
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    const violations = checkFile(r.masterCode, { kind: 'component', path: 'components/Hero.tsx' });
    expect(violations).toEqual([]);
  });

  it('REGRESSION (spot S7): mid-object root position is removed with exactly one comma', () => {
    // Builder-shaped roots carry position mid-object; eating both adjacent
    // commas produced `flexDirection: 'column' flex: ...` — SYNTAX_ERROR on
    // every real extraction (extract_component failed 4/4 in the spot run).
    const page = `export default function Page() {
  return (
    <div data-id="root">
      <div data-id="testimonial-1" data-name="Testimonial 1" style={{ padding: '32px', backgroundColor: '#ffffff', borderRadius: '12px', border: '1px solid #e5e5e5', display: 'flex', flexDirection: 'column', position: 'relative', flex: '0 0 auto', order: '0' }}>
        <div data-id="testimonial-1-stars" style={{ position: 'relative', flex: '0 0 auto', order: '0' }}>★★★★★</div>
        <p data-id="testimonial-1-text" style={{ position: 'relative', flex: '0 0 auto', order: '1' }}>"Quoted text here."</p>
      </div>
    </div>
  );
}
`;
    const r = buildExtractedMaster(page, 'testimonial-1', 'Testimonial');
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    // Only the ROOT loses position (children keep theirs — COMPONENT_ROOT_POSITION targets the root).
    const rootStyle = r.masterCode.match(/data-id="testimonial-1"[^>]*style=\{\{([\s\S]*?)\}\}/)?.[1] ?? '';
    expect(rootStyle).not.toContain('position');
    expect(rootStyle).toContain('...style');
    const violations = checkFile(r.masterCode, { kind: 'component', path: 'components/Testimonial.tsx' });
    expect(violations).toEqual([]);
  });

  it('fails cleanly on a missing node', () => {
    const r = buildExtractedMaster(HERO_PAGE, 'nope', 'Hero');
    expect('error' in r).toBe(true);
  });

  it('fails cleanly on a non-PascalCase name', () => {
    const r = buildExtractedMaster(HERO_PAGE, 'hero-section', 'hero');
    expect('error' in r).toBe(true);
  });

  it('refuses an already-component instance tag', () => {
    const page = HERO_PAGE.replace('<section', '<Hero').replace('</section>', '</Hero>');
    const r = buildExtractedMaster(page, 'hero-section', 'Hero2');
    expect(r).toMatchObject({ error: expect.stringContaining('already a component instance') });
  });

  it('leaves JSX expressions hardwired (only literal text becomes props)', () => {    const page = HERO_PAGE.replace('Concevez chaque section sur le canvas.', '{subtitle}');
    const r = buildExtractedMaster(page, 'hero-section', 'Hero');
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.props.map((p) => p.name)).not.toContain('heroSubtitle');
    expect(r.masterCode).toContain('{subtitle}');
  });
});

describe('convertRootStyleForMaster', () => {
  it('drops position + insets and appends the trailing spread', () => {
    const el = '<section data-id="s" style={{ position: \'relative\', left: \'10px\', display: \'flex\' }}>';
    const out = convertRootStyleForMaster(el);
    expect(out).not.toContain('position');
    expect(out).not.toContain('left');
    expect(out).toContain('display');
    expect(out).toMatch(/\.\.\.style,/);
  });

  it('adds a spread-only style when the root has none', () => {
    const out = convertRootStyleForMaster('<section data-id="s">');
    expect(out).toContain('style={{ ...style }}');
  });
});

describe('buildExtractedMaster — fluid sections with nested instances (agent extract_component)', () => {
  it('bakes the resolved root size and carries the nested component import', async () => {
    const { FIXTURE_FILES, HOME } = await import('@/ai/agent/capability/fixture');
    const r = buildExtractedMaster(FIXTURE_FILES[HOME], 'hero', 'HeroSection', { rootSize: { width: '1440px', height: 'auto' } });
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.masterCode).toContain("width: '1440px'");
    expect(r.masterCode).not.toMatch(/width: '100%'[^\n]*\n[^\n]*data-name="Hero"/);
    expect(r.masterCode).toContain("import PrimaryButton from '@/components/PrimaryButton';");
    expect(checkFile(r.masterCode, { kind: 'component', path: 'components/HeroSection.tsx' })).toEqual([]);
  });
});
