// shortcut-key.ts — Which shortcut key a keydown means, on any keyboard layout.
//
// Shortcuts match e.key (the character the layout typed) first, so a Latin
// layout keeps its printed letters: AZERTY's A key is code KeyQ, and matching
// the physical key there would move every shortcut. The PHYSICAL key (e.code,
// read as on a US layout) is a second candidate only when e.key can't be the
// shortcut's letter:
//  - Alt held: macOS composes Option+letter into a symbol (Option+R → "®",
//    Shift+Option+A → "Å"), so Alt-letter shortcuts (Rename Alt+R, Create
//    Frame Shift+Alt+A) never see their letter.
//  - The layout typed a non-Latin letter (Russian "ф", Greek "α", Hebrew "ש",
//    Korean "ㅁ"…), so no letter shortcut could ever match (user report
//    2026-10-22: Shift+A dead on a non-English layout). The key the user
//    presses is the one with that Latin letter printed on it.
//  - An IME took the keystroke (e.key "Process").
// Only a LETTER triggers the fallback, never punctuation: AZERTY's "," sits on
// code KeyM and must not fire an M shortcut.
//
// Leaf module (no imports): the vector editor uses it too.

type KeyLike = Pick<KeyboardEvent, 'key' | 'code' | 'altKey'>;

/** The physical key ("KeyR" → "r", "Digit1" → "1") when this keydown may
 *  match a shortcut by position; null when only e.key counts. */
export function physicalShortcutKey(e: KeyLike): string | null {
  const fallback = e.altKey || e.key === 'Process'
    || (/^\p{L}$/u.test(e.key) && !/^[a-z]$/i.test(e.key));
  if (!fallback) return null;
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3).toLowerCase();
  if (/^Digit\d$/.test(e.code)) return e.code.slice(5);
  return null;
}

/** Whether this keydown is shortcut key `key` ('a', '1', 'escape'…), by the
 *  typed character or, where that can't apply, the physical key. */
export function isShortcutKey(e: KeyLike, key: string): boolean {
  const k = key.toLowerCase();
  return e.key.toLowerCase() === k || physicalShortcutKey(e) === k;
}
