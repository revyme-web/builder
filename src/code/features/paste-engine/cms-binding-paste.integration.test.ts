// cms-binding-paste.integration.test.ts — END-TO-END copy/paste of a node whose
// content is bound to a CMS field inside a collection-list `.map()`.
//
// A binding is a JSX EXPRESSION (`<h3>{item.title}</h3>`), not a value, so it
// can't survive a rebuild from the clipboard's plain node fields — and the
// `item` ref would crash outside its `.map()` callback anyway. Copy therefore
// stashes the intent as `data-cms-orphan` (same helper the drag-out clone path
// uses) and paste rehydrates it against whatever iterator the copy lands in:
//
//   duplicate INSIDE the list  → live `{item.title}` again
//   paste OUTSIDE the list     → stays dormant → "Missing" pill
//
// Before this, copy captured no binding at all: duplicating the bound <h3> gave
// an empty text node, and pasting one out lost the pill (user report 2026-07-25).
// Drives the REAL pipeline (copyNodes → executePaste → flush) like
// overlay-paste.integration.test.ts.

import { describe, it, expect, beforeEach } from 'vitest';
import { projectFS } from '@/code/project/project-fs';
import { setActiveFilePath, flushNow, initMutationQueue } from '@/code/mutation/mutation-queue';
import { setBumpVersion } from '@/code/project/modify-file';
import { parseJSXToNodes } from '@/code/parsing/parser';
import { copyNodes } from './copy';
import { executePaste } from './paste';
import { parse } from '@babel/parser';

const FILE = 'app/page.tsx';
const ROW_TITLE = "The worse advice we've ever heard about web design";

// A collection list: `blog.map((item, idx) => …)` with a CMS-bound <h3> inside.
const BASE = `'use client';
import React from 'react';
import blog from '@/cms/blog.json';
export default function Page() {
  return (
    <div data-id="root" style={{ position: 'relative', width: '1440px' }}>
      <div data-id="list" data-collection-list="blog" style={{ display: 'flex' }}>
        {blog.map((item, idx) => (
          <div data-id="row" key={idx} style={{ display: 'flex' }}>
            <h3 data-id="bound-h3" style={{ color: '#111111' }}>{item.title}</h3>
          </div>
        ))}
      </div>
    </div>
  );
}`;

function seed(): Map<string, any> {
  projectFS.writeFile(FILE, BASE);
  setActiveFilePath(FILE);
  setBumpVersion(() => {});
  initMutationQueue(BASE, code => projectFS.writeFile(FILE, code));
  return parseJSXToNodes(BASE);
}

const expectParses = (code: string) =>
  expect(() => parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] })).not.toThrow();

beforeEach(() => {
  projectFS.writeFile(FILE, BASE);
  // The collection's rows — copy resolves the bound field against these so a
  // node pasted OUTSIDE the list still carries its real content.
  projectFS.writeFile('cms/blog.schema.json', JSON.stringify({
    slug: 'blog', name: 'Blog', fields: [{ id: 'title', name: 'Title', type: 'text' }],
  }));
  projectFS.writeFile('cms/blog.json', JSON.stringify([
    { _id: 'i1', _slug: 'a', _status: 'published', title: ROW_TITLE },
    { _id: 'i2', _slug: 'b', _status: 'published', title: 'The history of web design' },
  ]));
});

describe('copying a CMS-bound node', () => {
  it('parses the source binding as a structured node binding (empty textContent)', () => {
    const nodes = seed();
    const h3 = nodes.get('bound-h3');
    expect(h3?.binding).toEqual({ field: 'title', property: 'text' });
    expect(h3?.textContent || '').toBe(''); // the binding is an expression child
  });

  it('duplicated INSIDE the list keeps the binding live', () => {
    const nodes = seed();
    copyNodes(['bound-h3'], nodes);
    executePaste({ selectedIds: ['bound-h3'], nodes, activeFilePath: FILE });
    flushNow();
    const out = projectFS.readFile(FILE)!;
    expectParses(out);
    // Two bound headings now — the original and the copy.
    expect(out.match(/\{item\.title\}/g)?.length).toBe(2);
    // Rehydrated: no stash left behind, and no empty text node.
    expect(out).not.toContain('data-cms-orphan');
    expect(out).not.toMatch(/<h3[^>]*><\/h3>/);
  });

  it('pasted OUTSIDE the list keeps the field as a Missing stash', () => {
    const nodes = seed();
    copyNodes(['bound-h3'], nodes);
    // No selection + a forced position = paste onto the canvas.
    executePaste({
      selectedIds: [], nodes, forcePosition: { x: 300, y: 600 },
      viewportWidths: { desktop: 1440 }, activeFilePath: FILE,
    });
    flushNow();
    const out = projectFS.readFile(FILE)!;
    expectParses(out);
    expect(out).toContain('data-cms-orphan="__text:title"');
    // The copy must NOT reference the out-of-scope iterator.
    const copy = out.slice(out.indexOf('data-cms-orphan'));
    expect(copy).not.toContain('{item.title}');
    // The panel reads the stash back as an orphan binding → "Missing" pill.
    const orphan = parseJSXToNodes(out);
    const pasted = [...orphan.values()].find(n => n.orphanBindings?.some(o => o.prop === '__text'));
    expect(pasted?.orphanBindings?.[0]).toMatchObject({ prop: '__text', field: 'title' });
  });

  it('bakes the ROW value onto a copy pasted outside the list', () => {
    // Dormantizing alone left the node rendering the humanized field name — a
    // heading pasted on the canvas should still SAY what it said in the list,
    // AND keep its Missing pill (user report 2026-07-25).
    const nodes = seed();
    copyNodes(['bound-h3'], nodes);
    executePaste({
      selectedIds: [], nodes, forcePosition: { x: 300, y: 600 },
      viewportWidths: { desktop: 1440 }, activeFilePath: FILE,
    });
    flushNow();
    const out = projectFS.readFile(FILE)!;
    expectParses(out);
    expect(out).toContain(ROW_TITLE);                      // real content, baked in
    expect(out).toContain('data-cms-orphan="__text:title"'); // pill still shown
    expect(out).not.toContain('>Title<');                   // not the placeholder
  });

  it('re-binds over the baked literal when pasted back INTO a list', () => {
    const nodes = seed();
    copyNodes(['bound-h3'], nodes);
    executePaste({ selectedIds: ['bound-h3'], nodes, activeFilePath: FILE });
    flushNow();
    const out = projectFS.readFile(FILE)!;
    expectParses(out);
    expect(out.match(/\{item\.title\}/g)?.length).toBe(2);
    expect(out).not.toContain(ROW_TITLE);   // literal replaced by the binding
    expect(out).not.toContain('data-cms-orphan');
  });

  it('leaves the ORIGINAL binding untouched either way', () => {
    const nodes = seed();
    copyNodes(['bound-h3'], nodes);
    executePaste({
      selectedIds: [], nodes, forcePosition: { x: 300, y: 600 },
      viewportWidths: { desktop: 1440 }, activeFilePath: FILE,
    });
    flushNow();
    const out = projectFS.readFile(FILE)!;
    expect(out).toMatch(/data-id="bound-h3"[^>]*>\{item\.title\}/);
  });

  it('does not stamp a stash on an UNBOUND node', () => {
    const plain = BASE.replace('{item.title}', 'Static heading');
    projectFS.writeFile(FILE, plain);
    setActiveFilePath(FILE);
    setBumpVersion(() => {});
    initMutationQueue(plain, code => projectFS.writeFile(FILE, code));
    const nodes = parseJSXToNodes(plain);
    copyNodes(['bound-h3'], nodes);
    executePaste({ selectedIds: ['bound-h3'], nodes, activeFilePath: FILE });
    flushNow();
    const out = projectFS.readFile(FILE)!;
    expectParses(out);
    expect(out).not.toContain('data-cms-orphan');
    expect(out.match(/Static heading/g)?.length).toBe(2);
  });
});
