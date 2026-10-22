import { describe, it, expect } from 'vitest';
import { isShortcutKey, physicalShortcutKey } from './shortcut-key';

const ev = (key: string, code: string, altKey = false) => ({ key, code, altKey });

describe('isShortcutKey — any keyboard layout', () => {
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
