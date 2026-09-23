// src/ai/agent/tools/semantic-structure.test.ts

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { atom } from 'jotai';
import { queueMutation, flushNow, type Mutation } from '@/code/mutation/mutation-queue';
import { getNodesSnapshot, selectedIdsAtom } from '@/code/stores/store';
import { projectFS, resetProjectFS } from '@/code/project/project-fs';
import type { CanvasNode } from '@/code/parsing/parser';
import type { ToolContext } from '@/ai/agent';
import {
  addNodeTool,
  addCanvasNodeTool,
  deleteNodeTool,
  moveNodeTool,
  reorderNodeTool,
  duplicateNodeTool,
  cloneSubtree,
  addComponentInstanceTool,
  setComponentPropTool,
  filterDeclaredProps,
  missingRequiredProps,
  STRUCTURE_TOOLS,
} from './semantic-structure';

vi.mock('@/code/mutation/mutation-queue', () => ({
  queueMutation: vi.fn(),
  flushNow: vi.fn(),
  // P8: les outils routent via queueToolMutation(ctx) qui résout le fichier
  // actif de la queue pour les runs non-branchés (comportement legacy identique).
  getQueueActiveFilePath: vi.fn(() => 'app/page.client.tsx'),
}));

vi.mock('@/code/stores/store', () => ({
  getNodesSnapshot: vi.fn(),
  selectedIdsAtom: atom<string[]>([]),
}));

vi.mock('@/code/components/component-registry', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/code/components/component-registry')>();
  return { ...mod, buildComponentRegistry: vi.fn(() => new Map()) };
});

import { buildComponentRegistry } from '@/code/components/component-registry';

type AddNodeMutation = Extract<Mutation, { type: 'addNode' }>;

function makeCtx(): ToolContext {
  return { ensureCheckpoint: vi.fn(), vpWidth: 1440, signal: new AbortController().signal };
}

function lastMutation(): Mutation {
  return vi.mocked(queueMutation).mock.calls[vi.mocked(queueMutation).mock.calls.length - 1][0] as Mutation;
}

/** A 3-level snapshot: root → (section → h2/img, span → span-leaf). */
function makeSubtreeSnapshot(): Map<string, CanvasNode> {
  const nodes = [
    { id: 'root', type: 'div', name: 'Root', parentId: 'page', children: ['a', 'b'], styles: { display: 'flex' }, attrs: { id: 'main' }, textContent: '' },
    { id: 'a', type: 'section', name: 'A', parentId: 'root', children: ['a1', 'a2'], styles: { padding: '12px' }, attrs: {}, textContent: '' },
    { id: 'a1', type: 'h2', name: 'Heading', parentId: 'a', children: [], styles: { color: 'red' }, attrs: {}, textContent: 'Hello' },
    { id: 'a2', type: 'img', name: 'Pic', parentId: 'a', children: [], styles: {}, attrs: { src: '/img.png' }, textContent: '' },
    { id: 'b', type: 'span', name: 'B', parentId: 'root', children: ['b1'], styles: {}, attrs: {}, textContent: '' },
    { id: 'b1', type: 'span', name: '', parentId: 'b', children: [], styles: {}, attrs: {}, textContent: 'Neutral' },
  ] as unknown as CanvasNode[];
  return new Map(nodes.map((n) => [n.id, n]));
}

/** Collect every id of a cloned subtree, deepest-first. */
function collectCloneIds(node: { id: string; children?: any[] }): string[] {
  return [node.id, ...(node.children ?? []).flatMap((c) => collectCloneIds(c))];
}

describe('semantic structure tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('add_node without index queues addNode with no index key and returns the id', async () => {
    const ctx = makeCtx();
    const result = await addNodeTool.execute({ parent_id: 'p1' }, ctx);
    expect(ctx.ensureCheckpoint).toHaveBeenCalledTimes(1);
    expect(queueMutation).toHaveBeenCalledTimes(1);
    const m = lastMutation() as AddNodeMutation;
    expect(m.type).toBe('addNode');
    expect(m.parentId).toBe('p1');
    expect(m.node.type).toBe('div');
    // Every new node carries a position — the oracle rejects one without (NODE_MISSING_POSITION).
    expect(m.node.styles).toEqual({ position: 'relative' });
    expect(m.node.attrs).toEqual({});
    expect(typeof m.node.id).toBe('string');
    expect(m.node.id.length).toBeGreaterThan(0);
    expect('index' in m).toBe(false);
    expect(flushNow).toHaveBeenCalledTimes(1);
    const data = JSON.parse((result.content[0] as any).text);
    expect(data.node_id).toBe(m.node.id);
    expect(result.isError).toBeUndefined();
  });

  it('add_node with index, text, name and tag passes them through', async () => {
    vi.mocked(getNodesSnapshot).mockReturnValue(new Map<string, CanvasNode>());
    const ctx = makeCtx();
    const result = await addNodeTool.execute(
      { parent_id: 'p1', tag: 'section', text: 'Hello', name: 'hero', styles: { color: 'red' }, attrs: { role: 'banner' }, index: 2 },
      ctx,
    );
    const m = lastMutation() as AddNodeMutation;
    expect(m.parentId).toBe('p1');
    expect(m.index).toBe(2);
    expect(m.node.type).toBe('section');
    expect(m.node.textContent).toBe('Hello');
    expect(m.node.name).toBe('hero');
    expect(m.node.styles).toEqual({ color: 'red', position: 'relative' });
    expect(m.node.attrs).toEqual({ role: 'banner' });
    expect(flushNow).toHaveBeenCalledTimes(1);
    const data = JSON.parse((result.content[0] as any).text);
    expect(data.node_id).toBe(m.node.id);
  });

  it("add_node maps the HTML 'id' attribute to the node's data-id (reference-style naming)", async () => {
    vi.mocked(getNodesSnapshot).mockReturnValue(new Map<string, CanvasNode>());
    const ctx = makeCtx();
    const result = await addNodeTool.execute(
      { parent_id: 'p1', tag: 'section', attrs: { id: 'hero-section', className: 'hero' } },
      ctx,
    );
    const m = lastMutation() as AddNodeMutation;
    expect(m.node.id).toBe('hero-section');
    expect(m.node.attrs).toEqual({ className: 'hero' });
    const data = JSON.parse((result.content[0] as any).text);
    expect(data.node_id).toBe('hero-section');
    expect(result.isError).toBeUndefined();
  });

  it('add_node strips reserved attrs (data-id/data-name) and reports ignored_attrs', async () => {
    // E2E réel 2026-08-15 : le modèle envoyait attrs:{data-id} → le générateur
    // écrivait l'auto-id ET l'attribut → « Duplicate JSX attribute » → le
    // batch entier était rollbacké. L'éditeur reste propriétaire de l'identité.
    const ctx = makeCtx();
    const result = await addNodeTool.execute(
      {
        parent_id: 'p1',
        tag: 'section',
        name: 'agency-section',
        attrs: { 'data-id': 'agency-section', 'data-name': 'dup', role: 'banner' },
      },
      ctx,
    );
    const m = lastMutation() as AddNodeMutation;
    expect(m.node.attrs).toEqual({ role: 'banner' });
    expect(m.node.attrs?.['data-id']).toBeUndefined();
    expect(m.node.attrs?.['data-name']).toBeUndefined();
    const data = JSON.parse((result.content[0] as any).text);
    expect(data.ignored_attrs).toEqual(['data-id', 'data-name']);
    expect(data.node_id).toBe(m.node.id);
  });

  it('add_node accepts a model-chosen id and uses it as the data-id', async () => {
    vi.mocked(getNodesSnapshot).mockReturnValue(new Map<string, CanvasNode>());
    const ctx = makeCtx();
    const result = await addNodeTool.execute({ parent_id: 'p1', tag: 'section', id: 'hero-section' }, ctx);
    const m = lastMutation() as AddNodeMutation;
    expect(m.node.id).toBe('hero-section');
    const data = JSON.parse((result.content[0] as any).text);
    expect(data.node_id).toBe('hero-section');
    expect(result.isError).toBeUndefined();
  });

  it('add_node rejects a model-chosen id that already exists', async () => {
    vi.mocked(getNodesSnapshot).mockReturnValue(
      new Map<string, CanvasNode>([['hero-section', { id: 'hero-section' } as CanvasNode]]),
    );
    const ctx = makeCtx();
    const result = await addNodeTool.execute({ parent_id: 'p1', tag: 'div', id: 'hero-section' }, ctx);
    expect(result.isError).toBe(true);
    expect(JSON.parse((result.content[0] as any).text).error).toContain('already exists');
    expect(queueMutation).not.toHaveBeenCalled();
  });

  it('add_node rejects an invalid model-chosen id format', async () => {
    vi.mocked(getNodesSnapshot).mockReturnValue(new Map<string, CanvasNode>());
    const ctx = makeCtx();
    const result = await addNodeTool.execute({ parent_id: 'p1', tag: 'div', id: 'Héros Section!' }, ctx);
    expect(result.isError).toBe(true);
    expect(JSON.parse((result.content[0] as any).text).error).toContain('Invalid data-id');
    expect(queueMutation).not.toHaveBeenCalled();
  });

  it('add_canvas_node strips reserved attrs too', async () => {
    const ctx = makeCtx();
    const result = await addCanvasNodeTool.execute(
      { tag: 'div', attrs: { 'data-id': 'mine', class: 'x' } },
      ctx,
    );
    const m = lastMutation() as AddNodeMutation;
    expect(m.node.attrs).toEqual({ class: 'x' });
    const data = JSON.parse((result.content[0] as any).text);
    expect(data.ignored_attrs).toEqual(['data-id']);
  });

  it('add_canvas_node queues addCanvasNode and returns the id', async () => {
    const ctx = makeCtx();
    const result = await addCanvasNodeTool.execute({ tag: 'div', styles: { position: 'absolute' }, name: 'abs' }, ctx);
    expect(ctx.ensureCheckpoint).toHaveBeenCalledTimes(1);
    const m = lastMutation();
    expect(m).toEqual({
      type: 'addCanvasNode',
      node: expect.objectContaining({ id: expect.any(String), type: 'div', styles: { position: 'absolute' }, attrs: {}, name: 'abs' }),
    });
    expect(flushNow).toHaveBeenCalledTimes(1);
    const data = JSON.parse((result.content[0] as any).text);
    expect(data.node_id).toBe((m as Extract<Mutation, { type: 'addCanvasNode' }>).node.id);
  });

  it('delete_node queues removeNode', async () => {
    const ctx = makeCtx();
    const result = await deleteNodeTool.execute({ node_id: 'n1' }, ctx);
    expect(ctx.ensureCheckpoint).toHaveBeenCalledTimes(1);
    expect(queueMutation).toHaveBeenCalledWith({ type: 'removeNode', nodeId: 'n1' }, expect.anything());
    expect(flushNow).toHaveBeenCalledTimes(1);
    expect(JSON.parse((result.content[0] as any).text)).toEqual({});
  });

  it('move_node with null parent and before_id queues move without index', async () => {
    const ctx = makeCtx();
    await moveNodeTool.execute({ node_id: 'n1', parent_id: null, before_id: 'sib' }, ctx);
    expect(ctx.ensureCheckpoint).toHaveBeenCalledTimes(1);
    expect(queueMutation).toHaveBeenCalledWith({
      type: 'move',
      nodeId: 'n1',
      newParentId: null,
      insertBeforeId: 'sib',
    }, expect.anything());
    expect('index' in lastMutation()).toBe(false);
    expect(flushNow).toHaveBeenCalledTimes(1);
  });

  it('move_node with parent and index queues move with both', async () => {
    const ctx = makeCtx();
    await moveNodeTool.execute({ node_id: 'n1', parent_id: 'p2', index: 0 }, ctx);
    expect(queueMutation).toHaveBeenCalledWith({
      type: 'move',
      nodeId: 'n1',
      newParentId: 'p2',
      index: 0,
    }, expect.anything());
    expect(flushNow).toHaveBeenCalledTimes(1);
  });

  it('reorder_node queues reorder with index', async () => {
    const ctx = makeCtx();
    await reorderNodeTool.execute({ node_id: 'n1', parent_id: 'p1', index: 2 }, ctx);
    expect(ctx.ensureCheckpoint).toHaveBeenCalledTimes(1);
    expect(queueMutation).toHaveBeenCalledWith({
      type: 'reorder',
      nodeId: 'n1',
      parentId: 'p1',
      index: 2,
    }, expect.anything());
    expect(flushNow).toHaveBeenCalledTimes(1);
  });

  it('duplicate_node copies the source node with a fresh id', async () => {
    const src = {
      id: 'orig',
      type: 'button',
      styles: { color: 'red' },
      attrs: {},
      name: 'btn',
      parentId: 'root',
    } as unknown as CanvasNode;
    vi.mocked(getNodesSnapshot).mockReturnValue(new Map<string, CanvasNode>([['orig', src]]));
    const ctx = makeCtx();
    const result = await duplicateNodeTool.execute({ node_id: 'orig' }, ctx);
    expect(ctx.ensureCheckpoint).toHaveBeenCalledTimes(1);
    expect(queueMutation).toHaveBeenCalledTimes(1);
    const m = lastMutation() as AddNodeMutation;
    expect(m.type).toBe('addNode');
    expect(m.parentId).toBe('root');
    expect(m.node.id).not.toBe('orig');
    expect(typeof m.node.id).toBe('string');
    expect(m.node.type).toBe('button');
    expect(m.node.styles).toEqual({ color: 'red', position: 'relative' });
    expect(m.node.attrs).toEqual({});
    expect(m.node.name).toBe('btn');
    expect('index' in m).toBe(false);
    expect(flushNow).toHaveBeenCalledTimes(1);
    const data = JSON.parse((result.content[0] as any).text);
    expect(data.node_id).toBe(m.node.id);
    expect(result.isError).toBeUndefined();
  });

  it('duplicate_node honors explicit parent_id and index', async () => {
    const src = {
      id: 'orig',
      type: 'div',
      styles: {},
      attrs: {},
      name: 'box',
      parentId: 'root',
    } as unknown as CanvasNode;
    vi.mocked(getNodesSnapshot).mockReturnValue(new Map<string, CanvasNode>([['orig', src]]));
    const ctx = makeCtx();
    await duplicateNodeTool.execute({ node_id: 'orig', parent_id: 'other', index: 1 }, ctx);
    const m = lastMutation() as AddNodeMutation;
    expect(m.parentId).toBe('other');
    expect(m.index).toBe(1);
  });

  it('duplicate_node fails on a missing source node without queueing', async () => {
    vi.mocked(getNodesSnapshot).mockReturnValue(new Map<string, CanvasNode>());
    const ctx = makeCtx();
    const result = await duplicateNodeTool.execute({ node_id: 'ghost' }, ctx);
    expect(ctx.ensureCheckpoint).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
    const data = JSON.parse((result.content[0] as any).text);
    expect(data.error).toContain('ghost');
    expect(queueMutation).not.toHaveBeenCalled();
    expect(flushNow).not.toHaveBeenCalled();
  });

  it('duplicate_node names the valid ids in the missing-source error', async () => {
    vi.mocked(getNodesSnapshot).mockReturnValue(
      new Map<string, CanvasNode>([
        ['root', {} as CanvasNode],
        ['hero', {} as CanvasNode],
      ]),
    );
    const ctx = makeCtx();
    const result = await duplicateNodeTool.execute({ node_id: 'ghost' }, ctx);
    const data = JSON.parse((result.content[0] as any).text);
    expect(data.error).toContain('Valid ids: hero, root');
  });

  it('add_node invalid-id error spells the next action', async () => {
    vi.mocked(getNodesSnapshot).mockReturnValue(new Map<string, CanvasNode>());
    const ctx = makeCtx();
    const result = await addNodeTool.execute({ parent_id: 'p1', tag: 'div', id: 'bad id!' }, ctx);
    const data = JSON.parse((result.content[0] as any).text);
    expect(data.error).toContain('Invalid data-id "bad id!"');
    expect(data.error).toContain('NEXT ACTION:');
  });

  it('duplicate_node recursively clones the subtree — every id fresh and unique', async () => {
    vi.mocked(getNodesSnapshot).mockReturnValue(makeSubtreeSnapshot());
    const ctx = makeCtx();
    const result = await duplicateNodeTool.execute({ node_id: 'root' }, ctx);
    expect(ctx.ensureCheckpoint).toHaveBeenCalledTimes(1);
    expect(queueMutation).toHaveBeenCalledTimes(1);
    const m = lastMutation() as AddNodeMutation;
    expect(m.type).toBe('addNode');
    expect(m.parentId).toBe('page');

    // Every id in the clone is new and unique (the parser requires unique data-ids).
    const ids = collectCloneIds(m.node);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(['root', 'a', 'a1', 'a2', 'b', 'b1']).not.toContain(id);
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    }

    // The tree shape mirrors the source 3 levels deep.
    expect(m.node.type).toBe('div');
    expect(m.node.styles).toEqual({ display: 'flex', position: 'relative' });
    expect(m.node.attrs).toEqual({ id: 'main' });
    expect(m.node.name).toBe('Root');
    expect(m.node.children).toHaveLength(2);
    const childA = m.node.children![0];
    const childB = m.node.children![1];
    expect(childA.type).toBe('section');
    expect(childA.styles).toEqual({ padding: '12px' });
    expect(childA.name).toBe('A');
    expect(childA.children).toHaveLength(2);
    expect(childA.children![0].type).toBe('h2');
    expect(childA.children![0].textContent).toBe('Hello');
    expect(childA.children![1].type).toBe('img');
    expect(childA.children![1].attrs).toEqual({ src: '/img.png' });
    expect(childB.type).toBe('span');
    expect(childB.children).toHaveLength(1);
    expect(childB.children![0].type).toBe('span');
    expect(childB.children![0].textContent).toBe('Neutral');

    expect(flushNow).toHaveBeenCalledTimes(1);
    const data = JSON.parse((result.content[0] as any).text);
    expect(data.node_id).toBe(m.node.id);
    expect(result.isError).toBeUndefined();
  });

  it('duplicate_node clones a leaf with no children key and its text', async () => {
    vi.mocked(getNodesSnapshot).mockReturnValue(makeSubtreeSnapshot());
    const ctx = makeCtx();
    const result = await duplicateNodeTool.execute({ node_id: 'a1' }, ctx);
    const m = lastMutation() as AddNodeMutation;
    expect(m.type).toBe('addNode');
    expect(m.parentId).toBe('a');
    expect(m.node.id).not.toBe('a1');
    expect(m.node.type).toBe('h2');
    expect(m.node.textContent).toBe('Hello');
    expect('children' in m.node).toBe(false);
    expect(m.node.styles).toEqual({ color: 'red', position: 'relative' });
    const data = JSON.parse((result.content[0] as any).text);
    expect(data.node_id).toBe(m.node.id);
  });

  it('cloneSubtree skips snapshot orphans (missing child ids)', () => {
    const src = {
      id: 'root',
      type: 'div',
      textContent: '',
      styles: {},
      attrs: {},
      children: ['ghost', 'ok'],
    } as unknown as CanvasNode;
    const okChild = {
      id: 'ok',
      type: 'span',
      textContent: 'y',
      styles: {},
      attrs: {},
      children: [],
    } as unknown as CanvasNode;
    const clone = cloneSubtree(src, new Map<string, CanvasNode>([['root', src], ['ok', okChild]]));
    expect(clone.children).toHaveLength(1);
    expect(clone.children![0].id).not.toBe('ghost');
    expect(clone.children![0].type).toBe('span');
  });

  it('cloneSubtree re-wraps textIsLiteral text in a string literal (JSX-safe)', () => {
    const src = {
      id: 'lit',
      type: 'p',
      textContent: '<a {x}',
      textIsLiteral: true,
      styles: {},
      attrs: {},
      children: [],
    } as unknown as CanvasNode;
    const clone = cloneSubtree(src, new Map<string, CanvasNode>([['lit', src]]));
    expect(clone.textContent).toBe('{"<a {x}"}');
    expect(clone.textContent).not.toBe('<a {x}');
  });

  it('STRUCTURE_TOOLS exports all eight tools with category semantic', () => {
    expect(STRUCTURE_TOOLS).toHaveLength(8);
    const names = STRUCTURE_TOOLS.map((t) => t.name);
    expect(names).toEqual([
      'add_node',
      'add_canvas_node',
      'delete_node',
      'move_node',
      'reorder_node',
      'duplicate_node',
      'add_component_instance',
      'set_component_prop',
    ]);
    for (const tool of STRUCTURE_TOOLS) {
      expect(tool.category).toBe('semantic');
      expect(typeof tool.execute).toBe('function');
      expect(typeof tool.description).toBe('string');
      expect(tool.inputSchema).toBeTruthy();
    }
  });
});

// ─── Component instance tools ────────────────────────────────────────────────

/** Registry fixture: a Hero with text/option/number props, two required. */
const HERO_INFO = {
  name: 'Hero',
  filePath: 'components/Hero.tsx',
  props: [
    { name: 'title', defaultValue: 'Build', varType: 'text', description: 'Main heading' },
    { name: 'variant', defaultValue: 'primary', varType: 'option' },
    { name: 'count', defaultValue: null, varType: 'number' },
    { name: 'eyebrow', defaultValue: null },
  ],
  contentHash: 'h1',
  controlsMeta: null,
};

function registryWith(entries: Record<string, unknown>): void {
  vi.mocked(buildComponentRegistry).mockReturnValue(
    new Map(Object.entries(entries)) as unknown as ReturnType<typeof buildComponentRegistry>,
  );
}

describe('component instance tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getNodesSnapshot).mockReturnValue(new Map());
    vi.mocked(buildComponentRegistry).mockReturnValue(new Map());
  });

  it('add_component_instance queues addNode with the component tag and prop attrs', async () => {
    registryWith({ Hero: HERO_INFO });
    const ctx = makeCtx();
    const result = await addComponentInstanceTool.execute(
      { name: 'Hero', parent_id: 'page', props: { title: 'Hello', variant: 'dark', count: 60 } },
      ctx,
    );
    expect(ctx.ensureCheckpoint).toHaveBeenCalledTimes(1);
    expect(queueMutation).toHaveBeenCalledTimes(1);
    const m = lastMutation() as AddNodeMutation;
    expect(m.type).toBe('addNode');
    expect(m.parentId).toBe('page');
    expect(m.node.type).toBe('Hero');
    expect(m.node.name).toBe('Hero');
    // Explicit placement — the oracle bounces position-less nodes
    // (NODE_MISSING_POSITION); the editor's drop path does the same.
    expect(m.node.styles).toEqual({ position: 'relative' });
    expect(m.node.attrs).toEqual({ title: 'Hello', variant: 'dark', count: '60' });
    expect('index' in m).toBe(false);
    expect(flushNow).toHaveBeenCalledTimes(1);
    const data = JSON.parse((result.content[0] as any).text);
    expect(data.node_id).toBe(m.node.id);
    expect(data.component).toBe('Hero');
    expect(data.props_applied).toEqual(['title', 'variant', 'count']);
    expect(data.dropped_props).toEqual([]);
  });

  it('add_component_instance drops structural and undeclared props, lists them', async () => {
    registryWith({ Hero: HERO_INFO });
    const ctx = makeCtx();
    const result = await addComponentInstanceTool.execute(
      { name: 'Hero', parent_id: 'page', props: { title: 'ok', style: { color: 'red' }, ref: 'x', bogus: 1 } },
      ctx,
    );
    const m = lastMutation() as AddNodeMutation;
    expect(m.node.attrs).toEqual({ title: 'ok' });
    const data = JSON.parse((result.content[0] as any).text);
    expect(data.props_applied).toEqual(['title']);
    expect(data.dropped_props).toEqual(['style', 'ref', 'bogus']);
  });

  it('add_component_instance reports required props that were not supplied', async () => {
    registryWith({ Hero: HERO_INFO });
    const ctx = makeCtx();
    const result = await addComponentInstanceTool.execute({ name: 'Hero', parent_id: 'page', props: { title: 'x' } }, ctx);
    const res = JSON.parse((result.content[0] as any).text);
    expect(res.missing_required).toEqual(['count', 'eyebrow']);
  });

  it('add_component_instance resolves parent_id to the selected node, else to the page root', async () => {
    registryWith({ Hero: HERO_INFO });
    const store = (await import('jotai')).getDefaultStore();
    const selNode = { id: 'sel', type: 'section', parentId: 'root' } as unknown as CanvasNode;
    const rootNode = { id: 'root', type: 'main', parentId: null } as unknown as CanvasNode;
    const ctx = makeCtx();

    // 1. Selected node wins.
    store.set(selectedIdsAtom, ['sel']);
    vi.mocked(getNodesSnapshot).mockReturnValue(new Map([['sel', selNode], ['root', rootNode]]));
    await addComponentInstanceTool.execute({ name: 'Hero' }, ctx);
    expect((lastMutation() as AddNodeMutation).parentId).toBe('sel');

    // 2. No selection → first root of the page tree.
    store.set(selectedIdsAtom, []);
    await addComponentInstanceTool.execute({ name: 'Hero' }, ctx);
    expect((lastMutation() as AddNodeMutation).parentId).toBe('root');

    // 3. Empty page and no selection → clear error, nothing queued.
    vi.mocked(getNodesSnapshot).mockReturnValue(new Map());
    const result = await addComponentInstanceTool.execute({ name: 'Hero' }, ctx);
    expect(result.isError).toBe(true);
    expect(queueMutation).toHaveBeenCalledTimes(2);
  });

  it('add_component_instance fails on an unknown component without queueing', async () => {
    const ctx = makeCtx();
    const result = await addComponentInstanceTool.execute({ name: 'Ghost', parent_id: 'page' }, ctx);
    expect(result.isError).toBe(true);
    expect(queueMutation).not.toHaveBeenCalled();
    expect(flushNow).not.toHaveBeenCalled();
  });

  it('set_component_prop queues updateHtmlAttrs with the value', async () => {
    registryWith({ Hero: HERO_INFO });
    const ctx = makeCtx();
    const result = await setComponentPropTool.execute(
      { node_id: 'n1', component_name: 'Hero', prop: 'title', value: 'Hello' },
      ctx,
    );
    expect(ctx.ensureCheckpoint).toHaveBeenCalledTimes(1);
    expect(queueMutation).toHaveBeenCalledWith({
      type: 'updateHtmlAttrs',
      nodeId: 'n1',
      attrs: { title: 'Hello' },
    }, expect.anything());
    expect(flushNow).toHaveBeenCalledTimes(1);
    const data = JSON.parse((result.content[0] as any).text);
    expect(data.removed).toBe(false);
    expect(result.isError).toBeUndefined();
  });

  it('set_component_prop removes the prop when the value is empty string', async () => {
    registryWith({ Hero: HERO_INFO });
    const ctx = makeCtx();
    const result = await setComponentPropTool.execute(
      { node_id: 'n1', component_name: 'Hero', prop: 'title', value: '' },
      ctx,
    );
    expect(queueMutation).toHaveBeenCalledWith({
      type: 'updateHtmlAttrs',
      nodeId: 'n1',
      attrs: { title: '' },
    }, expect.anything());
    expect(JSON.parse((result.content[0] as any).text).removed).toBe(true);
  });

  it('set_component_prop rejects structural props', async () => {
    registryWith({ Hero: HERO_INFO });
    const ctx = makeCtx();
    const result = await setComponentPropTool.execute(
      { node_id: 'n1', component_name: 'Hero', prop: 'style', value: 'x' },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(queueMutation).not.toHaveBeenCalled();
  });

  it('set_component_prop rejects props the component does not declare', async () => {
    registryWith({ Hero: HERO_INFO });
    const ctx = makeCtx();
    const result = await setComponentPropTool.execute(
      { node_id: 'n1', component_name: 'Hero', prop: 'banana', value: 'x' },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(JSON.parse((result.content[0] as any).text).error).toContain('title');
    expect(queueMutation).not.toHaveBeenCalled();
  });

  it('filterDeclaredProps drops structural + undeclared props, keeps declared, serializes values', () => {
    const { attrs, dropped } = filterDeclaredProps(HERO_INFO as never, {
      title: 'Hello',
      variant: 'dark',
      count: 60,
      style: { color: 'red' },
      children: ['x'],
      bogus: true,
    });
    expect(attrs).toEqual({ title: 'Hello', variant: 'dark', count: '60' });
    expect(dropped).toEqual(['style', 'children', 'bogus']);
  });

  it('missingRequiredProps lists only omitted no-default props', () => {
    expect(missingRequiredProps(HERO_INFO as never, { title: 'x', count: '1' })).toEqual(['eyebrow']);
    expect(missingRequiredProps(HERO_INFO as never, {})).toEqual(['count', 'eyebrow']);
  });

  it('set_component_prop proceeds best-effort when the component is not in the registry', async () => {
    const ctx = makeCtx();
    const result = await setComponentPropTool.execute(
      { node_id: 'n1', component_name: 'Aliased', prop: 'any', value: '1' },
      ctx,
    );
    expect(queueMutation).toHaveBeenCalledWith({
      type: 'updateHtmlAttrs',
      nodeId: 'n1',
      attrs: { any: '1' },
    }, expect.anything());
    expect(result.isError).toBeUndefined();
  });
});

// ─── Branch routing (P8) ─────────────────────────────────────────────────────

const BRANCH_PAGE = `'use client';
import React from 'react';
export default function Page() {
  return (
    <div data-id="root" style={{ position: 'relative' }}>
      <p data-id="para" style={{ position: 'relative' }}>hi</p>
    </div>
  );
}`;

describe('semantic structure tools — branch routing (P8)', () => {
  const BRANCH = 'agent-br';
  const FILE = 'app/page.client.tsx';

  function branchCtx(): ToolContext {
    return {
      ensureCheckpoint: vi.fn(),
      vpWidth: 1440,
      signal: new AbortController().signal,
      workspace: { branchId: BRANCH, filePath: FILE },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getNodesSnapshot).mockReturnValue(new Map());
    expect(projectFS.createBranch(BRANCH)).toBeNull();
    projectFS.writeBranchFile(BRANCH, FILE, BRANCH_PAGE);
  });

  afterEach(() => {
    resetProjectFS();
  });

  it('branched add_node scopes the mutation to the branch map (file + branchId + author)', async () => {
    const ctx = branchCtx();
    const result = await addNodeTool.execute({ parent_id: 'root', tag: 'section', id: 'br-section' }, ctx);
    expect(result.isError).toBeUndefined();
    expect(queueMutation).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'addNode', parentId: 'root' }),
      expect.objectContaining({ author: 'agent', file: FILE, branchId: BRANCH }),
    );
    expect(flushNow).toHaveBeenCalledWith({ branchId: BRANCH });
  });

  it('branched duplicate_node reads its sources from the branch file, not the shared snapshot', async () => {
    // The shared snapshot is empty: success proves the branch map was read.
    const ctx = branchCtx();
    const result = await duplicateNodeTool.execute({ node_id: 'para' }, ctx);
    expect(result.isError).toBeUndefined();
    const data = JSON.parse((result.content[0] as any).text);
    expect(data.node_id).not.toBe('para');
    expect(queueMutation).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'addNode', parentId: 'root' }),
      expect.objectContaining({ author: 'agent', file: FILE, branchId: BRANCH }),
    );
    expect(flushNow).toHaveBeenCalledWith({ branchId: BRANCH });
  });

  it('unbranched runs keep the exact legacy routing (main scope, bare flush)', async () => {
    const ctx = makeCtx();
    await addNodeTool.execute({ parent_id: 'root', tag: 'div', id: 'legacy-node' }, ctx);
    expect(queueMutation).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'addNode', parentId: 'root' }),
      expect.objectContaining({ author: 'agent', branchId: 'main' }),
    );
    expect(flushNow).toHaveBeenCalledWith();
  });
});
