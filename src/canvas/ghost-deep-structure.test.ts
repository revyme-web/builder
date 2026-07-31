// @vitest-environment jsdom
// EMPIRICAL PIN: collection-list GHOST copies must adopt STRUCTURAL edits made
// DEEP inside the template between patches. Live find 2026-07-13: a text bound
// to item.description + a frame created INSIDE the tile's inner wrapper showed
// on the template (index 0) but the ghosts underneath never updated until a
// page switch — the mismatch check only counted DIRECT children.
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/code/project/project-fs', () => ({
  projectFS: {
    readFile: () => '', listFiles: () => [], exists: () => false,
    writeFile: () => {}, deleteFile: () => {},
  },
}));

import { parseJSXToNodes } from '@/code/parsing/parser';
import { renderNodes } from '@/canvas/Renderer';

const page = (deepExtra: string) => `
export default function Page() {
  const rows = [
    { title: 'Alpha', desc: 'First row' },
    { title: 'Beta', desc: 'Second row' },
    { title: 'Gamma', desc: 'Third row' },
  ];
  return (
    <div data-id="root" style={{ position: 'relative', width: '100%' }}>
      <div data-id="list" style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {rows.map((item, idx) => (
          <div data-id="row" style={{ position: 'relative', padding: '10px' }}>
            <div data-id="row-inner" style={{ position: 'relative', display: 'flex', flexDirection: 'column' }}>
              <h3 data-id="row-title" style={{ position: 'relative', margin: '0px' }}>{item.title}</h3>
              ${deepExtra}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}`;

const BEFORE = page('');
const AFTER = page(`<p data-id="row-desc" style={{ position: 'relative', margin: '0px' }}>{item.desc}</p>
              <div data-id="row-chip" style={{ position: 'relative', width: '40px', height: '20px', backgroundColor: '#ff9ab5' }}></div>`);

describe('collection ghost deep-structure sync', () => {
  it('a node added DEEP in the template appears in the ghosts on the next patch', () => {
    (globalThis as any).CSS = (globalThis as any).CSS ?? {};
    (globalThis as any).CSS.escape = (globalThis as any).CSS.escape ?? ((s: string) => s.replace(/[^a-zA-Z0-9_-]/g, (c: string) => `\\${c}`));
    const container = document.createElement('div');
    document.body.appendChild(container);
    const viewports = [{ id: 'desktop', width: 1440, x: 0, y: 0, isPrimary: true }] as any;

    // 1. Initial render — 1 template + 2 ghosts, no desc/chip anywhere.
    renderNodes(container, parseJSXToNodes(BEFORE), null, () => {}, viewports, BEFORE);
    const ghosts = container.querySelectorAll('[data-collection-ghost]');
    expect(ghosts.length).toBe(2);
    expect(container.querySelectorAll('[data-id="row-chip"]').length).toBe(0);

    // 2. The user adds a bound text + a frame INSIDE row-inner → re-render (patch path).
    renderNodes(container, parseJSXToNodes(AFTER), null, () => {}, viewports, AFTER);

    // Template has the new nodes…
    const tpl = container.querySelector('[data-node-id="row"]') as HTMLElement;
    expect(tpl.querySelector('[data-id="row-desc"]')).toBeTruthy();
    // …and EVERY ghost must too (this was the bug: ghosts stayed stale).
    const ghost1 = container.querySelector('[data-node-id="row__1"]') as HTMLElement;
    const ghost2 = container.querySelector('[data-node-id="row__2"]') as HTMLElement;
    expect(ghost1).toBeTruthy();
    expect(ghost2).toBeTruthy();
    expect(ghost1.querySelector('[data-id="row-desc"]')).toBeTruthy();
    expect(ghost1.querySelector('[data-id="row-chip"]')).toBeTruthy();
    expect(ghost2.querySelector('[data-id="row-desc"]')).toBeTruthy();
    expect(ghost2.querySelector('[data-id="row-chip"]')).toBeTruthy();
    // Bindings resolve per row.
    expect(ghost1.querySelector('[data-id="row-desc"]')?.textContent).toContain('Second row');
    expect(ghost2.querySelector('[data-id="row-desc"]')?.textContent).toContain('Third row');

    // 3. Identical re-render — structure matches, ghosts preserved (no churn).
    const g1El = ghost1;
    renderNodes(container, parseJSXToNodes(AFTER), null, () => {}, viewports, AFTER);
    expect(container.querySelector('[data-node-id="row__1"]')).toBe(g1El);
  });
});
