// shortcut-key.ts — Which shortcut key a keydown means, on any keyboard layout.
//
// Shortcuts match e.key (the character the layout typed) first, so a Latin
// layout keeps its printed letters: AZERTY's A key is code KeyQ, and matching
// the physical key there would move every shortcut. The PHYSICAL key (e.code)
// is a second candidate only when e.key can't be the shortcut's letter:
//  - Alt held: macOS composes Option+letter into a symbol (Option+R → "®",
//    Shift+Option+A → "Å"), so Alt-letter shortcuts (Rename Alt+R, Create
//    Frame Shift+Alt+A) never see their letter.
//  - The layout typed a non-Latin letter (Russian "ф", Greek "α", Hebrew "ש",
//    Korean "ㅁ"…), so no letter shortcut could ever match (user report
//    2026-10-22: Shift+A dead on a non-English layout).
//  - An IME took the keystroke (e.key "Process").
// Only a LETTER triggers the fallback, never punctuation: AZERTY's "," sits on
// code KeyM and must not fire an M shortcut.
//
// The physical key reads as the letter PRINTED on the user's keyboard, i.e.
// what their own Latin layout types there — not as on a US keyboard. On a
// French Mac the key printed "A" is code KeyQ; on the Russian layout it types
// "Й", and a US reading made it Shift+Q (user report 2026-10-23: Shift+A still
// dead, F fine). The user's Latin layout comes from:
//  - their own typing: e.key "a" on code KeyQ, learned from every plain keydown
//    (every browser);
//  - Chrome's navigator.keyboard.getLayoutMap(), when it lists Latin letters.
// Kept in localStorage, so a reload made while Russian is active still knows.
// A key neither source knows reads as on a US keyboard, unless the user's
// layout already has that letter on another key.
//
// Leaf module (imports only debug-trace): the vector editor uses it too.

import { trace } from './debug-trace';

type KeyLike = Pick<KeyboardEvent, 'key' | 'code' | 'altKey'>;

const STORAGE_KEY = 'revyme:latin-key-layout';
const LATIN = /^[a-z]$/i;

/** code → the Latin letter the user's own keyboard carries there. */
let ownLayout: Map<string, string> | null = null;

function layout(): Map<string, string> {
  if (ownLayout) return ownLayout;
  ownLayout = new Map();
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Record<string, unknown> | null;
    if (parsed && typeof parsed === 'object') {
      for (const [code, key] of Object.entries(parsed)) {
        if (typeof key === 'string' && LATIN.test(key)) ownLayout.set(code, key.toLowerCase());
      }
    }
  } catch { /* storage unavailable — learn again this session */ }
  return ownLayout;
}

/** Record physical keys and the Latin letter each carries. A letter lives on
 *  ONE key: learning it somewhere drops it from wherever it was before (a
 *  switch from AZERTY to US typing moves "a" back from KeyQ to KeyA). */
export function learnLatinKeys(entries: Iterable<[string, string]>): void {
  const map = layout();
  const changed: string[] = [];
  for (const [code, key] of entries) {
    if (!code || !LATIN.test(key)) continue;
    const letter = key.toLowerCase();
    if (map.get(code) === letter) continue;
    for (const [c, l] of map) if (l === letter) map.delete(c);
    map.set(code, letter);
    changed.push(`${code}=${letter}`);
  }
  if (changed.length === 0) return;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(map))); } catch { /* ignore */ }
  trace.action('shortcut-key:layout-learned', { changed: changed.slice(0, 12), count: changed.length });
}

/** Learn from a keydown typed on a Latin layout. Cmd/Ctrl may report another
 *  layout's letter (macOS answers Cmd combos from a QWERTY command map) and
 *  Alt composes symbols, so only plain / Shift keystrokes teach. */
function learnFromKeyDown(e: KeyboardEvent): void {
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  if (LATIN.test(e.key) && e.code) learnLatinKeys([[e.code, e.key]]);
}

/** Chrome / Edge: the OS layout map. Only its Latin letters count, so a map
 *  read while Russian is active teaches nothing rather than something wrong. */
async function learnFromBrowserLayout(): Promise<void> {
  const kb = (navigator as Navigator & { keyboard?: { getLayoutMap?: () => Promise<Map<string, string>> } }).keyboard;
  if (!kb?.getLayoutMap) return;
  try {
    const map = await kb.getLayoutMap();
    learnLatinKeys(map.entries());
  } catch { /* not allowed here (iframe, unfocused) — typing still teaches */ }
}

/** Keep the user's Latin layout current: every keydown, plus the browser's
 *  layout map now and whenever the window regains focus (the layout may have
 *  changed meanwhile). Returns the cleanup. */
export function watchKeyboardLayout(): () => void {
  const onFocus = () => { void learnFromBrowserLayout(); };
  window.addEventListener('keydown', learnFromKeyDown, true);
  window.addEventListener('focus', onFocus);
  void learnFromBrowserLayout();
  return () => {
    window.removeEventListener('keydown', learnFromKeyDown, true);
    window.removeEventListener('focus', onFocus);
  };
}

/** Tests: forget the learned layout (memory and storage). */
export function resetKeyboardLayoutForTests(): void {
  ownLayout = null;
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

/** The shortcut key this keydown carries physically ("r", "1"…) when it may
 *  match a shortcut by position; null when only e.key counts. */
export function physicalShortcutKey(e: KeyLike): string | null {
  const fallback = e.altKey || e.key === 'Process'
    || (/^\p{L}$/u.test(e.key) && !LATIN.test(e.key));
  if (!fallback) return null;
  const own = layout();
  const mine = own.get(e.code);
  if (mine) return mine;
  if (/^Key[A-Z]$/.test(e.code)) {
    const us = e.code.slice(3).toLowerCase();
    for (const l of own.values()) if (l === us) return null; // that letter is elsewhere on this keyboard
    return us;
  }
  if (/^Digit\d$/.test(e.code)) return e.code.slice(5);
  return null;
}

/** Whether this keydown is shortcut key `key` ('a', '1', 'escape'…), by the
 *  typed character or, where that can't apply, the physical key. */
export function isShortcutKey(e: KeyLike, key: string): boolean {
  const k = key.toLowerCase();
  return e.key.toLowerCase() === k || physicalShortcutKey(e) === k;
}
