// project-fs.seed-reset.test.ts — EMPIRICAL PIN, live find 2026-07-14:
// the seed's CSS reset zeroed margins only on html/body while the editor
// sandboxes (public/preview.html) reset `* { margin: 0; padding: 0 }`.
// A <p> without an inline margin therefore looked compact in the builder
// but gained UA `1em` margins on the PUBLISHED site — 120px top+bottom at
// a 120px font (the "nav menu has huge gaps live but not in the editor"
// bug, fuzzy-river-689). The fix is NATIVE: new projects seed the universal
// reset, and loadSnapshot upgrades the legacy seed block in-place so the
// project's own globals.css ships correct CSS with zero publish-time
// normalization.
import { describe, it, expect } from 'vitest';
import { InMemoryProjectFS, createEmptyProject } from './project-fs';

const LEGACY = `*, *::before, *::after {
  box-sizing: border-box;
}
html, body {
  margin: 0;
  padding: 0;
}`;

const UNIVERSAL = `*, *::before, *::after {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}`;

describe('seed reset — native universal margin/padding', () => {
  it('new projects ship the universal reset in globals.css', () => {
    const files = createEmptyProject();
    const globals = files.get('app/globals.css')!;
    expect(globals).toContain(UNIVERSAL);
    expect(globals).not.toContain(LEGACY);
  });

  it('loadSnapshot upgrades a legacy seed reset in-place', () => {
    const fs = new InMemoryProjectFS(new Map());
    fs.loadSnapshot(new Map([
      ['app/globals.css', `/* comment */\n${LEGACY}\n:root { --x: 1; }`],
      ['app/page.client.tsx', 'export default function Page() { return null }'],
    ]));
    const globals = fs.readFile('app/globals.css')!;
    expect(globals).toContain(UNIVERSAL);
    expect(globals).not.toContain(LEGACY);
    // Everything around the block is untouched.
    expect(globals).toContain('/* comment */');
    expect(globals).toContain(':root { --x: 1; }');
  });

  it('a customized reset is never touched', () => {
    const custom = `* { box-sizing: border-box; }\nbody { margin: 4px; }`;
    const fs = new InMemoryProjectFS(new Map());
    fs.loadSnapshot(new Map([['app/globals.css', custom]]));
    expect(fs.readFile('app/globals.css')).toBe(custom);
  });
});
