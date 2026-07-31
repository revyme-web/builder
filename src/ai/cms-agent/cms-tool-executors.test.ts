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
  addCollectionField: vi.fn(),
  updateCollectionField: vi.fn(),
  removeCollectionField: vi.fn(),
  addCollectionItem: vi.fn((_slug: string, values: any) => {
    const item = { _id: 'i1', _slug: 's1', ...values };
    cms.items.push(item);
    return item;
  }),
  updateCollectionItem: vi.fn(),
  removeCollectionItem: vi.fn(),
  resolveItemValues: vi.fn((_schema: any, raw: any) => ({ ...raw })),
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
