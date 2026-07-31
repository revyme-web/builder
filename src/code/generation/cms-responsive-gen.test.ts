import { describe, it, expect } from 'vitest';
import { parse } from '@babel/parser';
import {
  writeResponsiveListConfigInCode,
  listConfigVar,
  hasResponsiveOverrides,
  ensureResponsiveListHooks,
  rewriteListConfigBreakpoints,
  addListConfigBreakpoint,
  removeListConfigBreakpoint,
  type ResponsiveListConfig,
} from './cms-responsive-gen';
import { parseJSXToNodes } from '@/code/parsing/parser';

// A design-component master with a collection list inside a `function Name()` body
// (variant discriminator `initialVariant` in scope) — the per-variant axis case.
const COMPONENT_CODE = `'use client';
import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import Link from 'next/link';
import { withResponsiveProps } from '@revyme/runtime';
import blog from '@/cms/blog.json';

function Card({ style, initialVariant = 'default' }) {
  return <motion.div data-id="list" style={{ display: 'flex' }}>
    {blog.filter(item => item.featured === true).map((item, idx) => <Link data-id="row" key={idx} href="#">{item.title}</Link>)}
  </motion.div>;
}
export default withResponsiveProps(Card);`;

const emptyCfg = (): ResponsiveListConfig => ({ base: {}, viewport: {}, variants: {} });

const parses = (code: string): boolean => {
  try {
    parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] });
    return true;
  } catch {
    return false;
  }
};

describe('writeResponsiveListConfigInCode', () => {
  it('upgrades to __applyListConfig + const + hook block when a per-variant override is added', () => {
    const cfg: ResponsiveListConfig = {
      base: { filterGroup: { combinator: 'and', filters: [{ field: 'featured', operator: 'equals', value: true }] } },
      viewport: {},
      variants: { 'variant-1': { filterGroup: { combinator: 'and', filters: [{ field: 'pinned', operator: 'equals', value: true }] } } },
    };
    const out = writeResponsiveListConfigInCode(COMPONENT_CODE, 'list', 'blog', cfg, { variantArg: 'initialVariant', vpWidths: [] });

    // Upgraded array expr replaces the inline chain; .map(template) preserved.
    expect(out).toContain(`__applyListConfig(blog, ${listConfigVar('list')})`);
    expect(out).toContain('.map((item, idx) =>');
    expect(out).toContain('{item.title}');                 // template untouched
    expect(out).not.toContain('blog.filter(item =>');       // inline filter gone

    // The const carries base + per-variant overrides as JSON, variant arg in scope.
    expect(out).toContain(`const ${listConfigVar('list')} = useResponsiveListConfig(`);
    expect(out).toContain('"featured"');                    // base filter
    expect(out).toContain('"variant-1"');                   // variant override key
    expect(out).toContain(', initialVariant, ');            // discriminator in scope

    // The per-page hook block is injected once.
    expect(out).toContain('// @responsiveList-begin');
    expect(out).toContain('function __applyListConfig(');
    expect(out).toContain('function __matchListFilter(');

    expect(parses(out)).toBe(true);
  });

  it('emits the LIVE `variant` state token (not initialVariant) when the component has variant connections', () => {
    // When a design component has connection-driven variant switching it carries a
    // `const [variant, setVariant]` state that framer-motion animates on. The list
    // config must read THAT so it re-filters as the component switches variants
    // (initialVariant is frozen → list never updates during an animate preview).
    const CONNECTED_CODE = COMPONENT_CODE.replace(
      'function Card({ style, initialVariant = \'default\' }) {',
      'function Card({ style, initialVariant = \'default\' }) {\n  const [variant, setVariant] = useState(initialVariant);',
    );
    const cfg: ResponsiveListConfig = {
      base: {},
      viewport: {},
      variants: { 'variant-1': { filterGroup: { combinator: 'and', filters: [{ field: 'pinned', operator: 'equals', value: true }] } } },
    };
    const out = writeResponsiveListConfigInCode(CONNECTED_CODE, 'list', 'blog', cfg, { variantArg: 'initialVariant', vpWidths: [] });
    expect(out).toContain(', variant, ');          // live state token
    expect(out).not.toContain(', initialVariant, ');// NOT the frozen prop
    expect(parses(out)).toBe(true);
  });

  it('downgrades back to the inline chain (byte-identical-ish) + prunes const & hooks when overrides removed', () => {
    const cfg: ResponsiveListConfig = {
      base: { filterGroup: { combinator: 'and', filters: [{ field: 'featured', operator: 'equals', value: true }] } },
      viewport: {},
      variants: { 'variant-1': { filterGroup: { combinator: 'and', filters: [{ field: 'pinned', operator: 'equals', value: true }] } } },
    };
    const upgraded = writeResponsiveListConfigInCode(COMPONENT_CODE, 'list', 'blog', cfg, { variantArg: 'initialVariant', vpWidths: [] });

    // Remove the variant override → no overrides → downgrade.
    const downCfg: ResponsiveListConfig = { base: cfg.base, viewport: {}, variants: {} };
    const out = writeResponsiveListConfigInCode(upgraded, 'list', 'blog', downCfg, { variantArg: 'initialVariant', vpWidths: [] });

    expect(out).toContain('blog.filter(item => item.featured === true).map((item, idx) =>');
    expect(out).not.toContain('__applyListConfig(');
    expect(out).not.toContain('useResponsiveListConfig(');   // const removed
    expect(out).not.toContain('// @responsiveList-begin');    // hooks pruned
    expect(parses(out)).toBe(true);
  });

  it('keeps the pagination slice tail on the upgraded expr', () => {
    const cfg: ResponsiveListConfig = {
      base: {},
      viewport: {},
      variants: { 'variant-1': { sort: [{ field: 'date', direction: 'desc' }] } },
    };
    const out = writeResponsiveListConfigInCode(COMPONENT_CODE, 'list', 'blog', cfg, { paginationVar: 'visList', variantArg: 'initialVariant' });
    expect(out).toContain(`__applyListConfig(blog, ${listConfigVar('list')}).slice(0, visList).map(`);
    expect(parses(out)).toBe(true);
  });

  it('re-emits cleanly when already upgraded (edit a second variant)', () => {
    const cfg1: ResponsiveListConfig = {
      base: {}, viewport: {},
      variants: { 'variant-1': { sort: [{ field: 'date', direction: 'desc' }] } },
    };
    const once = writeResponsiveListConfigInCode(COMPONENT_CODE, 'list', 'blog', cfg1, { variantArg: 'initialVariant', vpWidths: [] });
    const cfg2: ResponsiveListConfig = {
      base: {}, viewport: {},
      variants: {
        'variant-1': { sort: [{ field: 'date', direction: 'desc' }] },
        'variant-2': { sort: [{ field: 'title', direction: 'asc' }] },
      },
    };
    const twice = writeResponsiveListConfigInCode(once, 'list', 'blog', cfg2, { variantArg: 'initialVariant', vpWidths: [] });
    expect(twice).toContain('"variant-2"');
    // exactly one __applyListConfig wrap (not doubled)
    expect(twice.match(/__applyListConfig\(blog,/g)?.length).toBe(1);
    // exactly one const
    expect(twice.match(/const listCfgList = useResponsiveListConfig/g)?.length).toBe(1);
    expect(parses(twice)).toBe(true);
  });

  it('ROUND-TRIP: generated upgraded shape parses back into base + per-variant config', () => {
    const cfg: ResponsiveListConfig = {
      base: { filterGroup: { combinator: 'and', filters: [{ field: 'featured', operator: 'equals', value: true }] } },
      viewport: { 768: { sort: [{ field: 'date', direction: 'desc' }] } },
      variants: { 'variant-1': { filterGroup: { combinator: 'and', filters: [{ field: 'category', operator: 'equals', value: 'News' }] } } },
    };
    const code = writeResponsiveListConfigInCode(COMPONENT_CODE, 'list', 'blog', cfg, { variantArg: 'initialVariant', vpWidths: [768, 1440] });

    const nodes = parseJSXToNodes(code);
    const list = nodes.get('list');
    expect(list?.collectionList).toBeTruthy();
    expect(list!.collectionList!.source).toBe('blog');
    // Base filter recovered from the config (not the inline chain).
    expect(list!.collectionList!.filterGroup).toEqual({ combinator: 'and', filters: [{ field: 'featured', operator: 'equals', value: true }] });
    // Per-variant override (filter only — sort inherits base = absent).
    expect(list!.collectionList!.variantConfigs?.['variant-1']?.filterGroup).toEqual({ combinator: 'and', filters: [{ field: 'category', operator: 'equals', value: 'News' }] });
    expect(list!.collectionList!.variantConfigs?.['variant-1']?.sort).toBeUndefined(); // inherits base
    // Per-viewport override (sort only — filter inherits base = absent).
    expect(list!.collectionList!.responsive?.['768']?.sort).toEqual([{ field: 'date', direction: 'desc' }]);
    expect(list!.collectionList!.responsive?.['768']?.filterGroup).toBeUndefined(); // inherits base
  });

  it('breakpoint sync: resize re-keys vp override + vpWidths; add/remove update vpWidths', () => {
    const cfg: ResponsiveListConfig = {
      base: {},
      viewport: { 768: { sort: [{ field: 'date', direction: 'desc' }] } },
      variants: {},
    };
    const code = writeResponsiveListConfigInCode(COMPONENT_CODE, 'list', 'blog', cfg, { variantArg: 'initialVariant', vpWidths: [768, 1440] });

    // Resize the 768 breakpoint → 810: the override key + vpWidths re-key.
    const resized = rewriteListConfigBreakpoints(code, 768, 810);
    expect(resized).toContain('"810":{"sort"');
    expect(resized).not.toContain('"768":{"sort"');
    expect(resized).toContain('[810,1440]');

    // Add a 375 viewport → appears in vpWidths (sorted), no override yet.
    const added = addListConfigBreakpoint(resized, 375);
    expect(added).toContain('[375,810,1440]');

    // Remove the 810 viewport → its override + width gone.
    const removed = removeListConfigBreakpoint(added, 810);
    expect(removed).not.toContain('"810":{"sort"');
    expect(removed).toContain('[375,1440]');
    expect(parses(removed)).toBe(true);
  });

  it('breakpoint sync does NOT touch the hook DEFINITION', () => {
    const cfg: ResponsiveListConfig = { base: {}, viewport: { 768: { sort: [{ field: 'x', direction: 'asc' }] } }, variants: {} };
    const code = writeResponsiveListConfigInCode(COMPONENT_CODE, 'list', 'blog', cfg, { variantArg: 'initialVariant', vpWidths: [768] });
    const out = rewriteListConfigBreakpoints(code, 768, 810);
    // The `function useResponsiveListConfig(...)` declaration is untouched + still parses.
    expect(out).toContain('function useResponsiveListConfig(base, vpOverrides, vpWidths, variant, variantOverrides)');
    expect(parses(out)).toBe(true);
  });

  it('hasResponsiveOverrides + ensureResponsiveListHooks helpers', () => {
    expect(hasResponsiveOverrides(emptyCfg())).toBe(false);
    expect(hasResponsiveOverrides({ base: {}, viewport: { 768: {} }, variants: {} })).toBe(false); // empty partial serializes away → still no real override... but key present
    expect(ensureResponsiveListHooks('const x = 1;')).toBe('const x = 1;'); // nothing to inject
  });
});
