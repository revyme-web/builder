import { describe, test, expect } from 'vitest';
import { layerCount, revealTarget, rowsForCard, describeRow, type ChangedFile, type CardRow } from './ChangesCard';

const f = (over: Partial<ChangedFile> = {}): ChangedFile => ({ path: 'app/page.client.tsx', ...over });

describe('layerCount', () => {
  test('sums everything that moved', () => {
    expect(layerCount(f({ addedIds: ['a', 'b'], changedIds: ['c'], removedIds: ['d'] }))).toBe(4);
  });

  // file-diff reports a file it could not parse with empty id sets. It still
  // changed, so the row stays — but a confident "0 Layers" would read as
  // "nothing happened", which is the opposite of true.
  test('an unparseable file counts zero rather than guessing', () => {
    expect(layerCount(f())).toBe(0);
  });
});

describe('revealTarget', () => {
  test('prefers something ADDED — the new thing worth looking at', () => {
    expect(revealTarget(f({ addedIds: ['new'], changedIds: ['old'] }))).toBe('new');
  });

  test('falls back to something changed', () => {
    expect(revealTarget(f({ changedIds: ['old'] }))).toBe('old');
  });

  // Selecting a deleted id silently does nothing, which makes the row feel
  // broken. Better to render it unclickable.
  test('NEVER targets a removed id', () => {
    expect(revealTarget(f({ removedIds: ['gone'] }))).toBeNull();
  });

  test('a file with no ids is not navigable', () => {
    expect(revealTarget(f())).toBeNull();
  });
});

// User reports 2026-09-21: "_meta/page-camera.json" listed as a change ("it is
// useless"), then: "the changes are much more granular in the reference builder — the exact
// change, and I can click every one: Home goes to the home page, the Header
// component goes inside the component".
describe('rowsForCard — what a turn is announced as', () => {
  const f = (path: string, extra: Partial<ChangedFile> = {}): ChangedFile => ({ path, ...extra });
  const keys = (rows: CardRow[]) => rows.map((r) => r.key);

  test('never lists editor bookkeeping', () => {
    const rows = rowsForCard([f('_meta/page-camera.json'), f('app/page.client.tsx', { changedIds: ['a'] }), f('_meta/agent-chats.json'), f('_revyme/cache.json')]);
    expect(keys(rows)).toEqual(['app/page.client.tsx']);
  });

  test('a run that only moved the camera has no card at all', () => {
    expect(rowsForCard([f('_meta/page-camera.json')])).toEqual([]);
  });

  test('pages and design components are rows of LAYERS', () => {
    const rows = rowsForCard([f('app/page.client.tsx', { addedIds: ['x'] }), f('components/Header.tsx', { changedIds: ['a', 'b'] })]);
    expect(rows.map((r) => r.kind)).toEqual(['page', 'component']);
  });

  // It has no layers to count, and it opens in its editor, not on the canvas.
  test('a CODE component is its own kind — decided by its source, not its path', () => {
    const rows = rowsForCard(
      [f('components/Galaxy.tsx'), f('components/Header.tsx')],
      { isCodeComponent: (p) => p === 'components/Galaxy.tsx' },
    );
    expect(rows.map((r) => r.kind)).toEqual(['code-component', 'component']);
  });

  // A collection is two files on disk; building one touches both.
  test('a CMS collection is ONE row, adding up its items and its fields', () => {
    const rows = rowsForCard([
      f('cms/blog.schema.json', { parts: [{ unit: 'field', count: 3, names: ['Cover'] }] }),
      f('cms/blog.json', { parts: [{ unit: 'item', count: 8, names: ['First'] }] }),
      f('cms/authors.json', { parts: [{ unit: 'item', count: 2, names: [] }] }),
    ]);
    expect(rows).toEqual([
      { kind: 'collection', key: 'cms:blog', slug: 'blog', items: 8, fields: 3 },
      { kind: 'collection', key: 'cms:authors', slug: 'authors', items: 2, fields: 0 },
    ]);
  });

  test('the design tokens are a row per KIND of style, never "globals.css"', () => {
    const rows = rowsForCard([f('app/globals.css', { parts: [
      { unit: 'style', group: 'color', count: 3, names: ['color-brand', 'color-link', 'color-bg'] },
      { unit: 'style', group: 'typography', count: 1, names: ['typo-h1-size'] },
    ] })]);
    expect(rows).toEqual([
      { kind: 'styles', key: 'styles:color', group: 'color', count: 3, names: ['color-brand', 'color-link', 'color-bg'] },
      { kind: 'styles', key: 'styles:typography', group: 'typography', count: 1, names: ['typo-h1-size'] },
    ]);
  });

  test('globals.css that changed without any token changing is still one row', () => {
    expect(rowsForCard([f('app/globals.css')])).toEqual([{ kind: 'styles', key: 'styles:other', group: 'other', count: 0, names: [] }]);
  });

  test('translations are a row per locale', () => {
    const rows = rowsForCard([f('messages/fr.json', { parts: [{ unit: 'string', count: 12, names: [] }] })]);
    expect(rows).toEqual([{ kind: 'translations', key: 'messages:fr', locale: 'fr', count: 12 }]);
  });

  test('keeps the order things first appeared in, and every key is unique', () => {
    const rows = rowsForCard([f('cms/blog.json'), f('_meta/x.json'), f('app/blog/page.client.tsx'), f('cms/blog.schema.json'), f('components/PostCard.tsx')]);
    expect(keys(rows)).toEqual(['cms:blog', 'app/blog/page.client.tsx', 'components/PostCard.tsx']);
    expect(new Set(keys(rows)).size).toBe(rows.length);
  });

  test('only a collection\'s own two files count — not anything under cms/', () => {
    expect(rowsForCard([f('cms/blog/assets/cover.json')]).map((r) => r.kind)).toEqual(['file']);
  });
});

describe('describeRow — the name, and how much of it, in ITS unit', () => {
  const names = { file: (p: string) => (p === 'app/page.client.tsx' ? 'Home' : 'Header'), collection: (s: string) => (s === 'blog' ? 'Blog Posts' : s) };
  const say = (row: CardRow) => { const d = describeRow(row, names); return `${d.label} | ${d.detail}`; };

  test('layers, singular and plural', () => {
    expect(say({ kind: 'page', key: 'k', file: { path: 'app/page.client.tsx', addedIds: ['a', 'b'], changedIds: ['c'] } })).toBe('Home | 3 Layers');
    expect(say({ kind: 'component', key: 'k', file: { path: 'components/Header.tsx', changedIds: ['a'] } })).toBe('Header | 1 Layer');
  });

  // file-diff reports a file it could not parse with empty id sets.
  test('says nothing rather than "0 Layers"', () => {
    expect(say({ kind: 'page', key: 'k', file: { path: 'app/page.client.tsx' } })).toBe('Home | ');
  });

  test('ONE style is named; several are named by their kind', () => {
    expect(say({ kind: 'styles', key: 'k', group: 'color', count: 1, names: ['color-link'] })).toBe('color-link | 1 Style');
    expect(say({ kind: 'styles', key: 'k', group: 'color', count: 3, names: ['a', 'b', 'c'] })).toBe('Colors | 3 Styles');
    expect(describeRow({ kind: 'styles', key: 'k', group: 'color', count: 9, names: ['a', 'b'] }, names).title).toBe('a, b, …');
  });

  test('a collection by its NAME, counting whichever of items / fields moved', () => {
    expect(say({ kind: 'collection', key: 'k', slug: 'blog', items: 8, fields: 3 })).toBe('Blog Posts | 8 Items · 3 Fields');
    expect(say({ kind: 'collection', key: 'k', slug: 'blog', items: 1, fields: 0 })).toBe('Blog Posts | 1 Item');
    expect(say({ kind: 'collection', key: 'k', slug: 'blog', items: 0, fields: 0 })).toBe('Blog Posts | Collection');
  });

  test('a code component and translations', () => {
    expect(say({ kind: 'code-component', key: 'k', path: 'components/Galaxy.tsx' })).toBe('Header | Code');
    expect(say({ kind: 'translations', key: 'k', locale: 'fr', count: 12 })).toBe('Translations · fr | 12 Strings');
  });
});

// User report 2026-09-21 (screenshot): "/articles" listed twice, "/articles/[slug]"
// listed twice. A page is TWO files on disk and a new page writes both.
describe('rowsForCard — a page pair is one row', () => {
  const f = (path: string, extra: Partial<ChangedFile> = {}): ChangedFile => ({ path, ...extra });

  test('the server wrapper and the client body are the SAME page', () => {
    const rows = rowsForCard([
      f('app/articles/page.client.tsx', { addedIds: Array.from({ length: 19 }, (_, i) => `n${i}`) }),
      f('app/articles/page.tsx', { addedIds: ['wrapper'] }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe('app/articles/page.client.tsx');
    expect(describeRow(rows[0], { file: () => '/articles', collection: (s) => s }).detail).toBe('20 Layers');
  });

  test('whichever half comes first, the row opens the half you CAN open', () => {
    const rows = rowsForCard([f('app/articles/[slug]/page.tsx', { addedIds: ['w'] }), f('app/articles/[slug]/page.client.tsx', { addedIds: ['a', 'b'] })]);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind === 'page' && rows[0].file.path).toBe('app/articles/[slug]/page.client.tsx');
  });

  test('two DIFFERENT pages stay two rows', () => {
    const rows = rowsForCard([f('app/articles/page.client.tsx'), f('app/about/page.client.tsx'), f('app/articles/page.tsx')]);
    expect(rows.map((r) => r.key)).toEqual(['app/articles/page.client.tsx', 'app/about/page.client.tsx']);
  });

  test('only the wrapper changed → still a page row, pointing at the client half', () => {
    const rows = rowsForCard([f('app/articles/page.tsx', { changedIds: ['x'] })]);
    expect(rows.map((r) => r.key)).toEqual(['app/articles/page.client.tsx']);
  });
});
