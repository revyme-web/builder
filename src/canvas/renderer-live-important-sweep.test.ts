// @vitest-environment jsdom
// LIVE-!important residue sweep: a replica scrub leaves an inline !important
// patch (data-live-important marker); renderNodes must clear it at the start
// of every pass so undo/redo's restored truth re-asserts (Cmd+Z left the
// stale inline winning until a page switch — live find 2026-07-21).
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/code/project/project-fs', () => ({
  projectFS: {
    readFile: () => '', listFiles: () => [], exists: () => false,
    writeFile: () => {}, deleteFile: () => {},
  },
}));

import { parseJSXToNodes } from '@/code/parsing/parser';
import { renderNodes } from '@/canvas/Renderer';

const page = `
export default function Page() {
  return (
    <div data-id="root" style={{ position: 'relative', width: '100%' }}>
      <div data-id="section" style={{ position: 'relative', width: '100%', display: 'flex', flexDirection: 'column' }}>
        <p data-id="label" style={{ position: 'relative', margin: '0px' }}>Hello</p>
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

describe('renderNodes live-important sweep', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('clears marked inline !important props + the marker on render', () => {
    const container = setup();
    const nodes = parseJSXToNodes(page);
    renderNodes(container, nodes, null, () => {}, viewports, page);
    const el = container.querySelector('[data-node-id="section"]') as HTMLElement;
    expect(el).toBeTruthy();
    // simulate a replica live scrub's residue
    el.style.setProperty('padding-top', '199px', 'important');
    el.setAttribute('data-live-important', 'padding-top');
    // next render (undo's patch render) sweeps it
    renderNodes(container, nodes, null, () => {}, viewports, page);
    const after = container.querySelector('[data-node-id="section"]') as HTMLElement;
    expect(after.getAttribute('data-live-important')).toBeNull();
    expect(after.style.getPropertyValue('padding-top')).toBe('');
  });

  it('unmarked inline styles are left alone', () => {
    const container = setup();
    const nodes = parseJSXToNodes(page);
    renderNodes(container, nodes, null, () => {}, viewports, page);
    const el = container.querySelector('[data-node-id="section"]') as HTMLElement;
    el.style.setProperty('outline', '1px solid red');
    renderNodes(container, nodes, null, () => {}, viewports, page);
    const after = container.querySelector('[data-node-id="section"]') as HTMLElement;
    expect(after.style.getPropertyValue('outline')).toBe('1px solid red');
  });
});
