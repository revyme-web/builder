import { describe, it, expect, beforeEach } from 'vitest';
import { createStore } from 'jotai';
import { activeFilePathAtom } from '../project/active-file-store';
import { projectFS } from '../project/project-fs';
import { visibleViewportsAtom } from './viewport-store';

describe('visibleViewportsAtom for icon-set master files', () => {
  beforeEach(() => {
    for (const f of projectFS.listFiles()) projectFS.deleteFile(f);
  });

  it('returns a SINGLE viewport (not desktop/tablet/mobile) for icon-set master', () => {
    projectFS.writeFile('icons/MyIcons.tsx', `
import React from 'react';
/** @iconSet */
export default function MyIcons() { return <div data-id="root" /> }
`);
    const store = createStore();
    store.set(activeFilePathAtom, 'icons/MyIcons.tsx');
    const vps = store.get(visibleViewportsAtom);
    expect(vps).toHaveLength(1);
    expect(vps[0].id).toBe('desktop');
    expect(vps[0].isPrimary).toBe(true);
  });

  it('still returns multiple viewports for regular pages', () => {
    projectFS.writeFile('app/page.tsx', `export default function Page() { return <div data-id="root" /> }`);
    const store = createStore();
    store.set(activeFilePathAtom, 'app/page.tsx');
    const vps = store.get(visibleViewportsAtom);
    expect(vps.length).toBeGreaterThan(1);
  });
});
