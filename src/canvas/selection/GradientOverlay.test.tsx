// GradientOverlay (linear) — no endpoint rotate dots and no edge-to-edge line:
// the line spans the stops, and rotating happens in invisible zones just beyond
// the outermost stops (user request 2026-10-16, the Framer behaviour).
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';
import GradientOverlay from './GradientOverlay';

beforeAll(() => {
  // jsdom has no pointer capture
  (Element.prototype as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {};
  (Element.prototype as unknown as { releasePointerCapture: () => void }).releasePointerCapture = () => {};
});
afterEach(() => cleanup());

const corners = { TL: { x: 0, y: 0 }, TR: { x: 200, y: 0 }, BR: { x: 200, y: 100 }, BL: { x: 0, y: 100 } };
const stops = [
  { id: 'a', color: '#000000', position: 25 },
  { id: 'b', color: '#e43225', position: 37 },
];

function mount(over: Record<string, unknown> = {}) {
  const onDirectionChange = vi.fn();
  const onCommit = vi.fn();
  const utils = render(
    <GradientOverlay corners={corners} localSize={{ w: 200, h: 100 }} gradientType="linear" stops={stops} selectedStopId={null}
      direction={180} centerX={50} centerY={50} radialShape="ellipse" radialSize="custom" angle={0} radiusX={50} radiusY={50}
      onDirectionChange={onDirectionChange} onCommit={onCommit} {...over} />,
  );
  return { ...utils, onDirectionChange, onCommit };
}

describe('linear gradient overlay', () => {
  it('draws the line from the first stop to the last — not edge to edge', () => {
    const { container } = mount();
    const line = container.querySelector('line')!;
    expect([line.getAttribute('y1'), line.getAttribute('y2')].map(v => Math.round(Number(v)))).toEqual([25, 37]);
  });

  it('has no visible rotate dots; two invisible rotate zones just beyond the end stops', () => {
    const { container } = mount();
    const circles = [...container.querySelectorAll('circle')];
    expect(circles.filter(c => c.getAttribute('fill') === '#ff6b6b')).toHaveLength(0);
    const zones = circles.filter(c => c.hasAttribute('data-gradient-rotate-zone'));
    expect(zones.map(z => Math.round(Number(z.getAttribute('cy'))))).toEqual([5, 57]);
    for (const z of zones) {
      expect(z.getAttribute('fill')).toBe('transparent');
      expect((z as SVGElement).style.cursor).toContain('svg');   // the rotate cursor glyph
    }
  });

  it('dragging a zone rotates by the pointer\'s turn and commits once', () => {
    const { container, onDirectionChange, onCommit } = mount();
    const after = container.querySelector('[data-gradient-rotate-zone="after"]')!;
    fireEvent.pointerDown(after, { clientX: 100, clientY: 57, pointerId: 1 });
    fireEvent.pointerMove(after, { clientX: 20, clientY: 50, pointerId: 1 });
    fireEvent.pointerUp(after, { pointerId: 1 });
    expect(onDirectionChange).toHaveBeenLastCalledWith(270);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('read-only (no direction callback): no rotate zones', () => {
    const { container } = mount({ onDirectionChange: undefined });
    expect(container.querySelectorAll('[data-gradient-rotate-zone]')).toHaveLength(0);
  });
});
