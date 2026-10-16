// Switching the Fill popup to Gradient left the frame TRANSPARENT: the tab
// change cleared the old fill, and the gradient editor's black→white default
// was display-only until a stop was touched (user report 2026-10-16). The
// switch now applies what the new tab shows; Color likewise applies #000000.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, act, cleanup, fireEvent } from '@testing-library/react';
import React, { useRef } from 'react';
import ToolPopup from '../../../ui/ToolPopup';
import { SingleModeFillContent } from './FillControl';
import { formatGradient, createDefaultGradient } from '@/shared/gradient-utils';

class RO { observe() {} unobserve() {} disconnect() {} }
(globalThis as unknown as { ResizeObserver: typeof RO }).ResizeObserver ??= RO;
afterEach(() => cleanup());

const DEFAULT = formatGradient(createDefaultGradient());

function Harness({ styles, onUpdate }: { styles: Record<string, string>; onUpdate: (k: string, v: string) => void }) {
  const anchor = useRef<HTMLDivElement>(null);
  return (
    <>
      <div ref={anchor} />
      <ToolPopup isOpen onClose={() => {}} title="Fill" anchorRef={anchor}>
        <SingleModeFillContent styles={styles} onUpdate={onUpdate} />
      </ToolPopup>
    </>
  );
}

/** Mount, click a tab, return the writes as an ordered [key, value] list. */
function switchTo(styles: Record<string, string>, tab: string): [string, string][] {
  const onUpdate = vi.fn();
  render(<Harness styles={styles} onUpdate={onUpdate} />);
  const btn = [...document.querySelectorAll('[data-tool-popup] button')].find((b) => b.textContent === tab)!;
  act(() => { fireEvent.click(btn); });
  return onUpdate.mock.calls as [string, string][];
}

/** The value each key ends at (later writes win, as in the mutation queue). */
const final = (writes: [string, string][]) => Object.fromEntries(writes);

describe('Fill popup — switching tabs applies what the new tab shows', () => {
  it('Color → Gradient paints the default black→white gradient', () => {
    const f = final(switchTo({ backgroundColor: '#ff0000' }, 'Gradient'));
    expect(f.backgroundColor).toBe('');
    expect(f.backgroundImage).toBe(DEFAULT);
    expect(DEFAULT).toMatch(/^linear-gradient\(180deg, #000000 0%, #ffffff 100%\)$/);
  });

  it('Image → Gradient replaces the picture with the gradient', () => {
    const f = final(switchTo({ backgroundImage: 'url(https://a/x.png)', backgroundSize: 'cover' }, 'Gradient'));
    expect(f.backgroundImage).toBe(DEFAULT);
    expect(f.backgroundSize).toBe('');
  });

  it('a `background` shorthand is cleared BEFORE the gradient lands (it would wipe the longhand)', () => {
    const writes = switchTo({ backgroundImage: 'url(https://a/x.png)', background: '#123456' }, 'Gradient');
    const bg = writes.findIndex(([k, v]) => k === 'background' && v === '');
    const img = writes.findIndex(([k, v]) => k === 'backgroundImage' && v === DEFAULT);
    expect(bg).toBeGreaterThanOrEqual(0);
    expect(img).toBeGreaterThan(bg);
  });

  it('Gradient → Color applies the #000000 the picker shows', () => {
    const f = final(switchTo({ backgroundImage: 'linear-gradient(90deg, #ff0000 0%, #0000ff 100%)' }, 'Color'));
    expect(f.backgroundImage).toBe('');
    expect(f.backgroundColor).toBe('#000000');
  });

  it('Gradient → Image applies nothing (the image tab starts empty)', () => {
    const f = final(switchTo({ backgroundImage: 'linear-gradient(90deg, #ff0000 0%, #0000ff 100%)' }, 'Image'));
    expect(f.backgroundImage).toBe('');
    expect(f.backgroundColor).toBeUndefined();
  });
});

// Image → Gradient → Cmd+Z put the image back while the popup stayed on
// Gradient (2026-10-16): the tab follows a fill that changes from OUTSIDE —
// but never an EMPTY one, which is the user choosing a tab.
describe('Fill popup — the tab follows external fill changes', () => {
  const GRADIENT = { backgroundImage: 'linear-gradient(90deg, #ff0000 0%, #0000ff 100%)' };
  const IMAGE = { backgroundImage: 'url(https://a/x.png)', backgroundSize: 'cover' };
  const has = (text: string) => [...document.querySelectorAll('[data-tool-popup] *')].some((el) => el.textContent === text);
  const onGradientTab = () => has('Linear');
  const onColorTab = () => has('HEX') && !onGradientTab();

  it('an undo that brings the image back moves the popup to the Image tab', () => {
    const onUpdate = vi.fn();
    const { rerender } = render(<Harness styles={GRADIENT} onUpdate={onUpdate} />);
    expect(onGradientTab()).toBe(true);
    rerender(<Harness styles={IMAGE} onUpdate={onUpdate} />);
    expect(onGradientTab()).toBe(false);
    expect(onColorTab()).toBe(false);
  });

  it('a colour coming back moves it to the Color tab', () => {
    const onUpdate = vi.fn();
    const { rerender } = render(<Harness styles={GRADIENT} onUpdate={onUpdate} />);
    rerender(<Harness styles={{ backgroundColor: '#ff0000' }} onUpdate={onUpdate} />);
    expect(onGradientTab()).toBe(false);   // the gradient tab has a HEX field too (its stop picker)
    expect(onColorTab()).toBe(true);
  });

  it('picking the EMPTY Image tab is not bounced back to Color', () => {
    const onUpdate = vi.fn();
    const { rerender } = render(<Harness styles={GRADIENT} onUpdate={onUpdate} />);
    const image = [...document.querySelectorAll('[data-tool-popup] button')].find((b) => b.textContent === 'Image')!;
    act(() => { fireEvent.click(image); });
    rerender(<Harness styles={{}} onUpdate={onUpdate} />);   // the gradient was cleared
    expect(onGradientTab()).toBe(false);
    expect(onColorTab()).toBe(false);
  });
});
