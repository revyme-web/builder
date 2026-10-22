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

  it('a Latin letter is matched by e.key only — the physical key never overrides it', () => {
    const handler = vi.fn();
    unregs.push(keyboard.register({ key: 'z', category: 'general', handler }));
    // e.key is a different LATIN letter → no physical fallback → no fire
    fire({ key: 'x', code: 'KeyZ', altKey: false });
    expect(handler).not.toHaveBeenCalled();
    // e.key matches → fires normally
    fire({ key: 'z', code: 'KeyZ', altKey: false });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

// User report 2026-10-22: Shift+A (Create Layout) did nothing on a non-English
// layout — Russian Shift+A types "Ф", which never equals 'a'. A non-Latin
// letter falls back to the physical key; Latin layouts keep their letters.
describe('KeyboardManager — non-Latin layouts', () => {
  let stop: () => void;
  const unregs: Array<() => void> = [];
  beforeEach(() => { stop = keyboard.listen(); });
  afterEach(() => { unregs.forEach((u) => u()); unregs.length = 0; stop(); });

  const fire = (init: KeyboardEventInit) =>
    window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));

  it('Russian Shift+A ("Ф", code KeyA) fires Create Layout', () => {
    const handler = vi.fn();
    unregs.push(keyboard.register({ key: 'a', shift: true, category: 'structure', handler }));
    fire({ key: 'Ф', code: 'KeyA', shiftKey: true });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('Russian F ("а", code KeyF) fires the Frame tool, not an A shortcut', () => {
    const frame = vi.fn();
    const a = vi.fn();
    unregs.push(keyboard.register({ key: 'f', category: 'tools', handler: frame }));
    unregs.push(keyboard.register({ key: 'a', category: 'tools', handler: a }));
    fire({ key: 'а', code: 'KeyF' });
    expect(frame).toHaveBeenCalledTimes(1);
    expect(a).not.toHaveBeenCalled();
  });

  it('AZERTY Shift+A (code KeyQ) still fires; AZERTY "," (code KeyM) fires nothing', () => {
    const a = vi.fn();
    const m = vi.fn();
    unregs.push(keyboard.register({ key: 'a', shift: true, category: 'structure', handler: a }));
    unregs.push(keyboard.register({ key: 'm', category: 'tools', handler: m }));
    fire({ key: 'A', code: 'KeyQ', shiftKey: true });
    fire({ key: ',', code: 'KeyM' });
    expect(a).toHaveBeenCalledTimes(1);
    expect(m).not.toHaveBeenCalled();
  });

  it('Cmd/Ctrl shortcuts work on a Cyrillic layout too (Ctrl+"с" = Copy)', () => {
    const handler = vi.fn();
    unregs.push(keyboard.register({ key: 'c', ctrl: true, category: 'general', handler }));
    fire({ key: 'с', code: 'KeyC', ctrlKey: true });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
