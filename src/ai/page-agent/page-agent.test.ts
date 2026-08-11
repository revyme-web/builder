// page-agent.test.ts — Tests for the page-agent tool surface.
//
// Two things matter here:
//   1. The schemas are well-formed and stay in lockstep with the executors
//      (every tool the AI is told about must actually be runnable, and vice
//      versa) — pure, no mocking.
//   2. The mutation executors produce the correct `Mutation` objects — the
//      whole safety guarantee rests on this mapping being right.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CanvasNode } from '@/code/parsing/parser';
import { DESIGN_COMPONENT_TOOLS, MUTATION_TOOL_NAMES } from './tool-schemas';

// ─── Mocks for the executor's browser-side dependencies ─────────────────────

const queued: any[] = [];
const flushSpy = vi.fn();
const testNodes = new Map<string, CanvasNode>();

vi.mock('@/code/mutation/mutation-queue', () => ({
  queueMutation: (m: any) => queued.push(m),
  flushNow: () => flushSpy(),
}));

// Sentinel atoms — the mocked store just keys off identity.
const nodesAtomSentinel = Symbol('nodesAtom');
const activeFilePathAtomSentinel = Symbol('activeFilePathAtom');

vi.mock('@/code/stores/store', () => ({ nodesAtom: nodesAtomSentinel }));
// `isComponentFilePath` is consumed by stripRootPercentSizing (update_node_styles
// + set_variant_style); without it those executors throw "not a function".
vi.mock('@/code/project/active-file-store', () => ({
  activeFilePathAtom: activeFilePathAtomSentinel,
  isComponentFilePath: () => false,
}));
vi.mock('jotai', () => ({
  // Module-scope atom creation (container-query-store et al) just needs a token.
  atom: (init: unknown) => ({ init }),
  getDefaultStore: () => ({
    get: (atom: any) => (atom === nodesAtomSentinel ? testNodes : 'app/page.tsx'),
  }),
}));

vi.mock('@/code/project/project-fs', () => ({
  projectFS: {
    listFiles: () => ['app/page.tsx', 'app/globals.css'],
    readFile: (p: string) => (p === 'app/page.tsx' ? 'export default function Page() {}' : null),
  },
}));
vi.mock('@/code/project/preset-ops', () => ({
  getPresetTokens: () => [{ name: 'brand', value: '#6366f1', category: 'color' }],
}));
vi.mock('@/canvas/creators/creator-utils', () => ({
  generateNodeId: (prefix: string) => `${prefix}-test-id`,
}));
vi.mock('@/shared/id-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/shared/id-utils')>()),
  generateNodeId: (prefix: string) => `${prefix}-test-id`,
}));
vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn() },
}));

// Imported AFTER the mocks so the executor module binds to them.
const { executeTool, REGISTERED_TOOLS, normalizeTextContainers } = await import('./tool-executors');

function makeNode(id: string, parentId: string | null, children: string[] = []): CanvasNode {
  return {
    id, type: 'div', name: id, parentId, children,
    styles: {}, attrs: {}, textContent: '', isCanvasNode: false,
  } as unknown as CanvasNode;
}

beforeEach(() => {
  queued.length = 0;
  flushSpy.mockClear();
  testNodes.clear();
  testNodes.set('root', makeNode('root', null, ['hero']));
  testNodes.set('hero', makeNode('hero', 'root'));
});

// ─── Schema well-formedness ─────────────────────────────────────────────────

describe('tool schemas', () => {
  it('every schema is well-formed', () => {
    for (const tool of DESIGN_COMPONENT_TOOLS) {
      expect(tool.name, 'tool has a name').toBeTruthy();
      expect(tool.description.length, `${tool.name} has a description`).toBeGreaterThan(10);
      expect(tool.parameters.type, `${tool.name} params is an object`).toBe('object');
      // Every `required` entry must name a declared property.
      for (const req of tool.parameters.required ?? []) {
        expect(tool.parameters.properties, `${tool.name}.${req} is declared`).toHaveProperty(req);
      }
    }
  });

  it('tool names are unique', () => {
    const names = DESIGN_COMPONENT_TOOLS.map(t => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

// ─── Schema ↔ executor parity ───────────────────────────────────────────────

describe('schema/executor parity', () => {
  it('every schema has a registered executor', () => {
    for (const tool of DESIGN_COMPONENT_TOOLS) {
      expect(REGISTERED_TOOLS, `executor exists for ${tool.name}`).toContain(tool.name);
    }
  });

  it('every registered executor has a schema', () => {
    const schemaNames = new Set(DESIGN_COMPONENT_TOOLS.map(t => t.name));
    for (const name of REGISTERED_TOOLS) {
      expect(schemaNames.has(name), `schema exists for ${name}`).toBe(true);
    }
  });

  it('edit_file is classified as a mutation tool', () => {
    expect(MUTATION_TOOL_NAMES.has('edit_file')).toBe(true);
    expect(MUTATION_TOOL_NAMES.has('get_node_tree')).toBe(false);
  });
});

// ─── Mutation executors → Mutation objects ──────────────────────────────────

describe('mutation executors produce correct Mutation objects', () => {
  it('update_node_styles → updateStyles', () => {
    const r = executeTool('update_node_styles', { nodeId: 'hero', styles: { color: 'red' } });
    expect(r.isError).toBe(false);
    expect(queued).toEqual([{ type: 'updateStyles', nodeId: 'hero', styles: { color: 'red' } }]);
    expect(flushSpy).toHaveBeenCalledOnce();
  });

  it('update_node_text → updateText', () => {
    executeTool('update_node_text', { nodeId: 'hero', text: 'Hello' });
    expect(queued).toEqual([{ type: 'updateText', nodeId: 'hero', text: 'Hello' }]);
  });

  it('add_node → addNode with a generated id, returned to the AI', () => {
    const r = executeTool('add_node', { parentId: 'root', nodeType: 'section', name: 'New' });
    expect(r.isError).toBe(false);
    expect(r.response.newNodeId).toBe('section-test-id');
    expect(queued[0]).toMatchObject({
      type: 'addNode',
      parentId: 'root',
      node: { id: 'section-test-id', type: 'section', name: 'New', styles: {} },
    });
  });

  it('remove_node → removeNode', () => {
    executeTool('remove_node', { nodeId: 'hero' });
    expect(queued).toEqual([{ type: 'removeNode', nodeId: 'hero' }]);
  });

  it('move_node → move', () => {
    testNodes.set('sidebar', makeNode('sidebar', 'root'));
    executeTool('move_node', { nodeId: 'hero', newParentId: 'sidebar', index: 0 });
    expect(queued).toEqual([{ type: 'move', nodeId: 'hero', newParentId: 'sidebar', index: 0 }]);
  });

  it('change_tag → changeTag', () => {
    executeTool('change_tag', { nodeId: 'hero', newTag: 'section' });
    expect(queued).toEqual([{ type: 'changeTag', nodeId: 'hero', newTag: 'section' }]);
  });

  it('set_variant_style: layout/size → setConditionalStyle ternary, paint → updateVariantStyle', () => {
    executeTool('set_variant_style', {
      nodeId: 'hero',
      variantName: 'variant-1',
      styles: { backgroundColor: 'blue', width: '768px', height: '462px', flexDirection: 'column' },
    });
    // Layout-affecting props each emit a setConditionalStyle (inline ternary) so a
    // per-variant resize rides the layout FLIP instead of value-tweening.
    expect(queued).toContainEqual({ type: 'setConditionalStyle', nodeId: 'hero', prop: 'width', variantName: 'variant-1', value: '768px' });
    expect(queued).toContainEqual({ type: 'setConditionalStyle', nodeId: 'hero', prop: 'height', variantName: 'variant-1', value: '462px' });
    expect(queued).toContainEqual({ type: 'setConditionalStyle', nodeId: 'hero', prop: 'flexDirection', variantName: 'variant-1', value: 'column' });
    // Paint props stay in the variants object.
    expect(queued).toContainEqual({ type: 'updateVariantStyle', nodeId: 'hero', variantName: 'variant-1', styles: { backgroundColor: 'blue' } });
    // No size/layout left in the variant-object write.
    const vs = queued.find(m => m.type === 'updateVariantStyle');
    expect(vs.styles).toEqual({ backgroundColor: 'blue' });
  });

  it('set_variant_style: a pure paint write emits ONLY updateVariantStyle', () => {
    executeTool('set_variant_style', { nodeId: 'hero', variantName: 'variant-1', styles: { color: 'red' } });
    expect(queued).toEqual([{ type: 'updateVariantStyle', nodeId: 'hero', variantName: 'variant-1', styles: { color: 'red' } }]);
  });

  // ── Animation tools (typed) — replace the legacy set_motion_prop/
  // remove_motion_prop. Each tool emits one or more `updateMotionProp`
  // mutations with the right propName + a formatted string map.

  it('add_appear emits initial + whileInView + transition mutations with formatted values', () => {
    executeTool('add_appear', {
      nodeId: 'hero',
      from: { opacity: 0, y: 24 },
      to: { opacity: 1, y: 0 },
      transition: { duration: 0.5, ease: 'easeOut' },
    });
    expect(queued).toEqual([
      { type: 'updateMotionProp', nodeId: 'hero', propName: 'initial',     props: { opacity: '0', y: '24' } },
      { type: 'updateMotionProp', nodeId: 'hero', propName: 'whileInView', props: { opacity: '1', y: '0' } },
      { type: 'updateMotionProp', nodeId: 'hero', propName: 'transition',  props: { duration: '0.5', ease: 'easeOut' } },
    ]);
  });

  it('add_appear without `from` skips the initial mutation', () => {
    executeTool('add_appear', { nodeId: 'hero', to: { opacity: 1 } });
    expect(queued).toEqual([
      { type: 'updateMotionProp', nodeId: 'hero', propName: 'whileInView', props: { opacity: '1' } },
    ]);
  });

  it('remove_appear clears initial + whileInView (leaves transition for hover/loop)', () => {
    executeTool('remove_appear', { nodeId: 'hero' });
    expect(queued).toEqual([
      { type: 'removeMotionProp', nodeId: 'hero', propName: 'initial' },
      { type: 'removeMotionProp', nodeId: 'hero', propName: 'whileInView' },
    ]);
  });

  it('add_hover writes whileHover + optional transition', () => {
    executeTool('add_hover', {
      nodeId: 'hero',
      to: { scale: 1.05, backgroundColor: '#ff3366' },
      transition: { duration: 0.2 },
    });
    expect(queued).toEqual([
      { type: 'updateMotionProp', nodeId: 'hero', propName: 'whileHover', props: { scale: '1.05', backgroundColor: '#ff3366' } },
      { type: 'updateMotionProp', nodeId: 'hero', propName: 'transition', props: { duration: '0.2' } },
    ]);
  });

  it('remove_hover clears whileHover only', () => {
    executeTool('remove_hover', { nodeId: 'hero' });
    expect(queued).toEqual([{ type: 'removeMotionProp', nodeId: 'hero', propName: 'whileHover' }]);
  });

  it('add_loop converts arrays to array-literal strings and forces repeat: Infinity', () => {
    executeTool('add_loop', {
      nodeId: 'hero',
      keyframes: { rotate: [0, 360], scale: [1, 1.1, 1] },
      transition: { duration: 8, ease: 'linear' },
    });
    expect(queued).toEqual([
      { type: 'updateMotionProp', nodeId: 'hero', propName: 'animate',    props: { rotate: '[0, 360]', scale: '[1, 1.1, 1]' } },
      { type: 'updateMotionProp', nodeId: 'hero', propName: 'transition', props: { duration: '8', ease: 'linear', repeat: 'Infinity', repeatType: 'loop' } },
    ]);
  });

  it('add_loop respects an explicit repeatType', () => {
    executeTool('add_loop', {
      nodeId: 'hero',
      keyframes: { rotate: [0, 360] },
      transition: { duration: 4, repeatType: 'reverse' },
    });
    expect(queued[1]).toMatchObject({
      propName: 'transition',
      props: { duration: '4', repeat: 'Infinity', repeatType: 'reverse' },
    });
  });

  it('add_loop rejects keyframes shorter than 2 values', () => {
    const r = executeTool('add_loop', { nodeId: 'hero', keyframes: { rotate: [90] } });
    expect(r.isError).toBe(true);
    expect(r.response.error).toContain('keyframes');
    expect(queued).toHaveLength(0);
  });

  it('remove_loop clears only animate (transition stays for hover/appear)', () => {
    executeTool('remove_loop', { nodeId: 'hero' });
    expect(queued).toEqual([{ type: 'removeMotionProp', nodeId: 'hero', propName: 'animate' }]);
  });

  it('add_preset_token → addPresetToken and returns the var() reference', () => {
    const r = executeTool('add_preset_token', { name: 'brand-primary', value: '#000', category: 'color' });
    expect(r.response.reference).toBe('var(--brand-primary)');
    expect(queued[0]).toMatchObject({ type: 'addPresetToken', token: { name: 'brand-primary', value: '#000' } });
  });

  // Oracle fence (2026-08-11): edit_file is a dormant whole-file escape hatch
  // — builder-dialect paths must now pass checkFile like every gated door.
  it('edit_file REFUSES builder-dialect content that fails the oracle', () => {
    const r = executeTool('edit_file', { path: 'components/Hero.tsx', content: 'export default () => null;' });
    expect(r.isError).toBe(true);
    expect(queued).toEqual([]);
  });

  it('edit_file REFUSES a div-of-spans page that fails the oracle', () => {
    const r = executeTool('edit_file', {
      path: 'app/page.tsx',
      content: 'export default () => (<div><span>A</span><span>B</span></div>);',
    });
    expect(r.isError).toBe(true);
    expect(queued).toEqual([]);
  });

  it('edit_file leaves non-JSX files untouched', () => {
    executeTool('edit_file', { path: 'app/globals.css', content: 'div span { color: red; }' });
    expect(queued[0].content).toBe('div span { color: red; }');
  });
});

// ─── Error handling — failures become { error } for the AI ──────────────────

describe('executor error handling', () => {
  it('unknown node id returns an error instead of throwing', () => {
    const r = executeTool('update_node_styles', { nodeId: 'ghost', styles: {} });
    expect(r.isError).toBe(true);
    expect(r.response.error).toContain('ghost');
    expect(queued).toHaveLength(0);
  });

  it('unknown tool name returns an error', () => {
    const r = executeTool('frobnicate', {});
    expect(r.isError).toBe(true);
    expect(r.response.error).toContain('Unknown tool');
  });
});

// ─── Read executors ─────────────────────────────────────────────────────────

describe('read executors', () => {
  it('get_node_tree returns a nested tree from the roots', () => {
    const r = executeTool('get_node_tree', {});
    expect(r.isError).toBe(false);
    expect(r.response.tree).toEqual([
      { id: 'root', tag: 'div', name: 'root', children: [{ id: 'hero', tag: 'div', name: 'hero' }] },
    ]);
  });

  it('find_nodes filters by tag', () => {
    const r = executeTool('find_nodes', { tag: 'div' });
    expect(r.response.count).toBe(2);
  });

  it('read_file returns content, or an error for a missing file', () => {
    expect(executeTool('read_file', { path: 'app/page.tsx' }).response.content).toContain('Page');
    expect(executeTool('read_file', { path: 'nope.tsx' }).response.error).toContain('not found');
  });

  it('get_design_tokens returns the project tokens', () => {
    const r = executeTool('get_design_tokens', {});
    expect(r.response.tokens).toHaveLength(1);
  });
});

// ─── normalizeTextContainers — frame-of-spans → text node guard ─────────────

describe('normalizeTextContainers', () => {
  it('rewrites a div whose children are all spans into a <p>', () => {
    const out = normalizeTextContainers('<div><span>THAT</span><span>outlast</span></div>');
    expect(out).toBe('<p><span>THAT</span><span>outlast</span></p>');
  });

  it('keeps the opening element attributes intact', () => {
    const out = normalizeTextContainers(
      '<div style={{ display: "flex" }} className="x"><span>A</span></div>',
    );
    expect(out).toBe('<p style={{ display: "flex" }} className="x"><span>A</span></p>');
  });

  it('preserves mixed text + span children', () => {
    const out = normalizeTextContainers('<div>Hello <span>world</span></div>');
    expect(out).toBe('<p>Hello <span>world</span></p>');
  });

  it('renames only the tag word of a motion.div, keeping the namespace', () => {
    const out = normalizeTextContainers('<motion.div><span>A</span></motion.div>');
    expect(out).toBe('<motion.p><span>A</span></motion.p>');
  });

  it('leaves a text tag (already a <p>) untouched', () => {
    const code = '<p><span>A</span><span>B</span></p>';
    expect(normalizeTextContainers(code)).toBe(code);
  });

  it('leaves a heading with span runs untouched', () => {
    const code = '<h1>Big <span>accent</span></h1>';
    expect(normalizeTextContainers(code)).toBe(code);
  });

  it('does NOT convert a nav — a div whose children are all <a>', () => {
    const code = '<div><a>Home</a><a>About</a></div>';
    expect(normalizeTextContainers(code)).toBe(code);
  });

  it('does NOT convert when no child is a <span>', () => {
    const code = '<div><strong>A</strong><em>B</em></div>';
    expect(normalizeTextContainers(code)).toBe(code);
  });

  it('does NOT convert when a child carries a data-id (structural node)', () => {
    const code = '<div><span data-id="real-1">A</span><span>B</span></div>';
    expect(normalizeTextContainers(code)).toBe(code);
  });

  it('does NOT convert a div with a block child', () => {
    const code = '<div><span>A</span><div>B</div></div>';
    expect(normalizeTextContainers(code)).toBe(code);
  });

  it('converts only the inner text container, not the outer frame', () => {
    const out = normalizeTextContainers('<div><div><span>A</span><span>B</span></div></div>');
    expect(out).toBe('<div><p><span>A</span><span>B</span></p></div>');
  });

  it('returns the content unchanged when it fails to parse', () => {
    const broken = '<div><span>A</span';
    expect(normalizeTextContainers(broken)).toBe(broken);
  });
});
