import { describe, test, it, expect, vi } from 'vitest';
import { parseJSXToNodes, type CanvasNode } from '../parsing/parser';
import { computeLayoutBrackets } from '@/shared/flex-helpers';

// Mock trace to avoid side effects
vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), dom: vi.fn(), error: vi.fn() },
}));

// Helper: simulate what nodesAtom does for layout merge
function mergeLayoutIntoPage(pageCode: string, layoutCode: string): Map<string, CanvasNode> {
  const pageNodes = parseJSXToNodes(pageCode);
  const layoutNodes = parseJSXToNodes(layoutCode);

  const childrenIdx = layoutCode.indexOf('{children}');
  if (childrenIdx < 0) return pageNodes;
  const before = layoutCode.slice(0, childrenIdx);
  const after = layoutCode.slice(childrenIdx);
  const parentMatches = [...before.matchAll(/data-id="([^"]+)"/g)];
  // Filter to nodes whose element is still open at {children} position
  // (i.e. their closing tag comes AFTER {children})
  const openAtChildren = parentMatches.filter(m => {
    const id = m[1];
    const node = layoutNodes.get(id);
    if (!node) return false;
    // Check if this node's closing tag appears after {children}
    const closingTag = new RegExp(`</${node.type}\\s*>`);
    // Find ALL closing tags for this type after {children}
    // But we need the one that closes THIS node. Use a simpler heuristic:
    // after {children}, count opens vs closes for this tag type to determine
    // if the element is still open.
    // Simpler: check if the node is an ancestor by seeing if {children} is
    // inside its subtree. Since we have the parsed tree, check if any
    // descendant's data-id appears after {children}.
    // Simplest: just check if closing tag for this tag type exists after {children}
    // and its opening tag is before {children}. Since nested same-type tags are rare
    // in layouts, this heuristic works.
    return closingTag.test(after);
  });
  const childrenParentId = openAtChildren.length > 0 ? openAtChildren[openAtChildren.length - 1][1] : null;
  if (!childrenParentId) return pageNodes;

  const origChildren = new Map<string, string[]>();
  for (const [id, node] of layoutNodes) origChildren.set(id, [...node.children]);

  const pageRootIds: string[] = [];
  for (const [id, node] of pageNodes) {
    if (!node.parentId) pageRootIds.push(id);
  }

  const merged = new Map(pageNodes);

  // ── MERGE the template ONTO the page root (mirrors store.ts) ──
  // The template root TAKES OVER the page root's id (`root`). The page's
  // SECTIONS splice into the {children} slot as flex children of the
  // template column; the old page-root box is dropped (overwritten).
  let templateRootOrigId: string | null = null;
  for (const [id, n] of layoutNodes) { if (!n.parentId) { templateRootOrigId = id; break; } }
  const primaryPageRootId = pageRootIds[0] ?? null;
  const primaryPageRoot = primaryPageRootId ? merged.get(primaryPageRootId) : null;
  const pageSectionIds = primaryPageRoot ? [...primaryPageRoot.children] : [];
  const childrenParentMergedId = (childrenParentId === templateRootOrigId && primaryPageRootId)
    ? primaryPageRootId
    : 'layout::' + childrenParentId;

  for (const [origId, node] of layoutNodes) {
    const isRoot = origId === templateRootOrigId;
    const newId = (isRoot && primaryPageRootId) ? primaryPageRootId : 'layout::' + origId;
    node.fromLayout = true;
    node.id = newId;

    const kids = (origChildren.get(origId) || []).map((c: string) => 'layout::' + c);
    if (origId === childrenParentId) {
      const beforeC = layoutCode.slice(0, childrenIdx);
      let insertIdx = 0;
      for (const kidId of (origChildren.get(origId) || [])) {
        if (beforeC.includes(`data-id="${kidId}"`)) insertIdx++;
      }
      kids.splice(insertIdx, 0, ...pageSectionIds);
    }
    node.children = kids;

    node.parentId = isRoot
      ? null
      : (node.parentId === templateRootOrigId && primaryPageRootId
          ? primaryPageRootId
          : 'layout::' + node.parentId);

    merged.set(newId, node);
  }

  // Bracket the template chrome around the page sections (mirrors store.ts —
  // band-order immunity, see the merge's comment).
  {
    const slotParentNode = merged.get(childrenParentMergedId);
    if (slotParentNode) {
      for (const b of computeLayoutBrackets(slotParentNode.children)) {
        const chrome = merged.get(b.id);
        if (chrome) chrome.styles = { ...(chrome.styles ?? {}), order: String(b.order) };
      }
    }
  }

  // Reparent the page's sections onto the merged {children} parent + strip
  // their inline order (mirrors store.ts).
  for (const secId of pageSectionIds) {
    const sec = merged.get(secId);
    if (sec) {
      sec.parentId = childrenParentMergedId;
      sec.styles = { ...(sec.styles ?? {}), order: '' };
    }
  }

  return merged;
}

describe('layout merge', () => {
  const PAGE = `<div data-id="root" style={{position: 'relative', width: '100%'}}>
  <div data-id="hero" style={{width: '100%', height: '500px'}}>Hello</div>
</div>`;

  const LAYOUT = `<div data-id="layout-root" style={{display: 'flex', flexDirection: 'column', width: '100%'}}>
  <nav data-id="navbar" style={{height: '60px'}}>Nav</nav>
  {children}
  <footer data-id="footer" style={{height: '40px'}}>Foot</footer>
</div>`;

  test('the template root TAKES OVER `root` — it is the only root node', () => {
    const merged = mergeLayoutIntoPage(PAGE, LAYOUT);
    const roots = [...merged.values()].filter(n => !n.parentId);
    expect(roots.length).toBe(1);
    expect(roots[0].id).toBe('root');
  });

  test('no separate `layout::root`/`layout::layout-root` ghost layer exists', () => {
    const merged = mergeLayoutIntoPage(PAGE, LAYOUT);
    expect(merged.has('layout::layout-root')).toBe(false);
    expect(merged.has('layout::root')).toBe(false);
  });

  test('merged root carries the TEMPLATE styles (flex column), not the page-root box', () => {
    const merged = mergeLayoutIntoPage(PAGE, LAYOUT);
    const root = merged.get('root')!;
    // template root's flex column survives…
    expect(root.styles.display).toBe('flex');
    expect(root.styles.flexDirection).toBe('column');
    // …and the page root's own box (position:relative) is dropped (overwritten).
    expect(root.styles.position).toBeUndefined();
  });

  test('page SECTIONS splice into the {children} slot, between navbar and footer', () => {
    const merged = mergeLayoutIntoPage(PAGE, LAYOUT);
    const root = merged.get('root')!;
    expect(root.children).toEqual([
      'layout::navbar',
      'hero',
      'layout::footer',
    ]);
  });

  test('the merged root carries fromLayout (it IS the template root)', () => {
    const merged = mergeLayoutIntoPage(PAGE, LAYOUT);
    expect(merged.get('layout::navbar')!.fromLayout).toBe(true);
    expect(merged.get('layout::footer')!.fromLayout).toBe(true);
    expect(merged.get('root')!.fromLayout).toBe(true);
  });

  test('page sections are reparented onto the merged root (inherit its flex)', () => {
    const merged = mergeLayoutIntoPage(PAGE, LAYOUT);
    expect(merged.get('hero')!.parentId).toBe('root');
  });

  test('template chrome is BRACKETED around page sections (band-order immunity)', () => {
    // Stripping the page sections' INLINE order is not enough: a replica's
    // @media band re-applies `order: N !important` on the canvas, and chrome
    // with no order (0) tied into the 0-group — the MOBILE tile painted the
    // template footer right after the hero while desktop/tablet and the live
    // site were fine (user report 2026-07-27). Leading chrome gets a very LOW
    // order, trailing chrome a very HIGH one, so no page-side order — inline
    // or banded — can interleave.
    const merged = mergeLayoutIntoPage(PAGE, LAYOUT);
    const nav = merged.get('layout::navbar')!;
    const foot = merged.get('layout::footer')!;
    expect(parseInt(nav.styles.order!, 10)).toBeLessThanOrEqual(-100000);
    expect(parseInt(foot.styles.order!, 10)).toBeGreaterThanOrEqual(100000);
    // Page sections keep NO inline order (stripped — DOM order governs them).
    expect(merged.get('hero')!.styles.order).toBe('');
  });

  test('layout with no {children} returns page nodes unchanged', () => {
    const noSlot = `<div data-id="layout-root" style={{}}>
  <nav data-id="navbar" style={{}}>Nav</nav>
</div>`;
    const merged = mergeLayoutIntoPage(PAGE, noSlot);
    const pageRoot = merged.get('root')!;
    expect(pageRoot.parentId).toBeNull();
  });
});

// ─── isComponentInstanceInCache ─────────────────────────────────────────────

describe('isComponentInstanceInCache', () => {
  // We test this by importing and using the cache helpers directly.
  // injectNodeIntoCache populates the internal _cachedNodes map.

  // Dynamic import to avoid module-level side effects
  test('returns true for a node with componentFile', async () => {
    const { injectNodeIntoCache, isComponentInstanceInCache } = await import('./store');
    const node: CanvasNode = {
      id: 'hero-instance',
      type: 'div',
      name: 'Hero',
      parentId: 'root',
      children: [],
      styles: {},
      textContent: '',
      attrs: {},
      componentFile: 'components/Hero.tsx',
      hasMixedContent: false, order: 0, isCanvasNode: false,
      componentInstanceId: null, isComponentRoot: false,
      motionVariants: null, motionVariantsRef: null, motionProps: null,
      responsiveVariantMap: null, conditionalStyles: null,
    };
    injectNodeIntoCache(node);
    expect(isComponentInstanceInCache('hero-instance')).toBe(true);
  });

  test('returns false for a regular node without componentFile', async () => {
    const { injectNodeIntoCache, isComponentInstanceInCache } = await import('./store');
    const node: CanvasNode = {
      id: 'regular-div',
      type: 'div',
      name: '',
      parentId: 'root',
      children: [],
      styles: {},
      textContent: '',
      attrs: {},
      hasMixedContent: false, order: 0, isCanvasNode: false,
      componentFile: null, componentInstanceId: null, isComponentRoot: false,
      motionVariants: null, motionVariantsRef: null, motionProps: null,
      responsiveVariantMap: null, conditionalStyles: null,
    };
    injectNodeIntoCache(node);
    expect(isComponentInstanceInCache('regular-div')).toBe(false);
  });

  test('returns false for a non-existent node', async () => {
    const { isComponentInstanceInCache } = await import('./store');
    expect(isComponentInstanceInCache('does-not-exist-12345')).toBe(false);
  });
});

// ─── moveNodeInCache — live layers re-nest contract ─────────────────────────
// Mid-drag reparents do NOT re-derive nodesAtom (deferred-drag-flush stashes
// the setCode fan-out); LayersPanel derives from the cache and re-renders on
// nodeTreeStructureVersionAtom bumps. These pin the bump + the canvas flag.

describe('moveNodeInCache — structure version + canvas flag', () => {
  const bareNode = (id: string, parentId: string | null, isCanvasNode: boolean): CanvasNode => ({
    id, type: 'div', name: '', parentId, children: [], styles: {}, textContent: '',
    attrs: {}, hasMixedContent: false, order: 0, isCanvasNode,
    componentFile: null, componentInstanceId: null, isComponentRoot: false,
    motionVariants: null, motionVariantsRef: null, motionProps: null,
    responsiveVariantMap: null, conditionalStyles: null,
  });

  test('bumps nodeTreeStructureVersionAtom and clears isCanvasNode on entry into a frame', async () => {
    const { injectNodeIntoCache, moveNodeInCache, getCachedNodesMap, nodeTreeStructureVersionAtom } = await import('./store');
    const { getDefaultStore } = await import('jotai');
    injectNodeIntoCache(bareNode('lv-frame', null, true));
    injectNodeIntoCache(bareNode('lv-chip', null, true));
    const v0 = getDefaultStore().get(nodeTreeStructureVersionAtom);

    moveNodeInCache('lv-chip', 'lv-frame');

    expect(getDefaultStore().get(nodeTreeStructureVersionAtom)).toBe(v0 + 1);
    const chip = getCachedNodesMap().get('lv-chip')!;
    expect(chip.parentId).toBe('lv-frame');
    expect(chip.isCanvasNode).toBe(false); // a parented node is never canvas-level
    expect(getCachedNodesMap().get('lv-frame')!.children).toContain('lv-chip');
  });

  test('exit to canvas root restores isCanvasNode and bumps again', async () => {
    const { moveNodeInCache, getCachedNodesMap, nodeTreeStructureVersionAtom } = await import('./store');
    const { getDefaultStore } = await import('jotai');
    const v0 = getDefaultStore().get(nodeTreeStructureVersionAtom);

    moveNodeInCache('lv-chip', null);

    expect(getDefaultStore().get(nodeTreeStructureVersionAtom)).toBe(v0 + 1);
    const chip = getCachedNodesMap().get('lv-chip')!;
    expect(chip.parentId).toBeNull();
    expect(chip.isCanvasNode).toBe(true);
    expect(getCachedNodesMap().get('lv-frame')!.children).not.toContain('lv-chip');
  });

  // ─── Cycle guard (collection-list drag-out crash, 2026-07-29) ─────────────
  // Linking a node under itself or its own descendant creates a parentId
  // cycle that blows every recursive tree walker (DragCoordinator subtree
  // nudge, LayersPanel rows) with a stack overflow. The move must be refused.

  test('refuses to move a node under ITSELF (no bump, no change)', async () => {
    const { injectNodeIntoCache, moveNodeInCache, getCachedNodesMap, nodeTreeStructureVersionAtom } = await import('./store');
    const { getDefaultStore } = await import('jotai');
    injectNodeIntoCache(bareNode('cy-a', null, true));
    const v0 = getDefaultStore().get(nodeTreeStructureVersionAtom);

    moveNodeInCache('cy-a', 'cy-a');

    expect(getDefaultStore().get(nodeTreeStructureVersionAtom)).toBe(v0);
    expect(getCachedNodesMap().get('cy-a')!.parentId).toBeNull();
  });

  test('refuses to move a node under its own DESCENDANT', async () => {
    const { injectNodeIntoCache, moveNodeInCache, getCachedNodesMap, nodeTreeStructureVersionAtom } = await import('./store');
    const { getDefaultStore } = await import('jotai');
    // cy-parent > cy-child > cy-grandchild
    injectNodeIntoCache({ ...bareNode('cy-parent', null, true), children: ['cy-child'] });
    injectNodeIntoCache({ ...bareNode('cy-child', 'cy-parent', false), children: ['cy-grandchild'] });
    injectNodeIntoCache(bareNode('cy-grandchild', 'cy-child', false));
    const v0 = getDefaultStore().get(nodeTreeStructureVersionAtom);

    moveNodeInCache('cy-parent', 'cy-grandchild');

    expect(getDefaultStore().get(nodeTreeStructureVersionAtom)).toBe(v0);
    const parent = getCachedNodesMap().get('cy-parent')!;
    expect(parent.parentId).toBeNull();
    expect(getCachedNodesMap().get('cy-grandchild')!.children).not.toContain('cy-parent');
  });

  test('cycle walk-up terminates on an ALREADY-corrupt cache and allows a valid move', async () => {
    const { injectNodeIntoCache, moveNodeInCache, getCachedNodesMap } = await import('./store');
    // Pre-corrupt pair: cx-a ⇄ cx-b point at each other (never via moveNodeInCache).
    injectNodeIntoCache({ ...bareNode('cx-a', 'cx-b', false), children: ['cx-b'] });
    injectNodeIntoCache({ ...bareNode('cx-b', 'cx-a', false), children: ['cx-a'] });
    injectNodeIntoCache(bareNode('cx-free', null, true));

    // Moving an unrelated node under the corrupt pair must not hang.
    moveNodeInCache('cx-free', 'cx-a');

    expect(getCachedNodesMap().get('cx-free')!.parentId).toBe('cx-a');
  });
});

describe('getVariantOverriddenKeys', () => {
  test('includes variants-object keys (paint props)', async () => {
    const { injectNodeIntoCache, getVariantOverriddenKeys } = await import('./store');
    const node: CanvasNode = {
      id: 'n1', type: 'div', name: '', parentId: 'root', children: [], styles: {}, textContent: '', attrs: {},
      motionVariants: { 'variant-2': { backgroundColor: '#ed3827' } },
    } as any;
    injectNodeIntoCache(node);
    expect(getVariantOverriddenKeys('n1', 'variant-2')).toEqual(new Set(['backgroundColor']));
  });

  test('includes conditional-style (inline ternary) props ONLY for variants with an explicit branch', async () => {
    const { injectNodeIntoCache, getVariantOverriddenKeys } = await import('./store');
    // Root's per-variant SIZE lives as a ternary → conditionalStyles { width: { variant-2, default } }.
    const node: CanvasNode = {
      id: 'n2', type: 'div', name: '', parentId: 'root', children: [], styles: {}, textContent: '', attrs: {},
      conditionalStyles: { width: { 'variant-2': '400px', default: '594px' } },
    } as any;
    injectNodeIntoCache(node);
    // variant-2 has its OWN width branch → overridden (must NOT mirror the primary resize).
    expect(getVariantOverriddenKeys('n2', 'variant-2')).toEqual(new Set(['width']));
    // variant-1 falls through to `default` → NOT overridden → mirrors the primary.
    expect(getVariantOverriddenKeys('n2', 'variant-1')).toBeNull();
  });

  test('merges variants-object + conditional-style overrides', async () => {
    const { injectNodeIntoCache, getVariantOverriddenKeys } = await import('./store');
    const node: CanvasNode = {
      id: 'n3', type: 'div', name: '', parentId: 'root', children: [], styles: {}, textContent: '', attrs: {},
      motionVariants: { 'variant-2': { backgroundColor: 'red' } },
      conditionalStyles: { width: { 'variant-2': '400px', default: '594px' } },
    } as any;
    injectNodeIntoCache(node);
    expect(getVariantOverriddenKeys('n3', 'variant-2')).toEqual(new Set(['backgroundColor', 'width']));
  });

  test('returns null for a node with no overrides', async () => {
    const { injectNodeIntoCache, getVariantOverriddenKeys } = await import('./store');
    const node: CanvasNode = {
      id: 'n4', type: 'div', name: '', parentId: 'root', children: [], styles: {}, textContent: '', attrs: {},
    } as any;
    injectNodeIntoCache(node);
    expect(getVariantOverriddenKeys('n4', 'variant-1')).toBeNull();
  });
});

describe('getVariantOverriddenKeys — position props own the transform (svg group children)', () => {
  it('a variant with x/y deltas reports transform as overridden', async () => {
    const { injectNodeIntoCache, getVariantOverriddenKeys } = await import('./store');
    injectNodeIntoCache({
      id: 'shape-vt', type: 'svg', parentId: 'group-vt', children: [], styles: {},
      attrs: { x: '298', y: '0' },
      motionVariants: { default: { x: '0', y: '0' }, 'variant-1': { x: '-163', y: '202' } },
    } as any);
    const keys = getVariantOverriddenKeys('shape-vt', 'variant-1')!;
    expect(keys.has('transform')).toBe(true);
    expect(keys.has('x')).toBe(true);
    // The default entry carries neutral deltas — still position-owning.
    expect(getVariantOverriddenKeys('shape-vt', 'default')!.has('transform')).toBe(true);
  });

  it('legacy attrX/attrY absolutes also own the transform; empty strings do not', async () => {
    const { injectNodeIntoCache, getVariantOverriddenKeys } = await import('./store');
    injectNodeIntoCache({
      id: 'shape-legacy', type: 'svg', parentId: 'group-vt', children: [], styles: {},
      motionVariants: { 'variant-1': { attrX: '-58', attrY: '110' }, 'variant-2': { attrX: '', attrY: '' } },
    } as any);
    expect(getVariantOverriddenKeys('shape-legacy', 'variant-1')!.has('transform')).toBe(true);
    expect(getVariantOverriddenKeys('shape-legacy', 'variant-2')?.has('transform') ?? false).toBe(false);
  });

  it('paint-only variants do NOT own the transform', async () => {
    const { injectNodeIntoCache, getVariantOverriddenKeys } = await import('./store');
    injectNodeIntoCache({
      id: 'shape-paint', type: 'svg', parentId: 'group-vt', children: [], styles: {},
      motionVariants: { 'variant-1': { backgroundColor: '#ff0000' } },
    } as any);
    expect(getVariantOverriddenKeys('shape-paint', 'variant-1')!.has('transform')).toBe(false);
  });
});

// ─── nodesAtom identity preservation across re-parses ───────────────────────
// A fresh parse emits all-new node objects; preserveNodeIdentities swaps each
// unchanged node back to its previous-generation object so ref-equality
// consumers (selectAtom per-node subscriptions, React.memo, useMemo deps) can
// skip commits that didn't touch their node. When NOTHING changed, the whole
// previous Map instance is returned so jotai skips notifying dependents.
describe('nodesAtom — identity preservation across re-parses', () => {
  const PAGE = (leftPx: number) => `'use client';
export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{ position: 'relative' }}>
      <div data-id="keep-1" data-name="Keep" style={{ position: 'relative', width: '100px' }}>
        <p data-id="keep-text" data-name="Text" style={{ position: 'relative', fontSize: '16px' }}>hello</p>
      </div>
      <div data-id="change-1" data-name="Change" style={{ position: 'relative', left: '${leftPx}px' }}></div>
    </div>
  );
}`;

  it('unchanged nodes keep identity; the edited node gets a new ref', async () => {
    const { getDefaultStore } = await import('jotai');
    const { nodesAtom, codeAtom } = await import('./store');
    const store = getDefaultStore();

    store.set(codeAtom, PAGE(10));
    const mapA = store.get(nodesAtom);
    expect(mapA.get('change-1')?.styles.left).toBe('10px');

    store.set(codeAtom, PAGE(99));
    const mapB = store.get(nodesAtom);

    // Map identity changed (a node DID change) …
    expect(mapB).not.toBe(mapA);
    // … the edited node is a fresh object with the new value …
    expect(mapB.get('change-1')?.styles.left).toBe('99px');
    expect(mapB.get('change-1')).not.toBe(mapA.get('change-1'));
    // … and every untouched node keeps its previous-generation identity.
    expect(mapB.get('keep-1')).toBe(mapA.get('keep-1'));
    expect(mapB.get('keep-text')).toBe(mapA.get('keep-text'));
    expect(mapB.get('root')).toBe(mapA.get('root'));
  });

  it('a code change that parses identically returns the SAME Map instance (zero fan-out)', async () => {
    const { getDefaultStore } = await import('jotai');
    const { nodesAtom, codeAtom } = await import('./store');
    const store = getDefaultStore();

    store.set(codeAtom, PAGE(42));
    const mapA = store.get(nodesAtom);

    // Trailing newline: different code string (memo miss → full re-parse) but
    // byte-identical parse output → all nodes preserved → same Map identity,
    // so jotai's Object.is check skips notifying every nodesAtom dependent.
    store.set(codeAtom, PAGE(42) + '\n');
    const mapB = store.get(nodesAtom);
    expect(mapB).toBe(mapA);
  });
});
