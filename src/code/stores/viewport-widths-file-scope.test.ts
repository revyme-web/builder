import { describe, it, expect, beforeEach } from 'vitest';
import { createStore } from 'jotai';
import { activeFilePathAtom } from '../project/active-file-store';
import { projectFS, projectVersionAtom } from '../project/project-fs';
import { viewportWidthsAtom, visibleViewportsAtom, viewportsConfigAtom } from './viewport-store';

const PAGE = `'use client';

/** @canvas {
  "viewports": [
    { "id": "desktop", "label": "Desktop", "width": 1440, "isPrimary": true, "order": 0 },
    { "id": "tablet", "label": "Tablet", "width": 768, "isPrimary": false, "order": 1 },
    { "id": "mobile", "label": "Mobile", "width": 898, "isPrimary": false, "order": 2 }
  ],
  "positions": { "desktop": { "x": 0, "y": 0 }, "tablet": { "x": 1600, "y": 0 }, "mobile": { "x": 2528, "y": 0 } }
} */

export default function Page() { return <div data-id="root" /> }
`;

const TEMPLATE = `'use client';
export default function LayoutClient({ children }: { children: React.ReactNode }) {
  return <div data-id="root">{children}</div>;
}
`;

describe('viewportWidthsAtom is FILE-SCOPED (the template round-trip leak)', () => {
  beforeEach(() => {
    for (const f of projectFS.listFiles()) projectFS.deleteFile(f);
    projectFS.writeFile('app/(Body)/page.client.tsx', PAGE);
    projectFS.writeFile('app/(Body)/LayoutClient.tsx', TEMPLATE);
  });

  it('derives widths from the ACTIVE file config; the template never sees the page widths and the page never sees the template defaults', () => {
    const store = createStore();
    store.set(activeFilePathAtom, 'app/(Body)/page.client.tsx');
    // Page: from its own @canvas config.
    expect(store.get(viewportWidthsAtom).mobile).toBe(898);

    // Enter the template (config-less file → defaults). Pre-fix the GLOBAL
    // widths atom kept the page's 898 here — the template's mobile tile
    // rendered at the PAGE's width.
    store.set(activeFilePathAtom, 'app/(Body)/LayoutClient.tsx');
    expect(store.get(viewportWidthsAtom).mobile).toBe(375);
    expect(store.get(visibleViewportsAtom).find(v => v.id === 'mobile')?.width).toBe(375);

    // Back to the page: pre-fix the reconcile effect could leave the
    // template's 375 overlaying the page's fresh 898 config — the visible
    // "my resize reverted" while the FILE was correct all along.
    store.set(activeFilePathAtom, 'app/(Body)/page.client.tsx');
    expect(store.get(viewportWidthsAtom).mobile).toBe(898);
    expect(store.get(visibleViewportsAtom).find(v => v.id === 'mobile')?.width).toBe(898);
  });

  it('a live-gesture override applies ONLY to the file it was written for, and the config becomes truth after the paired commit', () => {
    const store = createStore();
    store.set(activeFilePathAtom, 'app/(Body)/page.client.tsx');
    // Resize commit step 2: the width write (functional form).
    store.set(viewportWidthsAtom, prev => ({ ...prev, mobile: 920 }));
    expect(store.get(viewportWidthsAtom).mobile).toBe(920);

    // The override never follows into another file…
    store.set(activeFilePathAtom, 'app/(Body)/LayoutClient.tsx');
    expect(store.get(viewportWidthsAtom).mobile).toBe(375);

    // Resize commit step 4 pairs the width write with a durable config
    // write (version bump). After it, the CONFIG is the truth everywhere.
    store.set(activeFilePathAtom, 'app/(Body)/page.client.tsx');
    store.set(viewportsConfigAtom, prev => prev.map(v => v.id === 'mobile' ? { ...v, width: 920 } : v));
    store.set(activeFilePathAtom, 'app/(Body)/LayoutClient.tsx');
    store.set(activeFilePathAtom, 'app/(Body)/page.client.tsx');
    expect(store.get(viewportWidthsAtom).mobile).toBe(920);
  });

  it('a dangling override dies on any durable write (the undo case)', () => {
    const store = createStore();
    store.set(activeFilePathAtom, 'app/(Body)/page.client.tsx');
    store.set(viewportWidthsAtom, prev => ({ ...prev, mobile: 920 }));
    expect(store.get(viewportWidthsAtom).mobile).toBe(920);
    // Undo restores the file and bumps the project version — the pre-undo
    // override must NOT paint 920 back over the restored config.
    projectFS.writeFile('app/(Body)/page.client.tsx', PAGE);
    store.set(projectVersionAtom, v => v + 1);
    expect(store.get(viewportWidthsAtom).mobile).toBe(898);
  });
});
