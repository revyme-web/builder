import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), dom: vi.fn(), error: vi.fn() },
}));

// `seedNodesForCode(code)` means "derive the node map FOR THIS CODE and put it
// in the imperative cache" — it is how every canvas-first path (undo/redo
// restore, mid-drag clone extraction) gets a map for code that codeAtom does
// not have yet. During those windows the code is committed ONLY to the mutation
// queue's `currentCode`: `projectFS` is written by `activeCodeAtom`'s setter,
// which the deferred-drag-flush stash skips for the whole gesture.
//
// So the seed MUST parse the string it is handed. It used to hand that string
// to the single-file parser but silently ignore it on any project containing
// `components/` or `icons/` files — that branch re-read projectFS instead. The
// seeded map then described the file as it was BEFORE the commit, which is how
// a mid-drag clone extraction ended up with a map that lacked the very node the
// committed code declares (user trace 2026-08-04: seed produced 19 nodes and
// `canvas:force-render-skip-cache-lag` fired in the same millisecond reporting
// mapSize 19 with the clone id missing → the forced render was skipped and the
// dragged element stayed unmounted until mouseup).
describe('seedNodesForCode — parses the code it is given', () => {
  const PAGE_BEFORE = `'use client';
export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{ position: 'relative' }}>
      <div data-id="src-1" data-name="Card" style={{ position: 'absolute' }}></div>
    </div>
  );
}`;

  // What a clone extraction commits: a NEW node in the module-scope
  // `canvasNodes` fragment, present in the queue's code but not yet in projectFS.
  const PAGE_AFTER = `'use client';
const canvasNodes = <>
  <div data-id="detach-clone-1" data-name="Card" style={{ position: 'absolute', left: '10px', top: '20px' }}></div>
</>;
export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{ position: 'relative' }}>
      <div data-id="src-1" data-name="Card" style={{ position: 'absolute' }}></div>
    </div>
  );
}`;

  async function setup(withComponentsDir: boolean) {
    const { projectFS } = await import('@/code/project/project-fs');
    const files: Record<string, string> = {
      'app/page.client.tsx': PAGE_BEFORE,
      'app/layout.tsx': 'export default function Layout({ children }) { return <html><body>{children}</body></html>; }',
    };
    // A `components/*.tsx` file is what flips deriveAndCacheNodes onto the
    // PROJECT parser — the branch that used to drop the passed-in code. Real
    // projects almost always have one, which is why this was reproducible.
    if (withComponentsDir) {
      files['components/NuUxLi.tsx'] = `export default function NuUxLi() { return <div data-id="c-1" />; }`;
    }
    projectFS.loadSnapshot(new Map(Object.entries(files)));
    const { getDefaultStore } = await import('jotai');
    const { activeFilePathAtom } = await import('@/code/project/active-file-store');
    getDefaultStore().set(activeFilePathAtom, 'app/page.client.tsx');
  }

  beforeEach(() => { vi.resetModules(); });

  it('includes a canvas node that only the passed code declares (single-file project)', async () => {
    await setup(false);
    const { seedNodesForCode } = await import('./store');
    const nodes = seedNodesForCode(PAGE_AFTER);
    expect(nodes.has('detach-clone-1')).toBe(true);
  });

  // THE REGRESSION. Identical to the case above except the project has a
  // components/ directory, which routes the derive through the project parser.
  it('includes it on a project WITH components/ too — projectFS still holds the pre-commit file', async () => {
    await setup(true);
    const { seedNodesForCode } = await import('./store');
    const { projectFS } = await import('@/code/project/project-fs');

    const nodes = seedNodesForCode(PAGE_AFTER);

    // Precondition: projectFS is deliberately still on the OLD code — that is
    // the mid-gesture state the seed exists to paper over.
    expect(projectFS.readFile('app/page.client.tsx')).toBe(PAGE_BEFORE);
    expect(nodes.has('detach-clone-1')).toBe(true);
  });

  it('still resolves component instances from projectFS (the override is main-file only)', async () => {
    await setup(true);
    const { seedNodesForCode } = await import('./store');
    // The override replaces the ACTIVE file's source; sub-components must keep
    // coming from the file system, or every instance would parse as an empty
    // shell. Sanity-check the parse still succeeds and returns the page tree.
    const nodes = seedNodesForCode(PAGE_AFTER);
    expect(nodes.has('root')).toBe(true);
    expect(nodes.has('src-1')).toBe(true);
  });

  // The seam-to-guard chain, end to end — this is the decision that was
  // freezing the drag. Canvas.tsx's forced render asks
  // `shouldSkipLaggingForcedRender(committedCode, mapItIsAboutToShip)` and
  // VETOES the whole render when the map lacks an id the code declares. With
  // the seed returning the pre-commit tree, the answer was always "skip", so
  // the clone's element was never built and the dragged node sat frozen until
  // mouseup. Note the guard itself is NOT the bug and is deliberately left
  // alone: relaxing it would let the render through carrying that same
  // clone-less map, which rebuilds the canvas WITHOUT the element — the guard
  // was reporting a real defect, not inventing one.
  it('makes the forced-render integrity guard pass instead of vetoing the render', async () => {
    await setup(true);
    const { seedNodesForCode } = await import('./store');
    const { shouldSkipLaggingForcedRender } = await import('@/canvas/render-integrity');

    // Pre-fix behaviour, reproduced with the stale map the seed used to return:
    // the guard vetoes because the clone is missing.
    const staleMap = seedNodesForCode(PAGE_BEFORE);
    expect(shouldSkipLaggingForcedRender(PAGE_AFTER, staleMap)).toBe(true);

    // What the exit path actually does now: seed from the COMMITTED code.
    const seeded = seedNodesForCode(PAGE_AFTER);
    expect(shouldSkipLaggingForcedRender(PAGE_AFTER, seeded)).toBe(false);
  });
});
