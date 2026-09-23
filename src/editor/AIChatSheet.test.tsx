// The pop-out agent chat opens tall enough to read the conversation — the old
// 220px default left only the composer in view.
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import AIChatSheet from './AIChatSheet';

const tall = window.innerHeight;
const wide = window.innerWidth;
afterEach(() => {
  cleanup();
  Object.defineProperty(window, 'innerHeight', { value: tall, configurable: true });
  Object.defineProperty(window, 'innerWidth', { value: wide, configurable: true });
});

function opened(): { height: number; width: number; left: number } {
  const { container } = render(<AIChatSheet onClose={() => {}}><div /></AIChatSheet>);
  const el = container.firstElementChild as HTMLElement;
  return { height: parseFloat(el.style.height), width: parseFloat(el.style.width), left: parseFloat(el.style.left) };
}
const openedHeight = () => opened().height;

describe('AIChatSheet opening place', () => {
  it('opens at its narrowest width, just left of the right panel with a small gap', () => {
    Object.defineProperty(window, 'innerWidth', { value: 1400, configurable: true });
    const panel = document.createElement('div');
    panel.setAttribute('data-properties-panel', '');
    panel.getBoundingClientRect = () => ({ left: 1140, right: 1400, top: 52, bottom: 900, width: 260, height: 848, x: 1140, y: 52, toJSON() {} }) as DOMRect;
    document.body.appendChild(panel);
    const { width, left } = opened();
    panel.remove();
    expect(width).toBe(320);
    expect(left).toBe(1140 - 12 - 320);
  });

  it('no right panel measured: where it usually is (260px from the edge)', () => {
    Object.defineProperty(window, 'innerWidth', { value: 1400, configurable: true });
    expect(opened().left).toBe(1400 - 260 - 12 - 320);
  });
});

describe('AIChatSheet opening size', () => {
  it('opens 520px tall on a normal window', () => {
    Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true });
    expect(openedHeight()).toBe(520);
  });

  it('fits a short window (room kept for the top bar and the toolbar), never below the minimum', () => {
    Object.defineProperty(window, 'innerHeight', { value: 560, configurable: true });
    expect(openedHeight()).toBe(560 - 56 - 76);
    Object.defineProperty(window, 'innerHeight', { value: 300, configurable: true });
    expect(openedHeight()).toBe(300);
  });
});
