// canvas-node-label-strip.test.ts — the clickable strip above a canvas node.
//
// The name label used to shrink-wrap its text, so only those few dozen pixels
// selected or dragged the node while the rest of the row above it looked
// interactive and wasn't (user request 2026-08-09). Widening it to the node's
// full width makes the strip overlap things it never used to: the top-edge
// resize band is 8px tall CENTRED on the node's edge, and the corner handles
// have a 4px radius, so both reach 4px ABOVE the node — and the strip sits at a
// higher z-index. These pin the clearance.

import { describe, it, expect } from 'vitest';
import { labelStripGeometry, RESIZE_BAND_REACH } from './CanvasNodeNameDisplay';

const rect = (left: number, top: number, width: number) => ({ left, top, width });

describe('labelStripGeometry', () => {
  it('spans the node’s full width, not the name’s', () => {
    expect(labelStripGeometry(rect(100, 200, 754)).width).toBe(754);
  });

  it('keeps a grabbable minimum on a very narrow node', () => {
    expect(labelStripGeometry(rect(0, 0, 20)).width).toBe(60);
  });

  it('anchors to the node’s left edge', () => {
    expect(labelStripGeometry(rect(137, 200, 300)).left).toBe(137);
  });

  it('sits ABOVE the node with its bottom clear of the resize band', () => {
    // The invariant that matters. A strip reaching into the band would steal
    // the top edge across the node's whole width — much worse than the sliver
    // the text-width strip took.
    const g = labelStripGeometry(rect(0, 500, 400));
    const bottom = g.top + g.height;
    expect(bottom).toBeLessThanOrEqual(500 - RESIZE_BAND_REACH);
  });

  it('does not float so far up that it detaches from its node', () => {
    // The other side of the same constant: clearance is worth 2px of gap, not
    // an arbitrary amount. Anything beyond ~8px reads as an unrelated label.
    const g = labelStripGeometry(rect(0, 500, 400));
    expect(500 - (g.top + g.height)).toBeLessThanOrEqual(8);
  });

  it('is one row tall regardless of the node', () => {
    expect(labelStripGeometry(rect(0, 0, 40)).height)
      .toBe(labelStripGeometry(rect(0, 0, 4000)).height);
  });
});
