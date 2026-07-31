// cms-ops.test.ts — Tests for CMS collection CRUD operations.

import { describe, test, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), dom: vi.fn(), error: vi.fn() },
}));

// In-memory store backing the mock projectFS. Declared via vi.hoisted so
// it exists before the (hoisted) vi.mock factory runs — a transitive
// import of cms-ops pulls in project-fs during module resolution, which
// fires the factory before a plain `let` would have initialized.
const fsStore = vi.hoisted(() => new Map<string, string>());

vi.mock('./project-fs', () => ({
  projectFS: {
    readFile: vi.fn((path: string) => fsStore.get(path) ?? null),
    writeFile: vi.fn((path: string, content: string) => { fsStore.set(path, content); }),
    deleteFile: vi.fn((path: string) => { fsStore.delete(path); }),
    listFiles: vi.fn((dir?: string) => {
      const prefix = dir ? (dir.endsWith('/') ? dir : dir + '/') : '';
      const result: string[] = [];
      for (const path of fsStore.keys()) {
        if (!prefix || path.startsWith(prefix)) result.push(path);
      }
      return result.sort();
    }),
    exists: vi.fn((path: string) => fsStore.has(path)),
  },
}));

import {
  listCollections,
  getCollectionSchema,
  saveCollectionSchema,
  deleteCollection,
  getCollectionData,
  saveCollectionData,
  addCollectionItem,
  updateCollectionItem,
  removeCollectionItem,
  reorderCollectionItems,
  renameCollection,
  duplicateCollection,
  createBlankCollection,
  addCollectionField,
  updateCollectionField,
  removeCollectionField,
  resolveItemValues,
  generateItemId,
  slugify,
  cmsItemLabel,
  stripUrlWrapper,
  uniqueItemSlug,
  isAutoDerivedSlug,
  uniqueFieldName,
  syncFieldDefaultToItems,
} from './cms-ops';
import type { CollectionSchema, CollectionItem } from '@/shared/types';
import { triggerAutosave } from '@/backend/autosave';

// CMS writes bypass the mutation queue, so they must schedule the autosave
// themselves — see the persist points in cms-ops.
vi.mock('@/backend/autosave', () => ({ triggerAutosave: vi.fn() }));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSchema(slug: string, name: string, fields: CollectionSchema['fields'] = []): CollectionSchema {
  return { name, slug, fields };
}

function makeItem(overrides: Partial<CollectionItem> = {}): CollectionItem {
  return {
    _id: 'test-id',
    _slug: 'test',
    _status: 'published',
    _createdAt: '2026-01-01T00:00:00.000Z',
    _updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  fsStore.clear();
  vi.clearAllMocks();
});

// ── listCollections ─────────────────────────────────────────────────────────

describe('listCollections', () => {
  test('returns empty array when no collections exist', () => {
    expect(listCollections()).toEqual([]);
  });

  test('returns slug for a single collection', () => {
    fsStore.set('cms/team.schema.json', JSON.stringify(makeSchema('team', 'Team')));
    expect(listCollections()).toEqual(['team']);
  });

  test('returns multiple slugs sorted', () => {
    fsStore.set('cms/team.schema.json', JSON.stringify(makeSchema('team', 'Team')));
    fsStore.set('cms/blog-posts.schema.json', JSON.stringify(makeSchema('blog-posts', 'Blog Posts')));
    fsStore.set('cms/products.schema.json', JSON.stringify(makeSchema('products', 'Products')));
    const result = listCollections();
    expect(result).toContain('team');
    expect(result).toContain('blog-posts');
    expect(result).toContain('products');
    expect(result).toHaveLength(3);
  });

  test('ignores non-schema files in cms/', () => {
    fsStore.set('cms/team.schema.json', JSON.stringify(makeSchema('team', 'Team')));
    fsStore.set('cms/team.json', '[]');
    fsStore.set('cms/readme.md', '# CMS');
    expect(listCollections()).toEqual(['team']);
  });
});

// ── getCollectionSchema ─────────────────────────────────────────────────────

describe('getCollectionSchema', () => {
  test('returns schema when file exists', () => {
    const schema = makeSchema('team', 'Team Members', [
      { id: 'name', name: 'Name', type: 'text', required: true },
    ]);
    fsStore.set('cms/team.schema.json', JSON.stringify(schema));
    const result = getCollectionSchema('team');
    expect(result).toEqual(schema);
  });

  test('returns null when file does not exist', () => {
    expect(getCollectionSchema('nonexistent')).toBeNull();
  });

  test('returns null for malformed JSON', () => {
    fsStore.set('cms/bad.schema.json', '{ not valid json }}}');
    expect(getCollectionSchema('bad')).toBeNull();
  });
});

// ── saveCollectionSchema ────────────────────────────────────────────────────

describe('saveCollectionSchema', () => {
  test('creates schema file in projectFS', () => {
    const schema = makeSchema('team', 'Team Members');
    saveCollectionSchema('team', schema);
    const raw = fsStore.get('cms/team.schema.json');
    expect(raw).toBeDefined();
    expect(JSON.parse(raw!)).toEqual(schema);
  });

  test('overwrites existing schema file', () => {
    const schema1 = makeSchema('team', 'Team V1');
    const schema2 = makeSchema('team', 'Team V2', [
      { id: 'name', name: 'Name', type: 'text' },
    ]);
    saveCollectionSchema('team', schema1);
    saveCollectionSchema('team', schema2);
    expect(JSON.parse(fsStore.get('cms/team.schema.json')!)).toEqual(schema2);
  });
});

// ── deleteCollection ────────────────────────────────────────────────────────

describe('deleteCollection', () => {
  test('removes both schema and data files', () => {
    fsStore.set('cms/team.schema.json', JSON.stringify(makeSchema('team', 'Team')));
    fsStore.set('cms/team.json', '[]');
    deleteCollection('team');
    expect(fsStore.has('cms/team.schema.json')).toBe(false);
    expect(fsStore.has('cms/team.json')).toBe(false);
  });

  test('handles missing data file gracefully', () => {
    fsStore.set('cms/team.schema.json', JSON.stringify(makeSchema('team', 'Team')));
    // No data file — should not throw
    deleteCollection('team');
    expect(fsStore.has('cms/team.schema.json')).toBe(false);
  });

  test('handles missing schema file gracefully', () => {
    fsStore.set('cms/team.json', '[]');
    // No schema file — should not throw
    deleteCollection('team');
    expect(fsStore.has('cms/team.json')).toBe(false);
  });

  test('handles no files at all gracefully', () => {
    // Should not throw
    deleteCollection('nonexistent');
  });
});

// ── getCollectionData ───────────────────────────────────────────────────────

describe('getCollectionData', () => {
  test('returns items when data file exists', () => {
    const items = [makeItem({ _id: 'alice' }), makeItem({ _id: 'bob' })];
    fsStore.set('cms/team.json', JSON.stringify(items));
    expect(getCollectionData('team')).toEqual(items);
  });

  test('returns empty array when data file does not exist', () => {
    expect(getCollectionData('nonexistent')).toEqual([]);
  });

  test('returns empty array for empty JSON array', () => {
    fsStore.set('cms/team.json', '[]');
    expect(getCollectionData('team')).toEqual([]);
  });

  test('returns empty array for malformed JSON', () => {
    fsStore.set('cms/team.json', 'not json!!!');
    expect(getCollectionData('team')).toEqual([]);
  });
});

// ── saveCollectionData ──────────────────────────────────────────────────────

describe('saveCollectionData', () => {
  test('writes items to data file', () => {
    const items = [makeItem({ _id: 'alice' })];
    saveCollectionData('team', items);
    expect(JSON.parse(fsStore.get('cms/team.json')!)).toEqual(items);
  });

  test('overwrites existing data', () => {
    fsStore.set('cms/team.json', JSON.stringify([makeItem({ _id: 'old' })]));
    const newItems = [makeItem({ _id: 'new' })];
    saveCollectionData('team', newItems);
    expect(JSON.parse(fsStore.get('cms/team.json')!)).toEqual(newItems);
  });
});

// ── addCollectionItem ───────────────────────────────────────────────────────

describe('addCollectionItem', () => {
  test('generates _id and sets timestamps', () => {
    fsStore.set('cms/team.schema.json', JSON.stringify(makeSchema('team', 'Team', [
      { id: 'name', name: 'Name', type: 'text' },
    ])));
    fsStore.set('cms/team.json', '[]');

    const result = addCollectionItem('team', { name: 'Alice' });
    expect(result._id).toBeTruthy();
    expect(result._id).toMatch(/^item_/);
    expect(result._createdAt).toBeTruthy();
    expect(result._updatedAt).toBeTruthy();
    expect(result._status).toBe('published');
    expect(result.name).toBe('Alice');
  });

  test('generates _slug from first text field', () => {
    fsStore.set('cms/team.schema.json', JSON.stringify(makeSchema('team', 'Team', [
      { id: 'name', name: 'Name', type: 'text' },
    ])));
    fsStore.set('cms/team.json', '[]');

    const result = addCollectionItem('team', { name: 'Alice Johnson' });
    expect(result._slug).toBe('alice-johnson');
  });

  test('uses fallback slug when no text field value', () => {
    fsStore.set('cms/team.schema.json', JSON.stringify(makeSchema('team', 'Team', [
      { id: 'count', name: 'Count', type: 'number' },
    ])));
    fsStore.set('cms/team.json', '[]');

    const result = addCollectionItem('team', { count: 42 });
    expect(result._slug).toBe('item');
  });

  test('appends item to existing data', () => {
    fsStore.set('cms/team.schema.json', JSON.stringify(makeSchema('team', 'Team', [
      { id: 'name', name: 'Name', type: 'text' },
    ])));
    const existing = [makeItem({ _id: 'existing' })];
    fsStore.set('cms/team.json', JSON.stringify(existing));

    addCollectionItem('team', { name: 'New Person' });
    const data = JSON.parse(fsStore.get('cms/team.json')!);
    expect(data).toHaveLength(2);
    expect(data[0]._id).toBe('existing');
    expect(data[1].name).toBe('New Person');
  });

  test('works when no schema exists (slug fallback)', () => {
    fsStore.set('cms/team.json', '[]');
    const result = addCollectionItem('team', { name: 'Alice' });
    expect(result._slug).toBe('item'); // no schema → no first text field → fallback
    expect(result._id).toBeTruthy();
  });
});

// ── image-field normalization (plain URL, no url() wrapper) ──────────────────

describe('stripUrlWrapper', () => {
  test('strips url(), url(\'\'), url("")', () => {
    expect(stripUrlWrapper(`url('https://x/p.jpg')`)).toBe('https://x/p.jpg');
    expect(stripUrlWrapper(`url("https://x/p.jpg")`)).toBe('https://x/p.jpg');
    expect(stripUrlWrapper('url(https://x/p.jpg)')).toBe('https://x/p.jpg');
  });
  test('leaves a plain URL + non-strings untouched', () => {
    expect(stripUrlWrapper('https://x/p.jpg')).toBe('https://x/p.jpg');
    expect(stripUrlWrapper(42)).toBe(42);
    expect(stripUrlWrapper(undefined)).toBe(undefined);
  });
});

describe('image fields stored as PLAIN URLs (normalizeImageFieldValues)', () => {
  test('addCollectionItem strips a url() wrapper from an image field, leaves text + plain alone', () => {
    fsStore.set('cms/gal.schema.json', JSON.stringify(makeSchema('gal', 'Gallery', [
      { id: 'name', name: 'Name', type: 'text' },
      { id: 'image', name: 'Image', type: 'image' },
    ])));
    fsStore.set('cms/gal.json', '[]');
    const r = addCollectionItem('gal', { name: 'url(not-stripped)', image: `url('https://x/p.jpg')` });
    expect(r.image).toBe('https://x/p.jpg');     // image normalized
    expect(r.name).toBe('url(not-stripped)');    // text field NOT touched
  });

  test('updateCollectionItem strips a url() wrapper from an image field', () => {
    fsStore.set('cms/gal.schema.json', JSON.stringify(makeSchema('gal', 'Gallery', [
      { id: 'image', name: 'Image', type: 'image' },
    ])));
    fsStore.set('cms/gal.json', JSON.stringify([makeItem({ _id: 'x', image: 'old' })]));
    updateCollectionItem('gal', 'x', { image: 'url(https://y/q.png)' });
    expect(JSON.parse(fsStore.get('cms/gal.json')!)[0].image).toBe('https://y/q.png');
  });
});

// ── updateCollectionItem ────────────────────────────────────────────────────

describe('updateCollectionItem', () => {
  test('updates fields on existing item', () => {
    const items = [makeItem({ _id: 'alice', name: 'Alice', role: 'CEO' })];
    fsStore.set('cms/team.json', JSON.stringify(items));

    updateCollectionItem('team', 'alice', { role: 'CTO' });
    const data = JSON.parse(fsStore.get('cms/team.json')!);
    expect(data[0].role).toBe('CTO');
    expect(data[0].name).toBe('Alice'); // unchanged
  });

  test('bumps _updatedAt timestamp', () => {
    const items = [makeItem({ _id: 'alice', _updatedAt: '2020-01-01T00:00:00.000Z' })];
    fsStore.set('cms/team.json', JSON.stringify(items));

    updateCollectionItem('team', 'alice', { name: 'Alice Updated' });
    const data = JSON.parse(fsStore.get('cms/team.json')!);
    expect(data[0]._updatedAt).not.toBe('2020-01-01T00:00:00.000Z');
  });

  test('does nothing when item not found', () => {
    const items = [makeItem({ _id: 'alice' })];
    fsStore.set('cms/team.json', JSON.stringify(items));

    updateCollectionItem('team', 'nonexistent', { name: 'Ghost' });
    const data = JSON.parse(fsStore.get('cms/team.json')!);
    // Data unchanged
    expect(data).toHaveLength(1);
    expect(data[0]._id).toBe('alice');
  });
});

// ── uniqueItemSlug ──────────────────────────────────────────────────────────

describe('uniqueItemSlug', () => {
  test('returns base when free, else appends -2, -3, …', () => {
    const items = [makeItem({ _id: 'a', _slug: 'elena' }), makeItem({ _id: 'b', _slug: 'elena-2' })];
    expect(uniqueItemSlug(items, 'maria')).toBe('maria');     // free
    expect(uniqueItemSlug(items, 'elena')).toBe('elena-3');   // elena + elena-2 taken
  });
  test('excludes the item re-deriving its own slug (no self-suffix)', () => {
    const items = [makeItem({ _id: 'a', _slug: 'elena' })];
    expect(uniqueItemSlug(items, 'elena', 'a')).toBe('elena'); // a owns "elena" → not a collision
  });
});

// ── _slug auto-sync (the "item item item" fix) ───────────────────────────────

describe('_slug auto-sync to title', () => {
  function teamSchema() {
    fsStore.set('cms/team.schema.json', JSON.stringify(makeSchema('team', 'Team', [
      { id: 'name', name: 'Name', type: 'text' },
      { id: 'role', name: 'Role', type: 'text' },
    ])));
  }

  test('addCollectionItem uniquifies the empty fallback (no 3-way "item" collision)', () => {
    teamSchema();
    fsStore.set('cms/team.json', '[]');
    addCollectionItem('team', {});            // no name → 'item'
    addCollectionItem('team', {});            // → 'item-2'
    addCollectionItem('team', {});            // → 'item-3'
    const data = JSON.parse(fsStore.get('cms/team.json')!);
    expect(data.map((i: CollectionItem) => i._slug)).toEqual(['item', 'item-2', 'item-3']);
  });

  test('naming an item created empty (slug "item") re-derives the slug', () => {
    teamSchema();
    fsStore.set('cms/team.json', JSON.stringify([makeItem({ _id: 'x', _slug: 'item', name: '' })]));
    updateCollectionItem('team', 'x', { name: 'Elena Rodriguez' });
    expect(JSON.parse(fsStore.get('cms/team.json')!)[0]._slug).toBe('elena-rodriguez');
  });

  test('slug stays in sync while it still tracks the title', () => {
    teamSchema();
    fsStore.set('cms/team.json', JSON.stringify([makeItem({ _id: 'x', _slug: 'elena-rodriguez', name: 'Elena Rodriguez' })]));
    updateCollectionItem('team', 'x', { name: 'Elena Ruiz' });
    expect(JSON.parse(fsStore.get('cms/team.json')!)[0]._slug).toBe('elena-ruiz');
  });

  test('a hand-typed custom slug is PRESERVED when the title changes', () => {
    teamSchema();
    fsStore.set('cms/team.json', JSON.stringify([makeItem({ _id: 'x', _slug: 'my-custom-url', name: 'Elena Rodriguez' })]));
    updateCollectionItem('team', 'x', { name: 'Elena Ruiz' });
    expect(JSON.parse(fsStore.get('cms/team.json')!)[0]._slug).toBe('my-custom-url'); // untouched
  });

  test('an explicit _slug in the update always wins', () => {
    teamSchema();
    fsStore.set('cms/team.json', JSON.stringify([makeItem({ _id: 'x', _slug: 'item', name: '' })]));
    updateCollectionItem('team', 'x', { name: 'Elena', _slug: 'forced' });
    expect(JSON.parse(fsStore.get('cms/team.json')!)[0]._slug).toBe('forced');
  });

  test('re-derived slug avoids colliding with a sibling', () => {
    teamSchema();
    fsStore.set('cms/team.json', JSON.stringify([
      makeItem({ _id: 'a', _slug: 'elena', name: 'Elena' }),
      makeItem({ _id: 'b', _slug: 'item', name: '' }),
    ]));
    updateCollectionItem('team', 'b', { name: 'Elena' });   // would be 'elena' but 'a' owns it
    expect(JSON.parse(fsStore.get('cms/team.json')!)[1]._slug).toBe('elena-2');
  });

  test('updating a non-title field leaves the slug alone', () => {
    teamSchema();
    fsStore.set('cms/team.json', JSON.stringify([makeItem({ _id: 'x', _slug: 'item', name: 'Elena' })]));
    updateCollectionItem('team', 'x', { role: 'CTO' });
    expect(JSON.parse(fsStore.get('cms/team.json')!)[0]._slug).toBe('item'); // unchanged
  });

  // An EXPLICIT `_slug` used to bypass normalization AND the uniqueness pass —
  // only the auto-derived branch ran them. Every write path (item editor, the
  // CmsPanel slug row, MCP, the AI agent) passes `_slug` explicitly, so two
  // items in one collection could share a slug and one detail route became
  // unreachable (user report 2026-07-25).
  test('an explicit _slug is slugified', () => {
    teamSchema();
    fsStore.set('cms/team.json', JSON.stringify([makeItem({ _id: 'x', _slug: 'item', name: 'Elena' })]));
    updateCollectionItem('team', 'x', { _slug: 'My Custom URL!' });
    expect(JSON.parse(fsStore.get('cms/team.json')!)[0]._slug).toBe('my-custom-url');
  });

  test('an explicit _slug colliding with a sibling gets suffixed', () => {
    teamSchema();
    fsStore.set('cms/team.json', JSON.stringify([
      makeItem({ _id: 'a', _slug: 'elena', name: 'Elena' }),
      makeItem({ _id: 'b', _slug: 'maria', name: 'Maria' }),
    ]));
    updateCollectionItem('team', 'b', { _slug: 'elena' });
    expect(JSON.parse(fsStore.get('cms/team.json')!)[1]._slug).toBe('elena-2');
  });

  test('re-saving an item with its OWN slug does not self-suffix', () => {
    teamSchema();
    fsStore.set('cms/team.json', JSON.stringify([makeItem({ _id: 'x', _slug: 'elena', name: 'Elena' })]));
    updateCollectionItem('team', 'x', { _slug: 'elena', role: 'CTO' });
    expect(JSON.parse(fsStore.get('cms/team.json')!)[0]._slug).toBe('elena');
  });

  test('an emptied _slug falls back to the title', () => {
    teamSchema();
    fsStore.set('cms/team.json', JSON.stringify([makeItem({ _id: 'x', _slug: 'custom', name: 'Elena Ruiz' })]));
    updateCollectionItem('team', 'x', { _slug: '' });
    expect(JSON.parse(fsStore.get('cms/team.json')!)[0]._slug).toBe('elena-ruiz');
  });

  test('an emptied _slug on a title-less item falls back to "item"', () => {
    teamSchema();
    fsStore.set('cms/team.json', JSON.stringify([makeItem({ _id: 'x', _slug: 'custom', name: '' })]));
    updateCollectionItem('team', 'x', { _slug: '   ' });
    expect(JSON.parse(fsStore.get('cms/team.json')!)[0]._slug).toBe('item');
  });
});

// ── isAutoDerivedSlug (shared by the op and the item editor) ────────────────

describe('isAutoDerivedSlug', () => {
  test('empty and the "item" placeholders are auto-derived', () => {
    expect(isAutoDerivedSlug('', 'Anything')).toBe(true);
    expect(isAutoDerivedSlug('item', 'Anything')).toBe(true);
    expect(isAutoDerivedSlug('item-3', 'Anything')).toBe(true);
  });
  test('a slug matching the title (or its suffixed form) is auto-derived', () => {
    expect(isAutoDerivedSlug('elena-ruiz', 'Elena Ruiz')).toBe(true);
    expect(isAutoDerivedSlug('elena-ruiz-2', 'Elena Ruiz')).toBe(true);
  });
  test('a hand-typed slug is NOT auto-derived', () => {
    expect(isAutoDerivedSlug('my-custom-url', 'Elena Ruiz')).toBe(false);
  });
});

// ── removeCollectionItem ────────────────────────────────────────────────────

describe('removeCollectionItem', () => {
  test('removes item by ID', () => {
    const items = [
      makeItem({ _id: 'alice' }),
      makeItem({ _id: 'bob' }),
    ];
    fsStore.set('cms/team.json', JSON.stringify(items));

    removeCollectionItem('team', 'alice');
    const data = JSON.parse(fsStore.get('cms/team.json')!);
    expect(data).toHaveLength(1);
    expect(data[0]._id).toBe('bob');
  });

  test('does not modify data when item not found', () => {
    const items = [makeItem({ _id: 'alice' })];
    fsStore.set('cms/team.json', JSON.stringify(items));

    removeCollectionItem('team', 'nonexistent');
    // Data should not be re-saved (trace.error called instead)
    const data = JSON.parse(fsStore.get('cms/team.json')!);
    expect(data).toHaveLength(1);
  });
});

// ── reorderCollectionItems ───────────────────────────────────────────────────

describe('reorderCollectionItems', () => {
  test('reorders items to match the given id order', () => {
    const items = [makeItem({ _id: 'a' }), makeItem({ _id: 'b' }), makeItem({ _id: 'c' })];
    fsStore.set('cms/team.json', JSON.stringify(items));

    reorderCollectionItems('team', ['c', 'a', 'b']);
    const data = JSON.parse(fsStore.get('cms/team.json')!) as CollectionItem[];
    expect(data.map(i => i._id)).toEqual(['c', 'a', 'b']);
  });

  test('appends ids missing from the order — never drops items', () => {
    const items = [makeItem({ _id: 'a' }), makeItem({ _id: 'b' }), makeItem({ _id: 'c' })];
    fsStore.set('cms/team.json', JSON.stringify(items));

    // Only 'c' mentioned — 'a' and 'b' survive in their original relative order.
    reorderCollectionItems('team', ['c']);
    const data = JSON.parse(fsStore.get('cms/team.json')!) as CollectionItem[];
    expect(data.map(i => i._id)).toEqual(['c', 'a', 'b']);
  });

  test('ignores unknown ids in the order', () => {
    const items = [makeItem({ _id: 'a' }), makeItem({ _id: 'b' })];
    fsStore.set('cms/team.json', JSON.stringify(items));

    reorderCollectionItems('team', ['b', 'ghost', 'a']);
    const data = JSON.parse(fsStore.get('cms/team.json')!) as CollectionItem[];
    expect(data.map(i => i._id)).toEqual(['b', 'a']);
  });

  test('is a no-op when the order is unchanged (no rewrite)', () => {
    const items = [makeItem({ _id: 'a' }), makeItem({ _id: 'b' })];
    fsStore.set('cms/team.json', JSON.stringify(items));
    const before = fsStore.get('cms/team.json')!;

    reorderCollectionItems('team', ['a', 'b']);
    // Early-returned before re-serializing, so the stored content is byte-identical.
    expect(fsStore.get('cms/team.json')).toBe(before);
  });
});

// ── renameCollection ────────────────────────────────────────────────────────

describe('renameCollection', () => {
  test('changes the display name, keeps the slug', () => {
    fsStore.set('cms/team.schema.json', JSON.stringify(makeSchema('team', 'Team')));
    renameCollection('team', 'The Crew');
    const schema = getCollectionSchema('team');
    expect(schema?.name).toBe('The Crew');
    expect(schema?.slug).toBe('team');
    // File key (slug) unchanged.
    expect(fsStore.has('cms/team.schema.json')).toBe(true);
  });

  test('does nothing when the collection does not exist', () => {
    renameCollection('ghost', 'Nope');
    expect(fsStore.has('cms/ghost.schema.json')).toBe(false);
  });
});

// ── duplicateCollection ─────────────────────────────────────────────────────

describe('duplicateCollection', () => {
  test('copies schema with a new name + unique slug', () => {
    fsStore.set('cms/team.schema.json', JSON.stringify(makeSchema('team', 'Team', [
      { id: 'name', name: 'Name', type: 'text' },
    ])));
    const newSlug = duplicateCollection('team');
    expect(newSlug).toBe('team-copy');
    const copy = getCollectionSchema('team-copy');
    expect(copy?.name).toBe('Team copy');
    expect(copy?.slug).toBe('team-copy');
    expect(copy?.fields).toHaveLength(1);
  });

  test('copies all items', () => {
    fsStore.set('cms/team.schema.json', JSON.stringify(makeSchema('team', 'Team')));
    fsStore.set('cms/team.json', JSON.stringify([
      makeItem({ _id: 'a' }), makeItem({ _id: 'b' }),
    ]));
    const newSlug = duplicateCollection('team')!;
    expect(getCollectionData(newSlug)).toHaveLength(2);
  });

  test('uniquifies the slug on collision', () => {
    fsStore.set('cms/team.schema.json', JSON.stringify(makeSchema('team', 'Team')));
    fsStore.set('cms/team-copy.schema.json', JSON.stringify(makeSchema('team-copy', 'Team copy')));
    const newSlug = duplicateCollection('team');
    expect(newSlug).toBe('team-copy-2');
  });

  test('returns null when the source is missing', () => {
    expect(duplicateCollection('ghost')).toBeNull();
  });
});

// ── createBlankCollection ───────────────────────────────────────────────────

describe('createBlankCollection', () => {
  test('auto-names "Collection 1" with a Title field when none exist', () => {
    const slug = createBlankCollection();
    const schema = getCollectionSchema(slug);
    expect(schema?.name).toBe('Collection 1');
    expect(schema?.fields).toHaveLength(1);
    expect(schema?.fields[0].type).toBe('text');
  });

  test('picks one past the highest existing "Collection N"', () => {
    fsStore.set('cms/a.schema.json', JSON.stringify(makeSchema('a', 'Collection 2')));
    fsStore.set('cms/b.schema.json', JSON.stringify(makeSchema('b', 'Collection 3')));
    const slug = createBlankCollection();
    expect(getCollectionSchema(slug)?.name).toBe('Collection 4');
  });

  test('ignores non-matching names when numbering', () => {
    fsStore.set('cms/a.schema.json', JSON.stringify(makeSchema('a', 'My Blog')));
    expect(getCollectionSchema(createBlankCollection())?.name).toBe('Collection 1');
  });

  test('consecutive calls increment, with distinct slugs', () => {
    const s1 = createBlankCollection();
    const s2 = createBlankCollection();
    expect(getCollectionSchema(s1)?.name).toBe('Collection 1');
    expect(getCollectionSchema(s2)?.name).toBe('Collection 2');
    expect(s1).not.toBe(s2);
  });

  test('uses an explicit name verbatim when given', () => {
    const slug = createBlankCollection('Blog Posts');
    expect(slug).toBe('blog-posts');
    expect(getCollectionSchema(slug)?.name).toBe('Blog Posts');
  });
});

// ── addCollectionField ──────────────────────────────────────────────────────

describe('addCollectionField', () => {
  test('returns an identifier-safe camelCase id (no hyphens)', () => {
    fsStore.set('cms/team.schema.json', JSON.stringify(makeSchema('team', 'Team')));
    const id = addCollectionField('team', { name: 'Cover Image', type: 'image' });
    expect(id).toBe('coverImage');
    const schema = getCollectionSchema('team');
    expect(schema?.fields).toHaveLength(1);
    expect(schema?.fields[0]).toMatchObject({ id: 'coverImage', name: 'Cover Image', type: 'image' });
  });

  test('uniquifies the id without a hyphen', () => {
    fsStore.set('cms/team.schema.json', JSON.stringify(makeSchema('team', 'Team', [
      { id: 'title', name: 'Title', type: 'text' },
    ])));
    const id = addCollectionField('team', { name: 'Title', type: 'text' });
    expect(id).toBe('title2');
  });

  test('carries required + options', () => {
    fsStore.set('cms/team.schema.json', JSON.stringify(makeSchema('team', 'Team')));
    addCollectionField('team', { name: 'Role', type: 'enum', required: true, options: ['CEO', 'CTO'] });
    const f = getCollectionSchema('team')!.fields[0];
    expect(f.required).toBe(true);
    expect(f.options).toEqual(['CEO', 'CTO']);
  });

  test('returns null when the collection is missing', () => {
    expect(addCollectionField('ghost', { name: 'X', type: 'text' })).toBeNull();
  });
});

// ── updateCollectionField ───────────────────────────────────────────────────

describe('updateCollectionField', () => {
  test('patches an existing field', () => {
    fsStore.set('cms/team.schema.json', JSON.stringify(makeSchema('team', 'Team', [
      { id: 'name', name: 'Name', type: 'text' },
    ])));
    expect(updateCollectionField('team', 'name', { required: true })).toBe(true);
    expect(getCollectionSchema('team')!.fields[0].required).toBe(true);
  });

  test('returns false when the field does not exist', () => {
    fsStore.set('cms/team.schema.json', JSON.stringify(makeSchema('team', 'Team')));
    expect(updateCollectionField('team', 'ghost', { required: true })).toBe(false);
  });
});

// ── removeCollectionField ───────────────────────────────────────────────────

describe('removeCollectionField', () => {
  test('removes the field', () => {
    fsStore.set('cms/team.schema.json', JSON.stringify(makeSchema('team', 'Team', [
      { id: 'name', name: 'Name', type: 'text' },
      { id: 'role', name: 'Role', type: 'text' },
    ])));
    expect(removeCollectionField('team', 'name')).toBe(true);
    const fields = getCollectionSchema('team')!.fields;
    expect(fields).toHaveLength(1);
    expect(fields[0].id).toBe('role');
  });

  test('returns false when the field does not exist', () => {
    fsStore.set('cms/team.schema.json', JSON.stringify(makeSchema('team', 'Team')));
    expect(removeCollectionField('team', 'ghost')).toBe(false);
  });
});

// ── resolveItemValues ───────────────────────────────────────────────────────

describe('resolveItemValues', () => {
  const schema = makeSchema('blog', 'Blog', [
    { id: 'title', name: 'Title', type: 'text' },
    { id: 'body-content', name: 'Body Content', type: 'richtext' },
  ]);

  test('passes exact field ids through', () => {
    expect(resolveItemValues(schema, { 'title': 'Hi', 'body-content': '<p>x</p>' }))
      .toEqual({ 'title': 'Hi', 'body-content': '<p>x</p>' });
  });

  test('resolves a camelCase guess onto the hyphenated id', () => {
    expect(resolveItemValues(schema, { bodyContent: '<p>x</p>' }))
      .toEqual({ 'body-content': '<p>x</p>' });
  });

  test('resolves the field display name onto the id', () => {
    expect(resolveItemValues(schema, { 'Body Content': '<p>x</p>' }))
      .toEqual({ 'body-content': '<p>x</p>' });
  });

  test('passes meta keys (underscore-prefixed) through untouched', () => {
    expect(resolveItemValues(schema, { _status: 'published' }))
      .toEqual({ _status: 'published' });
  });

  test('throws listing valid ids when a key matches nothing', () => {
    expect(() => resolveItemValues(schema, { body: '<p>x</p>' }))
      .toThrow(/Unknown field\(s\): body.*body-content/);
  });
});

// ── generateItemId ──────────────────────────────────────────────────────────

describe('generateItemId', () => {
  test('returns a string starting with item_', () => {
    const id = generateItemId();
    expect(typeof id).toBe('string');
    expect(id).toMatch(/^item_/);
  });

  test('returns unique strings on consecutive calls', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generateItemId());
    }
    expect(ids.size).toBe(100);
  });
});

// ── slugify ─────────────────────────────────────────────────────────────────

describe('slugify', () => {
  test('converts basic text', () => {
    expect(slugify('Hello World')).toBe('hello-world');
  });

  test('handles special characters', () => {
    expect(slugify('Hello, World! @#$%')).toBe('hello-world');
  });

  test('handles unicode/diacritics', () => {
    expect(slugify('Cafe Résumé')).toBe('cafe-resume');
  });

  test('collapses multiple spaces/hyphens', () => {
    expect(slugify('hello   world---test')).toBe('hello-world-test');
  });

  test('trims leading/trailing hyphens', () => {
    expect(slugify('---hello---')).toBe('hello');
  });

  test('returns untitled for empty string', () => {
    expect(slugify('')).toBe('untitled');
  });

  test('returns untitled for whitespace-only', () => {
    expect(slugify('   ')).toBe('untitled');
  });

  test('handles numbers', () => {
    expect(slugify('Item 123')).toBe('item-123');
  });

  test('handles underscores', () => {
    expect(slugify('hello_world_test')).toBe('hello-world-test');
  });
});

// ── cmsItemLabel ─────────────────────────────────────────────────────────────

describe('cmsItemLabel', () => {
  test('uses the first text field value', () => {
    const schema = makeSchema('team', 'Team', [
      { id: 'role', name: 'Role', type: 'enum' },
      { id: 'name', name: 'Name', type: 'text' },
    ]);
    const item = makeItem({ _id: 'a', role: 'CEO', name: 'Alice' });
    expect(cmsItemLabel(item, schema)).toBe('Alice');
  });

  test('falls back to /slug when the text field is empty', () => {
    const schema = makeSchema('team', 'Team', [
      { id: 'name', name: 'Name', type: 'text' },
    ]);
    const item = makeItem({ _id: 'a', _slug: 'bob', name: '' });
    expect(cmsItemLabel(item, schema)).toBe('/bob');
  });

  test('falls back to /slug when there is no text field', () => {
    const schema = makeSchema('team', 'Team', [
      { id: 'count', name: 'Count', type: 'number' },
    ]);
    const item = makeItem({ _id: 'a', _slug: 'item-1', count: 3 });
    expect(cmsItemLabel(item, schema)).toBe('/item-1');
  });

  test('returns Untitled when slug is also empty', () => {
    const schema = makeSchema('team', 'Team', []);
    const item = makeItem({ _id: 'a', _slug: '' });
    expect(cmsItemLabel(item, schema)).toBe('Untitled');
  });
});

// ─── Field NAME uniqueness ──────────────────────────────────────────────────
// The field ID was always uniquified (`content`, `content2`) but the NAME was
// not, so a collection could hold two fields both displayed as "Content" —
// indistinguishable in the fields list, the binding pickers and the item editor
// (user report 2026-07-25). Matches the reference CMS: the second one becomes
// "Content 2".

describe('uniqueFieldName', () => {
  test('a free name is returned untouched', () => {
    expect(uniqueFieldName('Title', ['Content', 'Date'])).toBe('Title');
  });

  test('a taken name gets " 2", then " 3"', () => {
    expect(uniqueFieldName('Content', ['Content'])).toBe('Content 2');
    expect(uniqueFieldName('Content', ['Content', 'Content 2'])).toBe('Content 3');
  });

  test('comparison is trimmed + case-insensitive (ids collide anyway)', () => {
    expect(uniqueFieldName('content', ['Content'])).toBe('content 2');
    expect(uniqueFieldName('  Content  ', ['Content'])).toBe('Content 2');
  });

  test('a typed "Title 2" that is taken continues from the base, not "Title 2 2"', () => {
    expect(uniqueFieldName('Title 2', ['Title', 'Title 2'])).toBe('Title 3');
  });

  test('a blank name is left blank — new fields start as "Untitled field"', () => {
    expect(uniqueFieldName('', ['Content'])).toBe('');
    expect(uniqueFieldName('   ', [])).toBe('   ');
  });
});

describe('addCollectionField — name uniqueness', () => {
  test('a duplicate name is suffixed, and the id follows it', () => {
    saveCollectionSchema('blog', makeSchema('blog', 'Blog', [
      { id: 'content', name: 'Content', type: 'text' },
    ]));
    const id = addCollectionField('blog', { name: 'Content', type: 'textarea' });
    const fields = getCollectionSchema('blog')!.fields;
    expect(fields.map(f => f.name)).toEqual(['Content', 'Content 2']);
    expect(id).toBe('content2');
    // Both are still addressable — no id collision either.
    expect(new Set(fields.map(f => f.id)).size).toBe(2);
  });

  test('a free name is untouched', () => {
    saveCollectionSchema('blog', makeSchema('blog', 'Blog', [
      { id: 'content', name: 'Content', type: 'text' },
    ]));
    addCollectionField('blog', { name: 'Author', type: 'text' });
    expect(getCollectionSchema('blog')!.fields.map(f => f.name)).toEqual(['Content', 'Author']);
  });
});

describe('updateCollectionField — rename uniqueness', () => {
  beforeEach(() => {
    saveCollectionSchema('blog', makeSchema('blog', 'Blog', [
      { id: 'title', name: 'Title', type: 'text' },
      { id: 'content', name: 'Content', type: 'text' },
    ]));
  });

  test('renaming onto an existing name is suffixed', () => {
    updateCollectionField('blog', 'content', { name: 'Title' });
    expect(getCollectionSchema('blog')!.fields.map(f => f.name)).toEqual(['Title', 'Title 2']);
  });

  test('a field can keep its OWN name (re-commit is not a self-collision)', () => {
    updateCollectionField('blog', 'title', { name: 'Title' });
    expect(getCollectionSchema('blog')!.fields.map(f => f.name)).toEqual(['Title', 'Content']);
  });

  test('renaming to a genuinely free name is untouched', () => {
    updateCollectionField('blog', 'content', { name: 'Body' });
    expect(getCollectionSchema('blog')!.fields.map(f => f.name)).toEqual(['Title', 'Body']);
  });

  test('patches that do not touch the name are unaffected', () => {
    updateCollectionField('blog', 'content', { required: true });
    const f = getCollectionSchema('blog')!.fields.find(x => x.id === 'content')!;
    expect(f.name).toBe('Content');
    expect(f.required).toBe(true);
  });
});

// ─── Autosave on every CMS write ────────────────────────────────────────────
// Autosave is normally driven by the mutation queue's `onAfterFlush`, but CMS
// writes never touch that queue — they go straight to projectFS. Nothing flushed
// and nothing scheduled a save, so editing a collection and reloading lost the
// work (user report 2026-07-25). The three persist points now schedule it.

describe('CMS writes schedule an autosave', () => {
  test('saving a schema', () => {
    saveCollectionSchema('blog', makeSchema('blog', 'Blog'));
    expect(triggerAutosave).toHaveBeenCalled();
  });

  test('saving items', () => {
    saveCollectionData('blog', [makeItem()]);
    expect(triggerAutosave).toHaveBeenCalled();
  });

  test('deleting a collection', () => {
    saveCollectionSchema('blog', makeSchema('blog', 'Blog'));
    vi.mocked(triggerAutosave).mockClear();
    deleteCollection('blog');
    expect(triggerAutosave).toHaveBeenCalled();
  });

  test('a field edit (the reported case) rides the schema write', () => {
    saveCollectionSchema('blog', makeSchema('blog', 'Blog', [
      { id: 'title', name: 'Title', type: 'text' },
    ]));
    vi.mocked(triggerAutosave).mockClear();

    addCollectionField('blog', { name: 'Body', type: 'textarea' });
    expect(triggerAutosave).toHaveBeenCalledTimes(1);

    updateCollectionField('blog', 'title', { required: true });
    expect(triggerAutosave).toHaveBeenCalledTimes(2);

    removeCollectionField('blog', 'body');
    expect(triggerAutosave).toHaveBeenCalledTimes(3);
  });

  test('adding an item rides the data write', () => {
    saveCollectionSchema('blog', makeSchema('blog', 'Blog'));
    vi.mocked(triggerAutosave).mockClear();
    addCollectionItem('blog', {});
    expect(triggerAutosave).toHaveBeenCalled();
  });
});

// ── Field defaults must reach the ITEMS, not just the schema ────────────────
// The published page imports cms/<slug>.json directly, so nothing resolves a
// schema default at render time. A default that never lands on an item is
// invisible everywhere. Live find 2026-07-30: a Color field defaulted to
// #000000 stayed blank on all six pre-existing items.
describe('field defaults cascade to items', () => {
  beforeEach(() => {
    fsStore.clear();
    saveCollectionSchema('proj', {
      name: 'Projects', slug: 'proj',
      fields: [{ id: 'title', name: 'Title', type: 'text' }],
    } as CollectionSchema);
    // partial fixtures — the system fields aren't relevant to default cascading
    saveCollectionData('proj', [
      { _id: 'a', _slug: 'a', title: 'A' },
      { _id: 'b', _slug: 'b', title: 'B' },
      { _id: 'c', _slug: 'c', title: 'C' },
    ] as unknown as CollectionItem[]);
  });

  const values = () => getCollectionData('proj').map(i => (i as any).tint);

  it('adding a field WITH a default backfills every existing item', () => {
    const id = addCollectionField('proj', { name: 'Tint', type: 'color', defaultValue: '#000000' });
    expect(id).toBe('tint');
    expect(getCollectionSchema('proj')!.fields.find(f => f.id === 'tint')!.defaultValue).toBe('#000000');
    expect(values()).toEqual(['#000000', '#000000', '#000000']);
  });

  it('setting the default AFTER the field exists reaches items created earlier', () => {
    addCollectionField('proj', { name: 'Tint', type: 'color' });
    expect(values()).toEqual([undefined, undefined, undefined]);
    updateCollectionField('proj', 'tint', { defaultValue: '#000000' });
    expect(values()).toEqual(['#000000', '#000000', '#000000']);
  });

  it('changing the default follows items still on the old one, but NOT hand-edited items', () => {
    addCollectionField('proj', { name: 'Tint', type: 'color', defaultValue: '#000000' });
    updateCollectionItem('proj', 'b', { tint: '#FF2D00' } as Partial<CollectionItem>);  // user override

    updateCollectionField('proj', 'tint', { defaultValue: '#FFFFFF' });
    expect(values()).toEqual(['#FFFFFF', '#FF2D00', '#FFFFFF']);   // b keeps its own colour
  });

  it('a patch that does not touch defaultValue never rewrites item data', () => {
    addCollectionField('proj', { name: 'Tint', type: 'color', defaultValue: '#000000' });
    updateCollectionItem('proj', 'a', { tint: '#123456' } as Partial<CollectionItem>);
    updateCollectionField('proj', 'tint', { name: 'Colour' });     // rename only
    expect(values()).toEqual(['#123456', '#000000', '#000000']);
  });

  it('clearing a default leaves every item untouched', () => {
    addCollectionField('proj', { name: 'Tint', type: 'color', defaultValue: '#000000' });
    updateCollectionField('proj', 'tint', { defaultValue: undefined });
    expect(values()).toEqual(['#000000', '#000000', '#000000']);
  });

  it('false and 0 are REAL values, not "unset" — they are not overwritten', () => {
    saveCollectionData('proj', [{ _id: 'a', _slug: 'a', flag: false, n: 0 }] as any);
    syncFieldDefaultToItems('proj', 'flag', true);
    syncFieldDefaultToItems('proj', 'n', 10);
    const it0 = getCollectionData('proj')[0] as any;
    expect(it0.flag).toBe(false);
    expect(it0.n).toBe(0);
  });

  it('reports how many items it touched and is idempotent', () => {
    addCollectionField('proj', { name: 'Tint', type: 'color' });
    expect(syncFieldDefaultToItems('proj', 'tint', '#000000')).toBe(3);
    expect(syncFieldDefaultToItems('proj', 'tint', '#000000')).toBe(0);
  });
});

// New items get schema defaults from cms-ops itself, so the MCP agent and any
// other caller behave like the CMS panel (which used to be the only path that
// applied them).
describe('addCollectionItem seeds schema defaults', () => {
  beforeEach(() => {
    fsStore.clear();
    saveCollectionSchema('proj', {
      name: 'Projects', slug: 'proj',
      fields: [
        { id: 'title', name: 'Title', type: 'text' },
        { id: 'tint', name: 'Tint', type: 'color', defaultValue: '#000000' },
        { id: 'live', name: 'Live', type: 'boolean' },
        { id: 'kw', name: 'Keywords', type: 'tags' },
      ],
    } as CollectionSchema);
    saveCollectionData('proj', []);
  });

  it('applies defaultValue, and the boolean/tags empty states', () => {
    const it0 = addCollectionItem('proj', { title: 'A' }) as any;
    expect(it0.tint).toBe('#000000');
    expect(it0.live).toBe(false);
    expect(it0.kw).toEqual([]);
  });

  it('a caller-supplied value always beats the default', () => {
    const it0 = addCollectionItem('proj', { title: 'A', tint: '#FF2D00' } as any) as any;
    expect(it0.tint).toBe('#FF2D00');
  });
});
