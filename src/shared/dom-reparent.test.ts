import { describe, it, expect, beforeEach } from 'vitest';
import { reparentChildAtIndex, reprefixDataNodeId } from './dom-reparent';

// Backs the sandbox's imperative-first drag-in (reparentLive): move an element
// into a layout parent at the line-indicator index + renumber CSS order so it
// slots exactly where the line was, with no jump when the re-render lands.

const node = (id: string): HTMLElement => {
  const el = document.createElement('div');
  el.setAttribute('data-node-id', id);
  el.setAttribute('data-id', id);
  return el;
};
const ids = (parent: HTMLElement) =>
  Array.from(parent.children)
    .filter((c): c is HTMLElement => c instanceof HTMLElement && c.hasAttribute('data-node-id'))
    .map((c) => c.getAttribute('data-node-id'));
const orders = (parent: HTMLElement) =>
  Array.from(parent.children)
    .filter((c): c is HTMLElement => c instanceof HTMLElement)
    .map((c) => c.style.order);

describe('reparentChildAtIndex', () => {
  let parent: HTMLElement;
  let dragged: HTMLElement;

  beforeEach(() => {
    parent = document.createElement('div');
    parent.appendChild(node('a'));
    parent.appendChild(node('b'));
    dragged = node('x'); // currently OUTSIDE the parent (drag-in from canvas)
  });

  it('inserts the element at the requested index (a, x, b)', () => {
    reparentChildAtIndex(parent, dragged, 1);
    expect(ids(parent)).toEqual(['a', 'x', 'b']);
  });

  it('renumbers CSS order to match DOM order', () => {
    reparentChildAtIndex(parent, dragged, 1);
    expect(orders(parent)).toEqual(['0', '1', '2']);
  });

  it('appends when index is past the end', () => {
    reparentChildAtIndex(parent, dragged, 5);
    expect(ids(parent)).toEqual(['a', 'b', 'x']);
    expect(orders(parent)).toEqual(['0', '1', '2']);
  });

  it('inserts at the front for index 0', () => {
    reparentChildAtIndex(parent, dragged, 0);
    expect(ids(parent)).toEqual(['x', 'a', 'b']);
  });

  it('ignores non-node children when counting the index', () => {
    const placeholder = document.createElement('div'); // no data-node-id
    parent.insertBefore(placeholder, parent.firstChild);
    reparentChildAtIndex(parent, dragged, 1); // index among NODE children → between a and b
    expect(ids(parent)).toEqual(['a', 'x', 'b']);
  });

  it('is a no-op-safe correction when the element is already at the index', () => {
    parent.appendChild(dragged); // already inside: a, b, x
    reparentChildAtIndex(parent, dragged, 2);
    expect(ids(parent)).toEqual(['a', 'b', 'x']);
    expect(orders(parent)).toEqual(['0', '1', '2']);
  });

  // Mid-drag ABSOLUTE entry (canvas node → frame): the element has no layout
  // slot, and sibling CSS `order` may be code-driven (variant/conditional
  // reorders) — renumbering would clobber it with DOM-only values that stick
  // until the next unlocked render.
  it('index -1 appends WITHOUT renumbering sibling CSS order (absolute entry)', () => {
    (parent.children[0] as HTMLElement).style.order = '3'; // code-driven order on `a`
    reparentChildAtIndex(parent, dragged, -1);
    expect(ids(parent)).toEqual(['a', 'b', 'x']);
    expect(orders(parent)).toEqual(['3', '', '']); // untouched
  });

  it('index -1 leaves an existing child of the parent where it is', () => {
    parent.appendChild(dragged); // a, b, x
    reparentChildAtIndex(parent, dragged, -1);
    expect(ids(parent)).toEqual(['a', 'b', 'x']);
    expect(orders(parent)).toEqual(['', '', '']);
  });
});

describe('reprefixDataNodeId', () => {
  it('prefixes a primary node (empty prefix) into a replica', () => {
    const el = node('frame-1');
    reprefixDataNodeId(el, '', 'tablet-');
    expect(el.getAttribute('data-node-id')).toBe('tablet-frame-1');
    expect(el.getAttribute('data-id')).toBe('frame-1'); // data-id untouched
  });

  it('rewrites descendants that carry data-node-id, leaves others', () => {
    const el = node('frame-1');
    const child = node('child-1');
    const plain = document.createElement('span'); // no data-node-id
    el.appendChild(child);
    el.appendChild(plain);
    reprefixDataNodeId(el, '', 'mobile-');
    expect(el.getAttribute('data-node-id')).toBe('mobile-frame-1');
    expect(child.getAttribute('data-node-id')).toBe('mobile-child-1');
    expect(plain.hasAttribute('data-node-id')).toBe(false);
  });

  it('swaps one replica prefix for another (not just empty)', () => {
    const el = node('x');
    el.setAttribute('data-node-id', 'tablet-x');
    reprefixDataNodeId(el, 'tablet-', 'mobile-');
    expect(el.getAttribute('data-node-id')).toBe('mobile-x');
  });
});

// ─── The template `{children}` slot as an UNWRITABLE ANCHOR ─────────────────
// The commit path (computeReorderAssignments) never writes an order to the
// slot — it's a JSX expression pinned at the CSS default 0, with real siblings
// numbered relative to it. The preview renumber here must MATCH, or its
// imperative stamp on the slot element (never overwritten by any commit,
// ignored by the patch stale-clear) shoves the slot after the dropped node:
// drop BELOW the placeholder, node lands ABOVE it (user report 2026-07-27).
describe('reparentChildAtIndex — children-slot anchor semantics', () => {
  let parent: HTMLElement;
  let dragged: HTMLElement;

  beforeEach(() => {
    parent = document.createElement('div');
    parent.appendChild(node('KaFiBi-1'));
    parent.appendChild(node('children-slot'));
    parent.appendChild(node('KaPoJo-3'));
    dragged = node('frame-4');
  });

  it('dropping BELOW the slot: slot keeps NO inline order, siblings relative', () => {
    reparentChildAtIndex(parent, dragged, 2);   // after the slot
    expect(ids(parent)).toEqual(['KaFiBi-1', 'children-slot', 'frame-4', 'KaPoJo-3']);
    // Anchor at index 1 → header -1, slot '', dragged 1, footer 2 — the exact
    // values the commit writes, so the re-render lands with no jump AND no
    // leftover stamp on the slot.
    expect(orders(parent)).toEqual(['-1', '', '1', '2']);
  });

  it('dropping ABOVE the slot mirrors the negative side', () => {
    reparentChildAtIndex(parent, dragged, 1);   // before the slot
    expect(ids(parent)).toEqual(['KaFiBi-1', 'frame-4', 'children-slot', 'KaPoJo-3']);
    expect(orders(parent)).toEqual(['-2', '-1', '', '1']);
  });

  it('a PREFIXED slot (replica viewport) is recognised as the anchor too', () => {
    parent.innerHTML = '';
    parent.appendChild(node('tablet-KaFiBi-1'));
    parent.appendChild(node('tablet-children-slot'));
    reparentChildAtIndex(parent, node('tablet-frame-4'), 2);
    expect(orders(parent)).toEqual(['-1', '', '1']);
  });

  it('clears a STALE imperative order off the slot from a previous buggy drag', () => {
    (parent.children[1] as HTMLElement).style.order = '2';   // the old bug's residue
    reparentChildAtIndex(parent, dragged, 2);
    expect(orders(parent)[1]).toBe('');
  });

  it('no slot → plain sequential numbering (page behaviour unchanged)', () => {
    parent.innerHTML = '';
    parent.appendChild(node('a'));
    parent.appendChild(node('b'));
    reparentChildAtIndex(parent, dragged, 1);
    expect(orders(parent)).toEqual(['0', '1', '2']);
  });
});
