// copy-instance.test.ts — copying a component INSTANCE must not drag along its
// expanded master internals (the "paste includes the children → double render"
// bug). Code components, whose children are real passed-in content, must still
// copy their children.

import { describe, expect, test, vi, beforeEach } from 'vitest';

vi.mock('@/shared/debug-trace', () => ({ trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn(), dom: vi.fn() } }));
vi.mock('@/canvas/node-ops', () => ({ findNodeRect: () => null, getActiveFilePath: () => '', getActiveTransform: () => ({ x: 0, y: 0, scale: 1 }) }));
vi.mock('@/code/project/project-fs', () => ({ projectFS: { readFile: () => '' } }));
vi.mock('./effects-extractor', () => ({ extractEffectsForNodes: () => null }));

import { copyNodes, getClipboardData } from './index';
import type { CanvasNode } from '@/code/parsing/parser';

function node(id: string, overrides: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id, type: 'div', name: id, parentId: null, children: [], styles: {}, attrs: {},
    textContent: '', hasMixedContent: false, order: 0, isCanvasNode: false,
    componentFile: null, componentInstanceId: null, isComponentRoot: false,
    motionVariants: null, motionVariantsRef: null, responsiveVariantMap: null,
    conditionalStyles: null, motionProps: null, ...overrides,
  } as CanvasNode;
}

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
  });
});

// A DESIGN component instance (`StartTrialButton`) with its expanded master
// internals attached as children (MotionLink → label/arrow paragraphs).
function instanceTree(): Map<string, CanvasNode> {
  const m = new Map<string, CanvasNode>();
  m.set('btn', node('btn', { type: 'StartTrialButton', isComponentInstance: true, componentFile: 'components/StartTrialButton.tsx', children: ['btn::link'] }));
  m.set('btn::link', node('btn::link', { type: 'MotionLink', parentId: 'btn', componentInstanceId: 'btn', componentFile: 'components/StartTrialButton.tsx', children: ['btn::p'] }));
  m.set('btn::p', node('btn::p', { type: 'p', parentId: 'btn::link', componentInstanceId: 'btn', componentFile: 'components/StartTrialButton.tsx', textContent: 'Start free trial now' }));
  return m;
}

describe('copyNodes — component instance is a leaf', () => {
  test('copying a design instance does NOT copy its expanded master internals', () => {
    const res = copyNodes(['btn'], instanceTree());
    expect(res.success).toBe(true);
    expect(res.nodeCount).toBe(1);
    const ids = getClipboardData()!.nodes.map((n) => n.id);
    expect(ids).toEqual(['btn']);
    expect(ids).not.toContain('btn::link');
    expect(ids).not.toContain('btn::p');
  });

  test('the copied instance node has an EMPTY children list (pastes as <Instance/>)', () => {
    copyNodes(['btn'], instanceTree());
    const inst = getClipboardData()!.nodes.find((n) => n.id === 'btn')!;
    expect(inst.children).toEqual([]);
    expect(inst.componentFile).toBe('components/StartTrialButton.tsx');
  });

  test('copying a CONTAINER that holds an instance copies the container + the instance tag, not the internals', () => {
    const m = instanceTree();
    m.set('frame', node('frame', { type: 'div', children: ['btn'] }));
    m.get('btn')!.parentId = 'frame';
    const res = copyNodes(['frame'], m);
    const ids = getClipboardData()!.nodes.map((n) => n.id).sort();
    expect(ids).toEqual(['btn', 'frame']);
    expect(res.nodeCount).toBe(2);
  });

  test('a CODE component (isCodeComponent) still copies its real passed-in children', () => {
    const m = new Map<string, CanvasNode>();
    m.set('mq', node('mq', { type: 'CompanyMarquee', isCodeComponent: true, componentFile: 'components/CompanyMarquee.tsx', children: ['card'] } as Partial<CanvasNode>));
    m.set('card', node('card', { type: 'div', parentId: 'mq' }));
    copyNodes(['mq'], m);
    const ids = getClipboardData()!.nodes.map((n) => n.id);
    expect(ids).toContain('mq');
    expect(ids).toContain('card');
  });
});
