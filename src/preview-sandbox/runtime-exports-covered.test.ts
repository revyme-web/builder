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
import { buildAutoImports } from '@/shared/import-detection.mjs';

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

// ─── The import synchronizer is the OTHER consumer ──────────────────────────
//
// `syncImports` deliberately DROPS any pre-existing `@revyme/runtime` import
// line (otherwise it would be emitted twice) and hands ownership to
// `buildAutoImports`, which re-emits it from a hand-maintained list of names it
// scans the body for. A runtime export missing from that list therefore gets its
// import deleted on the next flush and never rebuilt — the page then crashes
// with "<name> is not defined" on the FIRST edit after the feature is used.
// `localizeRows` did exactly that (live find 2026-08-10), one day after the same
// omission in the preview shim above. Same package, same class, third consumer.

describe('buildAutoImports covers the runtime', () => {
  /** Runtime APIs a generated page can never reference by bare name. */
  const NOT_AUTO_IMPORTED = new Set<string>([
    // `default` is the HOC's export shape, not a name a page body uses.
    'default',
  ]);

  const callables = Object.keys(RevymeRuntime)
    .filter((k) => typeof (RevymeRuntime as Record<string, unknown>)[k] === 'function')
    .filter((k) => !NOT_AUTO_IMPORTED.has(k));

  it('re-emits the import for every runtime callable used in a body', () => {
    const missing = callables.filter((name) => {
      // A minimal page that references the export as a bare identifier.
      const body = `export default function Page() { const x = ${name}; return <div data-id="root" />; }`;
      return !buildAutoImports(body).some(
        (line: string) => line.includes('@revyme/runtime') && line.includes(name),
      );
    });
    expect(
      missing,
      `buildAutoImports drops these on flush → "X is not defined": ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('covers the specific one that regressed', () => {
    const body = `export default function Page() { return <div>{localizeRows(rows, l).map(() => null)}</div>; }`;
    expect(buildAutoImports(body).join('\n')).toContain("import { localizeRows } from '@revyme/runtime';");
  });

  it('emits nothing when the runtime is unused', () => {
    const body = `export default function Page() { return <div data-id="root" />; }`;
    expect(buildAutoImports(body).join('\n')).not.toContain('@revyme/runtime');
  });
});
