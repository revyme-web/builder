// Reproduce: page render → template-edit render over the SAME DOM (the
// create-template-after-undo flow). The template render must fully replace
// the page DOM inside each viewport.
import { describe, it, expect, beforeEach, vi } from 'vitest';
vi.mock('@/shared/debug-trace', () => ({ trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn(), dom: vi.fn() }, pauseDOMObserver: vi.fn(), resumeDOMObserver: vi.fn() }));
import { renderNodes } from './Renderer';
import type { CanvasNode } from '@/code/parsing/parser';

const N = (id: string, kids: string[] = [], extra: Partial<CanvasNode> = {}): CanvasNode => ({
  id, type: 'div', name: id, parentId: null, children: kids,
  styles: { display: 'flex', position: 'relative' }, textContent: '', hasMixedContent: false,
  attrs: {}, order: 0, isCanvasNode: false, componentFile: null, componentInstanceId: null,
  isComponentRoot: false, motionVariants: null, motionVariantsRef: null, motionProps: null,
  responsiveVariantMap: null, conditionalStyles: null, ...extra,
} as CanvasNode);

const link = (m: Map<string, CanvasNode>) => {
  for (const n of m.values()) for (const c of n.children) { const k = m.get(c); if (k) (k as any).parentId = n.id; }
  return m;
};

const PAGE = () => link(new Map([
  ['root', N('root', ['hero-1', 'features-2'])],
  ['hero-1', N('hero-1', ['p-1'])],
  ['p-1', N('p-1', [], { type: 'p', textContent: 'Save more' })],
  ['features-2', N('features-2', [])],
]));

const TEMPLATE = () => link(new Map([
  ['root', N('root', ['children-slot'])],
  ['children-slot', N('children-slot', [], { type: 'slot', name: 'Page Content', isChildrenSlot: true } as any)],
]));

const VPS = [
  { id: 'desktop', label: 'Desktop', width: 1440, isPrimary: true, order: 0, x: 0, y: 0 },
  { id: 'tablet', label: 'Tablet', width: 768, isPrimary: false, order: 1, x: 1600, y: 0 },
  { id: 'mobile', label: 'Mobile', width: 375, isPrimary: false, order: 2, x: 2500, y: 0 },
];

describe('page → template-edit render over the same DOM', () => {
  let container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    return () => container.remove();
  });

  const idsIn = (c: HTMLElement) => [...c.querySelectorAll('[data-node-id]')].map(e => e.getAttribute('data-node-id'));

  it('template render removes every page node from every viewport', () => {
    renderNodes(container, PAGE(), null, () => {}, VPS as any, 'page code');
    expect(idsIn(container).filter(id => id?.includes('hero-1')).length).toBe(3); // one per viewport
    renderNodes(container, TEMPLATE(), null, () => {}, VPS as any, 'template code');
    const after = idsIn(container);
    expect(after.filter(id => id?.includes('hero-1'))).toEqual([]);
    expect(after.filter(id => id?.includes('p-1'))).toEqual([]);
    expect(after.filter(id => id?.includes('children-slot')).length).toBe(3);
  });

  it('back-and-forth (page → template → page → template) stays correct', () => {
    renderNodes(container, PAGE(), null, () => {}, VPS as any, 'page code');
    renderNodes(container, TEMPLATE(), null, () => {}, VPS as any, 'template code');
    renderNodes(container, PAGE(), null, () => {}, VPS as any, 'page code');
    expect(idsIn(container).filter(id => id?.includes('hero-1')).length).toBe(3);
    renderNodes(container, TEMPLATE(), null, () => {}, VPS as any, 'template code');
    const after = idsIn(container);
    expect(after.filter(id => id?.includes('hero-1'))).toEqual([]);
    expect(after.filter(id => id?.includes('children-slot')).length).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The 2026-07-27 trap, distilled: root elements whose `__revymePatchKey`
// MATCHES the incoming render (stamped by an earlier render of the same file)
// but whose DOM content was replaced by another file's content through an
// imperative path that doesn't touch patch keys. The subtree skip then
// preserved the foreign DOM wholesale — the home page rendered inside a
// freshly-created template's viewports, across BOTH renders of the switch
// (trace: subtreeSkips 3 on each, `children: 31`).
// A FILE-SWITCH render passes distrustPatchKeys and must replace it.
// ─────────────────────────────────────────────────────────────────────────────
describe('distrustPatchKeys — file switches never trust stored subtree keys', () => {
  let container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    return () => container.remove();
  });

  const poisonRoots = () => {
    // Foreign content enters the template-stamped roots WITHOUT a patch pass
    // (stand-in for any imperative DOM path: culling replay, restore, etc.).
    for (const rootEl of container.querySelectorAll('[data-viewport]')) {
      rootEl.innerHTML = '<div data-node-id="hero-1" data-id="hero-1"><p data-node-id="p-1" data-id="p-1">Save more</p></div>';
    }
  };

  it('documents the trap: without distrust, matching keys preserve foreign DOM', () => {
    renderNodes(container, TEMPLATE(), null, () => {}, VPS as any, 'template code');
    poisonRoots();
    renderNodes(container, TEMPLATE(), null, () => {}, VPS as any, 'template code');
    // The skip fires (keys match) and the foreign DOM SURVIVES — this is the
    // exact mechanism of the bug. If this assertion ever fails, the skip
    // semantics changed and the distrust flag may be removable.
    expect([...container.querySelectorAll('[data-node-id]')].some(e => e.getAttribute('data-node-id')?.includes('hero-1'))).toBe(true);
  });

  it('the FIX: a distrusted render replaces the foreign DOM', () => {
    renderNodes(container, TEMPLATE(), null, () => {}, VPS as any, 'template code');
    poisonRoots();
    renderNodes(container, TEMPLATE(), null, () => {}, VPS as any, 'template code', undefined, undefined, undefined, true);
    const ids = [...container.querySelectorAll('[data-node-id]')].map(e => e.getAttribute('data-node-id'));
    expect(ids.filter(id => id?.includes('hero-1'))).toEqual([]);
    expect(ids.filter(id => id?.includes('children-slot')).length).toBe(3);
  });

  it('a distrusted render still RE-STAMPS keys (next same-file render skips again)', () => {
    renderNodes(container, TEMPLATE(), null, () => {}, VPS as any, 'template code', undefined, undefined, undefined, true);
    const rootEl = container.querySelector('[data-viewport]') as HTMLElement & { __revymePatchKey?: string };
    expect(rootEl.__revymePatchKey).toBeTruthy();
  });
});
