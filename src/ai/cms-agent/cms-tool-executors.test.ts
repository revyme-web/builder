// cms-tool-executors.test.ts — the PURE-TEXT guard on agent/MCP item writes.
//
// CMS field values must never carry HTML/JSX markup (user rule 2026-07-30):
// styling lives on the canvas elements a field is bound to, never in the
// data. add_item / update_item reject any tag-shaped value with a
// self-correcting error.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), dom: vi.fn(), error: vi.fn() },
}));

const cms = vi.hoisted(() => ({
  items: [] as any[],
  schema: {
    name: 'Blog',
    fields: [
      { id: 'title', name: 'Title', type: 'text' },
      { id: 'content', name: 'Content', type: 'richtext' },
    ],
  },
}));

vi.mock('@/code/project/cms-ops', () => ({
  listCollections: vi.fn(() => ['blog']),
  getCollectionSchema: vi.fn(() => cms.schema),
  getCollectionData: vi.fn(() => cms.items),
  createBlankCollection: vi.fn(),
  renameCollection: vi.fn(),
  cascadeDeleteCollection: vi.fn(),
  addCollectionField: vi.fn(() => 'newField'),
  updateCollectionField: vi.fn(() => true),
  removeCollectionField: vi.fn(),
  addCollectionItem: vi.fn((_slug: string, values: any) => {
    const item = { _id: 'i1', _slug: 's1', ...values };
    cms.items.push(item);
    return item;
  }),
  updateCollectionItem: vi.fn(),
  removeCollectionItem: vi.fn(),
  resolveItemValues: vi.fn((_schema: any, raw: any) => ({ ...raw })),
  setCollectionItemTranslation: vi.fn((slug: string, itemId: string, locale: string, field: string, value: string) => {
    const item = cms.items.find((i: any) => i._id === itemId);
    if (!item) return;
    item._i18n = { ...(item._i18n ?? {}), [locale]: { ...(item._i18n?.[locale] ?? {}), [field]: value } };
  }),
}));

import { executeCmsTool } from './cms-tool-executors';

beforeEach(() => { cms.items = []; });

describe('pure-text field guard', () => {
  it('rejects add_item values carrying HTML tags, naming the field + tag', () => {
    const res = executeCmsTool('add_item', {
      collection: 'blog',
      values: { title: 'Fine', content: '<h2>Heading</h2><p>Body</p>' },
    });
    expect(res.isError).toBe(true);
    expect(String((res.response as any).error)).toContain('"content"');
    expect(String((res.response as any).error)).toContain('<h2>');
    expect(String((res.response as any).error)).toContain('PURE text');
    expect(cms.items).toHaveLength(0);
  });

  it('rejects update_item the same way', () => {
    cms.items.push({ _id: 'i1' });
    const res = executeCmsTool('update_item', {
      collection: 'blog', itemId: 'i1',
      values: { content: 'plain then <span style="color:red">styled</span>' },
    });
    expect(res.isError).toBe(true);
    expect(String((res.response as any).error)).toContain('<span');
  });

  it('accepts pure text with blank-line paragraphs and comparison operators', () => {
    const res = executeCmsTool('add_item', {
      collection: 'blog',
      values: { title: 'a < b and 5<6 are fine', content: 'Para one.\n\nPara two.' },
    });
    expect(res.isError).toBe(false);
    expect(cms.items).toHaveLength(1);
  });

  it('ignores non-string and underscore-prefixed values', () => {
    const res = executeCmsTool('add_item', {
      collection: 'blog',
      values: { title: 'ok', _status: 'published' },
    });
    expect(res.isError).toBe(false);
  });
});

// ─── Collection localization ────────────────────────────────────────────────
//
// A translated collection is ONE row per item with `_i18n[locale][field]` on it
// — never a `language` column with duplicate rows per locale. That workaround
// shipped to a real customer page (2026-08-10): the page had to filter rows by
// locale, the derived array was unresolvable to the parser, and two sections
// lost their CMS panel and field bindings entirely.

describe('language-column refusal', () => {
  it('refuses add_field("Language") and points at set_item_translation', () => {
    const res = executeCmsTool('add_field', { collection: 'blog', name: 'Language', type: 'text' });
    expect(res.isError).toBe(true);
    const err = String((res.response as any).error);
    expect(err).toContain('NOT one row per language');
    expect(err).toContain('set_item_translation');
    expect(err).toContain('localizeRows');
  });

  it('refuses the aliases and other spellings', () => {
    for (const name of ['locale', 'lang', 'LANGUAGES', 'langue', ' Locale ']) {
      const res = executeCmsTool('add_field', { collection: 'blog', name, type: 'text' });
      expect(res.isError, `"${name}" must be refused`).toBe(true);
    }
  });

  it('refuses RENAMING a field into a language column', () => {
    const res = executeCmsTool('update_field', { collection: 'blog', fieldId: 'title', name: 'language' });
    expect(res.isError).toBe(true);
  });

  it('still allows ordinary fields', () => {
    const res = executeCmsTool('add_field', { collection: 'blog', name: 'Subtitle', type: 'text' });
    expect(res.isError).toBe(false);
  });
});

describe('set_item_translation — the native path', () => {
  beforeEach(() => { cms.items = [{ _id: 'i1', title: 'Opening' }]; });

  it('stores the translation on the row under _i18n', () => {
    const res = executeCmsTool('set_item_translation', {
      collection: 'blog', itemId: 'i1', locale: 'fr', field: 'title', value: 'Ouverture',
    });
    expect(res.isError).toBe(false);
    expect(cms.items[0]._i18n).toEqual({ fr: { title: 'Ouverture' } });
    expect(String((res.response as any).note)).toContain('localizeRows');
  });

  it('rejects a field id that does not exist — a typo would translate nothing', () => {
    const res = executeCmsTool('set_item_translation', {
      collection: 'blog', itemId: 'i1', locale: 'fr', field: 'titel', value: 'Ouverture',
    });
    expect(res.isError).toBe(true);
    expect(String((res.response as any).error)).toContain('title');
  });

  it('rejects an unknown item', () => {
    const res = executeCmsTool('set_item_translation', {
      collection: 'blog', itemId: 'nope', locale: 'fr', field: 'title', value: 'x',
    });
    expect(res.isError).toBe(true);
  });

  it('applies the pure-text guard to translations too', () => {
    const res = executeCmsTool('set_item_translation', {
      collection: 'blog', itemId: 'i1', locale: 'fr', field: 'title', value: '<b>Ouverture</b>',
    });
    expect(res.isError).toBe(true);
    expect(String((res.response as any).error)).toContain('PURE text');
  });
});
