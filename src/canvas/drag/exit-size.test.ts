import { describe, it, expect } from 'vitest';
import { exitSize, exitSizes } from './exit-size';

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

  it('keeps the measurement when the node authored nothing', () => {
    // No width of its own = the parent sized it. There is no "auto" to
    // preserve, so the measurement is all we have.
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
