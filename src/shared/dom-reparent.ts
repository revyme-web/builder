// dom-reparent.ts — pure DOM helper for the sandbox's imperative-first reparent
// (CanvasBridge.reparentLive). Kept dependency-free so it's shared by the sandbox
// bundle AND unit-tested in jsdom.

/** A parent's "node children" — direct children carrying a `data-node-id`
 *  (skips placeholders, text nodes, ghost wrappers, etc.). */
function nodeChildren(parent: Element): HTMLElement[] {
  return Array.from(parent.children).filter(
    (c): c is HTMLElement => c instanceof HTMLElement && c.hasAttribute('data-node-id'),
  );
}

/**
 * Move `el` to be the node-child at `index` of `parent`, then renumber every
 * node-child's CSS `order` to match the resulting DOM order. The order renumber
 * mirrors what the `move` commit's `computeLayoutInsertOrderUpdates` writes, so
 * when the async re-render lands there's no visual jump.
 *
 * Pure DOM, no side effects beyond `parent`/`el`. Safe to call when `el` is
 * already a child of `parent` (used for in-layout corrections too).
 *
 * `index < 0` = ABSOLUTE-entry mode: plain append, NO order renumber.
 * Absolutely-positioned children occupy no layout slot, and renumbering would
 * clobber code-driven CSS `order` on siblings (variant/conditional reorders)
 * with DOM-only values that survive until the next unlocked render.
 */
export function reparentChildAtIndex(parent: HTMLElement, el: HTMLElement, index: number): void {
  if (index < 0) {
    if (el.parentElement !== parent) parent.appendChild(el);
    return;
  }
  const before = nodeChildren(parent)[index] ?? null;
  if (before !== el) {
    if (before) parent.insertBefore(el, before);
    else parent.appendChild(el);
  }
  // Re-read AFTER the move (indices shifted) and assign order matching the
  // resulting DOM order — with the SAME anchor semantics the commit uses
  // (computeReorderAssignments). The `{children}` slot is a JSX expression:
  // the commit never writes an order to it (unwritable — it stays at the CSS
  // default 0) and numbers real siblings RELATIVE to it, negative before /
  // positive after. The old sequential 0,1,2… stamped an imperative order
  // onto the SLOT ELEMENT too (e.g. `2`), which no commit ever overwrote and
  // the patch stale-clear ignores (externally-set key) — so after dropping a
  // node BELOW the placeholder, the slot's leftover order shoved it after the
  // dropped node and the drop appeared ABOVE the line indicator's position
  // (template editing, user report 2026-07-27). Clearing the slot's inline
  // order here (CSS default 0) + relative numbering keeps preview == commit.
  const kids = nodeChildren(parent);
  const anchorIdx = kids.findIndex(
    (k) => (k.getAttribute('data-node-id') || '').endsWith('children-slot'),
  );
  kids.forEach((kid, i) => {
    if (i === anchorIdx) kid.style.order = '';
    else kid.style.order = String(anchorIdx < 0 ? i : i - anchorIdx);
  });
}

/**
 * Rewrite the `data-node-id` viewport prefix on `el` and every descendant that
 * carries one (`fromPrefix` → `toPrefix`). Used to turn a clone of a primary-
 * viewport node into a replica-viewport copy so it can be inserted live into the
 * tablet/mobile section. `data-id` (viewport-shared) is left untouched.
 */
export function reprefixDataNodeId(el: HTMLElement, fromPrefix: string, toPrefix: string): void {
  const swap = (node: HTMLElement): void => {
    const dni = node.getAttribute('data-node-id');
    if (dni != null && dni.startsWith(fromPrefix)) {
      node.setAttribute('data-node-id', toPrefix + dni.slice(fromPrefix.length));
    }
  };
  swap(el);
  el.querySelectorAll<HTMLElement>('[data-node-id]').forEach(swap);
}
