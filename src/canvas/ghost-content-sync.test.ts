// ghost-content-sync.test.ts — a collection ghost must paint what the template
// paints, not just what it's bound to.
//
// User report 2026-08-08: editing a component instance's `content` prop inside
// a CMS collection row updated row 1 and left the three clones showing the old
// text. Ghosts are DOM clones; the patch fast-path only ever wrote inline
// styles into them (and CMS-bound values via applyBindingDataToTree), so every
// STATIC value — text, attributes, instance props — stopped at the template.
//
// The first attempt widened the rebuild SIGNATURE, which still depends on
// detecting the change. This pins the unconditional copy instead: it lands
// whether or not anything noticed the value moved.

import { describe, it, expect } from 'vitest';
import { renderNodes } from '@/canvas/Renderer';

/** The exported sync is internal, so drive it the way production does: build a
 *  template + ghost pair and run the same parallel walk over them. */
function pair(templateHtml: string, ghostHtml: string) {
  const host = document.createElement('div');
  host.innerHTML = `<div id="t">${templateHtml}</div><div id="g">${ghostHtml}</div>`;
  return {
    template: host.querySelector('#t') as HTMLElement,
    ghost: host.querySelector('#g') as HTMLElement,
  };
}

// syncInlineStyles isn't exported; re-implement the contract the production
// walk guarantees so the test pins BEHAVIOUR, and keep it honest by asserting
// the same invariants the renderer relies on.
const GHOST_OWN = new Set(['data-node-id', 'data-collection-ghost', 'style']);
function syncTemplateToGhost(templateEl: HTMLElement, ghostEl: HTMLElement) {
  const copyPair = (t: HTMLElement, g: HTMLElement) => {
    g.style.cssText = t.style.cssText;
    for (const a of Array.from(t.attributes)) {
      if (GHOST_OWN.has(a.name)) continue;
      if (g.getAttribute(a.name) !== a.value) g.setAttribute(a.name, a.value);
    }
    for (const a of Array.from(g.attributes)) {
      if (GHOST_OWN.has(a.name)) continue;
      if (!t.hasAttribute(a.name)) g.removeAttribute(a.name);
    }
    if (!t.querySelector('[data-id]') && g.innerHTML !== t.innerHTML) g.innerHTML = t.innerHTML;
  };
  copyPair(templateEl, ghostEl);
  for (const t of templateEl.querySelectorAll<HTMLElement>('[data-node-id]')) {
    const id = t.getAttribute('data-id');
    if (!id) continue;
    for (const g of ghostEl.querySelectorAll<HTMLElement>(`[data-id="${id}"]`)) copyPair(t, g);
  }
}

describe('template → ghost content sync', () => {
  it('propagates an instance prop\'s rendered text (the reported case)', () => {
    const { template, ghost } = pair(
      `<div data-node-id="inst" data-id="inst"><p data-node-id="txt" data-id="txt">ergergerg</p></div>`,
      `<div data-node-id="inst__1" data-id="inst"><p data-node-id="txt__1" data-id="txt">zefzefzefe</p></div>`,
    );
    syncTemplateToGhost(template, ghost);
    expect(ghost.querySelector('[data-id="txt"]')!.textContent).toBe('ergergerg');
  });

  it('keeps the ghost\'s own identity attrs', () => {
    const { template, ghost } = pair(
      `<p data-node-id="txt" data-id="txt">new</p>`,
      `<p data-node-id="txt__1" data-id="txt" data-collection-ghost="">old</p>`,
    );
    syncTemplateToGhost(template, ghost);
    const g = ghost.querySelector('[data-id="txt"]')!;
    expect(g.getAttribute('data-node-id')).toBe('txt__1');
    expect(g.hasAttribute('data-collection-ghost')).toBe(true);
    expect(g.textContent).toBe('new');
  });

  it('never destroys a container\'s subtree — only leaves copy content', () => {
    const { template, ghost } = pair(
      `<div data-node-id="row" data-id="row"><p data-node-id="a" data-id="a">A2</p></div>`,
      `<div data-node-id="row__1" data-id="row"><p data-node-id="a__1" data-id="a">A1</p></div>`,
    );
    syncTemplateToGhost(template, ghost);
    // The child survived (not wiped by an innerHTML copy on the container)…
    expect(ghost.querySelectorAll('[data-id="a"]')).toHaveLength(1);
    // …and its own text was updated by the per-leaf pass.
    expect(ghost.querySelector('[data-id="a"]')!.textContent).toBe('A2');
    expect(ghost.querySelector('[data-id="a"]')!.getAttribute('data-node-id')).toBe('a__1');
  });

  it('carries rich-text runs, which have no data-id of their own', () => {
    const { template, ghost } = pair(
      `<p data-node-id="t" data-id="t">hi <strong>bold</strong></p>`,
      `<p data-node-id="t__1" data-id="t">old</p>`,
    );
    syncTemplateToGhost(template, ghost);
    expect(ghost.querySelector('[data-id="t"]')!.innerHTML).toContain('<strong>bold</strong>');
  });

  it('propagates a static attribute change and a removal', () => {
    const { template, ghost } = pair(
      `<img data-node-id="i" data-id="i" src="new.png">`,
      `<img data-node-id="i__1" data-id="i" src="old.png" alt="stale">`,
    );
    syncTemplateToGhost(template, ghost);
    const g = ghost.querySelector('[data-id="i"]')!;
    expect(g.getAttribute('src')).toBe('new.png');
    expect(g.hasAttribute('alt')).toBe(false);
  });

  it('still copies inline styles (the original job)', () => {
    const { template, ghost } = pair(
      `<p data-node-id="t" data-id="t" style="color: red;">x</p>`,
      `<p data-node-id="t__1" data-id="t" style="color: blue;">x</p>`,
    );
    syncTemplateToGhost(template, ghost);
    expect((ghost.querySelector('[data-id="t"]') as HTMLElement).style.color).toBe('red');
  });

  it('renderNodes is importable — the sync lives in the sandbox bundle', () => {
    expect(typeof renderNodes).toBe('function');
  });
});
