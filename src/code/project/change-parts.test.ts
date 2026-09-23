import { describe, test, expect } from 'vitest';
import { partsForFile, TOKENS_PATH } from './change-parts';
import { diffTurnChanges } from './file-diff';

const CSS = (brand: string, extra = '') => `/* Design Tokens — Presets */
:root {
  /* Colors */
  --color-brand: ${brand};
  --color-surface: #ffffff;
${extra}
  /* Typography */
  --typo-h1-size: 64px;
}
`;

describe('styles (design tokens in globals.css)', () => {
  test('a restyled token is one style, named', () => {
    expect(partsForFile(TOKENS_PATH, CSS('#6366f1'), CSS('#ff0044'))).toEqual([
      { unit: 'style', group: 'color', count: 1, names: ['color-brand'] },
    ]);
  });

  test('added and removed tokens count too, grouped by what kind of style they are', () => {
    const parts = partsForFile(TOKENS_PATH, CSS('#6366f1'), CSS('#6366f1', '  --color-link: #0af;').replace('--typo-h1-size: 64px;', '--typo-h1-size: 72px;'))!;
    expect(parts).toEqual(expect.arrayContaining([
      { unit: 'style', group: 'color', count: 1, names: ['color-link'] },
      { unit: 'style', group: 'typography', count: 1, names: ['typo-h1-size'] },
    ]));
  });

  test('a CSS change that touches no token has no parts (comments, whitespace)', () => {
    expect(partsForFile(TOKENS_PATH, CSS('#6366f1'), CSS('#6366f1') + '\n/* note */\n')).toBeUndefined();
  });

  test('a brand-new globals.css: every token is a change', () => {
    expect(partsForFile(TOKENS_PATH, undefined, CSS('#6366f1'))!.reduce((n, p) => n + p.count, 0)).toBe(3);
  });
});

describe('a CMS collection', () => {
  const items = (...rows: Record<string, unknown>[]) => JSON.stringify(rows);
  const schema = (...fields: Record<string, unknown>[]) => JSON.stringify({ name: 'Blog', slug: 'blog', fields });

  test('items: added, edited and removed all count, named by their title', () => {
    const before = items({ _id: 'a', title: 'First' }, { _id: 'b', title: 'Second' }, { _id: 'gone', title: 'Old' });
    const after = items({ _id: 'a', title: 'First' }, { _id: 'b', title: 'Second, edited' }, { _id: 'c', title: 'Third' });
    const [p] = partsForFile('cms/blog.json', before, after)!;
    expect(p.unit).toBe('item');
    expect(p.count).toBe(3);
    expect(p.names).toEqual(expect.arrayContaining(['Second, edited', 'Third', 'Old']));
  });

  test('an untouched item is not a change', () => {
    const same = items({ _id: 'a', title: 'First' });
    expect(partsForFile('cms/blog.json', same, same)).toBeUndefined();
  });

  test('fields, named by their display name', () => {
    const before = schema({ id: 'title', name: 'Title', type: 'text' });
    const after = schema({ id: 'title', name: 'Title', type: 'text' }, { id: 'f2', name: 'Cover Image', type: 'image' });
    expect(partsForFile('cms/blog.schema.json', before, after)).toEqual([{ unit: 'field', count: 1, names: ['Cover Image'] }]);
  });

  test('names are capped — this rides every turn\'s event', () => {
    const many = items(...Array.from({ length: 30 }, (_, i) => ({ _id: `i${i}`, title: `Post ${i}` })));
    const [p] = partsForFile('cms/blog.json', '[]', many)!;
    expect(p.count).toBe(30);
    expect(p.names.length).toBeLessThanOrEqual(4);
  });
});

describe('translations', () => {
  test('counts the strings that changed, nested keys included', () => {
    const before = JSON.stringify({ hero: { title: 'Hello', cta: 'Start' }, footer: 'Bye' });
    const after = JSON.stringify({ hero: { title: 'Bonjour', cta: 'Start' }, footer: 'Bye', nav: { home: 'Accueil' } });
    expect(partsForFile('messages/fr.json', before, after)).toEqual([{ unit: 'string', count: 2, names: ['hero.title', 'nav.home'] }]);
  });
});

describe('robustness', () => {
  test('layer files and unknown files have no parts', () => {
    expect(partsForFile('app/page.client.tsx', 'a', 'b')).toBeUndefined();
    expect(partsForFile('cms/blog/nested.json', '[]', '[1]')).toBeUndefined();
  });
  test('a file that does not parse is still a change — just one with no parts', () => {
    expect(partsForFile('cms/blog.json', '[{"_id":"a"}]', '{ not json')).toEqual([{ unit: 'item', count: 1, names: ['a'] }]);
    expect(partsForFile('messages/fr.json', 'nope', 'nope2')).toBeUndefined();
  });
});

// The mechanism, not my model of it: the real turn diff carries the parts.
describe('diffTurnChanges', () => {
  test('attaches parts to the files that have them, and leaves layer files alone', () => {
    const before = new Map([[TOKENS_PATH, CSS('#6366f1')], ['cms/blog.json', '[]']]);
    const after = new Map([[TOKENS_PATH, CSS('#000000')], ['cms/blog.json', JSON.stringify([{ _id: 'a', title: 'Hi' }])]]);
    const changes = diffTurnChanges(before, after);
    expect(changes.find((c) => c.path === TOKENS_PATH)!.parts).toEqual([{ unit: 'style', group: 'color', count: 1, names: ['color-brand'] }]);
    expect(changes.find((c) => c.path === 'cms/blog.json')!.parts![0]).toMatchObject({ unit: 'item', count: 1 });
  });
});
