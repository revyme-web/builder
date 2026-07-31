import { describe, it, expect } from 'vitest';
import { transform } from '@babel/standalone';
import { addSearchFieldInCode, buildSearchInputElement, buildSearchFieldFrame, searchInputId, searchLabelId, setSearchInputVariableInCode, SEARCH_FIELD_PLACEHOLDER } from './cms-search-field-gen';
import { updateCollectionListConfigInCode } from './cms-gen';
import generate from '@babel/generator';
import { parseJSXToNodes } from '../parsing/parser';
import { syncImports, validateGeneratedCode } from '../mutation/mutation-queue';
import type { FilterGroup } from '@/shared/types';

const parses = (code: string) =>
  expect(() => transform(code, { presets: ['react', 'typescript'], filename: 'f.tsx' })).not.toThrow();

const PAGE = `'use client';
import React, { useState } from 'react';
import blog from '@/cms/blog.json';
export default function Page() {
  return <div data-id="root">
    <div data-id="list" style={{ display: 'grid' }}>
      {blog.map((item, idx) => <div data-id="row" key={idx}>{item.title}</div>)}
    </div>
  </div>;
}`;

const FRAME = 'search-list-title';

describe('buildSearchInputElement', () => {
  it('builds a bound input (value + onChange, greyish fill) — page context', () => {
    const code = generate(buildSearchInputElement('searchTitle', searchInputId(FRAME), SEARCH_FIELD_PLACEHOLDER, false)).code;
    expect(code).toContain(`data-id="${searchInputId(FRAME)}"`);
    expect(code).toContain('type="text"');
    expect(code).toContain(`placeholder="${SEARCH_FIELD_PLACEHOLDER}"`);
    expect(code).toContain('value={searchTitle}');
    expect(code).toContain('onChange={e => setSearchTitle(e.target.value)}');
    expect(code).toContain('data-search-field="searchTitle"');
    expect(code).toContain('"#ebebeb"');   // greyer than near-white
    expect(code).toContain('width: "100%"'); // fills the frame
    expect(code).not.toContain('</input>'); // self-closing void input
  });

  it('emits motion.input in a component file', () => {
    expect(generate(buildSearchInputElement('q', 'x', 'Search...', true)).code).toContain('<motion.input');
  });
});

describe('buildSearchFieldFrame', () => {
  const code = generate(buildSearchFieldFrame('searchTitle', FRAME, searchLabelId(FRAME), searchInputId(FRAME), 'Bullet Point 2', SEARCH_FIELD_PLACEHOLDER, false)).code;

  it('is a 200px-wide frame', () => {
    expect(code).toContain(`data-id="${FRAME}"`);
    expect(code).toContain('width: "200px"');
    expect(code).toContain('flexDirection: "column"');
  });
  it('holds a field-name label text node', () => {
    expect(code).toContain(`data-id="${searchLabelId(FRAME)}"`);
    expect(code).toContain('Bullet Point 2');
  });
  it('holds the bound input as a child (marker on the input, not the frame)', () => {
    expect(code).toContain(`data-id="${searchInputId(FRAME)}"`);
    expect(code).toContain('data-search-field="searchTitle"');
    // label comes before the input
    expect(code.indexOf(searchLabelId(FRAME))).toBeLessThan(code.indexOf(searchInputId(FRAME)));
  });
});

describe('addSearchFieldInCode', () => {
  const out = addSearchFieldInCode(PAGE, 'list', 'searchTitle', FRAME, 'Title', SEARCH_FIELD_PLACEHOLDER, false);

  it('declares the text page variable', () => {
    expect(out).toContain('@pageVariables');
    expect(out).toContain('"name": "searchTitle"');
    expect(out).toContain('"type": "text"');
  });

  it('inserts the search FRAME (label + input) BEFORE the list container', () => {
    const frameIdx = out.indexOf(`data-id="${FRAME}"`);
    const listIdx = out.indexOf('data-id="list"');
    expect(frameIdx).toBeGreaterThan(-1);
    expect(out).toContain('Title');                       // field-name label
    expect(out).toContain(`data-id="${searchInputId(FRAME)}"`); // the input
    expect(frameIdx).toBeLessThan(listIdx);               // sibling before the list
  });

  it('emits the useState for the new variable', () => {
    expect(out).toMatch(/const \[searchTitle, setSearchTitle\] = useState\(['"]['"]\)/);
  });

  it('produces parseable code', () => parses(out));

  it('stores an optional queryParam on the page variable', () => {
    const withParam = addSearchFieldInCode(PAGE, 'list', 'searchTitle', FRAME, 'Title', SEARCH_FIELD_PLACEHOLDER, false, 'title');
    expect(withParam).toContain('"queryParam": "title"');
    parses(withParam);
  });

  it('the parser exposes the search-field marker on the INPUT node (not the frame)', () => {
    const nodes = parseJSXToNodes(out);
    expect(nodes.get(searchInputId(FRAME))!.attrs?.['data-search-field']).toBe('searchTitle');
    expect(nodes.get(FRAME)!.attrs?.['data-search-field']).toBeUndefined();
  });

  it('is a no-op insert when the list id is missing (var still safe)', () => {
    const miss = addSearchFieldInCode(PAGE, 'nope', 'searchTitle', 'search-x', 'Title', 'Search...', false);
    expect(miss).not.toContain('data-id="search-x"');
    parses(miss);
  });
});

describe('full round-trip: search field + dynamic filter', () => {
  const withField = addSearchFieldInCode(PAGE, 'list', 'searchTitle', FRAME, 'Title', SEARCH_FIELD_PLACEHOLDER, false);
  const fg: FilterGroup = {
    combinator: 'and',
    filters: [{ field: 'title', operator: 'contains', value: '', valueSource: 'searchField', valueVar: 'searchTitle' }],
  };
  const full = updateCollectionListConfigInCode(withField, 'list', fg, undefined, undefined, undefined);

  it('writes the guarded search predicate into the .filter() chain', () => {
    expect(full).toContain("searchTitle === ''");
    expect(full).toContain('String(item.title).toLowerCase().includes(searchTitle.toLowerCase())');
  });

  it('parses', () => parses(full));

  it('the parser round-trips the filter back to a searchField FilterConfig', () => {
    const list = parseJSXToNodes(full).get('list')!;
    expect(list.collectionList!.filterGroup!.filters[0]).toEqual({
      field: 'title', operator: 'contains', value: '', valueSource: 'searchField', valueVar: 'searchTitle',
    });
  });

  it('the frame + label + input all survive as nodes', () => {
    const nodes = parseJSXToNodes(full);
    expect(nodes.has(FRAME)).toBe(true);
    expect(nodes.has(searchLabelId(FRAME))).toBe(true);
    expect(nodes.has(searchInputId(FRAME))).toBe(true);
  });
});

describe('setSearchInputVariableInCode (re-bind via the dropdown)', () => {
  const PAGE_WITH_INPUT = `'use client';
export default function Page() {
  return <div data-id="root">
    <input data-id="sf" data-search-field="searchTitle3" value={""} placeholder="Search..." style={{ width: '100%' }} />
  </div>;
}`;
  it('rebinds data-search-field + value + onChange to the new var', () => {
    const out = setSearchInputVariableInCode(PAGE_WITH_INPUT, 'sf', 'searchAuthor');
    expect(out).toContain('data-search-field="searchAuthor"');
    expect(out).toContain('value={searchAuthor}');
    expect(out).toMatch(/onChange=\{\(?e\)? => setSearchAuthor\(e\.target\.value\)\}/);
    expect(out).not.toContain('searchTitle3');
    parses(out);
  });
  it('is a no-op for a missing input id', () => {
    expect(setSearchInputVariableInCode(PAGE_WITH_INPUT, 'nope', 'x')).toBe(PAGE_WITH_INPUT);
  });
});

describe('import sync (regression: useState undefined crash)', () => {
  // A page with only a DEFAULT React import (no named useState) — the shape that
  // crashed: addSearchFieldInCode injects `useState` but the import wasn't synced.
  const PAGE_NO_HOOK = `'use client';
import React from 'react';
import blog from '@/cms/blog.json';
export default function Page() {
  return <div data-id="root">
    <div data-id="list" style={{ display: 'grid' }}>
      {blog.map((item, idx) => <div data-id="row" key={idx}>{item.title}</div>)}
    </div>
  </div>;
}`;

  it('syncImports adds the useState named import after a search field is created', () => {
    const created = addSearchFieldInCode(PAGE_NO_HOOK, 'list', 'searchTitle', FRAME, 'Title', SEARCH_FIELD_PLACEHOLDER, false);
    expect(created).toContain('useState('); // hook emitted
    const synced = syncImports(created);
    expect(synced).toMatch(/import React,?\s*\{[^}]*\buseState\b[^}]*\}\s*from ['"]react['"]/);
    expect(validateGeneratedCode(synced)).toBeNull();
  });
});
