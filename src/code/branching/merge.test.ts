// branching/merge.test.ts — P8 (iv): merge matrix §10, proofs.

import { describe, it, expect } from 'vitest';
import {
  mergeFile,
  mergeMaps,
  resolveFileConflicts,
  regenerateIds,
  type FileConflict,
} from './merge';

const PAGE = (inner: string): string =>
  `'use client';\nimport React from 'react';\nexport default function Page() {\n  return (\n    <div data-id="root" style={{ position: 'relative' }}>\n${inner}\n    </div>\n  );\n}`;

const cleanText = (r: { status: string; merged?: string | null }): string => {
  if (r.status !== 'clean') throw new Error('expected clean');
  return (r as { merged: string | null }).merged ?? '__DELETED__';
};
const conflictsOf = (r: { status: string; conflicts?: FileConflict[] }): FileConflict[] => {
  if (r.status !== 'conflict') throw new Error('expected conflict');
  return (r as { conflicts: FileConflict[] }).conflicts;
};

const BASE = PAGE(`      <p data-id="a" style={{ position: 'relative', color: 'red' }}>hi</p>`);

describe('file matrix', () => {
  it('equal / one-sided / identical-both merge clean', () => {
    expect(cleanText(mergeFile(BASE, BASE, BASE, { path: 'app/page.client.tsx' }))).toBe(BASE);
    const edited = BASE.replace('hi', 'hello');
    expect(cleanText(mergeFile(BASE, edited, BASE, { path: 'app/page.client.tsx' }))).toBe(edited);
    expect(cleanText(mergeFile(BASE, BASE, edited, { path: 'app/page.client.tsx' }))).toBe(edited);
    expect(cleanText(mergeFile(BASE, edited, edited, { path: 'app/page.client.tsx' }))).toBe(edited);
  });

  it('both deleted → clean deleted; one-sided delete of untouched → clean deleted', () => {
    expect(cleanText(mergeFile(BASE, null, null, { path: 'x.tsx' }))).toBe('__DELETED__');
    expect(cleanText(mergeFile(BASE, null, BASE, { path: 'x.tsx' }))).toBe('__DELETED__');
    expect(cleanText(mergeFile(BASE, BASE, null, { path: 'x.tsx' }))).toBe('__DELETED__');
  });

  it('created one side only → clean take', () => {
    expect(cleanText(mergeFile(null, null, BASE, { path: 'x.tsx' }))).toBe(BASE);
    expect(cleanText(mergeFile(null, BASE, null, { path: 'x.tsx' }))).toBe(BASE);
  });

  it('created both sides differently → file conflict', () => {
    const r = mergeFile(null, BASE, `${BASE}\n// extra`, { path: 'x.tsx' });
    const cs = conflictsOf(r);
    expect(cs).toHaveLength(1);
    expect(cs[0].kind).toBe('file');
  });

  it('delete-vs-edit conflicts both directions', () => {
    const edited = BASE.replace('hi', 'hello');
    for (const r of [
      mergeFile(BASE, null, edited, { path: 'x.tsx' }),
      mergeFile(BASE, edited, null, { path: 'x.tsx' }),
    ]) {
      const cs = conflictsOf(r);
      expect(cs).toHaveLength(1);
      expect(cs[0].kind).toBe('delete-vs-edit');
    }
  });
});

describe('content matrix (JSX)', () => {
  it('disjoint regions merge (ailleurs)', () => {
    const base = PAGE(`      <p data-id="a" style={{ position: 'relative' }}>a</p>\n      <p data-id="b" style={{ position: 'relative' }}>b</p>`);
    const ours = base.replace('>a<', '>A<');
    const theirs = base.replace('>b<', '>B<');
    const merged = cleanText(mergeFile(base, ours, theirs, { path: 'app/page.client.tsx' }));
    expect(merged).toContain('>A<');
    expect(merged).toContain('>B<');
  });

  it('same node different props merge (union)', () => {
    const ours = BASE.replace(`color: 'red'`, `color: 'red', fontSize: '20px'`);
    const theirs = BASE.replace('>hi<', '>hello<');
    const merged = cleanText(mergeFile(BASE, ours, theirs, { path: 'app/page.client.tsx' }));
    expect(merged).toContain(`fontSize: '20px'`);
    expect(merged).toContain('>hello<');
  });

  it('same node same property → same-property conflict naming the key', () => {
    const ours = BASE.replace(`color: 'red'`, `color: 'blue'`);
    const theirs = BASE.replace(`color: 'red'`, `color: 'green'`);
    const cs = conflictsOf(mergeFile(BASE, ours, theirs, { path: 'app/page.client.tsx' }));
    expect(cs.some((c) => c.kind === 'same-property' && c.details.includes('"color"'))).toBe(true);
  });

  it('same node different lines → same-node conflict', () => {
    // Structural difference (data-name added) + style touch on the same
    // single-line element: intra-line merge declines → same-node.
    const ours = BASE.replace(`data-id="a"`, `data-id="a" data-name="A"`);
    const theirs = BASE.replace(`color: 'red'`, `color: 'green'`);
    const cs = conflictsOf(mergeFile(BASE, ours, theirs, { path: 'app/page.client.tsx' }));
    expect(cs.some((c) => c.kind === 'same-node')).toBe(true);
  });

  it('create-vs-create same id different content → conflict with regen path', () => {
    const base = PAGE(`      <p data-id="a" style={{ position: 'relative' }}>a</p>`);
    const ours = base.replace('</div>\n  );', `      <p data-id="n" style={{ position: 'relative' }}>one</p>\n    </div>\n  );`);
    const theirs = base.replace('</div>\n  );', `      <p data-id="n" style={{ position: 'relative' }}>two</p>\n    </div>\n  );`);
    const cs = conflictsOf(mergeFile(base, ours, theirs, { path: 'app/page.client.tsx' }));
    expect(cs.some((c) => c.kind === 'create-vs-create' && c.dataIds.includes('n'))).toBe(true);
  });

  it('pure reorder merges (branch wins), never conflicts', () => {
    const base = PAGE(`      <p data-id="a" style={{ position: 'relative' }}>a</p>\n      <p data-id="b" style={{ position: 'relative' }}>b</p>`);
    const reordered = PAGE(`      <p data-id="b" style={{ position: 'relative' }}>b</p>\n      <p data-id="a" style={{ position: 'relative' }}>a</p>`);
    const merged = cleanText(mergeFile(base, base, reordered, { path: 'app/page.client.tsx' }));
    expect(merged.indexOf('data-id="b"')).toBeLessThan(merged.indexOf('data-id="a"'));
  });

  it('imports union disjoint names; same module different locals conflict', () => {
    const base = `'use client';\nimport React from 'react';\nexport default function Page() { return <div data-id="root" />; }`;
    const ours = `'use client';\nimport React from 'react';\nimport Hero from '@/components/Hero';\nexport default function Page() { return <div data-id="root" />; }`;
    const theirs = `'use client';\nimport React from 'react';\nimport Footer from '@/components/Footer';\nexport default function Page() { return <div data-id="root" />; }`;
    const merged = cleanText(mergeFile(base, ours, theirs, { path: 'app/page.client.tsx' }));
    expect(merged).toContain(`@/components/Hero`);
    expect(merged).toContain(`@/components/Footer`);
    const ours2 = base.replace(`import React from 'react';`, `import React from 'react';\nimport H from '@/components/Hero';`);
    const theirs2 = base.replace(`import React from 'react';`, `import React from 'react';\nimport F from '@/components/Hero';`);
    const cs = conflictsOf(mergeFile(base, ours2, theirs2, { path: 'app/page.client.tsx' }));
    expect(cs.some((c) => c.kind === 'imports')).toBe(true);
  });
});

describe('JSON per key + CSS per rule', () => {
  const J = (o: unknown): string => JSON.stringify(o, null, 2);
  it('disjoint keys merge; same key both ways conflicts', () => {
    const base = J({ a: 1, b: 2 });
    expect(JSON.parse(cleanText(mergeFile(base, J({ a: 1, b: 2, c: 3 }), J({ a: 9, b: 2 }), { path: 'cms/x.json' })))).toEqual({ a: 9, b: 2, c: 3 });
    const cs = conflictsOf(mergeFile(base, J({ a: 10, b: 2 }), J({ a: 2, b: 2 }), { path: 'cms/x.json' }));
    // Key a: 1 vs 10 vs 2 → conflict; key b untouched.
    expect(cs.some((c) => c.kind === 'json-key' && c.details.includes('"a"'))).toBe(true);
    expect(cs.some((c) => c.details.includes('"b"'))).toBe(false);
  });

  it('CSS rules merge per selector; same rule both ways conflicts', () => {
    const base = `:root {\n  --a: 1;\n}\n.box {\n  color: red;\n}`;
    const ours = `:root {\n  --a: 1;\n}\n.box {\n  color: red;\n}\n.new {\n  color: blue;\n}`;
    const theirs = `:root {\n  --a: 2;\n}\n.box {\n  color: red;\n}`;
    const merged = cleanText(mergeFile(base, ours, theirs, { path: 'app/globals.css' }));
    expect(merged).toContain('--a: 2');
    expect(merged).toContain('.new');
    const cs = conflictsOf(
      mergeFile(base, `:root {\n  --a: 1;\n}`, `:root {\n  --a: 2;\n}`, { path: 'app/globals.css' }),
    );
    expect(cs.some((c) => c.kind === 'css-rule')).toBe(true);
  });
});

describe('resolution', () => {
  it('keep ours/theirs replays deterministically; missing choices error', () => {
    const ours = BASE.replace(`color: 'red'`, `color: 'blue'`);
    const theirs = BASE.replace(`color: 'red'`, `color: 'green'`);
    const detected = mergeFile(BASE, ours, theirs, { path: 'app/page.client.tsx' });
    expect(detected.status).toBe('conflict');
    const miss = resolveFileConflicts(BASE, ours, theirs, { path: 'app/page.client.tsx', choices: [] });
    expect('error' in miss).toBe(true);
    const ro = resolveFileConflicts(BASE, ours, theirs, { path: 'app/page.client.tsx', choices: ['ours'] });
    expect('merged' in ro && (ro as { merged: string }).merged).toContain(`color: 'blue'`);
    const rt = resolveFileConflicts(BASE, ours, theirs, { path: 'app/page.client.tsx', choices: ['theirs'] });
    expect('merged' in rt && (rt as { merged: string }).merged).toContain(`color: 'green'`);
  });

  it('regenerateIds renames only collisions, deterministically', () => {
    const used = new Set(['n', 'n-m2']);
    expect(regenerateIds('<p data-id="n">a</p><p data-id="x">b</p>', used)).toBe(
      '<p data-id="n-m3">a</p><p data-id="x">b</p>',
    );
  });
});

describe('mergeMaps', () => {
  it('merges files, omits conflicted files (never half-merged)', () => {
    const base = new Map([['a.tsx', BASE], ['b.tsx', BASE]]);
    const ours = new Map([['a.tsx', BASE.replace('hi', 'O')], ['b.tsx', BASE]]);
    const theirs = new Map([
      ['a.tsx', BASE.replace('hi', 'T')],
      ['b.tsx', BASE.replace(`color: 'red'`, `color: 'blue'`)],
    ]);
    // a.tsx: same text leaf edited both ways... single-line? 'hi' sits on its
    // own line in BASE (>hi< shares the line with tags — same-node expected.
    const { merged, conflicts } = mergeMaps(base, ours, theirs);
    expect(conflicts.length).toBeGreaterThan(0);
    expect(merged.has('b.tsx')).toBe(true);
    expect(merged.get('b.tsx')).toContain(`color: 'blue'`);
    expect(merged.has('a.tsx')).toBe(conflicts.every((c) => c.path !== 'a.tsx'));
  });
});
