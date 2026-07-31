// @vitest-environment jsdom
// Drag-locked nodes vs STALE mid-drag renders. During a drag,
// canvasInteracting blocks nodesAtom re-derivation, so a mid-drag
// forceRender can carry a PRE-ENTRY snapshot: the entered node is still a
// canvasRoot and is missing from its new parent's childIds. The renderer
// must not undo the strategy's imperative reparentLive placement —
// patchChildElements' removal sweep keeps locked extras, and
// patchCanvasNodes' build branch must not resurrect a locked node at the
// container root (the "glitches out and offsets on reparent" bug).
import { describe, it, expect, beforeEach } from 'vitest';

import { parseJSXToNodes } from '@/code/parsing/parser';
import { renderNodes, setRendererDragLockedNodeIds, clearPatchKeyChain } from '@/canvas/Renderer';

// Pre-entry source: frame + chip are BOTH canvas roots (the stale snapshot).
const PRE_ENTRY = `
export default function Page() {
  return (
    <div data-id="root" style={{ position: 'relative', width: '100%' }}></div>
  );
}
const canvasNodes = (<>
  <div data-id="frame" data-canvas-node="true" style={{ position: 'absolute', left: '100px', top: '100px', width: '400px', height: '300px' }}></div>
  <div data-id="chip" data-canvas-node="true" style={{ position: 'absolute', left: '600px', top: '100px', width: '90px', height: '90px' }}></div>
</>);`;

// Post-entry source: chip committed INSIDE the frame.
const POST_ENTRY = `
export default function Page() {
  return (
    <div data-id="root" style={{ position: 'relative', width: '100%' }}></div>
  );
}
const canvasNodes = (<>
  <div data-id="frame" data-canvas-node="true" style={{ position: 'absolute', left: '100px', top: '100px', width: '400px', height: '300px' }}>
    <div data-id="chip" style={{ position: 'absolute', left: '155px', top: '105px', width: '90px', height: '90px' }}></div>
  </div>
</>);`;

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

describe('drag-locked nodes survive stale mid-drag renders', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    setRendererDragLockedNodeIds(new Set());
  });

  it('a locked node moved into a frame imperatively is neither stripped nor rebuilt at root by a stale render', () => {
    const container = setup();
    renderNodes(container, parseJSXToNodes(PRE_ENTRY), null, () => {}, viewports, PRE_ENTRY);
    const frameEl = container.querySelector('[data-id="frame"]') as HTMLElement;
    const chipEl = container.querySelector('[data-id="chip"]') as HTMLElement;
    expect(frameEl.parentElement).toBe(container);
    expect(chipEl.parentElement).toBe(container);

    // Mid-drag entry: strategy locks the chip and reparentLive moves its
    // element into the frame with parent-local styles.
    setRendererDragLockedNodeIds(new Set(['chip']));
    frameEl.appendChild(chipEl);
    chipEl.style.left = '155px';
    chipEl.style.top = '105px';
    // reparentLive's applyTwoPass invalidates the patch-key chain — mirror it
    // so the stale render actually re-patches the frame subtree (otherwise
    // the subtree-sig skip would bypass the removal sweep trivially).
    clearPatchKeyChain(chipEl);

    // STALE render (pre-entry snapshot): chip still a canvasRoot, frame has
    // no children. Must leave the imperative placement intact.
    renderNodes(container, parseJSXToNodes(PRE_ENTRY), null, () => {}, viewports, PRE_ENTRY);
    const chips = container.querySelectorAll('[data-id="chip"]');
    expect(chips.length).toBe(1);
    expect((chips[0] as HTMLElement).parentElement).toBe(container.querySelector('[data-id="frame"]'));

    // Post-drop: locks release, the committed source re-renders — chip stays
    // a single element inside the frame.
    setRendererDragLockedNodeIds(new Set());
    renderNodes(container, parseJSXToNodes(POST_ENTRY), null, () => {}, viewports, POST_ENTRY);
    const healed = container.querySelectorAll('[data-id="chip"]');
    expect(healed.length).toBe(1);
    expect((healed[0] as HTMLElement).parentElement).toBe(container.querySelector('[data-id="frame"]'));
  });

  it('an unlocked extra child IS still removed by the sweep (no behavior change without locks)', () => {
    const container = setup();
    renderNodes(container, parseJSXToNodes(PRE_ENTRY), null, () => {}, viewports, PRE_ENTRY);
    const frameEl = container.querySelector('[data-id="frame"]') as HTMLElement;
    // A rogue unlocked element inside the frame (not in childIds) gets cleaned.
    const rogue = document.createElement('div');
    rogue.setAttribute('data-node-id', 'ghost');
    rogue.setAttribute('data-id', 'ghost');
    frameEl.appendChild(rogue);
    clearPatchKeyChain(rogue); // force the frame subtree to re-patch
    renderNodes(container, parseJSXToNodes(PRE_ENTRY), null, () => {}, viewports, PRE_ENTRY);
    expect(container.querySelector('[data-id="ghost"]')).toBeNull();
  });
});
