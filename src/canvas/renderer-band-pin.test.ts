// renderer-band-pin.test.ts — END-TO-END jsdom reproduction of the viewport-drag
// band-pin behavior: a node whose alignment lives ONLY in the mobile band must
// keep painting it through the whole gesture (rest → pinned mousedown render →
// pinned crossing render at a live width). Written to pin down the "counter
// container loses justify/align center during resize" report with REAL renders
// instead of theory.

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { renderNodes } from './Renderer';
import { parseJSXToNodes } from '@/code/parsing/parser';
import { viewportBandPinOps } from './resize/viewport-band-pin-store';
import type { ViewportConfig } from '@/shared/types';

const PAGE = `'use client';
import AnimatedCounter from '@/components/AnimatedCounter';
export default function Page() {
  return <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%', display: 'flex', flexDirection: 'column' }}>
    <style>{\`
    @media (max-width: 314px) {
      [data-id="counter-1"] { align-items: center !important; justify-content: center !important; flex-direction: column !important; }
      [data-id="AnimatedCounter-x1"] { width: 88px !important; }
    }
  \`}</style>
    <div data-id="counter-1" data-name="Counters" style={{ display: 'flex', flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'flex-start', width: '100%' }}>
      <p data-id="text-1" data-name="Text" style={{ fontSize: '16px' }}>{useResponsiveText("Primary text", { 314: "Mobile text" }, [1440, 564, 314])}</p>
      <AnimatedCounter fontSize={40} endValue={120} data-id="AnimatedCounter-x1" data-name="Counter" style={{ width: '131px', height: '48px', flex: '0 0 auto', position: 'relative' }}></AnimatedCounter>
    </div>
  </div>;
}
function useResponsiveText(primary, overrides, vpWidths) { return primary; }
`;

const VIEWPORTS = (mobileW: number): ViewportConfig[] => [
  { id: 'desktop', label: 'Desktop', width: 1440, isPrimary: true, order: 0, x: 0, y: 0 },
  { id: 'tablet', label: 'Tablet', width: 564, isPrimary: false, order: 1, x: 1540, y: 0 },
  { id: 'mobile', label: 'Mobile', width: mobileW, isPrimary: false, order: 2, x: 2200, y: 0 },
];

function mobileEl(container: HTMLElement, id: string): HTMLElement {
  const root = container.querySelector('[data-viewport="mobile"]') as HTMLElement;
  expect(root).toBeTruthy();
  if (root.getAttribute('data-id') === id) return root;
  const el = root.querySelector(`[data-id="${id}"]`) as HTMLElement;
  expect(el).toBeTruthy();
  return el;
}

describe('viewport-drag band pin — end-to-end renders', () => {
  let container: HTMLDivElement;
  const noop = () => {};

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });
  afterEach(() => {
    viewportBandPinOps.clear();
    container.remove();
  });

  const render = (mobileW: number) => {
    const nodes = parseJSXToNodes(PAGE);
    renderNodes(container, nodes, null, noop, VIEWPORTS(mobileW), PAGE);
  };

  test('REST render: band values are merged INLINE on the mobile tile (parity)', () => {
    render(314);
    const counters = mobileEl(container, 'counter-1');
    expect(counters.style.alignItems).toBe('center');
    expect(counters.style.justifyContent).toBe('center');
    expect(counters.style.flexDirection).toBe('column');
    const text = mobileEl(container, 'text-1');
    expect(text.textContent).toBe('Mobile text');
    // Other tiles keep base.
    const desktopCounters = container.querySelector('[data-viewport="desktop"] [data-id="counter-1"]') as HTMLElement;
    expect(desktopCounters.style.alignItems).toBe('flex-start');
  });

  test('PINNED mousedown render: inline band values and override text survive; container queries off', () => {
    render(314);
    viewportBandPinOps.set('mobile', 314);
    render(314); // the mousedown pinned render (same width)
    const root = container.querySelector('[data-viewport="mobile"]') as HTMLElement;
    expect(root.style.containerType).toBe('normal');
    const counters = mobileEl(container, 'counter-1');
    expect(counters.style.alignItems).toBe('center');
    expect(counters.style.justifyContent).toBe('center');
    expect(mobileEl(container, 'text-1').textContent).toBe('Mobile text');
  });

  test('PINNED crossing render at a LIVE width: page nodes still resolve at the pin width', () => {
    render(314);
    viewportBandPinOps.set('mobile', 314);
    render(314);
    // Crossing: live width 380 (past the 375-ish boundary), pin still 314.
    viewportBandPinOps.updateLiveWidth(380);
    render(380);
    const counters = mobileEl(container, 'counter-1');
    expect(counters.style.alignItems).toBe('center');
    expect(counters.style.justifyContent).toBe('center');
    expect(counters.style.flexDirection).toBe('column');
    expect(mobileEl(container, 'text-1').textContent).toBe('Mobile text');
    // The CODE-COMPONENT CONTAINER keeps its band width inline — this branch
    // was the one patch path without the band merge (the real "counters lose
    // center during resize": containers snapped 88px→base when the pin turned
    // band CSS off).
    expect(mobileEl(container, 'AnimatedCounter-x1').style.width).toBe('88px');
    const root = container.querySelector('[data-viewport="mobile"]') as HTMLElement;
    expect(root.style.containerType).toBe('normal');
  });

  test('pin CLEARED (mouseup commit): everything resolves at the final width', () => {
    render(314);
    viewportBandPinOps.set('mobile', 314);
    viewportBandPinOps.updateLiveWidth(380);
    render(380);
    viewportBandPinOps.clear();
    render(462); // committed final width — bands renamed in real flow; here 462 > 314 band
    const counters = mobileEl(container, 'counter-1');
    // Band keyed 314 no longer matches 462 → base shows (the real flow renames
    // the band to 462 first; this test only checks the pin released).
    expect(counters.style.alignItems).toBe('flex-start');
    const root = container.querySelector('[data-viewport="mobile"]') as HTMLElement;
    expect(root.style.containerType).toBe('inline-size');
  });
});
