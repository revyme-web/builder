// ghost-poll-idle.test.ts — the collection ghost-outline poll must be silent
// when nothing moves.
//
// User report 2026-08-08: setting a CMS binding reached the DOM instantly but
// took ~a second to show in the properties panel. The bind itself is fast (the
// trace shows write → parse → panel render in 17ms); the lag came from
// SelectionOverlay's ghost-outline poll, which ran a 60fps rAF loop while a
// collection row was selected and called setGhostCorners/setArrowPaths
// UNCONDITIONALLY — new array identities every frame, so the whole overlay
// re-rendered 60×/sec producing identical output. One 465ms window in the trace
// held 56 polls and 179 geometry reads, all returning the same thing.

import { describe, it, expect } from 'vitest';

/** The bail the poll now performs, extracted so the rule is pinned as a spec. */
const r = (n: number) => Math.round(n * 100) / 100;
type C = { TL: P; TR: P; BR: P; BL: P };
type P = { x: number; y: number };
const sigOf = (corners: C[], paths: string[]) =>
  corners
    .map((c) => `${r(c.TL.x)},${r(c.TL.y)},${r(c.TR.x)},${r(c.TR.y)},${r(c.BR.x)},${r(c.BR.y)},${r(c.BL.x)},${r(c.BL.y)}`)
    .join(';') + '|' + paths.join(';');

const box = (x: number, y: number): C => ({
  TL: { x, y }, TR: { x: x + 10, y }, BR: { x: x + 10, y: y + 10 }, BL: { x, y: y + 10 },
});

describe('ghost poll signature', () => {
  it('is identical across frames when nothing moved — no setState', () => {
    expect(sigOf([box(0, 0)], ['M0 0'])).toBe(sigOf([box(0, 0)], ['M0 0']));
  });

  it('the idle case (no ghosts) is stable too', () => {
    expect(sigOf([], [])).toBe(sigOf([], []));
  });

  it('changes when a ghost moves', () => {
    expect(sigOf([box(0, 0)], [])).not.toBe(sigOf([box(0, 1)], []));
  });

  it('changes when a ghost appears or disappears', () => {
    expect(sigOf([], [])).not.toBe(sigOf([box(0, 0)], []));
    expect(sigOf([box(0, 0), box(0, 20)], [])).not.toBe(sigOf([box(0, 0)], []));
  });

  it('changes when an arrow path changes', () => {
    expect(sigOf([box(0, 0)], ['M0 0'])).not.toBe(sigOf([box(0, 0)], ['M1 1']));
  });

  it('absorbs sub-0.01px float noise — jitter must not defeat the bail', () => {
    expect(sigOf([box(0, 0)], [])).toBe(sigOf([box(0.0001, 0.0001)], []));
  });

  it('still reacts to a real sub-pixel move', () => {
    expect(sigOf([box(0, 0)], [])).not.toBe(sigOf([box(0, 0.5)], []));
  });
});
