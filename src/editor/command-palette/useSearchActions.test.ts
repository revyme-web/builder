// useSearchActions.test.ts — Static guards on the action executor.
//
// These read the module's SOURCE rather than running it. Executing
// `executeSearchAction` in a unit test would mean mocking the canvas command
// bridge, history, transform, the backend client and half a dozen stores —
// a fixture heavy enough that it would test the mocks more than the code.
//
// What actually broke here was not logic but a WIRING assumption: the
// `switch-active-file` branch wrote `pendingFileSwitchAtom` believing
// Canvas.tsx watched it. Nothing reads that atom anywhere in the app, so
// every Pages and Template row closed the palette and did nothing. Types
// could not catch it — writing an unread atom is perfectly valid TypeScript
// — and no test caught it because the branch "worked" in isolation.
//
// So the guards below encode the wiring itself.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(__dirname, 'useSearchActions.ts'), 'utf8');

describe('useSearchActions wiring', () => {
  it('switches files through switchActiveFile, not a bare atom write', () => {
    // switchActiveFile flushes the outgoing file's mutation queue, clears
    // selection, applies the target's camera before render, and forces a
    // full Renderer rebuild. An atom write does none of that.
    expect(SRC).toContain('switchActiveFile(');
  });

  it('never writes the orphaned pendingFileSwitchAtom', () => {
    // The atom still exists in store.ts with no reader. If someone wires a
    // consumer later this can be revisited — until then, writing it is a
    // silent no-op.
    //
    // Matches the WRITE, not the name: the comment above the switch branch
    // explains this history and legitimately mentions the atom.
    expect(SRC).not.toMatch(/store\.set\(\s*pendingFileSwitchAtom/);
  });

  it('records MRU before dispatching, so early-returning branches still count', () => {
    const recordIdx = SRC.indexOf('recordRecent(itemId)');
    const switchIdx = SRC.indexOf('switch (action.type)');
    expect(recordIdx).toBeGreaterThan(-1);
    expect(switchIdx).toBeGreaterThan(-1);
    expect(recordIdx).toBeLessThan(switchIdx);
  });

  it('keeps the exhaustive never-check that forces new actions to be handled', () => {
    // This is what makes a new SearchAction variant a compile error rather
    // than a runtime "Unknown action" toast.
    expect(SRC).toContain('const _exhaustive: never = action');
  });
});
