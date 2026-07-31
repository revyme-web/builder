// snapshot-readers-flush.test.ts — every full-project snapshot reader must
// flush the mutation queue FIRST.
//
// Queued mutations apply to the queue's own `currentCode` and only reach
// `projectFS` when a flush lands — and the drag path deliberately DEFERS that
// write to the end of the gesture (`deferApply` in useMutationQueueLifecycle).
// So a reader that snapshots `projectFS` unflushed ships a project that is one
// or more edits behind, and whatever it feeds — the preview iframe, the publish
// build, a remix link — renders a layout the canvas has already moved past.
//
// Reported as "the live site shows a flex row where the canvas shows my grid"
// (2026-07-26): the JSX in the capture was a correct 3-column grid with a
// `span 2` first child, so the render could only have come from an older
// snapshot. `PreviewOverlay` was the one reader missing the flush; publish and
// the remix-link builder already had it.
//
// A SOURCE-level guard on purpose: these three call sites each live behind an
// iframe / network boundary that a unit test can't drive, and the failure mode
// is silent (stale pixels, no error). Cheap to keep honest, and it fails loudly
// the moment a fourth reader is added without a flush.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');

/** Full-project snapshot readers: (file, the call that reads every file). */
const SNAPSHOT_READERS: Array<{ file: string; reads: string }> = [
  { file: 'editor/header/PreviewOverlay.tsx', reads: 'projectFS.listFiles()' },
  { file: 'editor/header/menu-builders.tsx', reads: 'projectFS.getSnapshot()' },
];

describe('project snapshot readers flush the mutation queue first', () => {
  for (const { file, reads } of SNAPSHOT_READERS) {
    it(`${file} flushes before ${reads}`, () => {
      const src = readFileSync(join(ROOT, file), 'utf8');
      const readIdx = src.indexOf(reads);
      expect(readIdx, `${reads} not found — did the reader move?`).toBeGreaterThan(-1);
      const flushIdx = src.lastIndexOf('flushNow()', readIdx);
      expect(flushIdx, `no flushNow() before ${reads}`).toBeGreaterThan(-1);
    });
  }

  // Publish reads the STORED DB row rather than projectFS, so it needs BOTH:
  // the queue flushed into projectFS, then the debounced autosave flushed into
  // the backend. Dropping either one deploys the previous save.
  it('publish flushes the queue AND awaits the autosave flush', () => {
    const src = readFileSync(join(ROOT, 'editor/header/RightHeader.tsx'), 'utf8');
    const publishIdx = src.indexOf('/publish`');
    expect(publishIdx).toBeGreaterThan(-1);
    const head = src.slice(0, publishIdx);
    expect(head).toContain('flushNow()');
    expect(head).toContain('await flushSaveNow()');
  });

  // The preview must also RE-PUSH when files change while it's open.
  // `projectVersionAtom` is bumped by `modifyProjectFile` and history restores
  // only — an ordinary mutation-queue flush (how nearly every canvas edit
  // reaches projectFS, via `onFlush` → `projectFS.writeFile`) does NOT bump it.
  // So the open preview kept rendering the project as of the moment it opened:
  // switching a container to Grid showed correctly on the published site but
  // never in the preview (2026-07-26). `projectFS.subscribe` fires on every
  // write and is the complete signal.
  it('PreviewOverlay re-pushes on projectFS writes, not just projectVersion', () => {
    const src = readFileSync(join(ROOT, 'editor/header/PreviewOverlay.tsx'), 'utf8');
    expect(src).toContain('projectFS.subscribe(');
    // …and the push effect must actually depend on that signal.
    const pushDeps = src.match(/\}, \[open, iframeReady, projectVersion[^\]]*\]\);/);
    expect(pushDeps, 'push effect dep array not found — did it move?').not.toBeNull();
    expect(pushDeps![0]).toContain('fsTick');
  });

  // The preview iframe runs on its OWN ORIGIN, so it has its own localStorage —
  // and the generated `providers.tsx` resolves an unprefixed route's locale from
  // `localStorage.getItem('locale')`, mirroring it onto `<html lang>`. A locale
  // picked in an earlier preview session therefore stuck forever and every
  // `:lang(xx)` rule in the page fired: a stray
  // `:lang(fr) […] { display: flex !important }` collapsed a 3-column grid into
  // one row in the preview while the published site (lang="en") was correct
  // (user find 2026-07-26). Pinned the same way the theme already is.
  it('PreviewOverlay pins the locale, like it pins the theme', () => {
    const src = readFileSync(join(ROOT, 'editor/header/PreviewOverlay.tsx'), 'utf8');
    expect(src).toContain("type: 'preview:force-theme'");
    expect(src).toContain("type: 'preview:force-locale'");
    expect(src).toContain('activeLocaleAtom');
    // Must re-post when the editor's locale changes, not just on open.
    const deps = src.match(/\}, \[open, iframeReady, projectVersion[^\]]*\]\);/);
    expect(deps![0]).toContain('activeLocale');
  });

  it('the preview runtime handles force-locale via the app\'s own channel', () => {
    const src = readFileSync(join(ROOT, 'preview-sandbox/main.tsx'), 'utf8');
    expect(src).toContain("msg.type === 'preview:force-locale'");
    // providers.tsx reads `localStorage.locale` and listens for `locale-change`
    // — write through BOTH so `<html lang>` follows from the app's own effect
    // rather than a preview-specific hack.
    expect(src).toContain("localStorage.setItem('locale'");
    expect(src).toContain("'locale-change'");
  });
});
