// The ONE agent's CMS tools, against the REAL cms-ops — only ProjectFS is
// in-memory. A test that mocked cms-ops would prove the tools call functions;
// this proves a collection, its fields and its items actually exist afterwards.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), dom: vi.fn(), error: vi.fn() },
}));

const fsStore = vi.hoisted(() => new Map<string, string>());

vi.mock('@/code/project/project-fs', async () => {
  const { atom } = await import('jotai');
  return {
    projectVersionAtom: atom(0),
    stableProjectVersionAtom: atom(0),
    projectFS: {
      readFile: vi.fn((p: string) => fsStore.get(p) ?? null),
      writeFile: vi.fn((p: string, c: string) => { fsStore.set(p, c); }),
      deleteFile: vi.fn((p: string) => { fsStore.delete(p); }),
      exists: vi.fn((p: string) => fsStore.has(p)),
      listFiles: vi.fn((dir?: string) => {
        const prefix = dir ? (dir.endsWith('/') ? dir : `${dir}/`) : '';
        return [...fsStore.keys()].filter((p) => !prefix || p.startsWith(prefix)).sort();
      }),
      getActiveBranchId: vi.fn(() => 'main'),
    },
  };
});

import { getDefaultStore } from 'jotai';
import { z } from 'zod';
import { CMS_TOOLS, toAgentDialect } from './cms';
import { ALL_TOOLS } from './index';
import { buildToolManifest } from '../tool-manifest';
import { cmsEditorCollectionAtom } from '@/code/stores/cms-editor-store';
import { getCollectionSchema, getCollectionData, listCollections } from '@/code/project/cms-ops';
import type { ToolContext } from '@/ai/agent';

const store = getDefaultStore();
const tool = (name: string) => CMS_TOOLS.find((t) => t.name === name)!;
const checkpoints = { n: 0 };
const ctx = (): ToolContext => ({ ensureCheckpoint: () => { checkpoints.n++; }, vpWidth: 1440, signal: new AbortController().signal });
const call = async (name: string, args: Record<string, unknown>, c: ToolContext = ctx()) => {
  const r = await tool(name).execute(args, c);
  const first = r.content[0];
  return { isError: !!r.isError, data: JSON.parse(first.type === 'text' ? first.text : '{}') };
};

beforeEach(() => { fsStore.clear(); checkpoints.n = 0; store.set(cmsEditorCollectionAtom, null); });

describe('building a collection end to end', () => {
  it('create → fields → many items, and it is all really there', async () => {
    const created = await call('cms_create_collection', { name: 'Blog Posts' });
    expect(created.isError).toBe(false);
    const slug = created.data.slug as string;
    expect(listCollections()).toContain(slug);

    const field = await call('cms_add_field', { collection: slug, name: 'Excerpt', type: 'textarea' });
    expect(field.isError).toBe(false);
    const excerptId = field.data.field_id as string;
    expect(getCollectionSchema(slug)!.fields.map((f) => f.id)).toContain(excerptId);

    const titleId = getCollectionSchema(slug)!.fields[0].id;
    const added = await call('cms_add_items', { collection: slug, items: [
      { [titleId]: 'First post', [excerptId]: 'Hello' },
      { [titleId]: 'Second post', [excerptId]: 'World' },
    ] });
    expect(added.data).toMatchObject({ added: 2, failed: 0 });
    expect(getCollectionData(slug).map((i) => i[titleId])).toEqual(['First post', 'Second post']);
  });

  it('a run of CMS edits arms the checkpoint — so it is ONE undo step, like a canvas run', async () => {
    const { data } = await call('cms_create_collection', { name: 'Team' });
    await call('cms_add_field', { collection: data.slug, name: 'Role', type: 'text' });
    expect(checkpoints.n).toBe(2);
  });

  it('a read does not arm it', async () => {
    const { data } = await call('cms_create_collection', { name: 'Team' });
    checkpoints.n = 0;
    await call('cms_get_collection', { collection: data.slug });
    expect(checkpoints.n).toBe(0);
  });
});

describe('soft focus', () => {
  it('`collection` defaults to the one the user has open', async () => {
    const { data } = await call('cms_create_collection', { name: 'Jobs' });
    store.set(cmsEditorCollectionAtom, data.slug);
    const got = await call('cms_get_collection', {});
    expect(got.data.slug).toBe(data.slug);
  });

  // The OLD CMS agent refused this ("this chat is locked to the active
  // collection") — the per-panel fence the one-agent model removes.
  it('a NEW collection can be created while another is open', async () => {
    const first = await call('cms_create_collection', { name: 'Posts' });
    store.set(cmsEditorCollectionAtom, first.data.slug);
    const second = await call('cms_create_collection', { name: 'Authors' });
    expect(second.isError).toBe(false);
    expect(listCollections()).toEqual(expect.arrayContaining([first.data.slug, second.data.slug]));
  });

  it('with nothing open and no slug, it says what to pass instead of guessing', async () => {
    const r = await call('cms_get_collection', {});
    expect(r.isError).toBe(true);
    expect(String(r.data.error)).toMatch(/collection/i);
  });
});

describe('the rules the executors own still hold through these tools', () => {
  it('rejects HTML in a value, and says so in THIS agent\'s tool names', async () => {
    const { data } = await call('cms_create_collection', { name: 'Blog' });
    const titleId = getCollectionSchema(data.slug)!.fields[0].id;
    const r = await call('cms_add_items', { collection: data.slug, items: [{ [titleId]: '<h2>Nope</h2>' }] });
    expect(r.isError).toBe(true);
    expect(getCollectionData(data.slug)).toHaveLength(0);
  });

  it('refuses a "language" field and points at cms_set_item_translation, not the old name', async () => {
    const { data } = await call('cms_create_collection', { name: 'Blog' });
    const r = await call('cms_add_field', { collection: data.slug, name: 'Language', type: 'text' });
    expect(r.isError).toBe(true);
    expect(String(r.data.error)).toContain('cms_set_item_translation');
    expect(String(r.data.error)).toContain('item_id');
    expect(String(r.data.error)).not.toMatch(/\bitemId\b/);
  });

  it('a partial batch is reported honestly: what landed stays, what failed is named', async () => {
    const { data } = await call('cms_create_collection', { name: 'Blog' });
    const titleId = getCollectionSchema(data.slug)!.fields[0].id;
    const r = await call('cms_add_items', { collection: data.slug, items: [
      { [titleId]: 'Good' }, { [titleId]: '<b>bad</b>' }, { [titleId]: 'Also good' },
    ] });
    expect(r.isError).toBe(false);                       // something landed
    expect(r.data).toMatchObject({ added: 2, failed: 1 });
    expect(r.data.errors[0].index).toBe(1);
    expect(getCollectionData(data.slug)).toHaveLength(2);
  });

  it('delete never defaults to the open collection', async () => {
    const { data } = await call('cms_create_collection', { name: 'Keep me' });
    store.set(cmsEditorCollectionAtom, data.slug);
    // The bridge validates input with z.object(tool.inputSchema): a delete
    // with no slug never reaches the executor.
    expect(z.object(tool('cms_delete_collection').inputSchema).safeParse({}).success).toBe(false);
    expect(z.object(tool('cms_get_collection').inputSchema).safeParse({}).success).toBe(true);
    expect(listCollections()).toContain(data.slug);
  });

  it('refuses to write on a branch-bound run, like apply_file_edit', async () => {
    const bound: ToolContext = { ...ctx(), workspace: { branchId: 'exp', filePath: 'app/page.tsx' } };
    const r = await call('cms_create_collection', { name: 'X' }, bound);
    expect(r.isError).toBe(true);
    expect(listCollections()).toEqual([]);
  });
});

describe('toAgentDialect', () => {
  it('renames old tool names and arguments, once', () => {
    expect(toAgentDialect('Call get_collection, then add_item with itemId')).toBe('Call cms_get_collection, then cms_add_item with item_id');
    expect(toAgentDialect('use cms_get_collection')).toBe('use cms_get_collection');
  });
  it('leaves list_collections alone — that tool keeps its name', () => {
    expect(toAgentDialect('Call list_collections')).toBe('Call list_collections');
  });
});

describe('the one tool surface', () => {
  it('has no duplicate names after the CMS tools joined it', () => {
    const names = ALL_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
  it('every CMS tool and load_manual survives serialization to the manifest the service reads', () => {
    const manifest = new Set(buildToolManifest().map((t) => t.name));
    for (const t of [...CMS_TOOLS.map((x) => x.name), 'load_manual']) expect(manifest.has(t), t).toBe(true);
  });
  it('arguments are snake_case, like every other tool the prompt describes', () => {
    for (const t of CMS_TOOLS) for (const key of Object.keys(t.inputSchema)) expect(key, `${t.name}.${key}`).toMatch(/^[a-z][a-z_]*$/);
  });
});
