// shape-edit-history.test.ts — gesture-coalescing rules of the in-session
// shape-edit undo stack.
//
// Regression context: while shape-edit mode was active, Cmd+Z did nothing —
// vertex edits are live-DOM only (one source commit on exit), so the global
// history had no entries, and iframe focus meant the parent shortcut never
// fired anyway. ShapeEditHistory is the session-local stack the host keeps:
// one entry per USER GESTURE (drag / scrub / discrete op), undone and redone
// without leaving edit mode.

import { describe, it, expect } from 'vitest';
import { ShapeEditHistory, shapeEditKeyCommand } from './shape-edit-history';

type Snap = { label: string };
const s = (label: string): Snap => ({ label });

describe('ShapeEditHistory — gesture coalescing', () => {
  it('a drag gesture is ONE entry: first change pushes, later ticks coalesce', () => {
    const h = new ShapeEditHistory<Snap>();
    h.beginDrag();
    expect(h.recordChange(s('pre-drag'), 'drag', 0)).toBe(true);
    expect(h.recordChange(s('tick-2'), 'drag', 16)).toBe(false);
    expect(h.recordChange(s('tick-3'), 'drag', 32)).toBe(false);
    expect(h.depth).toBe(1);
    // Undo restores the state from BEFORE the drag's first change.
    expect(h.undo(s('final'))).toEqual(s('pre-drag'));
  });

  it('two drags are two entries', () => {
    const h = new ShapeEditHistory<Snap>();
    h.beginDrag();
    h.recordChange(s('before-drag-1'), 'drag', 0);
    h.recordChange(s('mid-1'), 'drag', 16);
    h.beginDrag();
    h.recordChange(s('before-drag-2'), 'drag', 1000);
    expect(h.depth).toBe(2);
    expect(h.undo(s('final'))).toEqual(s('before-drag-2'));
    expect(h.undo(s('after-drag-1'))).toEqual(s('before-drag-1'));
  });

  it('panel scrub ticks coalesce within the window (sliding), a later scrub is a new entry', () => {
    const h = new ShapeEditHistory<Snap>();
    // Continuous scrub: 0, 400, 800 — each within 500ms of the PREVIOUS tick.
    expect(h.recordChange(s('before-scrub-1'), 'panel', 0)).toBe(true);
    expect(h.recordChange(s('t400'), 'panel', 400)).toBe(false);
    expect(h.recordChange(s('t800'), 'panel', 800)).toBe(false);
    expect(h.depth).toBe(1);
    // Idle > window, then a second scrub → its own entry.
    expect(h.recordChange(s('before-scrub-2'), 'panel', 1400)).toBe(true);
    expect(h.depth).toBe(2);
    expect(h.undo(s('final'))).toEqual(s('before-scrub-2'));
    expect(h.undo(s('x'))).toEqual(s('before-scrub-1'));
  });

  it('discrete ops (delete vertex, pen point, curve change) each push', () => {
    const h = new ShapeEditHistory<Snap>();
    expect(h.recordChange(s('a'), 'discrete', 0)).toBe(true);
    expect(h.recordChange(s('b'), 'discrete', 10)).toBe(true);
    expect(h.recordChange(s('c'), 'discrete', 20)).toBe(true);
    expect(h.depth).toBe(3);
  });

  it('any new change clears redo — including a coalesced tick', () => {
    const h = new ShapeEditHistory<Snap>();
    h.recordChange(s('a'), 'discrete', 0);
    h.undo(s('b'));
    expect(h.canRedo).toBe(true);
    h.beginDrag();
    h.recordChange(s('a-again'), 'drag', 100); // pushes AND clears redo
    h.recordChange(s('tick'), 'drag', 116);    // coalesced — still keeps redo cleared
    expect(h.canRedo).toBe(false);
  });

  it('undo/redo round-trip hands back the right snapshots', () => {
    const h = new ShapeEditHistory<Snap>();
    h.recordChange(s('v1'), 'discrete', 0); // state moved v1 → v2
    const undone = h.undo(s('v2'));
    expect(undone).toEqual(s('v1'));
    expect(h.canUndo).toBe(false);
    const redone = h.redo(s('v1'));
    expect(redone).toEqual(s('v2'));
    expect(h.canUndo).toBe(true);
    expect(h.canRedo).toBe(false);
  });

  it('undo on an empty session returns null and does NOT poison redo', () => {
    const h = new ShapeEditHistory<Snap>();
    expect(h.undo(s('current'))).toBeNull();
    expect(h.canRedo).toBe(false);
    expect(h.redo(s('current'))).toBeNull();
  });

  it('undo breaks gesture coalescing — the next drag/scrub starts a fresh entry', () => {
    const h = new ShapeEditHistory<Snap>();
    h.beginDrag();
    h.recordChange(s('before-drag'), 'drag', 0);
    h.undo(s('mid'));
    // Same "drag" continues WITHOUT a new beginDrag (e.g. next pointermove
    // after an undo mid-gesture) — must push, not coalesce into the popped entry.
    expect(h.recordChange(s('after-undo'), 'drag', 50)).toBe(true);

    const h2 = new ShapeEditHistory<Snap>();
    h2.recordChange(s('scrub-1'), 'panel', 0);
    h2.undo(s('mid'));
    // A panel tick right after the undo (< window) must be a fresh entry.
    expect(h2.recordChange(s('scrub-2'), 'panel', 100)).toBe(true);
  });

  it('caps the stack at MAX_ENTRIES, dropping the oldest', () => {
    const h = new ShapeEditHistory<Snap>();
    const n = ShapeEditHistory.MAX_ENTRIES + 5;
    for (let i = 0; i < n; i++) h.recordChange(s(`v${i}`), 'discrete', i * 1000);
    expect(h.depth).toBe(ShapeEditHistory.MAX_ENTRIES);
    // Newest entry is still on top…
    expect(h.undo(s('cur'))).toEqual(s(`v${n - 1}`));
    // …and the bottom of the stack is v5 (v0..v4 dropped).
    for (let i = 0; i < ShapeEditHistory.MAX_ENTRIES - 2; i++) h.undo(s('x'));
    expect(h.undo(s('x'))).toEqual(s('v5'));
    expect(h.canUndo).toBe(false);
  });

  it('clear() empties both stacks', () => {
    const h = new ShapeEditHistory<Snap>();
    h.recordChange(s('a'), 'discrete', 0);
    h.undo(s('b'));
    h.recordChange(s('c'), 'discrete', 10);
    h.clear();
    expect(h.canUndo).toBe(false);
    expect(h.canRedo).toBe(false);
  });
});

describe('shapeEditKeyCommand — iframe keydown mapping', () => {
  const key = (k: string, mods: Partial<{ meta: boolean; ctrl: boolean; shift: boolean; alt: boolean }> = {}) => ({
    key: k, metaKey: !!mods.meta, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift, altKey: !!mods.alt,
  });

  it('Cmd+Z / Ctrl+Z → undo', () => {
    expect(shapeEditKeyCommand(key('z', { meta: true }))).toBe('undo');
    expect(shapeEditKeyCommand(key('z', { ctrl: true }))).toBe('undo');
  });

  it('Cmd+Shift+Z (either key case) and Cmd+Y → redo', () => {
    expect(shapeEditKeyCommand(key('z', { meta: true, shift: true }))).toBe('redo');
    expect(shapeEditKeyCommand(key('Z', { meta: true, shift: true }))).toBe('redo');
    expect(shapeEditKeyCommand(key('y', { meta: true }))).toBe('redo');
    expect(shapeEditKeyCommand(key('y', { ctrl: true }))).toBe('redo');
  });

  it('plain z (pen-adjacent typing), Alt chords, and other keys are ignored', () => {
    expect(shapeEditKeyCommand(key('z'))).toBeNull();
    expect(shapeEditKeyCommand(key('z', { meta: true, alt: true }))).toBeNull();
    expect(shapeEditKeyCommand(key('a', { meta: true }))).toBeNull();
    expect(shapeEditKeyCommand(key('Escape'))).toBeNull();
  });
});
