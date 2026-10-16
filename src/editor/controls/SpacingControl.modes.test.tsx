// SpacingControl modes (user request 2026-10-16): for padding + margin the
// corners button steps one value → X / Y (left+right, top+bottom) → all four,
// and its icon shows two corners for X / Y, four for per-side. Radius has no
// axes and keeps the two-state toggle.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';
import SpacingControl, { detectSpacingMode, nextSpacingMode, applyAxisValue } from './SpacingControl';

afterEach(() => cleanup());
type Sides = [string, string, string, string];

describe('mode helpers', () => {
  it('reads one value, matched pairs, or four sides', () => {
    expect(detectSpacingMode(['8px', '8px', '8px', '8px'], true)).toBe('uniform');
    expect(detectSpacingMode(['10px', '30px', '10px', '30px'], true)).toBe('axis');
    expect(detectSpacingMode(['10px', '30px', '12px', '30px'], true)).toBe('individual');
    expect(detectSpacingMode(['10px', '30px', '10px', '30px'], false)).toBe('individual');   // radius: no axes
  });
  it('the corners button: uniform → X / Y → four → X / Y; without axes, straight to four', () => {
    expect(nextSpacingMode('uniform', true)).toBe('axis');
    expect(nextSpacingMode('axis', true)).toBe('individual');
    expect(nextSpacingMode('individual', true)).toBe('axis');
    expect(nextSpacingMode('uniform', false)).toBe('individual');
  });
  it('an X edit writes right + left, a Y edit top + bottom', () => {
    expect(applyAxisValue(['1px', '2px', '3px', '4px'], 'x', '9px')).toEqual(['1px', '9px', '3px', '9px']);
    expect(applyAxisValue(['1px', '2px', '3px', '4px'], 'y', '9px')).toEqual(['9px', '2px', '9px', '4px']);
  });
});

function mount(values: Sides, axes = true) {
  const onChange = vi.fn(), onChangeAll = vi.fn(), onChangeSides = vi.fn();
  const utils = render(
    <SpacingControl values={values} labels={axes ? ['T', 'R', 'B', 'L'] : ['TL', 'TR', 'BR', 'BL']}
      onChange={onChange} onChangeAll={onChangeAll} onChangeSides={axes ? onChangeSides : undefined} />,
  );
  const corners = () => utils.container.querySelector('[data-spacing-mode]') as HTMLButtonElement;
  const segments = () => utils.container.querySelectorAll('input[type="text"]:not([data-spacing-axis])').length - 1;   // minus the global input
  return { ...utils, onChange, onChangeAll, onChangeSides, corners, segments };
}

describe('SpacingControl — padding / margin', () => {
  it('first click opens X / Y, the second all four, the third back to X / Y', () => {
    const m = mount(['8px', '8px', '8px', '8px']);
    expect(m.corners().dataset.spacingMode).toBe('uniform');
    fireEvent.click(m.corners());
    expect(m.corners().dataset.spacingMode).toBe('axis');
    expect(m.container.querySelectorAll('[data-spacing-axis]')).toHaveLength(2);
    fireEvent.click(m.corners());
    expect(m.corners().dataset.spacingMode).toBe('individual');
    expect(m.container.querySelectorAll('[data-spacing-axis]')).toHaveLength(0);
    expect(m.segments()).toBe(4);
    fireEvent.click(m.corners());
    expect(m.corners().dataset.spacingMode).toBe('axis');
  });

  it('the icon shows two corners for X / Y and four for per-side', () => {
    const m = mount(['8px', '8px', '8px', '8px']);
    const corners = () => (m.corners().querySelector('path')!.getAttribute('d')!.match(/[Mm]/g) ?? []).length;
    fireEvent.click(m.corners());
    expect(corners()).toBe(2);
    fireEvent.click(m.corners());
    expect(corners()).toBe(4);
  });

  it('opens on X / Y when the values are matched pairs, labelled and showing their unit', () => {
    const m = mount(['10px', '30px', '10px', '30px']);
    expect(m.corners().dataset.spacingMode).toBe('axis');
    const x = m.container.querySelector('[data-spacing-axis="x"]') as HTMLInputElement;
    const y = m.container.querySelector('[data-spacing-axis="y"]') as HTMLInputElement;
    expect([x.value, y.value]).toEqual(['30', '10']);
    expect(m.container.textContent).toContain('Xpx');
    expect(m.container.textContent).toContain('Ypx');
  });

  it('an X edit writes both horizontal sides in ONE call', () => {
    const m = mount(['10px', '30px', '10px', '30px']);
    const x = m.container.querySelector('[data-spacing-axis="x"]') as HTMLInputElement;
    fireEvent.focus(x);
    fireEvent.change(x, { target: { value: '44' } });
    fireEvent.blur(x);
    expect(m.onChangeSides).toHaveBeenCalledTimes(1);
    expect(m.onChangeSides).toHaveBeenCalledWith(['10px', '44px', '10px', '44px']);
    expect(m.onChange).not.toHaveBeenCalled();
  });

  it('a pair that differs shows "Mixed" and leaving it untouched writes nothing', () => {
    const m = mount(['10px', '30px', '12px', '30px']);
    fireEvent.click(m.corners());   // individual → X / Y
    const y = m.container.querySelector('[data-spacing-axis="y"]') as HTMLInputElement;
    expect(y.value).toBe('');
    expect(y.placeholder).toBe('Mixed');
    fireEvent.focus(y);
    fireEvent.blur(y);
    expect(m.onChangeSides).not.toHaveBeenCalled();
  });
});

describe('SpacingControl — radius (no axes)', () => {
  it('the corners button goes straight to four corners, with the four-corner icon', () => {
    const m = mount(['8px', '8px', '8px', '8px'], false);
    fireEvent.click(m.corners());
    expect(m.corners().dataset.spacingMode).toBe('individual');
    expect(m.container.querySelectorAll('[data-spacing-axis]')).toHaveLength(0);
    expect((m.corners().querySelector('path')!.getAttribute('d')!.match(/[Mm]/g) ?? []).length).toBe(4);
  });
});
