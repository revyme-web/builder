// The interacting viewport must name a tile that is actually on canvas.
//
// Reported 2026-08-24: with a variant tile selected, Cmd+Z removed that variant
// — and the selection overlay stayed, painting a box over empty canvas while
// the Layers panel correctly showed the surviving variant. The id was never
// revoked, so the overlay kept asking for the dead tile's rect and got a stale
// CACHED entry for a tile that no longer renders.
//
// The write target rides on the same id (`activeComponentVariantAtom`), so a
// style edit after that undo would have been routed into a variant object that
// no longer exists — the quieter half of the same bug.

import { describe, it, expect, beforeEach } from 'vitest';
import { createStore } from 'jotai';
import { activeFilePathAtom } from '../project/active-file-store';
import { projectFS, projectVersionAtom } from '../project/project-fs';
import {
  interactingViewportIdAtom,
  visibleViewportsAtom,
  activeComponentVariantAtom,
  isComponentVariantViewportAtom,
} from './viewport-store';

const COMPONENT = 'components/FeVuTi.tsx';

/** A component master with `variantConfig` naming `variants`. */
const master = (variants: string[]) => `
import React from 'react';
const variantConfig = [${variants.map((n, i) =>
  `{ name: '${n}', label: '${n}', x: ${i * 1500}, y: 0${i === 0 ? ', isPrimary: true' : ''} }`).join(', ')}];
export default function FeVuTi() { return <div data-id="root" /> }
`;

/** Rewrite the component file the way undo/redo does — a ProjectFS write plus
 *  the version bump that `activeCodeAtom` is gated on (history.ts does both;
 *  the trace records it as `hasBumpVersion: true`). */
function rewrite(store: ReturnType<typeof createStore>, variants: string[]) {
  projectFS.writeFile(COMPONENT, master(variants));
  store.set(projectVersionAtom, (v) => v + 1);
}

function storeWith(variants: string[]) {
  const store = createStore();
  store.set(activeFilePathAtom, COMPONENT);
  rewrite(store, variants);
  return store;
}

describe('interactingViewportIdAtom — clamped to a live viewport', () => {
  beforeEach(() => {
    for (const f of projectFS.listFiles()) projectFS.deleteFile(f);
  });

  it('keeps a viewport that exists', () => {
    const store = storeWith(['default', 'variant-1']);
    expect(store.get(visibleViewportsAtom).map((v) => v.id)).toEqual(['desktop', 'variant-1']);
    store.set(interactingViewportIdAtom, 'variant-1');
    expect(store.get(interactingViewportIdAtom)).toBe('variant-1');
  });

  it('THE BUG: an undo that removes the variant falls back to the primary', () => {
    const store = storeWith(['default', 'variant-1']);
    store.set(interactingViewportIdAtom, 'variant-1');
    expect(store.get(interactingViewportIdAtom)).toBe('variant-1');

    // The undo: the file goes back to one variant.
    rewrite(store, ['default']);
    expect(store.get(interactingViewportIdAtom)).toBe('desktop');
  });

  it('and the WRITE TARGET follows — no edit lands on a deleted variant', () => {
    const store = storeWith(['default', 'variant-1']);
    store.set(interactingViewportIdAtom, 'variant-1');
    expect(store.get(activeComponentVariantAtom)).toBe('variant-1');
    expect(store.get(isComponentVariantViewportAtom)).toBe(true);

    rewrite(store, ['default']);
    expect(store.get(activeComponentVariantAtom)).toBe('default');
    expect(store.get(isComponentVariantViewportAtom)).toBe(false);
  });

  it('a REDO that brings the variant back re-adopts it — the raw id is kept', () => {
    // Clamping on read (not overwriting the stored id) means the round trip is
    // lossless: the user lands back on the tile they were editing.
    const store = storeWith(['default', 'variant-1']);
    store.set(interactingViewportIdAtom, 'variant-1');
    rewrite(store, ['default']);
    expect(store.get(interactingViewportIdAtom)).toBe('desktop');
    rewrite(store, ['default', 'variant-1']);
    expect(store.get(interactingViewportIdAtom)).toBe('variant-1');
  });

  it('falls back to the PRIMARY, not merely the first id', () => {
    const store = storeWith(['default', 'variant-1', 'variant-2']);
    store.set(interactingViewportIdAtom, 'variant-2');
    rewrite(store, ['default', 'variant-1']);
    expect(store.get(interactingViewportIdAtom)).toBe('desktop');
  });

  it('a page file clamps against its own viewport set', () => {
    projectFS.writeFile('app/page.tsx', `export default function Page() { return <div data-id="root" /> }`);
    const store = createStore();
    store.set(activeFilePathAtom, 'app/page.tsx');
    const ids = store.get(visibleViewportsAtom).map((v) => v.id);
    expect(ids).toContain('desktop');
    // A variant id from a component file can't survive a switch to a page —
    // it is clamped to that page's own primary.
    store.set(interactingViewportIdAtom, 'variant-1');
    expect(ids).not.toContain('variant-1');
    expect(store.get(interactingViewportIdAtom)).toBe(
      store.get(visibleViewportsAtom).find((v) => v.isPrimary)!.id,
    );
  });
});
