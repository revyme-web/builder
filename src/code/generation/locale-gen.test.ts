import { describe, test, expect } from 'vitest';
import { updateLocaleStyleInCode, removeLocaleRulesFromCode, parseLocaleRules, ensureRootDataVariantAttr } from './locale-gen';

// ─── Fixtures ──────────────────────────────────────────────────────────────

const PAGE_NO_STYLE = `<div data-id="root" style={{position: 'relative', width: '1440px'}}>
  <h1 data-id="hero-title" style={{fontSize: '52px', color: '#ffffff'}}>Welcome</h1>
  <p data-id="subtitle" style={{fontSize: '18px'}}>Build websites</p>
</div>`;

const PAGE_WITH_CONTAINER = `<div data-id="root" style={{position: 'relative', width: '1440px'}}>
  <h1 data-id="hero-title" style={{fontSize: '52px', color: '#ffffff'}}>Welcome</h1>
  <style>{\`
    @media (max-width: 768px) {
      [data-id="hero-title"] { font-size: 28px !important; }
    }
  \`}</style>
</div>`;

const PAGE_WITH_LOCALE = `<div data-id="root" style={{position: 'relative', width: '1440px'}}>
  <h1 data-id="hero-title" style={{fontSize: '52px', color: '#ffffff'}}>Welcome</h1>
  <style>{\`
    @media (max-width: 768px) {
      [data-id="hero-title"] { font-size: 28px !important; }
    }
    :lang(fr) [data-id="hero-title"] { font-size: 48px !important; }
  \`}</style>
</div>`;

const PAGE_MULTI_LOCALE = `<div data-id="root" style={{position: 'relative', width: '1440px'}}>
  <h1 data-id="hero-title" style={{fontSize: '52px'}}>Welcome</h1>
  <style>{\`
    :lang(ar) [data-id="root"] { direction: rtl !important; }
    :lang(fr) [data-id="hero-title"] { font-size: 48px !important; }
    :lang(fr) [data-id="subtitle"] { font-size: 20px !important; }
  \`}</style>
</div>`;

// ─── parseLocaleRules ─────────────────────────────────────────────────────

describe('parseLocaleRules', () => {
  test('parses :lang() rules from CSS', () => {
    const css = `
    :lang(fr) [data-id="hero-title"] { font-size: 48px !important; color: red !important; }
    :lang(ar) [data-id="root"] { direction: rtl !important; }
    `;
    const rules = parseLocaleRules(css);

    expect(rules.size).toBe(2);
    expect(rules.get('fr')!.get('hero-title')!.get('font-size')).toBe('48px');
    expect(rules.get('fr')!.get('hero-title')!.get('color')).toBe('red');
    expect(rules.get('ar')!.get('root')!.get('direction')).toBe('rtl');
  });

  test('returns empty map for CSS with no :lang() rules', () => {
    const css = `
    @media (max-width: 768px) {
      [data-id="hero-title"] { font-size: 28px !important; }
    }
    `;
    const rules = parseLocaleRules(css);
    expect(rules.size).toBe(0);
  });
});

// ─── updateLocaleStyleInCode ─────────────────────────────────────────────

describe('updateLocaleStyleInCode', () => {
  test('creates style block when none exists', () => {
    const result = updateLocaleStyleInCode(
      PAGE_NO_STYLE,
      'hero-title',
      'fr',
      { fontSize: '48px' },
    );

    expect(result).toContain('<style>');
    expect(result).toContain(':lang(fr) [data-id="hero-title"] { font-size: 48px !important; }');
  });

  test('creates :lang() rule in existing style block', () => {
    const result = updateLocaleStyleInCode(
      PAGE_WITH_CONTAINER,
      'hero-title',
      'fr',
      { fontSize: '48px' },
    );

    // Should still have @media rules
    expect(result).toContain('@media (max-width: 768px)');
    expect(result).toContain('font-size: 28px !important');
    // Should have the new :lang() rule
    expect(result).toContain(':lang(fr) [data-id="hero-title"] { font-size: 48px !important; }');
  });

  test('updates existing :lang() rule for same locale+nodeId', () => {
    const result = updateLocaleStyleInCode(
      PAGE_WITH_LOCALE,
      'hero-title',
      'fr',
      { color: 'red' },
    );

    // Should have both old and new properties merged
    expect(result).toContain(':lang(fr) [data-id="hero-title"]');
    expect(result).toContain('font-size: 48px !important');
    expect(result).toContain('color: red !important');
    // Should still have @media
    expect(result).toContain('@media (max-width: 768px)');
  });

  test('removes property when value is empty string', () => {
    const result = updateLocaleStyleInCode(
      PAGE_WITH_LOCALE,
      'hero-title',
      'fr',
      { fontSize: '' },
    );

    // font-size should be gone from the :lang(fr) rule for hero-title
    // Since that was the only property, the entire rule should be gone
    expect(result).not.toContain(':lang(fr) [data-id="hero-title"]');
    // @media rules should be preserved
    expect(result).toContain('@media (max-width: 768px)');
  });

  test('removes entire rule when all properties are empty', () => {
    // Start with a locale rule that has one property
    const result = updateLocaleStyleInCode(
      PAGE_WITH_LOCALE,
      'hero-title',
      'fr',
      { fontSize: '' },
    );

    // The entire :lang(fr) [data-id="hero-title"] rule should be removed
    expect(result).not.toContain(':lang(fr)');
  });

  test('keeps other locale rules when removing one node', () => {
    const result = updateLocaleStyleInCode(
      PAGE_MULTI_LOCALE,
      'hero-title',
      'fr',
      { fontSize: '' },
    );

    // fr hero-title rule removed, but fr subtitle rule should remain
    expect(result).not.toContain(':lang(fr) [data-id="hero-title"]');
    expect(result).toContain(':lang(fr) [data-id="subtitle"]');
    // ar rules untouched
    expect(result).toContain(':lang(ar) [data-id="root"]');
  });

  test('multiple locales in same style block', () => {
    let code = PAGE_WITH_CONTAINER;

    // Add French rule
    code = updateLocaleStyleInCode(code, 'hero-title', 'fr', { fontSize: '48px' });
    // Add Arabic rule
    code = updateLocaleStyleInCode(code, 'root', 'ar', { direction: 'rtl' });

    expect(code).toContain(':lang(ar) [data-id="root"] { direction: rtl !important; }');
    expect(code).toContain(':lang(fr) [data-id="hero-title"] { font-size: 48px !important; }');
    // @media still intact
    expect(code).toContain('@media (max-width: 768px)');
  });

  test('composes with existing @media rules without breaking them', () => {
    const result = updateLocaleStyleInCode(
      PAGE_WITH_CONTAINER,
      'hero-title',
      'de',
      { fontSize: '44px', letterSpacing: '1px' },
    );

    // @media rules preserved exactly
    expect(result).toContain('@media (max-width: 768px)');
    expect(result).toContain('[data-id="hero-title"] { font-size: 28px !important; }');
    // Locale rule added
    expect(result).toContain(':lang(de) [data-id="hero-title"]');
    expect(result).toContain('font-size: 44px !important');
    expect(result).toContain('letter-spacing: 1px !important');
  });

  test('handles multiple properties at once', () => {
    const result = updateLocaleStyleInCode(
      PAGE_NO_STYLE,
      'cta-section',
      'fr',
      { overflow: 'visible', padding: '40px 60px' },
    );

    expect(result).toContain(':lang(fr) [data-id="cta-section"]');
    expect(result).toContain('overflow: visible !important');
    expect(result).toContain('padding: 40px 60px !important');
  });

  test('converts camelCase to kebab-case', () => {
    const result = updateLocaleStyleInCode(
      PAGE_NO_STYLE,
      'hero-title',
      'ar',
      { textAlign: 'right', letterSpacing: '2px' },
    );

    expect(result).toContain('text-align: right !important');
    expect(result).toContain('letter-spacing: 2px !important');
  });
});

// ─── removeLocaleRulesFromCode ──────────────────────────────────────────

describe('removeLocaleRulesFromCode', () => {
  test('removes all rules for a locale', () => {
    const result = removeLocaleRulesFromCode(PAGE_MULTI_LOCALE, 'fr');

    // French rules gone
    expect(result).not.toContain(':lang(fr)');
    // Arabic rules still there
    expect(result).toContain(':lang(ar) [data-id="root"] { direction: rtl !important; }');
  });

  test('returns code unchanged when locale not found', () => {
    const result = removeLocaleRulesFromCode(PAGE_WITH_CONTAINER, 'fr');
    // No :lang rules to remove, code unchanged
    expect(result).toContain('@media (max-width: 768px)');
  });

  test('returns code unchanged when no style block exists', () => {
    const result = removeLocaleRulesFromCode(PAGE_NO_STYLE, 'fr');
    expect(result).toBe(PAGE_NO_STYLE);
  });

  test('preserves @media rules when removing locale', () => {
    const result = removeLocaleRulesFromCode(PAGE_WITH_LOCALE, 'fr');

    expect(result).not.toContain(':lang(fr)');
    expect(result).toContain('@media (max-width: 768px)');
    expect(result).toContain('font-size: 28px !important');
  });

  test('removes style block entirely when last locale is removed and no other rules', () => {
    // Build a page that only has locale rules (no @media)
    const pageOnlyLocale = `<div data-id="root" style={{position: 'relative', width: '1440px'}}>
  <h1 data-id="hero-title" style={{fontSize: '52px'}}>Welcome</h1>
  <style>{\`
    :lang(fr) [data-id="hero-title"] { font-size: 48px !important; }
  \`}</style>
</div>`;

    const result = removeLocaleRulesFromCode(pageOnlyLocale, 'fr');

    // Entire <style> block should be gone
    expect(result).not.toContain('<style>');
    expect(result).not.toContain(':lang(fr)');
  });
});

// ── Width-scoped parsing (responsive localization) ─────────────────────────
import { parseLocaleRulesScoped, localeOffMarker } from './locale-gen';

describe('parseLocaleRulesScoped', () => {
  const css = `
:lang(fr) [data-id="hero"] { background-color: #111 !important; }
@media (max-width: 768px) {
  [data-id="hero"] { width: 100% !important; }
  :lang(fr) [data-id="hero"] { background-color: #222 !important; }
}
@media (max-width: 375px) {
  :lang(fr) [data-id="hero"] { background-color: #111 !important; --locale-off-background-color: 1 !important; }
}
`;
  test('separates global from banded rules', () => {
    const { global, banded } = parseLocaleRulesScoped(css);
    expect(global.get('fr')!.get('hero')!.get('background-color')).toBe('#111');
    expect(banded.get(768)!.get('fr')!.get('hero')!.get('background-color')).toBe('#222');
    // The global map must NOT contain the banded values.
    expect(global.get('fr')!.get('hero')!.get('background-color')).not.toBe('#222');
  });
  test('exposes the removal marker per band', () => {
    const { banded } = parseLocaleRulesScoped(css);
    const mobile = banded.get(375)!.get('fr')!.get('hero')!;
    expect(mobile.get(localeOffMarker('background-color'))).toBe('1');
  });
  test('no bands → everything global', () => {
    const { global, banded } = parseLocaleRulesScoped(`:lang(es) [data-id="x"] { color: red !important; }`);
    expect(global.get('es')!.get('x')!.get('color')).toBe('red');
    expect(banded.size).toBe(0);
  });
});

// ── Banded writer: ranged heads, removal, creation ─────────────────────────
describe('updateLocaleStyleInsideContainer via updateLocaleStyleInCode(maxWidth)', () => {
  const page = (css: string) => `'use client';
export default function Page() {
  return (<div data-id="root"><style>{\`${css}\`}</style><p data-id="hero">Hi</p></div>);
}`;

  test('writes into a RANGED band head (max-width AND min-width)', () => {
    const code = page(`
    @media (max-width: 768px) and (min-width: 375px) {
      [data-id="hero"] { width: 100% !important; }
    }
  `);
    const out = updateLocaleStyleInCode(code, 'hero', 'fr', { borderRadius: '10px' }, 768);
    expect(out).toMatch(/max-width: 768px\) and \(min-width: 375px\)[^{]*\{[\s\S]*:lang\(fr\) \[data-id="hero"\] \{ border-radius: 10px !important; \}/);
    // Must NOT have leaked to top level (outside the band).
    const topLevel = out.split('@media')[0];
    expect(topLevel).not.toContain(':lang(fr)');
  });

  test('removes a banded rule with empty values (Reset Override path)', () => {
    const code = page(`
    @media (max-width: 768px) and (min-width: 375px) {
      :lang(fr) [data-id="hero"] { border-radius: 22px !important; --locale-off-border-radius: 1 !important; }
    }
  `);
    const out = updateLocaleStyleInCode(code, 'hero', 'fr', { borderRadius: '', '--locale-off-border-radius': '' }, 768);
    expect(out).not.toContain(':lang(fr)');
  });

  test('a value write CLEARS a stale removal marker (remove-then-relocalize)', () => {
    // The buggy end-state from the live find: bake left the marker, a later
    // Set wrote a new value beside it — CSS painted the value while the pill
    // read "removed" and hid.
    const code = page(`
    @media (max-width: 768px) and (min-width: 375.02px) {
      :lang(fr) [data-id="hero"] { background-color: #aa8ad9 !important; --locale-off-background-color: 1 !important; }
    }
  `);
    const out = updateLocaleStyleInCode(code, 'hero', 'fr', { backgroundColor: '#9d5dfb' }, 768);
    expect(out).toContain('background-color: #9d5dfb !important');
    expect(out).not.toContain('--locale-off-background-color');
  });

  test('the bake batch (value + marker together) keeps BOTH', () => {
    const code = page(`
    @media (max-width: 768px) and (min-width: 375.02px) {
      :lang(fr) [data-id="hero"] { background-color: #9d5dfb !important; }
    }
  `);
    const out = updateLocaleStyleInCode(code, 'hero', 'fr',
      { backgroundColor: '#aa8ad9', '--locale-off-background-color': '1' }, 768);
    expect(out).toContain('background-color: #aa8ad9 !important');
    expect(out).toContain('--locale-off-background-color: 1 !important');
  });

  test('bare numeric values are px-normalized (gap: 45 was invalid dead CSS)', () => {
    const code = page(`
    [data-id="hero"] { color: red; }
  `);
    const out = updateLocaleStyleInCode(code, 'hero', 'fr', { gap: '45' }, 768);
    expect(out).toContain('gap: 45px !important');
    // Unitless props stay bare.
    const out2 = updateLocaleStyleInCode(code, 'hero', 'fr', { opacity: '0.5' }, 768);
    expect(out2).toContain('opacity: 0.5 !important');
  });

  test('creates the band when none exists for that width', () => {
    const code = page(`
    [data-id="hero"] { color: red; }
  `);
    const out = updateLocaleStyleInCode(code, 'hero', 'fr', { borderRadius: '8px' }, 375);
    expect(out).toMatch(/@media \(max-width: 375px\)\s*\{[\s\S]*:lang\(fr\) \[data-id="hero"\] \{ border-radius: 8px !important; \}/);
  });

  test('merges into an existing banded :lang rule (marker + value coexist)', () => {
    const code = page(`
    @media (max-width: 375px) {
      :lang(fr) [data-id="hero"] { border-radius: 22px !important; }
    }
  `);
    const out = updateLocaleStyleInCode(code, 'hero', 'fr', { '--locale-off-border-radius': '1' }, 375);
    expect(out).toMatch(/:lang\(fr\) \[data-id="hero"\] \{[^}]*border-radius: 22px !important[^}]*--locale-off-border-radius: 1 !important/);
  });
});

describe('cascade ordering — global :lang before bands', () => {
  test('a global locale write lands BEFORE the @media bands so banded locale rules win', () => {
    const code = `'use client';
export default function Page() {
  return (<div data-id="root"><style>{\`
    @media (max-width: 768px) and (min-width: 375px) {
      :lang(fr) [data-id="hero"] { background-color: #4995FF !important; }
    }
  \`}</style><p data-id="hero">Hi</p></div>);
}`;
    const out = updateLocaleStyleInCode(code, 'hero', 'fr', { backgroundColor: '#AA8AD9' });
    const globalIdx = out.indexOf(':lang(fr) [data-id="hero"] { background-color: #AA8AD9');
    const bandIdx = out.indexOf('@media (max-width: 768px)');
    expect(globalIdx).toBeGreaterThan(-1);
    expect(bandIdx).toBeGreaterThan(-1);
    // Global FIRST → the banded rule (equal specificity, later) wins at 768.
    expect(globalIdx).toBeLessThan(bandIdx);
    // The banded value survives the global rewrite.
    expect(out).toContain('#4995FF');
  });
});

describe('variant-scoped locale rules (design components)', () => {
  const COMP = `'use client';
import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
const variantConfig = [{ name: 'default', label: 'F', x: 0, y: 0, isPrimary: true }, { name: 'variant-1', label: 'F', x: 756, y: 0 }];
function DuZaBa({ style, initialVariant = 'default', ...rest }: any) {
  return <LayoutGroup>
    <motion.div layout={true} data-id="root-1" {...rest} data-name="Frame" style={{ position: 'absolute', width: '556px', backgroundColor: '#97cffc', ...style }}>
  <style>{\`
    :lang(fr) [data-id="child-2"] { background-color: #22bd21 !important; }
  \`}</style>
    <motion.div layout={true} data-id="child-2" data-name="Frame" style={{ position: 'absolute', backgroundColor: '#ffb3ba' }}></motion.div>
  </motion.div>
    </LayoutGroup>;
}
export default withResponsiveProps(DuZaBa);
`;

  test('variant write emits a data-variant-scoped rule + the root carrier attr', () => {
    const out = updateLocaleStyleInCode(COMP, 'child-2', 'fr', { backgroundColor: '#ff0000' }, undefined, 'variant-1');
    expect(out).toContain(':lang(fr) [data-variant="variant-1"] [data-id="child-2"] { background-color: #ff0000 !important; }');
    // global rule untouched; carrier attr on the ROOT only
    expect(out).toContain(':lang(fr) [data-id="child-2"] { background-color: #22bd21 !important; }');
    expect(out).toContain('data-id="root-1" data-variant={initialVariant}');
    const scoped = parseLocaleRulesScoped(out.match(/<style>\{`([\s\S]*?)`\}<\/style>/)![1]);
    expect(scoped.variants.get('variant-1')?.get('fr')?.get('child-2')?.get('background-color')).toBe('#ff0000');
    expect(scoped.global.get('fr')?.get('child-2')?.get('background-color')).toBe('#22bd21');
  });

  test('a GLOBAL locale write preserves variant-scoped rules', () => {
    const withVariant = updateLocaleStyleInCode(COMP, 'child-2', 'fr', { backgroundColor: '#ff0000' }, undefined, 'variant-1');
    const out = updateLocaleStyleInCode(withVariant, 'child-2', 'fr', { backgroundColor: '#111111' });
    expect(out).toContain('[data-variant="variant-1"] [data-id="child-2"] { background-color: #ff0000');
    expect(out).toContain(':lang(fr) [data-id="child-2"] { background-color: #111111');
  });

  test('variant removal bake (value + marker) and re-set clears the marker', () => {
    const withVariant = updateLocaleStyleInCode(COMP, 'child-2', 'fr', { backgroundColor: '#ff0000' }, undefined, 'variant-1');
    const removed = updateLocaleStyleInCode(withVariant, 'child-2', 'fr',
      { backgroundColor: '#ffb3ba', '--locale-off-background-color': '1' }, undefined, 'variant-1');
    const sr = parseLocaleRulesScoped(removed.match(/<style>\{`([\s\S]*?)`\}<\/style>/)![1]);
    const props = sr.variants.get('variant-1')!.get('fr')!.get('child-2')!;
    expect(props.get('--locale-off-background-color')).toBe('1');
    const reset = updateLocaleStyleInCode(removed, 'child-2', 'fr', { backgroundColor: '#00ff00' }, undefined, 'variant-1');
    expect(reset).not.toContain('--locale-off-background-color');
    expect(reset).toContain('[data-variant="variant-1"] [data-id="child-2"] { background-color: #00ff00');
  });

  test('empty-value variant write deletes the scoped rule entirely', () => {
    const withVariant = updateLocaleStyleInCode(COMP, 'child-2', 'fr', { backgroundColor: '#ff0000' }, undefined, 'variant-1');
    const cleared = updateLocaleStyleInCode(withVariant, 'child-2', 'fr',
      { backgroundColor: '', '--locale-off-background-color': '' }, undefined, 'variant-1');
    expect(cleared).not.toContain('data-variant="variant-1"] [data-id="child-2"]');
    expect(cleared).toContain(':lang(fr) [data-id="child-2"]');
  });

  test('ensureRootDataVariantAttr upgrades to {variant} when connection state exists', () => {
    const withState = COMP.replace("function DuZaBa({", "function DuZaBa({")
      .replace('return <LayoutGroup>', 'const [variant, setVariant] = useState(initialVariant);\n  return <LayoutGroup>');
    const out = ensureRootDataVariantAttr(withState);
    expect(out).toContain('data-variant={variant}');
  });
});
