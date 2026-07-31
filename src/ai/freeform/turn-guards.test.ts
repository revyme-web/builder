import { describe, it, expect } from 'vitest';
import { checkSubmitPath, checkPreservation, checkComponentCompat, checkTokenRefs, extractComponentProps } from './turn-guards';

const codes = (vs: { code: string }[]) => vs.map((v) => v.code);

describe('checkSubmitPath — path discipline', () => {
  it('accepts the canonical component path', () => {
    expect(checkSubmitPath('components/HeroCard.tsx', 'component')).toEqual([]);
  });

  it.each([
    'app/(Header)/LayoutClient.tsx',  // the template-clobber hole
    'app/layout.tsx',                 // the server shell
    'lib/withResponsiveProps.tsx',
    'icons/SeYuSe.tsx',
    'styles/tokens.css',
    '_meta/comments.json',
    'components/lowercase.tsx',       // not PascalCase
    'components/nested/Deep.tsx',     // no nesting
    'components/Hero.ts',             // wrong extension
  ])('bounces component kind at %s with COMPONENT_PATH_SHAPE', (path) => {
    expect(codes(checkSubmitPath(path, 'component'))).toEqual(['COMPONENT_PATH_SHAPE']);
  });

  it('accepts page kind on page.client.tsx and LayoutClient.tsx', () => {
    expect(checkSubmitPath('app/ergeg/page.client.tsx', 'page')).toEqual([]);
    expect(checkSubmitPath('app/(Header)/LayoutClient.tsx', 'page')).toEqual([]);
  });

  it.each([
    'app/layout.tsx',                 // server shell — isLayoutFile matches it, the gate must not
    'app/(Header)/layout.tsx',
    'lib/cursor-runtime.tsx',
    'cms/posts.json',
    'app/page.tsx',                   // server wrapper half, not the client page
  ])('bounces page kind at %s with PROTECTED_PATH', (path) => {
    expect(codes(checkSubmitPath(path, 'page'))).toEqual(['PROTECTED_PATH']);
  });
});

describe('checkPreservation — builder-owned constructs survive edits', () => {
  const CANVAS_BLOCK = `/** @canvas {
  "viewports": [{ "id": "desktop", "label": "Desktop", "width": 1440, "height": 900, "isPrimary": true, "order": 0 }],
  "positions": { "desktop": { "x": 0, "y": 0 } }
} */`;
  const OLD_PAGE = `'use client';

${CANVAS_BLOCK}

import React from 'react';

export default function Page() {
  return <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%' }}>
    <div data-id="hero" data-name="Hero" data-scroll-fx='{"speed":110}' style={{ display: 'flex' }} />
    <style>{\`@media (max-width: 768px){ [data-id="hero"] { display: none; } }\`}</style>
  </div>;
}`;

  it('stays silent on a no-op resubmit (prime rule)', () => {
    expect(checkPreservation(OLD_PAGE, OLD_PAGE)).toEqual([]);
  });

  it('bounces a removed @canvas block', () => {
    const next = OLD_PAGE.replace(CANVAS_BLOCK, '');
    expect(codes(checkPreservation(OLD_PAGE, next))).toContain('CANVAS_CONFIG_DESTROYED');
  });

  it('bounces an EDITED @canvas block (verbatim is the law)', () => {
    const next = OLD_PAGE.replace('"width": 1440', '"width": 1280');
    expect(codes(checkPreservation(OLD_PAGE, next))).toContain('CANVAS_CONFIG_DESTROYED');
  });

  it('bounces a stripped tool-owned attribute when the element survives', () => {
    const next = OLD_PAGE.replace(` data-scroll-fx='{"speed":110}'`, '');
    const vs = checkPreservation(OLD_PAGE, next);
    expect(codes(vs)).toContain('TOOL_OWNED_FX_REMOVED');
    expect(vs.find((x) => x.code === 'TOOL_OWNED_FX_REMOVED')!.message).toContain('data-scroll-fx');
  });

  it('allows deleting the whole element that carried the tool-owned attribute', () => {
    const next = OLD_PAGE.replace(
      `<div data-id="hero" data-name="Hero" data-scroll-fx='{"speed":110}' style={{ display: 'flex' }} />`,
      '',
    );
    expect(codes(checkPreservation(OLD_PAGE, next))).not.toContain('TOOL_OWNED_FX_REMOVED');
  });

  it('the CSS selector form [data-id="x"] does not count as element-retained', () => {
    // element deleted but the @media rule mentioning it remains — no bounce
    const next = OLD_PAGE.replace(
      `<div data-id="hero" data-name="Hero" data-scroll-fx='{"speed":110}' style={{ display: 'flex' }} />`,
      '',
    );
    expect(next).toContain('[data-id="hero"]'); // the style block still has it
    expect(codes(checkPreservation(OLD_PAGE, next))).not.toContain('TOOL_OWNED_FX_REMOVED');
  });

  it('catches attribute-before-data-id order too', () => {
    const old = `<div data-scroll-variant='{"to":"v1"}' data-id="card" style={{ display: 'flex' }} />`;
    const next = `<div data-id="card" style={{ display: 'flex' }} />`;
    expect(codes(checkPreservation(old, next))).toContain('TOOL_OWNED_FX_REMOVED');
  });

  it('bounces a removed @pageVariables block', () => {
    const old = `/** @pageVariables {"fade":{"type":"number","default":1}} */\n${OLD_PAGE}`;
    expect(codes(checkPreservation(old, OLD_PAGE))).toContain('PAGE_VARIABLES_DESTROYED');
  });

});

describe('checkComponentCompat — instances keep working across component edits', () => {
  const OLD_COMPONENT = `import React from 'react';
import { withResponsiveProps } from '@revyme/runtime';

/** @name "Card" */

const variantConfig = [
{ name: 'default', label: 'Closed', x: 0, y: 0, isPrimary: true },
{ name: 'open', label: 'Open', x: 520, y: 0 }];

function HeroCard({ style, initialVariant = 'default', accentColor = '#ff4524' }) {
  return <div data-id="card" style={{ position: 'absolute', width: '320px', ...style }} />;
}

export default withResponsiveProps(HeroCard);
`;

  const PAGE_USING_OPEN = {
    path: 'app/page.client.tsx',
    code: `'use client';
import HeroCard from '@/components/HeroCard';
export default function Page() {
  return <div data-id="root" style={{ position: 'relative', width: '100%' }}>
    <HeroCard data-id="hero-card" data-name="Hero Card" initialVariant="open" accentColor="#3b82f6" style={{ position: 'relative' }} />
  </div>;
}`,
  };

  it('extractComponentProps reads the destructured signature', () => {
    expect([...(extractComponentProps(OLD_COMPONENT) ?? [])]).toEqual(['style', 'initialVariant', 'accentColor']);
  });

  it('bounces removing a variant an instance references', () => {
    const next = OLD_COMPONENT.replace(`,\n{ name: 'open', label: 'Open', x: 520, y: 0 }`, '');
    const vs = checkComponentCompat('components/HeroCard.tsx', OLD_COMPONENT, next, [PAGE_USING_OPEN]);
    expect(codes(vs)).toContain('VARIANT_REMOVED_IN_USE');
    expect(vs[0].message).toContain('app/page.client.tsx');
  });

  it('bounces removing a prop an instance passes', () => {
    const next = OLD_COMPONENT.replace(`, accentColor = '#ff4524'`, '');
    expect(codes(checkComponentCompat('components/HeroCard.tsx', OLD_COMPONENT, next, [PAGE_USING_OPEN])))
      .toContain('PROP_REMOVED_IN_USE');
  });

  it('resolves cleanly when the SAME batch updates the consuming page', () => {
    const next = OLD_COMPONENT.replace(`,\n{ name: 'open', label: 'Open', x: 520, y: 0 }`, '');
    const updatedPage = { ...PAGE_USING_OPEN, code: PAGE_USING_OPEN.code.replace(' initialVariant="open"', '') };
    expect(checkComponentCompat('components/HeroCard.tsx', OLD_COMPONENT, next, [updatedPage])
      .filter((v) => v.code === 'VARIANT_REMOVED_IN_USE')).toEqual([]);
  });

  it('reads data-responsive variant references too', () => {
    const page = {
      path: 'app/page.client.tsx',
      code: `import HeroCard from '@/components/HeroCard';
<HeroCard data-id="hc" data-responsive='{"768":"open"}' style={{ position: 'relative' }} />`,
    };
    const next = OLD_COMPONENT.replace(`,\n{ name: 'open', label: 'Open', x: 520, y: 0 }`, '');
    expect(codes(checkComponentCompat('components/HeroCard.tsx', OLD_COMPONENT, next, [page])))
      .toContain('VARIANT_REMOVED_IN_USE');
  });

  it('stays silent when removed things are unused, and on a no-op rewrite', () => {
    const pageNotUsing = { path: 'app/other/page.client.tsx', code: `<div data-id="root" />` };
    const next = OLD_COMPONENT.replace(`,\n{ name: 'open', label: 'Open', x: 520, y: 0 }`, '');
    expect(checkComponentCompat('components/HeroCard.tsx', OLD_COMPONENT, next, [pageNotUsing])).toEqual([]);
    expect(checkComponentCompat('components/HeroCard.tsx', OLD_COMPONENT, OLD_COMPONENT, [PAGE_USING_OPEN])).toEqual([]);
  });
});

describe('checkTokenRefs — var(--x) must resolve', () => {
  const KNOWN = new Set(['color-brand', 'typo-heading-size-default', 'radius-card']);

  it('passes refs to existing tokens (with and without fallback)', () => {
    const code = `<div data-id="a" style={{ backgroundColor: 'var(--color-brand)', borderRadius: 'var(--radius-card, 8px)' }} />`;
    expect(checkTokenRefs(code, KNOWN)).toEqual([]);
  });

  it('bounces an invented token with the available list in the message', () => {
    const code = `<div data-id="a" style={{ color: 'var(--color-imaginary)' }} />`;
    const vs = checkTokenRefs(code, KNOWN);
    expect(vs.map((v) => v.code)).toEqual(['UNKNOWN_TOKEN']);
    expect(vs[0].message).toContain('color-imaginary');
    expect(vs[0].message).toContain('color-brand');
  });

  it('allows custom properties DECLARED in the same file (border-overlay variable pattern)', () => {
    const code = `<div data-id="a" style={{ '--cardBorder': cardBorder }} /><style>{\`[data-id="a"]::after { border: var(--cardBorder); }\`}</style>`;
    expect(checkTokenRefs(code, new Set())).toEqual([]);
  });

  it('dedupes repeated refs to the same unknown token', () => {
    const code = `<div data-id="a" style={{ color: 'var(--nope)', backgroundColor: 'var(--nope)' }} />`;
    expect(checkTokenRefs(code, KNOWN)).toHaveLength(1);
  });
});
