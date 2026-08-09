// withResponsiveProps-resize.test.tsx — a window resize must cost ONE render
// per breakpoint crossing, not one per mouse move.
//
// User report 2026-08-09: resizing a window down to mobile and back left a
// design component's footer contents stranded and invisible. The HOC held the
// raw `window.innerWidth` in state and set it on every resize event, so a
// single drag re-rendered the whole component hundreds of times — each commit
// re-measuring a `layout` projection tree 30+ nodes deep while the variant's
// non-tweenable props (position/display) were mid-flight on motion's own loop.
// Only the resolved BUCKET can change what renders, so only the bucket belongs
// in state.

import { describe, it, expect, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import React from 'react';
import { withResponsiveProps } from '@revyme/runtime';

const RESPONSIVE = JSON.stringify({
  375: { initialVariant: 'variant-2' },
  768: { initialVariant: 'variant-1' },
  _bp: [375, 768, 1440],
});

let renders = 0;
let lastVariant: string | undefined;
function Probe(props: Record<string, any>) {
  renders++;
  lastVariant = props.initialVariant;
  return <div data-probe="root" />;
}
const Wrapped = withResponsiveProps(Probe as any) as any;

function setWidth(w: number) {
  (window as any).innerWidth = w;
}

beforeEach(() => {
  renders = 0;
  lastVariant = undefined;
  setWidth(1440);
});

/** Fire n resize events at the given width, as a drag would. */
async function drag(widths: number[]) {
  for (const w of widths) {
    setWidth(w);
    await act(async () => { window.dispatchEvent(new Event('resize')); });
  }
}

describe('withResponsiveProps — resize is bucketed to breakpoints', () => {
  it('resizes WITHIN one bucket cost nothing', async () => {
    render(<Wrapped data-responsive={RESPONSIVE} initialVariant="default" />);
    const after = renders;
    // 40 mouse-move-sized steps, all still above the 768 breakpoint.
    await drag([1400, 1350, 1300, 1200, 1100, 1000, 950, 900, 850, 800, 790, 780, 775, 770, 769]);
    expect(renders).toBe(after);
  });

  it('crossing a breakpoint renders, and resolves the new variant', async () => {
    render(<Wrapped data-responsive={RESPONSIVE} initialVariant="default" />);
    expect(lastVariant).toBe('default');
    await drag([700]);
    expect(lastVariant).toBe('variant-1');
  });

  it('one crossing costs a bounded number of renders, not one per event', async () => {
    // THE BUG: this used to be one render per resize event — 20 here, and
    // hundreds during a real drag.
    render(<Wrapped data-responsive={RESPONSIVE} initialVariant="default" />);
    const before = renders;
    // Ends at 375, not 376: buckets are `(prev, bp]` so they line up with
    // `@media (max-width: 375px)` — 376 still belongs to the 768 bucket.
    await drag([1200, 1000, 900, 800, 769, 760, 700, 600, 500, 400, 380, 375]);
    // Two crossings (→768 bucket, →375 bucket). Each costs the switch render
    // plus the flag-release render; nothing else in that 12-event drag renders.
    expect(renders - before).toBeLessThanOrEqual(4);
    expect(lastVariant).toBe('variant-2');
  });

  it('settles back to the primary above every breakpoint', async () => {
    render(<Wrapped data-responsive={RESPONSIVE} initialVariant="default" />);
    await drag([700, 300, 1500]);
    expect(lastVariant).toBe('default');
  });

  it('the canvas path ignores window width entirely', async () => {
    // Each canvas tile passes its own width; a browser resize must not
    // reshuffle the tiles.
    render(<Wrapped data-responsive={RESPONSIVE} initialVariant="default" __canvasViewportWidth={375} />);
    expect(lastVariant).toBe('variant-2');
    const after = renders;
    await drag([1400, 900, 700]);
    expect(renders).toBe(after);
    expect(lastVariant).toBe('variant-2');
  });

  it('a component with no data-responsive never re-renders on resize', async () => {
    render(<Wrapped initialVariant="default" />);
    const after = renders;
    await drag([1200, 800, 400]);
    expect(renders).toBe(after);
  });
});

describe('withResponsiveProps — bucket boundaries match the CSS', () => {
  // The buckets have to agree with the `@media (max-width: N)` rules the
  // editor writes for the SAME breakpoints, or a component and the page it
  // sits on disagree about which viewport they're in at the exact boundary.
  it.each([
    [1441, 'default'],
    [1440, 'default'],   // widest bp has no override entry → primary
    [769, 'default'],
    [768, 'variant-1'],  // inclusive upper edge
    [376, 'variant-1'],
    [375, 'variant-2'],  // inclusive upper edge
    [320, 'variant-2'],
  ])('width %i resolves to %s', async (width, expected) => {
    setWidth(width as number);
    render(<Wrapped data-responsive={RESPONSIVE} initialVariant="default" />);
    await act(async () => { window.dispatchEvent(new Event('resize')); });
    expect(lastVariant).toBe(expected);
  });
});
