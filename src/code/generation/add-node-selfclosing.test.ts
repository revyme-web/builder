// add-node-selfclosing.test.ts — inserting / moving a node INTO a self-closing
// parent must open the parent up, not drop the child.
//
// Regression: a self-closing drop target (e.g. a full-bleed background layer
// `<motion.div .../>`) parses to a JSXElement with `openingElement.selfClosing`
// true + `closingElement` null. Pushing children without converting it to an
// open/close pair made @babel/generator either DROP the child (no-op) or emit
// an unterminated tag (re-parse throws) — both showed up as "the inserted /
// dragged node vanishes and the properties panel crashes".

import { describe, it, expect, vi } from 'vitest';
vi.mock('@/shared/debug-trace', () => ({ trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn(), dom: vi.fn() } }));
import { addNodeInCode, moveNodeInCode } from './generator-crud';
import { parse } from '@babel/parser';

function parses(src: string): boolean {
  try { parse(src, { sourceType: 'module', plugins: ['jsx', 'typescript'] }); return true; }
  catch { return false; }
}

const NEW_FRAME = { id: 'new-frame', type: 'div', name: 'Frame', styles: { width: '100px', height: '100px' } };

describe('addNodeInCode into a self-closing parent', () => {
  it('opens a self-closing <div/> and keeps the child + valid JSX', () => {
    const code = `export default function Page() {
  return <div data-id="root"><div data-id="bg" style={{ position: 'absolute' }} /></div>;
}`;
    const out = addNodeInCode(code, 'bg', NEW_FRAME);
    expect(out).toContain('data-id="new-frame"');
    expect(out).toContain('</div>');
    expect(parses(out)).toBe(true);
  });

  it('opens a self-closing <motion.div/> (member tag) — the hero-bg case', () => {
    const code = `export default function Page() {
  return <div data-id="root"><motion.div data-scroll-fx='{"appear":{"opacity":"0"}}' ref={heroBgRef} data-id="hero-bg" style={{ position: 'absolute', opacity: heroBgOpacityA, y: heroBgYAC, scale: heroBgScaleA }} /></div>;
}`;
    const out = addNodeInCode(code, 'hero-bg', NEW_FRAME);
    expect(out).toContain('data-id="new-frame"');
    expect(out).toContain('</motion.div>');        // proper member closing tag
    expect(out).not.toMatch(/<motion\.div[^>]*\/>/); // no longer self-closing
    expect(parses(out)).toBe(true);
  });

  it('index-specific insertion into a self-closing parent also works', () => {
    const code = `export default function Page() {
  return <div data-id="root"><div data-id="bg" style={{ position: 'absolute' }} /></div>;
}`;
    const out = addNodeInCode(code, 'bg', NEW_FRAME, 0);
    expect(out).toContain('data-id="new-frame"');
    expect(parses(out)).toBe(true);
  });

  it('still appends normally when the parent already has children (no regression)', () => {
    const code = `export default function Page() {
  return <div data-id="root"><div data-id="box"><span data-id="kid">x</span></div></div>;
}`;
    const out = addNodeInCode(code, 'box', NEW_FRAME);
    expect(out).toContain('data-id="new-frame"');
    expect(out).toContain('data-id="kid"');         // existing child preserved
    expect(parses(out)).toBe(true);
  });
});

describe('moveNodeInCode into a self-closing parent', () => {
  it('moving a node into a self-closing parent keeps it (does not delete it)', () => {
    const code = `export default function Page() {
  return <div data-id="root"><div data-id="bg" style={{ position: 'absolute' }} /><div data-id="mover" style={{ width: '50px' }} /></div>;
}`;
    const out = moveNodeInCode(code, 'mover', 'bg', {}, 0); // styleChanges={}, insertIndex=0
    expect(out).toContain('data-id="mover"');        // node survived the move
    expect(out).toContain('</div>');
    expect(parses(out)).toBe(true);
    // 'mover' now lives inside 'bg' — appears AFTER bg's opening tag, before its close.
    const bgOpen = out.indexOf('data-id="bg"');
    const mover = out.indexOf('data-id="mover"');
    expect(mover).toBeGreaterThan(bgOpen);
  });
});
