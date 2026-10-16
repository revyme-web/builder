import { describe, it, expect } from 'vitest';
import { exitSize, exitSizes, isTextExitNode } from './exit-size';

// Dragging a text out of its parent onto the canvas used to commit the
// MEASURED box — `width: 'auto'` became `width: '123px'`. The Dimensions
// panel then read "123" where it read "auto" a moment before, and editing
// the text no longer resized it (user report 2026-10-05, node
// `client-1-name`).

describe('exitSize', () => {
  it('keeps auto instead of the measured px', () => {
    expect(exitSize({ width: 'auto', height: 'auto' }, 'width', '123px')).toBe('auto');
    expect(exitSize({ width: 'auto', height: 'auto' }, 'height', '31px')).toBe('auto');
  });

  it('keeps the measurement for a parent-relative size', () => {
    // `100%`, a stretch or a flex basis resolved against a parent the node
    // no longer has. On the canvas root the percentage would mean something
    // else entirely, so the measured px is the honest preservation.
    expect(exitSize({ width: '100%' }, 'width', '640px')).toBe('640px');
    expect(exitSize({ width: '50vw' }, 'width', '640px')).toBe('640px');
  });

  it('keeps the measurement for an authored px', () => {
    expect(exitSize({ width: '200px' }, 'width', '200px')).toBe('200px');
  });

  it('keeps the editor\'s own Fit values — they read the content, not the parent', () => {
    expect(exitSize({ width: 'min-content' }, 'width', '88px')).toBe('min-content');
    expect(exitSize({ height: 'max-content' }, 'height', '40px')).toBe('max-content');
    // fit-content clamps to the AVAILABLE width — parent-relative for a frame
    expect(exitSize({ width: 'fit-content' }, 'width', '88px')).toBe('88px');
  });

  it('keeps the measurement when a FRAME authored nothing', () => {
    // No width of its own = the parent sized it (stretch). There is no
    // "auto" to preserve, so the measurement is all we have.
    expect(exitSize({}, 'width', '88px')).toBe('88px');
    expect(exitSize(undefined, 'width', '88px')).toBe('88px');
    expect(exitSize(null, 'height', '12px')).toBe('12px');
  });

  it('ignores surrounding whitespace', () => {
    expect(exitSize({ width: '  auto ' }, 'width', '123px')).toBe('auto');
  });

  it('treats each axis on its own', () => {
    // A text fixed in width but hugging in height is the common case.
    expect(exitSizes({ width: '300px', height: 'auto' }, '300px', '31px'))
      .toEqual({ width: '300px', height: 'auto' });
  });

  it('reproduces the reported node exactly', () => {
    expect(exitSizes({ width: 'auto', height: 'auto', position: 'relative' }, '123px', '31px'))
      .toEqual({ width: 'auto', height: 'auto' });
  });
});

// Second report (2026-10-16, `text-mvaooeph-2`): a bare `<p>` — no width or
// height of its own, which the Dimensions panel reads as auto/auto — dragged
// out of a centred column landed as `width: 95px; height: 19px`, and the
// round-down from 95.19 wrapped its last letter onto a second line.
describe('exitSizes — text', () => {
  const P = { fontSize: '16px', lineHeight: '1.2', overflowWrap: 'break-word', position: 'relative', flex: '0 0 auto' };

  it('reproduces the reported node: auto width + auto height, no px', () => {
    expect(exitSizes(P, '95px', '19px', true)).toEqual({ width: 'max-content', height: 'auto' });
  });

  it('an auto width lands as max-content — the 0-wide canvas root breaks `auto` per word', () => {
    expect(exitSize({ width: 'auto' }, 'width', '95px', true)).toBe('max-content');
    expect(exitSize({ width: 'fit-content' }, 'width', '95px', true)).toBe('max-content');
    expect(exitSize({ width: 'max-content' }, 'width', '95px', true)).toBe('max-content');
    expect(exitSize({ width: 'min-content' }, 'width', '95px', true)).toBe('min-content');
    expect(exitSize({ height: 'auto' }, 'height', '19px', true)).toBe('auto');
  });

  it('a fixed or parent-relative text size still becomes the measured px', () => {
    expect(exitSizes({ width: '300px', height: '48px' }, '300px', '48px', true)).toEqual({ width: '300px', height: '48px' });
    expect(exitSize({ width: '100%' }, 'width', '640px', true)).toBe('640px');
    // fixed width + auto height — the wrapping paragraph case
    expect(exitSizes({ width: '300px' }, '300px', '62px', true)).toEqual({ width: '300px', height: 'auto' });
  });
});

describe('isTextExitNode', () => {
  it('text leaves are text; frames and element-wrapping links are not', () => {
    expect(isTextExitNode({ type: 'p', children: [] })).toBe(true);
    expect(isTextExitNode({ type: 'h2' })).toBe(true);
    expect(isTextExitNode({ type: 'a', children: [] })).toBe(true);
    expect(isTextExitNode({ type: 'a', children: ['card-img'] })).toBe(false);
    expect(isTextExitNode({ type: 'div', children: [] })).toBe(false);
    expect(isTextExitNode(undefined)).toBe(false);
  });
});
