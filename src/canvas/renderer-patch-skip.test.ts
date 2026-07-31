// @vitest-environment jsdom
// Subtree patch-skip: renderNodes stores a content signature per element and
// skips whole unchanged subtrees on the next render. Undo / drag-commit /
// single-style edits then cost only the changed branch — not a full
// N-nodes × viewports patch pass (live find 2026-07-17: ~200ms renderNodes
// per Cmd+Z on an 800-node page).
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/code/project/project-fs', () => ({
  projectFS: {
    readFile: () => '', listFiles: () => [], exists: () => false,
    writeFile: () => {}, deleteFile: () => {},
  },
}));

import { parseJSXToNodes } from '@/code/parsing/parser';
import { renderNodes, clearPatchKeyChain } from '@/canvas/Renderer';

const page = (color: string) => `
export default function Page() {
  return (
    <div data-id="root" style={{ position: 'relative', width: '100%' }}>
      <div data-id="section" style={{ position: 'relative', width: '100%', display: 'flex', flexDirection: 'column' }}>
        <p data-id="label" style={{ position: 'relative', margin: '0px', color: '${color}' }}>Hello</p>
      </div>
    </div>
  );
}`;

const viewports = [{ id: 'desktop', width: 1440, x: 0, y: 0, isPrimary: true }] as any;

function setup() {
  (globalThis as any).CSS = (globalThis as any).CSS ?? {};
  (globalThis as any).CSS.escape = (globalThis as any).CSS.escape ?? ((s: string) => s.replace(/[^a-zA-Z0-9_-]/g, (c: string) => `\\${c}`));
  document.body.innerHTML = '';
  const container = document.createElement('div');
  container.setAttribute('data-content-root', 'true');
  document.body.appendChild(container);
  return container;
}

describe('renderNodes canvas-perf containment', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('injects the containment stylesheet once (tiles + top-level sections)', () => {
    const container = setup();
    const src = page('#111111');
    renderNodes(container, parseJSXToNodes(src), null, () => {}, viewports, src);
    renderNodes(container, parseJSXToNodes(src), null, () => {}, viewports, src);
    const perfEls = container.querySelectorAll('[data-canvas-perf]');
    expect(perfEls.length).toBe(1);
    const css = perfEls[0].textContent || '';
    expect(css).toContain('[data-viewport] { contain: layout style; }');
    expect(css).toContain('[data-viewport] > [data-node-id] { contain: layout style; }');
  });
});

describe('renderNodes subtree patch-skip', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('skips an unchanged subtree on the next render (DOM edits survive)', () => {
    const container = setup();
    const src = page('#111111');
    // Render 1 BUILDS elements; render 2 patches and stores the signatures.
    renderNodes(container, parseJSXToNodes(src), null, () => {}, viewports, src);
    renderNodes(container, parseJSXToNodes(src), null, () => {}, viewports, src);
    const label = container.querySelector('[data-node-id="label"]') as HTMLElement;
    expect(label.textContent).toBe('Hello');

    // Simulate DOM divergence WITHOUT invalidating the key: the next render
    // of identical content must skip the subtree and leave this untouched.
    label.textContent = 'HACK';
    renderNodes(container, parseJSXToNodes(src), null, () => {}, viewports, src);
    expect((container.querySelector('[data-node-id="label"]') as HTMLElement).textContent).toBe('HACK');
  });

  it('re-patches when the node content changes', () => {
    const container = setup();
    const src = page('#111111');
    renderNodes(container, parseJSXToNodes(src), null, () => {}, viewports, src);
    renderNodes(container, parseJSXToNodes(src), null, () => {}, viewports, src);
    const label = container.querySelector('[data-node-id="label"]') as HTMLElement;
    label.textContent = 'HACK';

    const changed = page('#ff0000');
    renderNodes(container, parseJSXToNodes(changed), null, () => {}, viewports, changed);
    const after = container.querySelector('[data-node-id="label"]') as HTMLElement;
    expect(after.textContent).toBe('Hello');
    expect(after.style.color).toBe('rgb(255, 0, 0)');
  });

  it('clearPatchKeyChain forces a re-patch through skipped ancestors', () => {
    const container = setup();
    const src = page('#111111');
    renderNodes(container, parseJSXToNodes(src), null, () => {}, viewports, src);
    renderNodes(container, parseJSXToNodes(src), null, () => {}, viewports, src);
    const label = container.querySelector('[data-node-id="label"]') as HTMLElement;
    label.textContent = 'HACK';

    // Imperative-write contract: invalidate the chain, then an
    // identical-content render must restore the branch.
    clearPatchKeyChain(label);
    renderNodes(container, parseJSXToNodes(src), null, () => {}, viewports, src);
    expect((container.querySelector('[data-node-id="label"]') as HTMLElement).textContent).toBe('Hello');
  });
});
