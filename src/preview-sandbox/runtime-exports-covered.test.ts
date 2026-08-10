// runtime-exports-covered.test.ts — the preview must expose the whole runtime.
//
// The preview iframe can't hand user code the `@revyme/runtime` namespace
// directly: Vite's optimizer rewrites the linked-package namespace in a way
// that drops named exports through Babel's CommonJS interop, so `main.tsx`
// re-exports each API by hand into an `esm({...})` shim.
//
// A hand-maintained list drifts. Adding `localizeRows` to the package and not
// to that shim made every localized collection list throw
// "(0, _runtime.localizeRows) is not a function" in preview while working fine
// on the canvas and on the published site (user report 2026-08-10) — the
// package was correct, one of its three consumers wasn't.
//
// This test fails the moment a new runtime export isn't mirrored. It reads the
// source rather than importing `main.tsx`, which boots a whole preview app.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as RevymeRuntime from '@revyme/runtime';

/** Runtime APIs the preview is NOT expected to re-export, with the reason. */
const NOT_EXPOSED = new Set<string>([
  // Type-only or internal helpers would go here. Keep this list short and
  // justified: anything a generated page can import belongs in the shim.
]);

describe('preview runtime shim', () => {
  const src = readFileSync(resolve(__dirname, 'main.tsx'), 'utf8');
  // The `'@revyme/runtime': esm({ … })` block.
  const block = src.slice(src.indexOf("'@revyme/runtime': esm({"));
  const shim = block.slice(0, block.indexOf('}),') + 3);

  const runtimeExports = Object.keys(RevymeRuntime)
    .filter((k) => typeof (RevymeRuntime as Record<string, unknown>)[k] === 'function')
    .filter((k) => !NOT_EXPOSED.has(k));

  it('exposes every callable the runtime package exports', () => {
    const missing = runtimeExports.filter((name) => !shim.includes(`${name}:`));
    expect(missing, `not re-exported to the preview iframe: ${missing.join(', ')}`).toEqual([]);
  });

  it('covers the specific one that regressed', () => {
    expect(runtimeExports).toContain('localizeRows');
    expect(shim).toContain('localizeRows: RevymeRuntime.localizeRows');
  });
});
