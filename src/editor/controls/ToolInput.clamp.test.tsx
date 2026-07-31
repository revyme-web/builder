// ToolInput.clamp.test.tsx — EMPIRICAL PIN, live find 2026-07-14: the Radius
// control's global input scrubbed to -60. The chevron drag/hold/arrow paths
// bypassed any clamp (SpacingControl only clamped the segmented inputs), so a
// downward drag ran past 0 into negative radius. ToolInput now takes `min`/
// `max` and clamps BOTH the emitted values and the drag ref (so the drag
// sticks at the floor with no invisible overshoot).

import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import React from 'react';
import ToolInput from './ToolInput';

describe('ToolInput min clamp (scrub floor)', () => {
  it('arrow-down at the floor stays at min', () => {
    const onChange = vi.fn();
    const { container } = render(
      <ToolInput value="0px" onChange={onChange} min={0} />,
    );
    const input = container.querySelector('input')!;
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(onChange).toHaveBeenCalledWith('0px');
    expect(onChange).not.toHaveBeenCalledWith('-1px');
  });

  it('arrow-down from 2 with shift (step 10) clamps to min instead of -8', () => {
    const onChange = vi.fn();
    const { container } = render(
      <ToolInput value="2px" onChange={onChange} min={0} />,
    );
    const input = container.querySelector('input')!;
    fireEvent.keyDown(input, { key: 'ArrowDown', shiftKey: true });
    expect(onChange).toHaveBeenCalledWith('0px');
  });

  it('without min, arrow-down goes negative (margins keep working)', () => {
    const onChange = vi.fn();
    const { container } = render(
      <ToolInput value="0px" onChange={onChange} />,
    );
    const input = container.querySelector('input')!;
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(onChange).toHaveBeenCalledWith('-1px');
  });

  it('max clamps upward nudges symmetrically', () => {
    const onChange = vi.fn();
    const { container } = render(
      <ToolInput value="100" onChange={onChange} max={100} />,
    );
    const input = container.querySelector('input')!;
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(onChange).toHaveBeenCalledWith('100');
  });
});
