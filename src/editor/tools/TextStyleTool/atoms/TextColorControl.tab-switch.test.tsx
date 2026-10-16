// Text colour Solid → Gradient showed a black→white gradient but kept the text
// solid until a stop was touched (2026-10-16, same cause as the Fill popup:
// the editor's default was display-only). The switch now applies it.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, act, cleanup, fireEvent } from '@testing-library/react';
import React, { useRef } from 'react';
import ToolPopup from '../../../ui/ToolPopup';
import { TextColorPopupContent } from './TextColorControl';
import { formatGradient, createDefaultGradient } from '@/shared/gradient-utils';

class RO { observe() {} unobserve() {} disconnect() {} }
(globalThis as unknown as { ResizeObserver: typeof RO }).ResizeObserver ??= RO;
afterEach(() => cleanup());

function mount(styles: Record<string, string>, onGradientChange = vi.fn()) {
  function Harness() {
    const anchor = useRef<HTMLDivElement>(null);
    return (
      <>
        <div ref={anchor} />
        <ToolPopup isOpen onClose={() => {}} title="Color" anchorRef={anchor}>
          <TextColorPopupContent
            styles={styles} isEditing={false} currentValue={styles.color ?? ''} initialTab="solid"
            onColorChange={vi.fn()} onColorCommit={vi.fn()} onGradientChange={onGradientChange}
            onGradientLiveChange={vi.fn()} onClearGradient={vi.fn()}
          />
        </ToolPopup>
      </>
    );
  }
  render(<Harness />);
  const tab = [...document.querySelectorAll('[data-tool-popup] button')].find((b) => b.textContent === 'Gradient')!;
  act(() => { fireEvent.click(tab); });
  return onGradientChange;
}

describe('Text colour — Solid → Gradient', () => {
  it('applies the default black→white gradient the editor shows', () => {
    const onGradientChange = mount({ color: '#222222' });
    expect(onGradientChange).toHaveBeenCalledTimes(1);
    expect(onGradientChange).toHaveBeenCalledWith(formatGradient(createDefaultGradient()));
  });

  it('keeps a gradient the text already has instead of resetting it', () => {
    const onGradientChange = mount({ background: 'linear-gradient(90deg, #ff0000 0%, #0000ff 100%)', color: 'transparent' });
    expect(onGradientChange).not.toHaveBeenCalled();
  });
});
