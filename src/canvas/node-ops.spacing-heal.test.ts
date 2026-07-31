// node-ops.spacing-heal.test.ts — the padding/margin shorthand HEAL must run on
// PRIMARY page writes only.
//
// Heal exists for legacy imports that mix longhands with a trailing shorthand in
// ONE inline style object (`{ paddingTop: '134px', padding: '34px' }` renders 34
// everywhere because React applies keys in order). When a primary write touches
// a longhand on such a node, heal folds the effective values into the sides the
// write doesn't set and deletes the shorthand — one edit heals the file.
//
// On a REPLICA that is destructive, and it was firing there: the gate tested
// `!options.viewportPrefix` as a stand-in for "primary", but that flag only says
// the caller patched one tile's DOM — PaddingHandles' source commit passes none.
// Dragging the top padding handle on the MOBILE tile of a node with inline
// `padding: '58px'` therefore turned the band
//   { padding: 12px !important; gap: 46px !important }
// into
//   { gap: 46px !important; padding-right: 58px !important;
//     padding-left: 58px !important; padding-top: 78px !important; … }
// — the band's own 12px shorthand deleted, and the PRIMARY's 58px pinned onto
// the two sides the user never dragged (user report 2026-07-26).
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn(), dom: vi.fn() },
}));
vi.mock('@/code/svg/refit-group', () => ({
  moveChildAndRefitGroup: vi.fn(() => null),
  refitGroupChain: vi.fn(),
  normalizeGroupOnResize: vi.fn(),
}));
vi.mock('@/code/mutation/mutation-queue', () => ({
  queueMutation: vi.fn(),
  flushNow: vi.fn(),
  setForceRender: vi.fn(),
}));
vi.mock('@/code/project/active-file-store', () => ({
  isComponentFilePath: (p: string) => p.startsWith('components/'),
  getLayoutForPage: () => null,
  isLayoutFile: () => false,
}));
vi.mock('@/code/project/project-fs', () => ({ projectFS: { readFile: () => '' } }));
vi.mock('@/code/variants/variant-config', () => ({ parseVariantConfig: () => [] }));

import { updateNodeStyles, setStyleContext } from './node-ops';
import { setActiveBridge } from './canvas-bridge';
import { getDefaultStore } from 'jotai';
import { nodesAtom } from '@/code/stores/store';
import { queueMutation } from '@/code/mutation/mutation-queue';
import type { CanvasNode } from '@/code/parsing/parser';

const mkNode = (partial: Partial<CanvasNode>): CanvasNode => ({
  id: '', type: 'div', name: '', parentId: null, children: [],
  styles: {}, attrs: {}, textContent: '', hasMixedContent: false, order: 0,
  ...partial,
} as unknown as CanvasNode);

const stubBridge = {
  getRect: () => null,
  getChildRects: () => [],
  getComputedValue: () => '',
  getComputedValues: () => ({}),
  getContainerRect: () => null,
  getElementIdsAtPoint: () => [],
  patchStyles: vi.fn(),
  patchAttrsAndStyles: vi.fn(),
  injectCSS: vi.fn(),
  removeCSS: vi.fn(),
} as any;

/** The reported node: inline `padding: '58px'` on a page file. */
function seedNode(styles: Record<string, string>) {
  const nodes = new Map<string, CanvasNode>();
  nodes.set('div-ms0qgj6f-2', mkNode({
    id: 'div-ms0qgj6f-2', parentId: 'frame-1', styles,
  }));
  nodes.set('frame-1', mkNode({ id: 'frame-1', children: ['div-ms0qgj6f-2'] }));
  getDefaultStore().set(nodesAtom, nodes);
}

/** The style payload that reached the mutation queue. */
function queuedStyles(): Record<string, string> {
  const call = (queueMutation as unknown as { mock: { calls: unknown[][] } }).mock.calls
    .map(c => c[0] as { type?: string; styles?: Record<string, string> })
    .find(u => !!u?.styles);
  return call?.styles ?? {};
}

const contentEl = { querySelector: () => null, querySelectorAll: () => [] } as unknown as HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
  setActiveBridge(stubBridge);
  seedNode({ display: 'flex', padding: '58px', gap: '46px' });
});

describe('spacing shorthand heal — viewport gating', () => {
  it('does NOT heal on a page REPLICA (the reported bleed)', () => {
    setStyleContext('app/page.client.tsx', 'mobile', 375);
    updateNodeStyles({
      id: 'div-ms0qgj6f-2',
      styles: { paddingTop: '78px', paddingBottom: '78px' },
      contentEl,
    });
    const styles = queuedStyles();
    // Only the two dragged sides — no folded left/right, no shorthand delete.
    expect(styles).toEqual({ paddingTop: '78px', paddingBottom: '78px' });
    expect(styles).not.toHaveProperty('paddingLeft');
    expect(styles).not.toHaveProperty('paddingRight');
    expect(styles).not.toHaveProperty('padding');
  });

  it('DOES heal on the primary (legacy mix still self-heals in one edit)', () => {
    setStyleContext('app/page.client.tsx', 'desktop', 1440);
    updateNodeStyles({
      id: 'div-ms0qgj6f-2',
      styles: { paddingTop: '78px', paddingBottom: '78px' },
      contentEl,
    });
    const styles = queuedStyles();
    expect(styles.paddingTop).toBe('78px');
    expect(styles.paddingBottom).toBe('78px');
    // Untouched sides keep the effective 58px, and the shorthand is deleted.
    expect(styles.paddingLeft).toBe('58px');
    expect(styles.paddingRight).toBe('58px');
    expect(styles.padding).toBe('');
  });

  it('never heals a domOnly live tick, on either viewport', () => {
    for (const vp of ['desktop', 'mobile']) {
      vi.clearAllMocks();
      setStyleContext('app/page.client.tsx', vp, vp === 'mobile' ? 375 : 1440);
      updateNodeStyles({
        id: 'div-ms0qgj6f-2',
        styles: { paddingTop: '78px' },
        contentEl,
        domOnly: true,
      });
      expect(queuedStyles()).toEqual({});   // domOnly never queues
    }
  });

  it('leaves a replica MARGIN write alone too', () => {
    seedNode({ display: 'flex', margin: '20px' });
    setStyleContext('app/page.client.tsx', 'tablet', 768);
    updateNodeStyles({
      id: 'div-ms0qgj6f-2',
      styles: { marginTop: '4px' },
      contentEl,
    });
    expect(queuedStyles()).toEqual({ marginTop: '4px' });
  });

  it('is a no-op when the node carries no shorthand to heal', () => {
    seedNode({ display: 'flex', paddingTop: '10px' });
    setStyleContext('app/page.client.tsx', 'desktop', 1440);
    updateNodeStyles({
      id: 'div-ms0qgj6f-2',
      styles: { paddingTop: '78px' },
      contentEl,
    });
    expect(queuedStyles()).toEqual({ paddingTop: '78px' });
  });
});
