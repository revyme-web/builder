import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { keyboard } from './KeyboardManager';

// macOS composes Option/Alt+letter into a symbol (Option+R → "®"), so a pure-Alt
// shortcut's e.key never equals its letter. The manager falls back to the PHYSICAL
// key (e.code) when Alt is held so Alt-letter shortcuts (Rename Alt+R, Create Frame
// Shift+Alt+A) still fire on Mac.
describe('KeyboardManager — Alt physical-key fallback (macOS Option compose)', () => {
  let stop: () => void;
  const unregs: Array<() => void> = [];
  beforeEach(() => { stop = keyboard.listen(); });
  afterEach(() => { unregs.forEach((u) => u()); unregs.length = 0; stop(); });

  const fire = (init: KeyboardEventInit) =>
    window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));

  it('fires Alt+R when e.key is the composed symbol "®" (e.code = KeyR)', () => {
    const handler = vi.fn();
    unregs.push(keyboard.register({ key: 'r', alt: true, category: 'general', handler }));
    fire({ key: '®', code: 'KeyR', altKey: true });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('also fires when the layout does NOT compose (e.key === "r")', () => {
    const handler = vi.fn();
    unregs.push(keyboard.register({ key: 'r', alt: true, category: 'general', handler }));
    fire({ key: 'r', code: 'KeyR', altKey: true });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire the Alt shortcut when Alt is not held', () => {
    const handler = vi.fn();
    unregs.push(keyboard.register({ key: 'r', alt: true, category: 'general', handler }));
    fire({ key: 'r', code: 'KeyR', altKey: false });
    expect(handler).not.toHaveBeenCalled();
  });

  it('the physical-key fallback only applies under Alt — a non-Alt shortcut still matches e.key only', () => {
    const handler = vi.fn();
    unregs.push(keyboard.register({ key: 'z', category: 'general', handler }));
    // e.key mismatched, no Alt → no code fallback → no fire
    fire({ key: 'x', code: 'KeyZ', altKey: false });
    expect(handler).not.toHaveBeenCalled();
    // e.key matches → fires normally
    fire({ key: 'z', code: 'KeyZ', altKey: false });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
