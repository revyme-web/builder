// A pinch inside the canvas iframe (text / vector edit makes it take clicks)
// must zoom the CANVAS, never the browser page: the forwarder swallows it and
// hands it to the parent's camera.
import { describe, it, expect, vi } from 'vitest';
import { installWheelForwarding, type ForwardedWheel } from './wheel-forward';

function wheel(init: WheelEventInit): WheelEvent {
  const e = new WheelEvent('wheel', { cancelable: true, bubbles: true, ...init });
  window.dispatchEvent(e);
  return e;
}

describe('installWheelForwarding', () => {
  it('a trackpad pinch (ctrl-wheel) is swallowed and posted to the parent', () => {
    const post = vi.fn<(m: ForwardedWheel) => void>();
    const dispose = installWheelForwarding(window, post);
    const e = wheel({ ctrlKey: true, deltaY: -4, deltaMode: 0, clientX: 120, clientY: 80 });
    dispose();

    expect(e.defaultPrevented).toBe(true);   // the browser never zooms the page
    expect(post).toHaveBeenCalledWith({
      type: 'wheel', deltaX: 0, deltaY: -4, deltaMode: 0,
      ctrlKey: true, metaKey: false, clientX: 120, clientY: 80,
    });
  });

  it('a plain two-finger scroll is forwarded too — it pans the canvas, as outside edit mode', () => {
    const post = vi.fn<(m: ForwardedWheel) => void>();
    const dispose = installWheelForwarding(window, post);
    const e = wheel({ deltaX: 12, deltaY: 30 });
    dispose();

    expect(e.defaultPrevented).toBe(true);
    expect(post.mock.calls[0][0]).toMatchObject({ deltaX: 12, deltaY: 30, ctrlKey: false });
  });

  it('carries deltaMode, so a Firefox mouse wheel (lines) keeps the wheel zoom speed', () => {
    const post = vi.fn<(m: ForwardedWheel) => void>();
    const dispose = installWheelForwarding(window, post);
    wheel({ metaKey: true, deltaY: 3, deltaMode: 1 });
    dispose();
    expect(post.mock.calls[0][0]).toMatchObject({ deltaMode: 1, metaKey: true });
  });

  it('the disposer detaches it', () => {
    const post = vi.fn();
    installWheelForwarding(window, post)();
    const e = wheel({ ctrlKey: true, deltaY: -4 });
    expect(post).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });
});
