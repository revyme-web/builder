import { describe, it, expect } from 'vitest';
import { transform } from '@babel/standalone';
import { setPaginationInCode, removePaginationInCode, paginationStateVar, buildLoadMoreComponentCode, LOADMORE_COMPONENT_NAME, buildSpinnerComponentCode, SPINNER_COMPONENT_NAME, readPaginationMarker, pruneOrphanedPaginationHooks } from './cms-pagination-gen';
import { updateCollectionListConfigInCode } from './cms-gen';
import { buildAutoImports } from '@/shared/import-detection.mjs';

const parses = (code: string) =>
  expect(() => transform(code, { presets: ['react', 'typescript'], filename: 'f.tsx' })).not.toThrow();

const PAGE = `import React from 'react';
import blog from '@/cms/blog.json';
export default function Page() {
  return <div data-id="root">
    <div data-id="list" style={{ display: 'flex', flexDirection: 'column' }}>
      {blog.map((item, idx) => <div data-id="row" key={idx}>{item.title}</div>)}
    </div>
  </div>;
}`;

const VAR = paginationStateVar('list'); // 'visList'
const SETTER = 'set' + VAR.charAt(0).toUpperCase() + VAR.slice(1); // 'setVisList'

describe('setPaginationInCode — Load More', () => {
  const out = setPaginationInCode(PAGE, 'list', { mode: 'loadMore', perPage: 3 });

  it('slices the list by the visibleCount state var', () => {
    expect(out).toContain(`{blog.slice(0, ${VAR}).map((item, idx)`);
  });
  it('emits the useState seeded to perPage', () => {
    expect(out).toContain(`const [${VAR}, setVisList] = useState(3)`);
  });
  it('injects a guarded <LoadMore> component instance wired to bump the count', () => {
    expect(out).toContain(`{${VAR} < blog.length && <LoadMore data-id="loadmore-list"`);
    expect(out).toContain(`onLoadMore={() => setVisList((c) => c + 3)}`);
  });
  it('adds the LoadMore component import', () => {
    expect(out).toContain("import LoadMore from '@/components/LoadMore';");
  });
  it('stamps the data-pagination round-trip marker', () => {
    expect(out).toContain('data-pagination="loadMore:3"');
  });
  it('produces parseable JSX', () => parses(out));
});

// A DESIGN COMPONENT is `function Name(...) {` + a SEPARATE `export default
// withResponsiveProps(Name)` — NOT `export default function`. The param list also
// carries a TS type annotation (`}: {style?: …})`). The old ensureHook matched only
// `export default function`, so inside a component it returned the code UNCHANGED →
// the `visX` useState was never declared → `ReferenceError: visX is not defined`.
const COMPONENT = `'use client';
import React, { useState } from 'react';
import { withResponsiveProps } from '@revyme/runtime';
import advisors from '@/cms/advisors.json';
function MaQiWe({ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  return <div data-id="frame-1">
    <div data-id="list" style={{ display: 'flex', flexDirection: 'column' }}>
      {advisors.map((item, idx) => <div data-id="row" key={idx}>{item.name}</div>)}
    </div>
  </div>;
}
export default withResponsiveProps(MaQiWe);`;

describe('setPaginationInCode — inside a DESIGN COMPONENT (regression: visX not defined)', () => {
  const out = setPaginationInCode(COMPONENT, 'list', { mode: 'loadMore', perPage: 3 });

  it('injects the useState into the component function body (not skipped)', () => {
    expect(out).toContain(`const [${VAR}, setVisList] = useState(3)`);
    // …right after the component fn brace, not a page/helper.
    expect(out).toMatch(/function MaQiWe\([\s\S]*?\)[^{]*\{\s*\n\s*const \[visList, setVisList\] = useState\(3\);/);
  });
  it('slices + wires the LoadMore instance', () => {
    expect(out).toContain(`{advisors.slice(0, ${VAR}).map((item, idx)`);
    expect(out).toContain(`onLoadMore={() => setVisList((c) => c + 3)}`);
  });
  it('produces parseable JSX', () => parses(out));
});

describe('setPaginationInCode — Infinite Scroll', () => {
  const out = setPaginationInCode(PAGE, 'list', { mode: 'infinite', perPage: 6 });

  it('emits the sentinel + IntersectionObserver effect + ref', () => {
    expect(out).toContain(`<div ref={${VAR}Ref} data-id="sentinel-list"`);
    expect(out).toContain(`const ${VAR}Ref = useRef(null)`);
    expect(out).toContain('new IntersectionObserver');
    expect(out).toContain('data-pagination="infinite:6"');
    expect(out).toContain(`{blog.slice(0, ${VAR}).map`);
  });
  it('mounts the Spinner loader inside the (guarded) sentinel + imports it', () => {
    expect(out).toContain(`{${VAR} < blog.length && <div ref={${VAR}Ref} data-id="sentinel-list"`);
    expect(out).toContain('<Spinner data-id="spinner-list" />');
    expect(out).toContain("import Spinner from '@/components/Spinner';");
  });
  it('produces parseable JSX', () => parses(out));
});

describe('buildSpinnerComponentCode — the infinite-scroll Spinner master', () => {
  const code = buildSpinnerComponentCode();
  it('is a conic-gradient ring with a continuous loop rotation', () => {
    parses(code);
    expect(code).toContain('/** @name "Spinner" */');
    expect(code).toContain(`function ${SPINNER_COMPONENT_NAME}({ style, initialVariant = 'default', ...rest }`);
    expect(code).toContain('data-id="spinner-root"');
    expect(code).toContain('data-id="spinner-conic"');
    expect(code).toContain('data-id="spinner-round"');
    expect(code).toContain('conic-gradient(');
    // Every element inside a design component must be motion.* (the canvas
    // measures them via the component pipeline) — NOT plain <div>.
    expect(code).not.toMatch(/<div data-id="spinner-(root|conic|round)"/);
    // The ROOT is a plain `layout` element (matches a Make-Component root the
    // canvas hit-test expects) — NOT animated (a spinning root mis-sized the
    // hover hit-area). The LOOP rotation lives on the Conic instead.
    expect(code).toContain('<motion.div layout={true} data-id="spinner-root"');
    expect(code).not.toMatch(/data-id="spinner-root"[^>]*animate=/);
    expect(code).toContain('data-name="Conic" animate={{ rotate: 360 }}');
    expect(code).toContain('repeat: Infinity');
    expect(code).toContain('<motion.div layout={true} data-id="spinner-round"');
    // The Conic must fill the root IN-FLOW (relative + 100%) — NOT absolute/inset,
    // which escaped its 20px box on canvas (its hit-area swallowed list hovers).
    expect(code).not.toContain("inset: 0");
    expect(code).toMatch(/data-id="spinner-conic"[\s\S]*?position: 'relative'/);
    expect(code).toContain('@spinner-gen v4');
    // radial mask turns the filled disc into a ring (no external asset).
    expect(code).toContain('radial-gradient(farthest-side');
    expect(code).toContain(`export default withResponsiveProps(${SPINNER_COMPONENT_NAME})`);
  });
});

describe('import sync — the React hooks must be importable (regression: validation block)', () => {
  it('buildAutoImports emits the React hook named-imports for an infinite-scroll body', () => {
    const out = setPaginationInCode(PAGE, 'list', { mode: 'infinite', perPage: 6 });
    const importLines = buildAutoImports(out).join('\n');
    // setPagination is in IMPORT_AFFECTING_TYPES, so the flush runs syncImports →
    // buildAutoImports, which must surface useState/useRef/useEffect.
    expect(importLines).toMatch(/import React, \{[^}]*\buseState\b[^}]*\} from 'react'/);
    expect(importLines).toContain('useRef');
    expect(importLines).toContain('useEffect');
  });
  it('load-more body needs useState imported', () => {
    const out = setPaginationInCode(PAGE, 'list', { mode: 'loadMore', perPage: 3 });
    expect(buildAutoImports(out).join('\n')).toMatch(/import React, \{[^}]*\buseState\b[^}]*\} from 'react'/);
  });
});

describe('buildLoadMoreComponentCode — the Load More component master', () => {
  const code = buildLoadMoreComponentCode();
  it('is a valid component with an event-type prop fired on click', () => {
    parses(code);
    expect(code).toContain('/** @propMeta {"onLoadMore":{"type":"event","label":"Load More"}} */');
    expect(code).toContain('/** @name "Load More" */');
    expect(code).toContain(`function ${LOADMORE_COMPONENT_NAME}({ style, initialVariant = 'default', onLoadMore, ...rest }`);
    expect(code).toContain('onClick={onLoadMore}');
    expect(code).toContain(`export default withResponsiveProps(${LOADMORE_COMPONENT_NAME})`);
    expect(code).toContain('const variantConfig = [{ name: \'default\'');
    // Frame+Text structure: a motion.div container with a motion.p text CHILD —
    // NOT a button with bare text (which doesn't resolve in the component pipeline).
    expect(code).toContain('<motion.div layout={true} data-id="loadmore-root"');
    expect(code).toContain('<motion.p layout={true} data-id="loadmore-label"');
    expect(code).toMatch(/<motion\.p[\s\S]*?>\s*Load More\s*<\/motion\.p>/);
    expect(code).not.toContain('motion.button');
    // Fit sizing must be min-content (NOT auto) so the flex/layout container shrinks
    // to its nowrap text — matches how the reference emits "Fit" (width: min-content).
    expect(code).toContain("width: 'min-content'");
    expect(code).toContain("height: 'min-content'");
  });
});

describe('removePaginationInCode', () => {
  it('restores the plain .map() and removes scaffold + hooks + import (Load More)', () => {
    const on = setPaginationInCode(PAGE, 'list', { mode: 'loadMore', perPage: 3 });
    const off = removePaginationInCode(on, 'list');
    expect(off).toContain('{blog.map((item, idx)');
    expect(off).not.toContain('data-pagination');
    expect(off).not.toContain('loadmore-list');
    expect(off).not.toContain('<LoadMore');
    expect(off).not.toContain("import LoadMore from '@/components/LoadMore'");
    expect(off).not.toContain(`${VAR}`);
    parses(off);
  });
  it('restores the plain .map() (Infinite Scroll) + strips Spinner + import', () => {
    const on = setPaginationInCode(PAGE, 'list', { mode: 'infinite', perPage: 6 });
    const off = removePaginationInCode(on, 'list');
    expect(off).toContain('{blog.map((item, idx)');
    expect(off).not.toContain('IntersectionObserver');
    expect(off).not.toContain('sentinel-list');
    expect(off).not.toContain('<Spinner');
    expect(off).not.toContain("import Spinner from '@/components/Spinner'");
    parses(off);
  });
  it('editing filter/sort on a paginated list keeps the visibleCount slice (not numeric limit)', () => {
    const on = setPaginationInCode(PAGE, 'list', { mode: 'loadMore', perPage: 3 });
    // Now change the config (filter) via the config writer — must preserve .slice(0, visList).
    const edited = updateCollectionListConfigInCode(on, 'list',
      { combinator: 'and', filters: [{ field: 'title', operator: 'contains', value: 'x' }] }, undefined, 5);
    expect(edited).toContain(`.slice(0, ${VAR})`);   // pagination slice preserved
    expect(edited).not.toContain('.slice(0, 5)');     // numeric limit did NOT win
    expect(edited).toContain('.filter(item =>');       // new filter applied
    parses(edited);
  });

  it('switching modes does not stack scaffolds (set loadMore then infinite)', () => {
    const a = setPaginationInCode(PAGE, 'list', { mode: 'loadMore', perPage: 3 });
    const b = setPaginationInCode(a, 'list', { mode: 'infinite', perPage: 6 });
    expect(b).not.toContain('loadmore-list');       // old button gone
    expect(b).toContain('sentinel-list');           // new sentinel present
    expect((b.match(/data-pagination=/g) || []).length).toBe(1);
    parses(b);
  });
});

describe('robust hook removal — survives reformatting + heals corruption', () => {
  it('a babel-reformatted body (no space after `{`) still removes the old observer', () => {
    let code = setPaginationInCode(PAGE, 'list', { mode: 'infinite', perPage: 3 });
    // Reformat collapses `=> { const el` to `=> {const el` (what babel-generate does).
    code = code.replace(/=> \{ const el/g, '=> {const el');
    code = setPaginationInCode(code, 'list', { mode: 'infinite', perPage: 1 });
    expect((code.match(/IntersectionObserver/g) || []).length).toBe(1);
    expect((code.match(/useState\(/g) || []).length).toBe(1);
    parses(code);
  });

  it('removePagination heals duplicate observers + the stray `;N;` residue trail', () => {
    const corrupted = `import React, { useState, useEffect, useRef } from 'react';
import advisors from '@/cms/advisors.json';
import Spinner from '@/components/Spinner';
export default function Page() {
  useEffect(() => {const el = ${VAR}Ref.current;if (!el) return;const io = new IntersectionObserver((entries) => {if (entries[0].isIntersecting) ${SETTER}((c) => Math.min(c + 1, advisors.length));});io.observe(el);return () => io.disconnect();}, []);
  const ${VAR}Ref = useRef(null);
  const [${VAR}, ${SETTER}] = useState(1);2;
  useEffect(() => {const el = ${VAR}Ref.current;if (!el) return;const io = new IntersectionObserver((entries) => {if (entries[0].isIntersecting) ${SETTER}((c) => Math.min(c + 3, advisors.length));});io.observe(el);return () => io.disconnect();}, []);3;3;2;5;
  return <div data-id="root"><div data-id="list" data-pagination="infinite:1">
    {advisors.slice(0, ${VAR}).map((item, idx) => <div data-id="row" key={idx}>{item.name}</div>)}
    {${VAR} < advisors.length && <div ref={${VAR}Ref} data-id="sentinel-list" data-pagination-ui="true" style={{ display: 'flex' }}><Spinner data-id="spinner-list" /></div>}
  </div></div>;
}`;
    const off = removePaginationInCode(corrupted, 'list');
    expect((off.match(/IntersectionObserver/g) || []).length).toBe(0);
    expect((off.match(/useState\(/g) || []).length).toBe(0);
    expect(off).not.toContain('<Spinner');
    expect(/;\s*\d+;/.test(off)).toBe(false);   // stray trail healed
    parses(off);
  });
});

describe('readPaginationMarker + re-apply after a source change', () => {
  it('reads the marker', () => {
    const on = setPaginationInCode(PAGE, 'list', { mode: 'infinite', perPage: 4 });
    expect(readPaginationMarker(on, 'list')).toEqual({ mode: 'infinite', perPage: 4 });
    expect(readPaginationMarker(PAGE, 'list')).toBeNull();
  });

  it('re-applying pagination after the chain head changes rewrites <slug>.length (no stale ref)', () => {
    // setPagination on the `blog` source → guard + useEffect reference blog.length.
    const on = setPaginationInCode(PAGE, 'list', { mode: 'infinite', perPage: 3 });
    expect(on).toContain('blog.length');
    // Simulate changeCollectionSource: it rewrites only the .map() chain head +
    // import (blog → advisors), leaving the pagination refs pointing at blog.
    const sourceChanged = on
      .replace('blog.slice(0,', 'advisors.slice(0,')
      .replace("import blog from '@/cms/blog.json';", "import advisors from '@/cms/advisors.json';");
    expect(sourceChanged).toContain('blog.length');   // stale ref before re-apply
    // The handler re-applies pagination from the marker → regenerates against the
    // new chain head (advisors), healing the stale blog.length references.
    const marker = readPaginationMarker(sourceChanged, 'list')!;
    const fixed = setPaginationInCode(sourceChanged, 'list', marker);
    expect(fixed).not.toContain('blog.length');
    expect(fixed).toContain('advisors.length');
    expect((fixed.match(/IntersectionObserver/g) || []).length).toBe(1);
    parses(fixed);
  });
});

describe('pruneOrphanedPaginationHooks', () => {
  it('removes hooks for a deleted list (no .slice references it) but keeps the live one', () => {
    // `visGhost` has no `.slice(0, visGhost)` (its list was deleted) → orphan,
    // still referencing the no-longer-imported `advisors`. `visLive` is sliced → keep.
    const code = `import React, { useState, useEffect, useRef } from 'react';
import blog from '@/cms/blog.json';
export default function Page() {
  useEffect(() => { const el = visGhostRef.current; if (!el) return; const io = new IntersectionObserver((entries) => { if (entries[0].isIntersecting) setVisGhost((c) => Math.min(c + 3, advisors.length)); }); io.observe(el); return () => io.disconnect(); }, []);
  const visGhostRef = useRef(null);
  const [visGhost, setVisGhost] = useState(3);
  const [visStrayLoadMore, setVisStrayLoadMore] = useState(2);
  const [visLive, setVisLive] = useState(3);
  return <div data-id="root"><div data-id="list" data-pagination="infinite:3">
    {blog.slice(0, visLive).map((item, idx) => <div data-id="row" key={idx}>{item.title}</div>)}
  </div></div>;
}`;
    const out = pruneOrphanedPaginationHooks(code);
    expect(out).not.toContain('visGhost');
    expect(out).not.toContain('visStrayLoadMore');
    expect(out).not.toContain('advisors.length');   // the orphan's stale ref is gone
    expect(out).not.toContain('IntersectionObserver');
    expect(out).toContain('const [visLive, setVisLive] = useState(3)'); // live one kept
    parses(out);
  });

  it('is a no-op when every vis* var is still sliced', () => {
    const on = setPaginationInCode(PAGE, 'list', { mode: 'infinite', perPage: 3 });
    expect(pruneOrphanedPaginationHooks(on)).toBe(on);
  });

  it('works on a RESPONSIVE-upgraded list (__applyListConfig head) — regression', () => {
    // A list with a per-variant/viewport override is `__applyListConfig(slug, cfg).map()`;
    // findCollectionChainHead returns null on it, so pagination used to silently bail.
    const upgraded = `import React from 'react';
import advisors from '@/cms/advisors.json';
export default function Page() {
  const listCfgList = useResponsiveListConfig({}, {}, [768], undefined, { 'variant-1': { sort: [{ field: 'name', direction: 'asc' }] } });
  return (
    <div data-id="list">
      {__applyListConfig(advisors, listCfgList).map((item, idx) => <a data-id="row" key={idx}>{item.name}</a>)}
    </div>
  );
}`;
    const out = setPaginationInCode(upgraded, 'list', { mode: 'loadMore', perPage: 3 });
    expect(out).toContain('__applyListConfig(advisors, listCfgList).slice(0, visList)');
    expect(out).toContain(`<${LOADMORE_COMPONENT_NAME} data-id="loadmore-list"`);
    expect(out).toContain('visList < advisors.length');           // slug resolved from __applyListConfig
    expect(out).toContain('data-pagination="loadMore:3"');
    parses(out);
  });
});
