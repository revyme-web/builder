// imperative-style-tracking.test.ts — an imperative style write must be visible
// to the next render's stale-clear.
//
// Reported (2026-07-26): set padding on a CMS collection-list row, then ⌘Z. The
// code loses `padding` but the canvas keeps it — "stuck" — until a redo+undo or
// a page switch (which destroys and rebuilds the element). The trace shows the
// exact chain:
//
//   1780.303  control:update-style {padding: '54px'}   → patched imperatively
//   1780.527  CanvasRenderer:skip-canvasUpdating       → the render was SKIPPED
//   1780.861  history:undo → render runs …             → ZERO stale-clear traces
//
// `patchElement`'s stale-clear removes keys present in the PREVIOUS patch but
// absent from the new model — and it tracked only what the renderer itself
// wrote. `updateStyles` is in IMPERATIVELY_PATCHED_MUTATIONS, so a style edit
// patches the DOM and ARMS the render skip: no render ever recorded `padding`.
// When the undo dropped it from the model, nothing knew to clear it.

import { describe, it, expect, beforeEach } from 'vitest';
import { trackImperativeStyleKeys, getTrackedStyleKeys } from './Renderer';
import { applyTwoPass } from '@/canvas-sandbox/sandbox/style-handlers';

describe('trackImperativeStyleKeys', () => {
  let el: HTMLElement;
  beforeEach(() => { el = document.createElement('div'); });

  it('registers keys for an element the renderer has never patched', () => {
    trackImperativeStyleKeys(el, ['padding']);
    expect([...(getTrackedStyleKeys(el) ?? [])]).toEqual(['padding']);
  });

  it('MERGES into an existing set instead of replacing it', () => {
    // The renderer's own set must survive — clobbering it would make every
    // previously-rendered key un-clearable.
    trackImperativeStyleKeys(el, ['width', 'height']);
    trackImperativeStyleKeys(el, ['padding']);
    const keys = getTrackedStyleKeys(el)!;
    expect(keys.has('width')).toBe(true);
    expect(keys.has('height')).toBe(true);
    expect(keys.has('padding')).toBe(true);
  });

  it('de-duplicates repeated writes (a 60fps slider drag)', () => {
    for (let i = 0; i < 50; i++) trackImperativeStyleKeys(el, ['fontSize']);
    expect(getTrackedStyleKeys(el)!.size).toBe(1);
  });

  it('is undefined for an untouched element', () => {
    expect(getTrackedStyleKeys(document.createElement('div'))).toBeUndefined();
  });

  it('tracks per element, not globally', () => {
    const other = document.createElement('div');
    trackImperativeStyleKeys(el, ['padding']);
    expect(getTrackedStyleKeys(other)).toBeUndefined();
  });
});

describe('applyTwoPass — the sandbox write path registers what it wrote', () => {
  it('tracks the keys of an imperative padding write (the reported bug)', () => {
    const el = document.createElement('div');
    applyTwoPass(el, { padding: '54px', paddingTop: '', paddingRight: '' }, false);

    expect(el.style.padding).toBe('54px');
    const keys = getTrackedStyleKeys(el)!;
    // `padding` is the one that matters — it was ADDED, so a later model that
    // lacks it must clear it. The cleared longhands ride along harmlessly.
    expect(keys.has('padding')).toBe(true);
    expect(keys.has('paddingTop')).toBe(true);
  });

  it('accumulates across successive writes to the same element', () => {
    const el = document.createElement('div');
    applyTwoPass(el, { padding: '54px' }, false);
    applyTwoPass(el, { backgroundColor: 'red' }, false);
    const keys = getTrackedStyleKeys(el)!;
    expect(keys.has('padding')).toBe(true);
    expect(keys.has('backgroundColor')).toBe(true);
  });

  it('also invalidates the subtree-skip key so the next render descends', () => {
    // Both halves are needed: the skip key lets the render REACH the element,
    // the tracked keys let it know what to clear once there.
    const el = document.createElement('div') as HTMLElement & { __revymePatchKey?: string };
    el.__revymePatchKey = 'stale-sig|desktop-||||';
    applyTwoPass(el, { padding: '54px' }, false);
    expect(el.__revymePatchKey).toBeUndefined();
  });
});
