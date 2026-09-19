// src/ai/agent/tools/read.test.ts
//
// Read tools: the pure projections (projectNodeTree, formatTreeLine, projectNode,
// projectTokens) are tested without any store, on hand-built CanvasNode /
// PresetToken fixtures. Two lightweight integration tests exercise the real
// global store through get_active_file and get_selection.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getDefaultStore } from 'jotai';
import type { CanvasNode } from '@/code/parsing/parser';
import type { PresetToken } from '@/shared/types';
import type { ToolContext } from '@/ai/agent';
import type { ComponentInfo } from '@/code/components/component-registry';
import { selectedIdsAtom } from '@/code/stores/store';
import { activeCodeAtom, activeFilePathAtom } from '@/code/project/active-file-store';
import { projectVersionAtom } from '@/code/project/project-fs';
import { resetActiveBridge, setActiveBridge, type CacheEpoch, type CanvasBridge } from '@/canvas/canvas-bridge';
import { readProjectVersion } from '@/canvas/canvas-bridge';
import {
  NODE_DETAIL_TEXT_CAP,
  TREE_TEXT_CAP,
  auditDesignTool,
  formatTreeLine,
  getActiveFileTool,
  getComponentTool,
  getLayoutTool,
  getSelectionTool,
  getVisualsTool,
  formatPropLine,
  formatComponentDetail,
  readComponentPropOptions,
  suggestComponentNames,
  projectNode,
  projectNodeTree,
  projectTokens,
  formatDesignTokens,
  getDesignTokensTool,
} from './read';
import { ALL_TOOLS } from './index';

vi.mock('@/code/components/component-registry', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/code/components/component-registry')>();
  return { ...mod, buildComponentRegistry: vi.fn(() => new Map()) };
});

vi.mock('@/code/project/preset-ops', () => ({ getPresetTokens: vi.fn(() => []) }));

import { buildComponentRegistry } from '@/code/components/component-registry';
import { getPresetTokens } from '@/code/project/preset-ops';

const toolCtx: ToolContext = {
  ensureCheckpoint: () => {},
  vpWidth: 1280,
  signal: new AbortController().signal,
};

/** Tiny page the parser turns into a 4-node map: hero → (card-a → card-a-text, card-b). */
const PAGE_CODE = `export default function Page() {
  return (
    <section data-id="hero" style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      <div data-id="card-a" style={{ width: '200px' }}>
        <p data-id="card-a-text" style={{ color: '#111827', fontSize: '16px' }}>Buy now</p>
      </div>
      <div data-id="card-b" style={{ width: '200px' }} />
    </section>
  );
}
`;

/** A page where every linter rule can be triggered: overlapping siblings,
 *  an overflowing child, dim/tiny/long text and a 3×3 dead spot. */
const AUDIT_PAGE_CODE = `export default function Page() {
  return (
    <section data-id="hero" style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      <div data-id="a" style={{ width: '300px' }} />
      <div data-id="b" style={{ width: '300px' }} />
      <p data-id="dim" style={{ color: '#999999' }}>Dim</p>
      <p data-id="tiny" style={{ fontSize: '10px' }}>tiny</p>
      <p data-id="long" style={{ fontSize: '6px', width: '40px' }}>This line is way longer than its box can hold</p>
      <div data-id="dead" style={{ width: '3px', height: '3px' }} />
      <div data-id="wide" style={{ width: '2000px' }} />
    </section>
  );
}
`;

type RectFixture = { left: number; top: number; width: number; height: number };

/**
 * Minimal CanvasBridge serving the SYNC caches the tools read through
 * node-ops (findNodeRect / findNodeComputedStyles). Rects and computed
 * values are keyed `${vpPrefix}:${nodeId}` exactly like the real
 * PostMessageBridge caches, so the tools exercise their real code paths
 * (incl. the `'getCachedComputedStyles' in bridge` preference).
 */
class FakeBridge implements CanvasBridge {
  private rects = new Map<string, RectFixture>();
  private computeds = new Map<string, Record<string, string>>();
  /** P6 T4 — pinned fill version for the fake epoch; null = follow the
   *  live project version (fresh). Set to an older version to simulate a
   *  stale cache. */
  epochVersion: number | null = null;

  getCacheEpoch(): CacheEpoch | null {
    return { renderSeq: 1, projectVersion: this.epochVersion ?? readProjectVersion() };
  }

  private key(nodeId: string, vpId: string): string {
    return `${vpId && vpId !== 'desktop' ? vpId + '-' : ''}:${nodeId}`;
  }

  rect(nodeId: string, r: RectFixture, computed: Record<string, string> = {}, vpId = 'desktop'): void {
    const key = this.key(nodeId, vpId);
    this.rects.set(key, r);
    this.computeds.set(key, computed);
  }

  computed(nodeId: string, c: Record<string, string>): void {
    const key = this.key(nodeId, 'desktop');
    this.computeds.set(key, { ...this.computeds.get(key), ...c });
  }

  getRect(nodeId: string, vpPrefix: string): DOMRect | null {
    const r = this.rects.get(`${vpPrefix}:${nodeId}`);
    return r
      ? ({ left: r.left, top: r.top, width: r.width, height: r.height, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top } as DOMRect)
      : null;
  }
  getChildRects(): Array<{ id: string; rect: DOMRect }> {
    return [];
  }
  getCachedComputedStyles(nodeId: string, vpPrefix: string, props: string[]): Record<string, string> {
    const c = this.computeds.get(`${vpPrefix}:${nodeId}`) ?? {};
    const out: Record<string, string> = {};
    for (const p of props) if (c[p] !== undefined) out[p] = c[p];
    return out;
  }
  getComputedValue(nodeId: string, vpPrefix: string, prop: string): string {
    return this.computeds.get(`${vpPrefix}:${nodeId}`)?.[prop] ?? '';
  }
  getComputedValues(nodeId: string, vpPrefix: string, props: string[]): Record<string, string> {
    return this.getCachedComputedStyles(nodeId, vpPrefix, props);
  }
  getContainerRect(): DOMRect | null {
    return null;
  }
  getElementIdsAtPoint(): string[] {
    return [];
  }
  patchStyles(): void {}
  patchAttrsAndStyles(): void {}
  setInnerHTML(): void {}
  setAttribute(): void {}
  injectCSS(): void {}
  removeCSS(): void {}
  getIframeDocument(): Document | null {
    return null;
  }
  loadFontInIframe(): void {}
}

let bridge: FakeBridge;

function makeNode(overrides: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id: 'n1',
    type: 'div',
    name: 'Root',
    parentId: null,
    children: [],
    styles: {},
    textContent: '',
    attrs: {},
    hasMixedContent: false,
    order: 0,
    isCanvasNode: true,
    componentFile: null,
    componentInstanceId: null,
    isComponentRoot: false,
    motionVariants: null,
    motionVariantsRef: null,
    motionProps: null,
    responsiveVariantMap: null,
    conditionalStyles: null,
    ...overrides,
  };
}

describe('formatTreeLine', () => {
  it('writes id, bracketed type and name, with two-space separators', () => {
    const line = formatTreeLine(makeNode({ id: 'hero', type: 'section', name: 'Hero' }));
    expect(line).toBe('hero  [section]  Hero');
  });

  it('omits a name that only repeats the id or the type', () => {
    expect(formatTreeLine(makeNode({ id: 'h2', type: 'h2', name: 'h2' }))).toBe('h2  [h2]');
    expect(formatTreeLine(makeNode({ id: 'n7', type: 'img', name: 'img' }))).toBe('n7  [img]');
  });

  it('abbreviates known style keys and omits default values', () => {
    const line = formatTreeLine(
      makeNode({
        styles: {
          position: 'relative', // default → omitted
          display: 'flex', // abbreviated
          flexDirection: 'row', // default → omitted
          padding: '80px 24px',
          backgroundColor: '#0f141c',
        },
      }),
    );
    expect(line).toBe('n1  [div]  Root  {d:flex, p:80px 24px, bg:#0f141c}');
  });

  it('prints style keys outside the shorthand map verbatim', () => {
    const line = formatTreeLine(
      makeNode({ styles: { gridTemplateColumns: '1fr 2fr', gap: '8px' } }),
    );
    expect(line).toContain('{gridTemplateColumns:1fr 2fr, g:8px}');
  });

  it('only omits a default on exact value equality', () => {
    const line = formatTreeLine(
      makeNode({ styles: { position: 'absolute', display: 'inline-flex', fontWeight: '400' } }),
    );
    expect(line).toContain('pos:absolute');
    expect(line).toContain('d:inline-flex');
    expect(line).toContain('fw:400'); // '400' ≠ default 'normal' → printed
  });

  it('skips empty style values (the "" = delete convention)', () => {
    const line = formatTreeLine(makeNode({ styles: { padding: '', gap: '24px' } }));
    expect(line).not.toContain('p:');
    expect(line).toContain('g:24px');
  });

  it('truncates text to 40 chars with the ellipsis', () => {
    const line = formatTreeLine(makeNode({ textContent: 'x'.repeat(60) }));
    expect(line).toContain(`"${'x'.repeat(TREE_TEXT_CAP)}…"`);
    expect(line).not.toContain('xxxxx"');
  });

  it('keeps short text untouched and quoted', () => {
    const line = formatTreeLine(makeNode({ textContent: 'Hi' }));
    expect(line).toBe('n1  [div]  Root  "Hi"');
  });

  it('escapes quotes and backslashes inside text', () => {
    const line = formatTreeLine(makeNode({ textContent: 'say "hi" \\ ok' }));
    expect(line).toContain('"say \\"hi\\" \\\\ ok"');
  });

  it('omits both styles and text when absent', () => {
    expect(formatTreeLine(makeNode({ name: 'div' }))).toBe('n1  [div]');
  });
});

describe('projectNodeTree', () => {
  it('renders an indented tree in document order, parent before children', () => {
    const nodes = new Map<string, CanvasNode>([
      ['root', makeNode({ id: 'root', name: 'Root', children: ['a', 'b'] })],
      ['a', makeNode({ id: 'a', type: 'p', name: 'A', parentId: 'root', textContent: 'Hello' })],
      [
        'b',
        makeNode({
          id: 'b',
          type: 'div',
          name: 'B',
          parentId: 'root',
          children: ['c'],
          styles: { display: 'flex', gap: '10px' },
        }),
      ],
      ['c', makeNode({ id: 'c', type: 'span', name: 'C', parentId: 'b', textContent: 'World' })],
    ]);

    const tree = projectNodeTree(nodes);

    expect(tree).toBe(
      [
        'root  [div]  Root',
        '  a  [p]  A  "Hello"',
        '  b  [div]  B  {d:flex, g:10px}',
        '    c  [span]  C  "World"',
      ].join('\n'),
    );
  });

  it('keeps sibling order from the children array', () => {
    const nodes = new Map<string, CanvasNode>([
      ['root', makeNode({ id: 'root', children: ['second', 'first'] })],
      ['first', makeNode({ id: 'first', parentId: 'root', name: 'First' })],
      ['second', makeNode({ id: 'second', parentId: 'root', name: 'Second' })],
    ]);

    const tree = projectNodeTree(nodes);
    const lines = tree.split('\n');
    expect(lines[0]).toBe('root  [div]  Root');
    expect(lines[1]).toBe('  second  [div]  Second');
    expect(lines[2]).toBe('  first  [div]  First');
  });

  it('collapses a run of ≥4 same-shape siblings to one full entry + a "×N more" line listing their ids', () => {
    const children = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'];
    const nodes = new Map<string, CanvasNode>();
    nodes.set('grid', makeNode({ id: 'grid', type: 'div', children }));
    for (const id of children) {
      nodes.set(
        id,
        makeNode({ id, type: 'card', parentId: 'grid', children: [`${id}-t`, `${id}-b`] }),
      );
      nodes.set(`${id}-t`, makeNode({ id: `${id}-t`, type: 'h3', parentId: id, textContent: 'Title' }));
      nodes.set(`${id}-b`, makeNode({ id: `${id}-b`, type: 'p', parentId: id, textContent: 'Body' }));
    }

    const tree = projectNodeTree(nodes);

    // The first card renders fully (its own two children visible)…
    expect(tree).toBe(
      [
        'grid  [div]  Root',
        '  c1  [card]  Root',
        '    c1-t  [h3]  Root  "Title"',
        '    c1-b  [p]  Root  "Body"',
        '  … ×5 more card (same shape): c2 c3 c4 c5 c6',
      ].join('\n'),
    );
  });

  it('does NOT collapse runs under the threshold or with a different children signature', () => {
    const nodes = new Map<string, CanvasNode>();
    nodes.set('row', makeNode({ id: 'row', type: 'div', children: ['d1', 'd2', 'd3'] }));
    nodes.set('d1', makeNode({ id: 'd1', type: 'card', parentId: 'row', children: ['d1-t'] }));
    nodes.set('d2', makeNode({ id: 'd2', type: 'card', parentId: 'row', children: ['d2-t'] }));
    nodes.set('d3', makeNode({ id: 'd3', type: 'card', parentId: 'row', children: ['d3-t', 'd3-x'] }));
    nodes.set('d1-t', makeNode({ id: 'd1-t', type: 'h3', parentId: 'd1' }));
    nodes.set('d2-t', makeNode({ id: 'd2-t', type: 'h3', parentId: 'd2' }));
    nodes.set('d3-t', makeNode({ id: 'd3-t', type: 'h3', parentId: 'd3' }));
    nodes.set('d3-x', makeNode({ id: 'd3-x', type: 'p', parentId: 'd3' }));

    const tree = projectNodeTree(nodes);

    // Only 3 siblings (below the 4 threshold) and d3 has a different
    // signature — every card renders on its own line, no summary.
    expect(tree).toContain('  d1  [card]  Root');
    expect(tree).toContain('  d2  [card]  Root');
    expect(tree).toContain('  d3  [card]  Root');
    expect(tree).not.toContain('more card');
  });

  it('collapses nested repeated runs inside the first card', () => {
    const nodes = new Map<string, CanvasNode>();
    nodes.set('group', makeNode({ id: 'group', type: 'div', children: ['c1', 'c2', 'c3', 'c4'] }));
    for (const id of ['c1', 'c2', 'c3', 'c4']) {
      nodes.set(id, makeNode({ id, type: 'card', parentId: 'group', children: [`${id}-a`, `${id}-b`, `${id}-c`, `${id}-d`] }));
      nodes.set(`${id}-a`, makeNode({ id: `${id}-a`, type: 'li', parentId: id }));
      nodes.set(`${id}-b`, makeNode({ id: `${id}-b`, type: 'li', parentId: id }));
      nodes.set(`${id}-c`, makeNode({ id: `${id}-c`, type: 'li', parentId: id }));
      nodes.set(`${id}-d`, makeNode({ id: `${id}-d`, type: 'li', parentId: id }));
    }

    const tree = projectNodeTree(nodes);

    expect(tree).toBe(
      [
        'group  [div]  Root',
        '  c1  [card]  Root',
        '    c1-a  [li]  Root',
        '    … ×3 more li (same shape): c1-b c1-c c1-d',
        '  … ×3 more card (same shape): c2 c3 c4',
      ].join('\n'),
    );
  });
});

describe('projectNode', () => {
  it('returns full styles, attrs, text and children ids', () => {
    const projected = projectNode(
      makeNode({
        id: 'n1',
        type: 'p',
        name: 'Hero',
        parentId: 'root',
        children: ['x'],
        textContent: 'Hi',
        styles: { position: 'relative', padding: '4px' },
        attrs: { href: '/' },
      }),
    );
    expect(projected).toEqual({
      id: 'n1',
      type: 'p',
      name: 'Hero',
      parentId: 'root',
      children: ['x'],
      styles: { position: 'relative', padding: '4px' },
      attrs: { href: '/' },
      text: 'Hi',
    });
  });

  it('does NOT abbreviate styles or omit defaults — the tree is the compact view', () => {
    const projected = projectNode(
      makeNode({ styles: { position: 'relative', display: 'block' } }),
    );
    expect(projected.styles).toEqual({ position: 'relative', display: 'block' });
    expect(projected.text).toBe('');
    expect(projected.attrs).toEqual({});
  });

  it('truncates a long textContent to 2000 chars with the ellipsis', () => {
    const projected = projectNode(makeNode({ textContent: 'z'.repeat(NODE_DETAIL_TEXT_CAP + 50) }));
    expect(projected.text).toHaveLength(NODE_DETAIL_TEXT_CAP + 1);
    expect(projected.text.endsWith('…')).toBe(true);
  });

  it('defaults an undefined textContent to an empty string', () => {
    const projected = projectNode(makeNode({ textContent: undefined }));
    expect(projected.text).toBe('');
  });

  it('reports children and attrs by copy, not by reference', () => {
    const children = ['a', 'b'];
    const attrs = { href: '/' };
    const projected = projectNode(makeNode({ children, attrs }));
    projected.children.push('c');
    projected.attrs.href = '/x';
    expect(children).toEqual(['a', 'b']);
    expect(attrs).toEqual({ href: '/' });
  });
});

describe('projectTokens', () => {
  it('projects raw tokens with and without a label', () => {
    const tokens: PresetToken[] = [
      { name: 'brand', value: '#6366f1', category: 'color', label: 'Brand' },
      { name: 'gap', value: '8px', category: 'spacing' },
    ];

    const projected = projectTokens(tokens);

    expect(projected).toHaveLength(2);
    expect(projected[0]).toEqual({ name: 'brand', value: '#6366f1', category: 'color', label: 'Brand' });
    expect(projected[1]).toEqual({ name: 'gap', value: '8px', category: 'spacing' });
    expect('label' in projected[1]).toBe(false);
  });

  it('returns an empty array for no tokens', () => {
    expect(projectTokens([])).toEqual([]);
  });
});

describe('formatDesignTokens', () => {
  it('groups tokens by category with the usage directive, in priority order', () => {
    const tokens: PresetToken[] = [
      { name: 'space-gap', value: '24px', category: 'spacing' },
      { name: 'color-brand', value: '#6366f1', category: 'color' },
      { name: 'typo-heading-size', value: '56px', category: 'typography' },
    ];

    const text = formatDesignTokens(tokens);

    expect(text).toMatch(/^## Design tokens — use these before inventing values\n/);
    expect(text).toContain('Prefer these tokens over hard-coded values for colors, spacing, radii and type scales.');
    expect(text).toContain('colors: color-brand → #6366f1');
    expect(text).toContain('spacing: space-gap → 24px');
    expect(text).toContain('typography: typo-heading-size → 56px');
    // colors and spacing come first regardless of input order
    expect(text.indexOf('colors:')).toBeLessThan(text.indexOf('spacing:'));
    expect(text.indexOf('spacing:')).toBeLessThan(text.indexOf('typography:'));
  });

  it('omits categories with no tokens and returns "" for none', () => {
    const text = formatDesignTokens([{ name: 'color-brand', value: '#6366f1', category: 'color' }]);
    expect(text).toContain('colors:');
    expect(text).not.toContain('spacing:');
    expect(formatDesignTokens([])).toBe('');
  });

  it('caps whole categories first — colors and spacing survive, later ones are cut with a hint', () => {
    const tokens: PresetToken[] = [
      ...Array.from({ length: 30 }, (_, i) => ({ name: `color-x${i}`, value: '#000000', category: 'color' as const })),
      ...Array.from({ length: 3 }, (_, i) => ({ name: `space-x${i}`, value: '8px', category: 'spacing' as const })),
      ...Array.from({ length: 12 }, (_, i) => ({ name: `typo-x${i}`, value: '16px', category: 'typography' as const })),
    ];

    const text = formatDesignTokens(tokens, 40);
    expect(text).toContain('color-x29 → #000000');
    expect(text).toContain('space-x2 → 8px');
    expect(text).toContain('typo-x6 → 16px');
    expect(text).not.toContain('typo-x7');
    expect(text).toContain('…(truncated, call get_design_tokens for the full list)');

    // uncapped: everything is back, no hint
    const full = formatDesignTokens(tokens);
    expect(full).toContain('typo-x11 → 16px');
    expect(full).not.toContain('(truncated');
  });
});

describe('get_design_tokens', () => {
  it('returns the full grouped format, uncapped', async () => {
    vi.mocked(getPresetTokens).mockReturnValue([
      { name: 'color-brand', value: '#6366f1', category: 'color' },
      { name: 'color-text', value: '#111111', category: 'color' },
      { name: 'space-gap', value: '24px', category: 'spacing' },
    ]);

    const result = await getDesignTokensTool.execute({}, toolCtx);
    expect(result.isError).toBeUndefined();
    expect((result.content[0] as any).text).toContain('colors: color-brand → #6366f1, color-text → #111111');
    expect((result.content[0] as any).text).toContain('spacing: space-gap → 24px');
    expect((result.content[0] as any).text).toContain('## Design tokens — use these before inventing values');
  });

  it('is registered in ALL_TOOLS', () => {
    expect(ALL_TOOLS.map((t) => t.name)).toContain('get_design_tokens');
  });
});

describe('integration with the global store', () => {
  const store = getDefaultStore();

  beforeEach(() => {
    store.set(activeFilePathAtom, 'app/page.client.tsx');
    store.set(selectedIdsAtom, []);
  });

  afterEach(() => {
    store.set(activeFilePathAtom, 'app/page.client.tsx');
    store.set(selectedIdsAtom, []);
  });

  it('get_active_file returns the active file path', async () => {
    const result = await getActiveFileTool.execute({}, toolCtx);
    expect(result.isError).toBeUndefined();
    const data = JSON.parse((result.content[0] as any).text);
    expect(data.path).toBe('app/page.client.tsx');
  });

  it('get_selection returns the selected ids', async () => {
    store.set(selectedIdsAtom, ['n1']);
    const result = await getSelectionTool.execute({}, toolCtx);
    const data = JSON.parse((result.content[0] as any).text);
    expect(data.ids).toContain('n1');
  });
});
describe('rendered-layout observation tools (with a fake cache bridge)', () => {
  const store = getDefaultStore();

  beforeEach(() => {
    store.set(activeFilePathAtom, 'app/page.client.tsx');
    store.set(selectedIdsAtom, []);
    store.set(activeCodeAtom, PAGE_CODE);
    bridge = new FakeBridge();
    setActiveBridge(bridge);
  });

  afterEach(() => {
    resetActiveBridge();
  });

  it('registers the three observation tools in READ_TOOLS', () => {
    const names = ALL_TOOLS.map((t) => t.name);
    expect(names).toContain('get_layout');
    expect(names).toContain('get_visuals');
    expect(names).toContain('audit_design');
  });

  it('get_layout prints measured rects with visible/hidden status', async () => {
    bridge.rect('hero', { left: 0, top: 0, width: 1440, height: 900 }, { display: 'flex' });
    bridge.rect('card-a-text', { left: 24, top: 48, width: 200.4, height: 28.6 }, { display: 'block' });
    bridge.rect('card-b', { left: 24, top: 90, width: 200, height: 120 }, { display: 'none' });

    const result = await getLayoutTool.execute({ viewport: 'desktop' }, toolCtx);
    const data = JSON.parse((result.content[0] as any).text);
    expect(data.viewport).toBe('desktop');
    expect(data.note).toBeUndefined();
    expect(data.lines).toContain('hero  x:0 y:0 w:1440 h:900  visible');
    expect(data.lines).toContain('card-a-text  x:24 y:48 w:200 h:29  visible');
    expect(data.lines).toContain('card-b  x:24 y:90 w:200 h:120  hidden(display:none)');
    expect(data.lines).toContain('card-a  norect');
  });

  it('get_layout reports an empty cache instead of crashing', async () => {
    const result = await getLayoutTool.execute({ viewport: 'desktop' }, toolCtx);
    const data = JSON.parse((result.content[0] as any).text);
    expect(data.lines.every((line: string) => line.endsWith('norect'))).toBe(true);
    expect(data.note).toContain('No cached rects yet');
    expect(result.isError).toBeUndefined();
  });

  it('get_visuals returns computed styles, rect and contrast', async () => {
    bridge.rect('card-a-text', { left: 24, top: 48, width: 392, height: 29 }, { color: '#111827', backgroundColor: '#ffffff', fontSize: '16px' });
    bridge.computed('card-a-text', { color: '#111827', backgroundColor: '#ffffff', fontSize: '16px' });

    const result = await getVisualsTool.execute({ node_id: 'card-a-text', viewport: 'desktop' }, toolCtx);
    const data = JSON.parse((result.content[0] as any).text);
    expect(data.node_id).toBe('card-a-text');
    expect(data.rect).toEqual({ x: 24, y: 48, w: 392, h: 29 });
    expect(data.styles).toContain('c:#111827');
    expect(data.styles).toContain('fs:16px');
    expect(data.styles).toContain('bg:#ffffff');
    expect(data.contrast).not.toBeNull();
    expect(data.contrast.ratio).toBeGreaterThan(4.5);
  });

  it('get_visuals returns null contrast when colors are unmeasured', async () => {
    bridge.rect('card-a', { left: 10, top: 10, width: 200, height: 100 }, {});
    const result = await getVisualsTool.execute({ node_id: 'card-a' }, toolCtx);
    const data = JSON.parse((result.content[0] as any).text);
    expect(data.contrast).toBeNull();
  });

  it('get_visuals fails for an unknown node id', async () => {
    const result = await getVisualsTool.execute({ node_id: 'nope' }, toolCtx);
    expect(result.isError).toBe(true);
  });

  it('get_visuals names the valid ids when the node is unknown', async () => {
    const result = await getVisualsTool.execute({ node_id: 'nope' }, toolCtx);
    const data = JSON.parse((result.content[0] as any).text);
    expect(data.error).toContain('Node "nope" not found.');
    expect(data.error).toContain('Valid ids:');
    expect(data.error).toContain('card-a');
  });

  it('audit_design surfaces every rule on a bad fixture and none on a clean one', async () => {
    store.set(activeCodeAtom, AUDIT_PAGE_CODE);
    bridge.rect('hero', { left: 0, top: 0, width: 1440, height: 900 });
    bridge.rect('a', { left: 0, top: 0, width: 300, height: 100 });
    bridge.rect('b', { left: 250, top: 0, width: 300, height: 100 }); // overlaps a by 50px
    bridge.rect('dim', { left: 0, top: 120, width: 300, height: 20 });
    bridge.rect('tiny', { left: 0, top: 160, width: 300, height: 16 });
    bridge.rect('long', { left: 0, top: 200, width: 40, height: 20 });
    bridge.rect('dead', { left: 0, top: 260, width: 3, height: 3 });
    bridge.rect('wide', { left: 0, top: 300, width: 2000, height: 50 }); // extends 560px past hero
    bridge.computed('dim', { color: '#999999', backgroundColor: '#ffffff', fontSize: '16px' });
    bridge.computed('tiny', { color: '#111827', backgroundColor: '#ffffff', fontSize: '10px' });
    bridge.computed('long', { color: '#111827', backgroundColor: '#ffffff', fontSize: '6px' });

    const result = await auditDesignTool.execute({ viewport: 'desktop' }, toolCtx);
    const data = JSON.parse((result.content[0] as any).text);
    const joined = data.violations.join('\n');
    expect(joined).toContain('OVERLAP');
    expect(joined).toContain('OVERFLOW');
    expect(joined).toContain('CONTRAST');
    expect(joined).toContain('FONT_SIZE');
    expect(joined).toContain('TRUNCATION');
    expect(joined).toContain('EMPTY_NODE');
    expect(data.summary).toMatch(/\d+ violation/);
  });

  it('audit_design never reports a clean pass when the cache measured nothing', async () => {
    // Sanctioned change (M3): with zero measured rects the audit must NOT
    // claim an all-clear — the summary says "Not measured: 0/N" instead.
    const result = await auditDesignTool.execute({ viewport: 'desktop' }, toolCtx);
    const data = JSON.parse((result.content[0] as any).text);
    expect(data.violations).toEqual([]);
    expect(data.summary).toBe('Not measured: 0/4 nodes checked.');
  });

  it('audit_design surfaces SECTION_DEPASSE_VIEWPORT for a section that pours off the mobile tile', async () => {
    store.set(activeCodeAtom, AUDIT_PAGE_CODE);
    bridge.rect('hero', { left: 0, top: 0, width: 375, height: 600 }, {}, 'mobile');
    bridge.rect('wide', { left: 0, top: 0, width: 400, height: 50 }, {}, 'mobile');
    const result = await auditDesignTool.execute({ viewport: 'mobile' }, toolCtx);
    const data = JSON.parse((result.content[0] as any).text);
    const joined = data.violations.join('\n');
    expect(joined).toContain('SECTION_DEPASSE_VIEWPORT');
    expect(joined).toContain('wide extends right by 25px');
    // The measured tile is exposed so the model can reason about the verdict.
    expect(data.viewport_rect).toEqual({ x: 0, y: 0, width: 375, height: 600 });
  });

  it('audit_design flags the frame itself when it renders wider than its configured tile (the root hole)', async () => {
    // PAGE_CODE's frame is the hero section (parent-less). Measured 400 on a
    // 375 tile → the root-too-wide signal the OVERFLOW rule cannot see.
    bridge.rect('hero', { left: 0, top: 0, width: 400, height: 600 }, {}, 'mobile');
    const result = await auditDesignTool.execute({ viewport: 'mobile' }, toolCtx);
    const data = JSON.parse((result.content[0] as any).text);
    const joined = data.violations.join('\n');
    expect(joined).toContain('SECTION_DEPASSE_VIEWPORT');
    expect(joined).toContain('hero extends right by 25px');
  });

  it('audit_design interferes with nothing on a clean fixture — no SECTION_DEPASSE_VIEWPORT when everything fits', async () => {
    bridge.rect('hero', { left: 0, top: 0, width: 1440, height: 900 }, {}, 'desktop');
    bridge.rect('card-a', { left: 0, top: 0, width: 200, height: 100 }, {}, 'desktop');
    bridge.rect('card-a-text', { left: 0, top: 0, width: 100, height: 20 }, {}, 'desktop');
    bridge.rect('card-b', { left: 0, top: 120, width: 200, height: 100 }, {}, 'desktop');
    const result = await auditDesignTool.execute({ viewport: 'desktop' }, toolCtx);
    const data = JSON.parse((result.content[0] as any).text);
    const sectionFlags = data.violations.filter((v: string) => v.startsWith('SECTION_DEPASSE_VIEWPORT'));
    expect(sectionFlags).toHaveLength(0);
  });

  it('audit_design reports a null viewport_rect when the frame has no measured rect', async () => {
    const result = await auditDesignTool.execute({ viewport: 'desktop' }, toolCtx);
    const data = JSON.parse((result.content[0] as any).text);
    expect(data.viewport_rect).toBeNull();
  });

  it('observation tools carry a status + reason so the model can react', async () => {
    const result = await auditDesignTool.execute({ viewport: 'desktop' }, toolCtx);
    const data = JSON.parse((result.content[0] as any).text);
    expect(data.status).toBe('pending');
    expect(data.reason).toContain('No rects cached');
  });
});

describe('P6 epoch + coverage (T4) — never ready on partial or stale', () => {
  const store = getDefaultStore();

  beforeEach(() => {
    store.set(activeFilePathAtom, 'app/page.client.tsx');
    store.set(selectedIdsAtom, []);
    store.set(activeCodeAtom, PAGE_CODE);
    bridge = new FakeBridge();
    setActiveBridge(bridge);
  });

  afterEach(() => {
    resetActiveBridge();
  });

  it('get_layout is pending with UNMEASURED on a partial snapshot', async () => {
    bridge.rect('hero', { left: 0, top: 0, width: 1440, height: 900 });
    const result = await getLayoutTool.execute({ viewport: 'desktop' }, toolCtx);
    const data = JSON.parse((result.content[0] as any).text);
    expect(data.status).toBe('pending');
    expect(data.reason).toContain('Not measured: 1/4');
    expect(data.coverage).toEqual({ withRect: 1, total: 4 });
    expect(data.unmeasured).toEqual(expect.arrayContaining(['card-a', 'card-a-text', 'card-b']));
    expect(data.unmeasuredTotal).toBe(3);
    expect(data.epoch.stale).toBe(false);
  });

  it('get_layout is ready at full coverage on a fresh epoch', async () => {
    bridge.rect('hero', { left: 0, top: 0, width: 1440, height: 900 });
    bridge.rect('card-a', { left: 0, top: 0, width: 200, height: 100 });
    bridge.rect('card-a-text', { left: 0, top: 0, width: 100, height: 20 });
    bridge.rect('card-b', { left: 0, top: 120, width: 200, height: 100 });
    const result = await getLayoutTool.execute({ viewport: 'desktop' }, toolCtx);
    const data = JSON.parse((result.content[0] as any).text);
    expect(data.status).toBe('ready');
    expect(data.coverage).toEqual({ withRect: 4, total: 4 });
    expect(data.unmeasured).toEqual([]);
    expect(data.epoch.stale).toBe(false);
  });

  it('get_layout is pending when the epoch is stale, even at full coverage', async () => {
    bridge.rect('hero', { left: 0, top: 0, width: 1440, height: 900 });
    bridge.rect('card-a', { left: 0, top: 0, width: 200, height: 100 });
    bridge.rect('card-a-text', { left: 0, top: 0, width: 100, height: 20 });
    bridge.rect('card-b', { left: 0, top: 120, width: 200, height: 100 });
    // Pin the fill epoch, then move the project: the measurement predates it.
    const saved = store.get(projectVersionAtom);
    bridge.epochVersion = saved;
    store.set(projectVersionAtom, saved + 1);
    try {
      const result = await getLayoutTool.execute({ viewport: 'desktop' }, toolCtx);
      const data = JSON.parse((result.content[0] as any).text);
      expect(data.coverage).toEqual({ withRect: 4, total: 4 });
      expect(data.epoch.stale).toBe(true);
      expect(data.status).toBe('pending');
      expect(data.reason).toContain('Stale');
    } finally {
      store.set(projectVersionAtom, saved);
    }
  });

  it('get_visuals is pending on a stale epoch even with a rect', async () => {
    bridge.rect('card-a-text', { left: 24, top: 48, width: 392, height: 29 }, { color: '#111827', backgroundColor: '#ffffff', fontSize: '16px' });
    const saved = store.get(projectVersionAtom);
    bridge.epochVersion = saved;
    store.set(projectVersionAtom, saved + 1);
    try {
      const result = await getVisualsTool.execute({ node_id: 'card-a-text', viewport: 'desktop' }, toolCtx);
      const data = JSON.parse((result.content[0] as any).text);
      expect(data.rect).not.toBeNull();
      expect(data.epoch.stale).toBe(true);
      expect(data.status).toBe('pending');
      // P6 (M2): the envelope speaks at the node's scope, not the viewport's.
      expect(data.coverage).toEqual({ withRect: 1, total: 1 });
      expect(data.unmeasured).toEqual([]);
    } finally {
      store.set(projectVersionAtom, saved);
    }
  });

  it('audit_design never claims a clean pass on a partial snapshot (the P6 NO-GO kill)', async () => {
    // 3/4 measured, zero findings on the measured subset — the pre-P6 code
    // reported ready + "No violations detected." here.
    bridge.rect('hero', { left: 0, top: 0, width: 1440, height: 900 });
    bridge.rect('card-a-text', { left: 0, top: 0, width: 100, height: 20 });
    bridge.rect('card-b', { left: 0, top: 120, width: 200, height: 100 });
    const result = await auditDesignTool.execute({ viewport: 'desktop' }, toolCtx);
    const data = JSON.parse((result.content[0] as any).text);
    expect(data.violations).toEqual([]);
    expect(data.status).toBe('pending');
    expect(data.summary).not.toBe('No violations detected.');
    expect(data.summary).toContain('Not measured: 3/4');
    expect(data.unmeasured).toEqual(['card-a']);
  });

  it('audit_design reports ready + a clean pass only at full coverage', async () => {
    bridge.rect('hero', { left: 0, top: 0, width: 1440, height: 900 }, {}, 'desktop');
    bridge.rect('card-a', { left: 0, top: 0, width: 200, height: 100 }, {}, 'desktop');
    bridge.rect('card-a-text', { left: 0, top: 0, width: 100, height: 20 }, {}, 'desktop');
    bridge.rect('card-b', { left: 0, top: 120, width: 200, height: 100 }, {}, 'desktop');
    const result = await auditDesignTool.execute({ viewport: 'desktop' }, toolCtx);
    const data = JSON.parse((result.content[0] as any).text);
    expect(data.status).toBe('ready');
    expect(data.summary).toBe('No violations detected.');
    expect(data.coverage).toEqual({ withRect: 4, total: 4 });
  });
});

// ─── get_component ──────────────────────────────────────────────────────────

describe('get_component', () => {
  const HERO_INFO: ComponentInfo = {
    name: 'Hero',
    filePath: 'components/Hero.tsx',
    props: [
      { name: 'title', defaultValue: 'Build', varType: 'text', description: 'Main heading' },
      { name: 'variant', defaultValue: 'primary', varType: 'option' },
      { name: 'count', defaultValue: null, varType: 'number' },
    ],
    contentHash: 'h1',
    controlsMeta: null,
  };

  beforeEach(() => {
    vi.mocked(buildComponentRegistry).mockReturnValue(new Map([['Hero', HERO_INFO]]));
  });

  it('formatPropLine prints type, default, options and description', () => {
    const line = formatPropLine({ name: 'variant', defaultValue: 'primary', varType: 'option' }, ['primary', 'dark']);
    expect(line).toContain('variant');
    expect(line).toContain('type: option');
    expect(line).toContain('default: "primary"');
    expect(line).toContain('options: primary|dark');
    const desc = formatPropLine({ name: 'title', defaultValue: 'Build', varType: 'text', description: 'Main heading' });
    expect(desc).toContain('description: "Main heading"');
  });

  it('formatPropLine marks required props (no default)', () => {
    const line = formatPropLine({ name: 'count', defaultValue: null, varType: 'number' });
    expect(line).toContain('NONE (REQUIRED)');
  });

  it('formatComponentDetail emits a header and one line per prop', () => {
    const text = formatComponentDetail(HERO_INFO, { variant: ['primary', 'dark'] });
    const lines = text.split('\n');
    expect(lines[0]).toContain('Hero');
    expect(lines[0]).toContain('components/Hero.tsx');
    expect(lines[0]).toContain('3 props');
    expect(lines).toHaveLength(4);
    expect(text).toContain('options: primary|dark');
  });

  it('readComponentPropOptions extracts only option-typed lists from @propMeta', () => {
    const code = `/** @propMeta {"variant":{"type":"option","options":["primary","dark"]},"title":{"type":"text"},"pad":{"options":["a"]}} */\nfn`;
    const out = readComponentPropOptions(code);
    expect(out).toEqual({ variant: ['primary', 'dark'] });
  });


  it('execute returns the formatted component detail for an existing component', async () => {
    const result = await getComponentTool.execute({ name: 'Hero' }, toolCtx);
    expect(result.isError).toBeUndefined();
    expect((result.content[0] as any).text).toContain('Hero');
    expect((result.content[0] as any).text).toContain('type: text');
    expect((result.content[0] as any).text).toContain('NONE (REQUIRED)');
  });

  it('execute fails with a did-you-mean suggestion for a close name', async () => {
    const result = await getComponentTool.execute({ name: 'Hro' }, toolCtx);
    expect(result.isError).toBe(true);
    const data = JSON.parse((result.content[0] as any).text);
    expect(data.error).toContain('Did you mean: Hero');
  });

  it('execute fails clearly when nothing is close', async () => {
    const result = await getComponentTool.execute({ name: 'Zzz' }, toolCtx);
    expect(result.isError).toBe(true);
    const data = JSON.parse((result.content[0] as any).text);
    expect(data.error).toContain('list_components');
  });

  it('suggestComponentNames: case-insensitive hit, then prefix, then edit distance', () => {
    const names = ['Hero', 'Navbar', 'HeroCard'];
    expect(suggestComponentNames(names, 'hero')).toEqual(['Hero']);          // case-insensitive exact
    expect(suggestComponentNames(names, 'Nav')).toEqual(['Navbar']);         // prefix
    expect(suggestComponentNames(names, 'H')).toEqual(['Hero', 'HeroCard']); // prefix set, shortest first
    expect(suggestComponentNames(names, 'Nvbar')).toEqual(['Navbar']);       // small edit distance
    expect(suggestComponentNames(['Hero', 'Navbar'], 'Zzz')).toEqual([]);    // nothing close
  });

  it('get_component is registered in ALL_TOOLS', () => {
    expect(ALL_TOOLS.map((t) => t.name)).toContain('get_component');
  });
});

describe('P7 (v) — read_source bounded + turn_diff RO', () => {
  it('read_source returns ranged raw bytes with caps', async () => {
    const { readSourceTool } = await import('./read');
    const result = await readSourceTool.execute({ path: 'app/page.client.tsx', from_line: 1, to_line: 3 }, toolCtx);
    expect(result.isError).toBeUndefined();
    const data = JSON.parse((result.content[0] as any).text);
    expect(data.path).toBe('app/page.client.tsx');
    expect(data.from_line).toBe(1);
    expect(data.to_line).toBe(3);
    expect(typeof data.total_lines).toBe('number');
    expect(data.truncated).toBe(false);
    expect(typeof data.content).toBe('string');
  });

  it('read_source refuses secrets, traversal and non-source extensions', async () => {
    const { readSourceTool } = await import('./read');
    // Dotfiles (secrets), parent traversal and non-source extensions are
    // refused by the path rule (before any FS read).
    for (const p of ['.env', '.env.local', '../outside.tsx', 'notes.md', 'run.sh']) {
      const r = await readSourceTool.execute({ path: p }, toolCtx);
      expect(r.isError, p).toBe(true);
      expect(JSON.parse((r.content[0] as any).text).error).toMatch(/Refused path/);
    }
    // Absolute-ish input is normalized into the virtual FS (never the disk).
    const abs = await readSourceTool.execute({ path: '/abs/path.tsx' }, toolCtx);
    expect(abs.isError).toBe(true);
    // Unknown but well-formed project path → clean missing-file fail.
    const miss = await readSourceTool.execute({ path: 'app/nope.tsx' }, toolCtx);
    expect(miss.isError).toBe(true);
  });

  it('read_source truncates honestly beyond caps', async () => {
    const { readSourceTool, READ_SOURCE_CAP_LINES } = await import('./read');
    const big = Array.from({ length: READ_SOURCE_CAP_LINES + 50 }, (_, i) => `// line ${i}`).join('\n');
    const { projectFS } = await import('@/code/project/project-fs');
    const pre = projectFS.getSnapshot();
    try {
      projectFS.loadSnapshot(new Map([['app/page.client.tsx', big]]));
      const result = await readSourceTool.execute({ path: 'app/page.client.tsx' }, toolCtx);
      const data = JSON.parse((result.content[0] as any).text);
      expect(data.truncated).toBe(true);
      expect(data.to_line - data.from_line + 1).toBe(READ_SOURCE_CAP_LINES);
    } finally {
      projectFS.loadSnapshot(pre);
    }
  });

  it('turn_diff fails clearly with no sealed turns, reads the last sealed turn otherwise', async () => {
    const { turnDiffTool } = await import('./read');
    const { agentCheckpointsAtom } = await import('@/code/stores/agent-checkpoints');
    const store = getDefaultStore();
    const pre = store.get(agentCheckpointsAtom);
    try {
      store.set(agentCheckpointsAtom, new Map());
      const empty = await turnDiffTool.execute({}, toolCtx);
      expect(empty.isError).toBe(true);
      store.set(
        agentCheckpointsAtom,
        new Map([
          ['run-1', { before: new Map(), after: new Map(), changes: [], runId: '1-1' }],
          [
            'run-2',
            {
              before: new Map(),
              after: new Map(),
              changes: [{ path: 'app/page.client.tsx', addedIds: ['a'], removedIds: [], changedIds: ['b'] }],
              runId: '1-2',
            },
          ],
        ]),
      );
      const last = await turnDiffTool.execute({}, toolCtx);
      expect(last.isError).toBeUndefined();
      const data = JSON.parse((last.content[0] as any).text);
      expect(data.scope).toBe('last-sealed-turn');
      expect(data.run_key).toBe('run-2');
      expect(data.changes).toEqual([{ path: 'app/page.client.tsx', added: ['a'], removed: [], changed: ['b'] }]);
      expect(data).not.toHaveProperty('before');
      expect(data).not.toHaveProperty('after');
      const first = await turnDiffTool.execute({ run_key: 'run-1' }, toolCtx);
      expect(JSON.parse((first.content[0] as any).text).run_key).toBe('run-1');
      const miss = await turnDiffTool.execute({ run_key: 'run-9' }, toolCtx);
      expect(miss.isError).toBe(true);
    } finally {
      store.set(agentCheckpointsAtom, pre);
    }
  });

  it('turn_diff surfaces a branched run’s sealed changes (never main fallback)', async () => {
    const { turnDiffTool } = await import('./read');
    const { agentCheckpointsAtom } = await import('@/code/stores/agent-checkpoints');
    const store = getDefaultStore();
    const pre = store.get(agentCheckpointsAtom);
    try {
      store.set(
        agentCheckpointsAtom,
        new Map([
          [
            'run-7',
            {
              before: new Map(),
              after: new Map(),
              changes: [{ path: 'app/page.client.tsx', addedIds: ['n'], removedIds: [], changedIds: [] }],
              runId: '7-7',
              branchId: 'agent-x',
            },
          ],
        ]),
      );
      const res = await turnDiffTool.execute({}, toolCtx);
      expect(res.isError).toBeUndefined();
      const data = JSON.parse((res.content[0] as any).text);
      expect(data.run_key).toBe('run-7');
      expect(data.changes).toEqual([{ path: 'app/page.client.tsx', added: ['n'], removed: [], changed: [] }]);
    } finally {
      store.set(agentCheckpointsAtom, pre);
    }
  });
});
