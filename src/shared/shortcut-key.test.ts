import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { isShortcutKey, physicalShortcutKey, learnLatinKeys, watchKeyboardLayout, resetKeyboardLayoutForTests } from './shortcut-key';

const ev = (key: string, code: string, altKey = false) => ({ key, code, altKey });

describe('isShortcutKey — any keyboard layout', () => {
  beforeEach(() => resetKeyboardLayoutForTests());

  it('US layout: the typed letter', () => {
    expect(isShortcutKey(ev('a', 'KeyA'), 'a')).toBe(true);
    expect(isShortcutKey(ev('A', 'KeyA'), 'a')).toBe(true); // Shift+A
  });

  it('Russian: Shift+A types "Ф" — the physical A key still counts', () => {
    expect(isShortcutKey(ev('Ф', 'KeyA'), 'a')).toBe(true);
    expect(isShortcutKey(ev('ф', 'KeyA'), 'a')).toBe(true);
    expect(isShortcutKey(ev('а', 'KeyF'), 'f')).toBe(true); // Cyrillic а on the F key
    expect(isShortcutKey(ev('а', 'KeyF'), 'a')).toBe(false); // not the Latin a
  });

  it('Greek, Hebrew and Korean letters fall back to the physical key', () => {
    expect(isShortcutKey(ev('α', 'KeyA'), 'a')).toBe(true);
    expect(isShortcutKey(ev('ש', 'KeyA'), 'a')).toBe(true);
    expect(isShortcutKey(ev('ㅁ', 'KeyA'), 'a')).toBe(true);
  });

  it('AZERTY keeps its printed letters: A is on code KeyQ, Q on code KeyA', () => {
    expect(isShortcutKey(ev('a', 'KeyQ'), 'a')).toBe(true);
    expect(isShortcutKey(ev('q', 'KeyA'), 'a')).toBe(false);
  });

  it('punctuation never falls back — AZERTY "," sits on code KeyM', () => {
    expect(physicalShortcutKey(ev(',', 'KeyM'))).toBeNull();
    expect(isShortcutKey(ev(',', 'KeyM'), 'm')).toBe(false);
  });

  it('Alt: the composed macOS symbol falls back to the physical key', () => {
    expect(isShortcutKey(ev('®', 'KeyR', true), 'r')).toBe(true);
    expect(isShortcutKey(ev('Å', 'KeyA', true), 'a')).toBe(true);
  });

  it('IME "Process" falls back to the physical key', () => {
    expect(isShortcutKey(ev('Process', 'KeyK'), 'k')).toBe(true);
  });

  it('digits: an accented letter on the number row reads as its digit', () => {
    expect(physicalShortcutKey(ev('é', 'Digit2'))).toBe('2'); // AZERTY / Czech
  });

  it('named keys and keys outside letters/digits have no physical key', () => {
    expect(physicalShortcutKey(ev('Escape', 'Escape'))).toBeNull();
    expect(physicalShortcutKey(ev('ñ', 'Semicolon'))).toBeNull(); // Spanish
    expect(isShortcutKey(ev('Escape', 'Escape'), 'escape')).toBe(true);
  });
});

// User report 2026-10-23: on a French (AZERTY) Mac the key printed "A" is code
// KeyQ; on the Russian layout it types "Й", and a US reading made Shift+A into
// Shift+Q. The physical key reads as the user's OWN Latin layout.
describe('physical key = the letter printed on the user\'s keyboard', () => {
  beforeEach(() => resetKeyboardLayoutForTests());
  afterEach(() => { resetKeyboardLayoutForTests(); vi.unstubAllGlobals(); });

  it('AZERTY + Russian: the key printed A (code KeyQ, types "Й") is A', () => {
    learnLatinKeys([['KeyQ', 'a'], ['KeyA', 'q']]);
    expect(isShortcutKey(ev('Й', 'KeyQ'), 'a')).toBe(true);
    expect(isShortcutKey(ev('Ф', 'KeyA'), 'a')).toBe(false); // that one is printed Q
    expect(isShortcutKey(ev('Ф', 'KeyA'), 'q')).toBe(true);
  });

  it('a US guess is dropped when the user\'s layout has that letter on another key', () => {
    learnLatinKeys([['Semicolon', 'm']]); // AZERTY M
    expect(physicalShortcutKey(ev('ь', 'KeyM'))).toBeNull(); // AZERTY "," key
    expect(physicalShortcutKey(ev('ж', 'Semicolon'))).toBe('m');
  });

  it('a letter lives on one key — switching back to US typing moves it back', () => {
    learnLatinKeys([['KeyQ', 'a']]);
    learnLatinKeys([['KeyA', 'a']]);
    expect(physicalShortcutKey(ev('Ф', 'KeyA'))).toBe('a');
    expect(physicalShortcutKey(ev('Й', 'KeyQ'))).toBe('q'); // unknown again → US
  });

  it('Alt on AZERTY: Shift+Option + the key printed A (code KeyQ) is A', () => {
    learnLatinKeys([['KeyQ', 'a']]);
    expect(isShortcutKey(ev('Æ', 'KeyQ', true), 'a')).toBe(true);
  });

  it('survives a reload (localStorage)', async () => {
    learnLatinKeys([['KeyQ', 'a']]);
    vi.resetModules();
    const fresh = await import('./shortcut-key');
    expect(fresh.physicalShortcutKey(ev('Й', 'KeyQ'))).toBe('a');
  });

  it('watchKeyboardLayout learns from plain typing, not from Cmd/Ctrl/Alt combos', () => {
    const stop = watchKeyboardLayout();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyQ' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', code: 'KeyW', metaKey: true }));
    stop();
    expect(physicalShortcutKey(ev('Й', 'KeyQ'))).toBe('a');
    expect(physicalShortcutKey(ev('Ц', 'KeyW'))).toBe('w'); // the Cmd combo taught nothing
  });

  it('watchKeyboardLayout reads Chrome\'s layout map, keeping only Latin letters', async () => {
    vi.stubGlobal('navigator', { ...navigator, keyboard: { getLayoutMap: async () => new Map([['KeyQ', 'a'], ['KeyA', 'q'], ['KeyM', ','], ['KeyW', 'ц']]) } });
    const stop = watchKeyboardLayout();
    await new Promise((r) => setTimeout(r, 0));
    stop();
    expect(physicalShortcutKey(ev('Й', 'KeyQ'))).toBe('a');
    expect(physicalShortcutKey(ev('Ц', 'KeyW'))).toBe('w'); // "ц" isn't Latin — not learned
  });
});
