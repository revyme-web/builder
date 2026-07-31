// theme-tokens.test.ts — guards the design-token contract in globals.css.
//
// Every token a component references must resolve in BOTH themes. `.dark`
// only OVERRIDES `:root`; a token declared *only* under `.dark` is simply
// missing in light mode. For a colour that degrades quietly (the property
// falls back to its initial value), but for a token used inside a shorthand
// it takes the whole declaration down with it: an unresolvable `var()` is
// invalid-at-computed-value-time, so
//
//   grid-template-columns: var(--tool-label-col) minmax(0, 1fr)
//
// computes to `none` and every two-column ToolRow collapses into one — the
// label stacked above its control across the entire properties panel in
// light mode (user report 2026-07-25, `--tool-label-col` was declared in
// `.dark` only).
//
// The A/B palette files are swap-in copies of globals.css ("copy this entire
// file over src/styles/globals.css"), so they carry the same contract.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const STYLES_DIR = join(__dirname);
const THEME_FILES = ['globals.css', 'globals.aurora.css', 'globals.grove.css', 'globals.reef.css'];

/** The `--token: value` names declared directly inside one CSS block. */
function declaredTokens(block: string): Set<string> {
  return new Set(Array.from(block.matchAll(/(--[a-z0-9-]+)\s*:/g), m => m[1]));
}

/** Split a theme file into its `:root { … }` and `.dark { … }` blocks. */
function themeBlocks(css: string): { root: string; dark: string } {
  // Anchor at line start — the header comment mentions "the `.dark { … }`
  // block below", and a bare indexOf would match THAT instead.
  const at = (sel: string) => css.search(new RegExp(`^\\s*${sel} \\{`, 'm'));
  const rootStart = at(':root');
  const darkStart = at('\\.dark');
  expect(rootStart, 'theme file must declare :root').toBeGreaterThan(-1);
  expect(darkStart, 'theme file must declare .dark').toBeGreaterThan(rootStart);
  const root = css.slice(rootStart, darkStart);
  const rest = css.slice(darkStart);
  const darkEnd = rest.indexOf('\n  }\n');
  return { root, dark: rest.slice(0, darkEnd > 0 ? darkEnd : rest.length) };
}

describe('theme tokens', () => {
  for (const file of THEME_FILES) {
    describe(file, () => {
      const css = readFileSync(join(STYLES_DIR, file), 'utf8');
      const { root, dark } = themeBlocks(css);

      it('declares every .dark token in :root too (dark only OVERRIDES)', () => {
        const rootTokens = declaredTokens(root);
        const darkOnly = [...declaredTokens(dark)].filter(t => !rootTokens.has(t));
        expect(darkOnly).toEqual([]);
      });

      it('declares --tool-label-col in :root (ToolRow grid track)', () => {
        expect(declaredTokens(root).has('--tool-label-col')).toBe(true);
      });

      it('keeps --tool-label-col out of .dark (theme-independent metric)', () => {
        expect(declaredTokens(dark).has('--tool-label-col')).toBe(false);
      });
    });
  }
});
