import { describe, it, expect, afterEach } from 'vitest';
import { getStyleNum, nextFrames, commitFocusedPanelInput } from './dom-utils';

// DOM-dependent tests are limited in vitest/jsdom but we can test pure functions

describe('getStyleNum', () => {
  it('returns 0 for empty style', () => {
    const el = document.createElement('div');
    expect(getStyleNum(el, 'left')).toBe(0);
  });

  it('parses numeric style values', () => {
    const el = document.createElement('div');
    el.style.left = '42px';
    expect(getStyleNum(el, 'left')).toBe(42);
  });

  it('handles negative values', () => {
    const el = document.createElement('div');
    el.style.top = '-100px';
    expect(getStyleNum(el, 'top')).toBe(-100);
  });

  it('handles decimal values', () => {
    const el = document.createElement('div');
    el.style.width = '99.5px';
    expect(getStyleNum(el, 'width')).toBe(99.5);
  });
});

describe('nextFrames', () => {
  it('runs the callback after n stacked animation frames', () => {
    const queued: FrameRequestCallback[] = [];
    const orig = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => { queued.push(cb); return queued.length; }) as typeof requestAnimationFrame;
    try {
      let ran = false;
      nextFrames(2, () => { ran = true; });
      expect(queued.length).toBe(1);
      queued.shift()!(0); // frame 1 → schedules frame 2
      expect(ran).toBe(false);
      expect(queued.length).toBe(1);
      queued.shift()!(0); // frame 2 → callback
      expect(ran).toBe(true);
    } finally {
      globalThis.requestAnimationFrame = orig;
    }
  });

  it('runs synchronously for n <= 0', () => {
    let ran = false;
    nextFrames(0, () => { ran = true; });
    expect(ran).toBe(true);
  });
});

// ─── commitFocusedPanelInput ────────────────────────────────────────────────
//
// Panel inputs commit on BLUR, and the handler closes over whatever node is
// selected at that moment. Clicking from a half-typed Font Size straight onto
// another element ran in this order: canvas mousedown → selection changes →
// panel re-renders with the NEW node → blur fires → the typed value landed on
// the node just clicked. The report's trace has it to the millisecond: hit-test
// selects `frame-mrz14wdv-1` at 2635.679s, then
// `control:update-style {nodeIds:["frame-mrz14wdv-1"], fontSize:"53px"}` at
// 2635.707s (user report 2026-07-26). Blurring FIRST makes the commit run while
// the original selection is still active.

describe('commitFocusedPanelInput', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  it('blurs a focused input so its commit runs before the selection changes', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    expect(document.activeElement).toBe(input);
    commitFocusedPanelInput();
    expect(document.activeElement).not.toBe(input);
  });

  it('blurs a focused textarea too', () => {
    const ta = document.createElement('textarea');
    document.body.appendChild(ta);
    ta.focus();
    commitFocusedPanelInput();
    expect(document.activeElement).not.toBe(ta);
  });

  it('leaves a focused IFRAME alone (canvas text editing lives in the sandbox)', () => {
    // From the parent document the sandbox's activeElement is the iframe
    // ELEMENT — blurring it would fight TipTap for focus mid-edit.
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    iframe.focus();
    const before = document.activeElement;
    commitFocusedPanelInput();
    expect(document.activeElement).toBe(before);
  });

  it('is a no-op when a non-input element has focus', () => {
    const btn = document.createElement('button');
    document.body.appendChild(btn);
    btn.focus();
    commitFocusedPanelInput();
    expect(document.activeElement).toBe(btn);
  });

  it('is a no-op when nothing is focused', () => {
    expect(() => commitFocusedPanelInput()).not.toThrow();
  });
});
