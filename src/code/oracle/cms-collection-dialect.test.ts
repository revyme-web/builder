import { describe, it, expect, vi } from 'vitest';
vi.mock('@/shared/debug-trace', () => ({ trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn() } }));
import { checkFile } from './check-file';

// ─────────────────────────────────────────────────────────────────────────────
// CMS COLLECTION LIST dialect oracle. Six rules that catch the wrong `.map()`
// repeater shapes which PARSE but crash / render empty / can't be edited:
//   CMS_RESPONSIVE_BLOCK_MISSING · CMS_LISTCFG_UNDECLARED ·
//   CMS_PAGINATION_VAR_UNDECLARED · CMS_VARIANT_REF_ON_PAGE ·
//   CMS_MAP_EMPTY_TEMPLATE · CMS_ROW_HIDE_ANIMATEPRESENCE
// Each test: the wrong form FIRES the rule; the canonical form passes that rule.
// ─────────────────────────────────────────────────────────────────────────────

const CMS_CODES = new Set([
  'CMS_RESPONSIVE_BLOCK_MISSING',
  'CMS_LISTCFG_UNDECLARED',
  'CMS_PAGINATION_VAR_UNDECLARED',
  'CMS_VARIANT_REF_ON_PAGE',
  'CMS_MAP_EMPTY_TEMPLATE',
  'CMS_ROW_HIDE_ANIMATEPRESENCE',
]);

// All collection-dialect violations for a file (filters out unrelated oracle noise).
const cms = (code: string, kind: 'page' | 'component' = 'page') =>
  checkFile(code, { kind }).filter((x) => CMS_CODES.has(x.code));
const has = (code: string, ruleCode: string, kind: 'page' | 'component' = 'page') =>
  cms(code, kind).some((x) => x.code === ruleCode);

// A minimal page shell wrapping a JSX body.
const PAGE = (body: string, hooks = '', imports = '') => `'use client';
import React, { useState } from 'react';
import advisors from '@/cms/advisors.json';
${imports}
export default function Page() {
${hooks}
  return <div data-id="root" data-name="Page" style={{ position: 'relative' }}>
${body}
  </div>;
}`;

// A minimal design-component shell (withResponsiveProps export, initialVariant param).
const COMP = (body: string, hooks = '', imports = '') => `'use client';
import React, { useState } from 'react';
import advisors from '@/cms/advisors.json';
${imports}
function Card({ initialVariant = 'default' }) {
${hooks}
  return <motion.div data-id="root" data-name="Card" style={{ position: 'relative' }}>
${body}
  </motion.div>;
}
export default withResponsiveProps(Card);`;

// The @responsiveList interpreter block (what the editor auto-injects).
const RESP_BLOCK = `
// @responsiveList-begin
function useResponsiveListConfig(base, vp, w, v, vo) { return base; }
function __applyListConfig(arr, cfg) { return arr; }
function __matchListFilter(item, f) { return true; }
function __cmpListSort(a, b, s) { return 0; }
// @responsiveList-end`;

describe('CMS_RESPONSIVE_BLOCK_MISSING', () => {
  // Declared listCfg, uses __applyListConfig, but NO interpreter block → crash.
  const BAD = COMP(
    `    {__applyListConfig(advisors, listCfgRoot).map((item, idx) => <a data-id="row" key={idx}>{item.name}</a>)}`,
    `  const listCfgRoot = useResponsiveListConfig({}, {}, [1440], initialVariant, {});`,
  );
  it('fires when __applyListConfig is used without its interpreter block', () => {
    expect(has(BAD, 'CMS_RESPONSIVE_BLOCK_MISSING', 'component')).toBe(true);
  });
  it('passes clean once the @responsiveList block is present', () => {
    const GOOD = COMP(
      `    {__applyListConfig(advisors, listCfgRoot).map((item, idx) => <a data-id="row" key={idx}>{item.name}</a>)}`,
      `  const listCfgRoot = useResponsiveListConfig({}, {}, [1440], initialVariant, {});`,
    ) + RESP_BLOCK;
    expect(has(GOOD, 'CMS_RESPONSIVE_BLOCK_MISSING', 'component')).toBe(false);
  });
  it('does not fire for a plain inline-chain list (no __applyListConfig)', () => {
    const PLAIN = PAGE(`    {advisors.slice(0, 6).map((item, idx) => <a data-id="row" key={idx}>{item.name}</a>)}`);
    expect(has(PLAIN, 'CMS_RESPONSIVE_BLOCK_MISSING')).toBe(false);
  });
});

describe('CMS_LISTCFG_UNDECLARED', () => {
  // Interpreter block present, but the listCfg const is missing → ReferenceError.
  const BAD = COMP(
    `    {__applyListConfig(advisors, listCfgRoot).map((item, idx) => <a data-id="row" key={idx}>{item.name}</a>)}`,
  ) + RESP_BLOCK;
  it('fires when __applyListConfig references an undeclared config var', () => {
    expect(has(BAD, 'CMS_LISTCFG_UNDECLARED', 'component')).toBe(true);
  });
  it('passes clean once the listCfg const is declared', () => {
    const GOOD = COMP(
      `    {__applyListConfig(advisors, listCfgRoot).map((item, idx) => <a data-id="row" key={idx}>{item.name}</a>)}`,
      `  const listCfgRoot = useResponsiveListConfig({}, {}, [1440], initialVariant, {});`,
    ) + RESP_BLOCK;
    expect(has(GOOD, 'CMS_LISTCFG_UNDECLARED', 'component')).toBe(false);
  });
});

describe('CMS_PAGINATION_VAR_UNDECLARED', () => {
  // Slices by visRoot but never declares it.
  const BAD = PAGE(
    `    {advisors.slice(0, visRoot).map((item, idx) => <a data-id="row" key={idx}>{item.name}</a>)}`,
  );
  it('fires when .slice(0, visX) has no useState declaration', () => {
    expect(has(BAD, 'CMS_PAGINATION_VAR_UNDECLARED')).toBe(true);
  });
  it('passes clean once the useState pagination var is declared', () => {
    const GOOD = PAGE(
      `    {advisors.slice(0, visRoot).map((item, idx) => <a data-id="row" key={idx}>{item.name}</a>)}`,
      `  const [visRoot, setVisRoot] = useState(3);`,
    );
    expect(has(GOOD, 'CMS_PAGINATION_VAR_UNDECLARED')).toBe(false);
  });
  it('does not fire for a static numeric slice (no pagination)', () => {
    const STATIC = PAGE(`    {advisors.slice(0, 6).map((item, idx) => <a data-id="row" key={idx}>{item.name}</a>)}`);
    expect(has(STATIC, 'CMS_PAGINATION_VAR_UNDECLARED')).toBe(false);
  });
});

describe('CMS_VARIANT_REF_ON_PAGE', () => {
  // A page that references initialVariant (copied from a component, not demoted).
  const BAD = PAGE(
    `    {__applyListConfig(advisors, listCfgRoot).map((item, idx) => <a data-id="row" key={idx}>{item.name}</a>)}`,
    `  const listCfgRoot = useResponsiveListConfig({}, {}, [1440], initialVariant, {});`,
  ) + RESP_BLOCK;
  it('fires when a PAGE references the component-only initialVariant', () => {
    expect(has(BAD, 'CMS_VARIANT_REF_ON_PAGE')).toBe(true);
  });
  it('passes clean when the page is demoted (initialVariant → undefined)', () => {
    const GOOD = PAGE(
      `    {__applyListConfig(advisors, listCfgRoot).map((item, idx) => <a data-id="row" key={idx}>{item.name}</a>)}`,
      `  const listCfgRoot = useResponsiveListConfig({}, {}, [1440], undefined, {});`,
    ) + RESP_BLOCK;
    expect(has(GOOD, 'CMS_VARIANT_REF_ON_PAGE')).toBe(false);
  });
  it('does NOT fire inside a design component (initialVariant is a bound param)', () => {
    const inComp = COMP(
      `    {__applyListConfig(advisors, listCfgRoot).map((item, idx) => <a data-id="row" key={idx}>{item.name}</a>)}`,
      `  const listCfgRoot = useResponsiveListConfig({}, {}, [1440], initialVariant, {});`,
    ) + RESP_BLOCK;
    expect(has(inComp, 'CMS_VARIANT_REF_ON_PAGE', 'component')).toBe(false);
  });
  it('does NOT false-positive on a component-instance prop initialVariant="x"', () => {
    const instance = PAGE(`    <MaQiWe data-id="inst" initialVariant="variant-1" />`);
    expect(has(instance, 'CMS_VARIANT_REF_ON_PAGE')).toBe(false);
  });
  it('does NOT false-positive on an "initialVariant" JSON key in data-responsive', () => {
    const respAttr = PAGE(`    <MaQiWe data-id="inst" data-responsive='{"768":{"initialVariant":"variant-1"}}' />`);
    expect(has(respAttr, 'CMS_VARIANT_REF_ON_PAGE')).toBe(false);
  });
});

describe('CMS_MAP_EMPTY_TEMPLATE', () => {
  it('fires when the CMS .map() callback returns null (detached template)', () => {
    const BAD = PAGE(`    {advisors.map((item, idx) => null)}`);
    expect(has(BAD, 'CMS_MAP_EMPTY_TEMPLATE')).toBe(true);
  });
  it('fires for a CMS chain map (filter→slice→map) returning null', () => {
    const BAD = PAGE(`    {advisors.filter(x => x.active).slice(0, 6).map((item, idx) => null)}`);
    expect(has(BAD, 'CMS_MAP_EMPTY_TEMPLATE')).toBe(true);
  });
  it('passes clean for a CMS .map() that returns a real row template', () => {
    const GOOD = PAGE(`    {advisors.map((item, idx) => <a data-id="row" key={idx}>{item.name}</a>)}`);
    expect(has(GOOD, 'CMS_MAP_EMPTY_TEMPLATE')).toBe(false);
  });
  it('does NOT fire for a NON-CMS .map(() => null) (not a collection)', () => {
    const NON_CMS = PAGE(`    {[1, 2, 3].map((item, idx) => null)}`);
    expect(has(NON_CMS, 'CMS_MAP_EMPTY_TEMPLATE')).toBe(false);
  });
});

describe('CMS_ROW_HIDE_ANIMATEPRESENCE', () => {
  it('fires when an AnimatePresence wraps a row INSIDE a .map() callback', () => {
    const BAD = COMP(
      `    {advisors.map((item, idx) => <AnimatePresence key={idx}>{visible && <a data-id="row">{item.name}</a>}</AnimatePresence>)}`,
    );
    expect(has(BAD, 'CMS_ROW_HIDE_ANIMATEPRESENCE', 'component')).toBe(true);
  });
  it('passes clean for inline display-ternary per-variant hide on the row', () => {
    const GOOD = COMP(
      `    {advisors.map((item, idx) => <a data-id="row" key={idx} style={{ display: initialVariant === 'variant-1' ? 'none' : 'flex' }}>{item.name}</a>)}`,
    );
    expect(has(GOOD, 'CMS_ROW_HIDE_ANIMATEPRESENCE', 'component')).toBe(false);
  });
  it('does NOT fire for an AnimatePresence OUTSIDE a .map() (normal element)', () => {
    const NORMAL = COMP(`    <AnimatePresence>{visible && <div data-id="box">hi</div>}</AnimatePresence>`);
    expect(has(NORMAL, 'CMS_ROW_HIDE_ANIMATEPRESENCE', 'component')).toBe(false);
  });
  it('does NOT fire for AnimatePresence inside a NON-CMS .map() (legit list animation)', () => {
    const NON_CMS = COMP(
      `    {items.map((item, idx) => <AnimatePresence key={idx}>{item.open && <div data-id="card">{item.t}</div>}</AnimatePresence>)}`,
    );
    expect(has(NON_CMS, 'CMS_ROW_HIDE_ANIMATEPRESENCE', 'component')).toBe(false);
  });
});

describe('no false positives on a non-CMS page', () => {
  it('a plain page with no collection list produces zero CMS-collection violations', () => {
    const plain = PAGE(`    <div data-id="box" style={{ position: 'relative' }}>hello</div>`);
    expect(cms(plain)).toEqual([]);
  });
});
