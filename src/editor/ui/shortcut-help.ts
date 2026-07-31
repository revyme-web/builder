// shortcut-help.ts — pure helpers for the Keyboard Shortcuts help modal.
// Turns the LIVE KeyboardManager registry (keyboard.getAll()) into display
// sections, so the modal can never drift from what's actually registered.

import type { ShortcutSpec } from '@/canvas/KeyboardManager';

interface HelpShortcut {
  label: string;
  /** Modifier chips in platform order (e.g. ['⌥','⇧','⌘'] / ['Ctrl','Alt','Shift']). */
  mods: string[];
  /** Key chips (usually one; nudge rows show the arrow cluster). */
  keys: string[];
}

export interface HelpSection {
  title: string;
  shortcuts: HelpShortcut[];
}

/** Display names + order for the registry categories. `zoom` and
 *  `navigation` merge into one "View" section (the reference groups them too). */
const CATEGORY_TITLES: Record<string, string> = {
  tools: 'Tools',
  general: 'General',
  selection: 'Selection',
  structure: 'Structure',
  zoom: 'View',
  navigation: 'View',
};
const SECTION_ORDER = ['Tools', 'General', 'Selection', 'Structure', 'View'];

/** e.key values that need a friendlier chip than their raw form. */
const KEY_DISPLAY: Record<string, string> = {
  ' ': 'Space',
  escape: 'Esc',
  backspace: '⌫',
  delete: 'Del',
  enter: '⏎',
  tab: 'Tab',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
};

/** Shortcuts that live OUTSIDE the KeyboardManager (separate window
 *  listeners) but belong in the help modal. Keep in sync with their
 *  owners — Ctrl+K: CommandPalette.tsx, Ctrl+P: App.tsx preview toggle. */
const EXTRA_HELP_SHORTCUTS: Array<{ label: string; category: string; ctrl?: boolean; shift?: boolean; alt?: boolean; key: string }> = [
  { label: 'Quick Actions', category: 'general', ctrl: true, key: 'k' },
  { label: 'Toggle preview', category: 'zoom', ctrl: true, key: 'p' },
];

export function formatKeyChip(key: string): string {
  const lower = key.toLowerCase();
  if (KEY_DISPLAY[lower]) return KEY_DISPLAY[lower];
  return key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1);
}

/** Modifier chips in platform conventions: macOS symbol order ⌥ ⇧ ⌘
 *  (Ctrl registrations match metaKey on mac — see KeyboardManager's
 *  `e.ctrlKey || e.metaKey`), Windows/Linux textual Ctrl Alt Shift. */
export function formatMods(spec: { ctrl?: boolean; shift?: boolean; alt?: boolean }, isMac: boolean): string[] {
  if (isMac) {
    const mods: string[] = [];
    if (spec.alt) mods.push('⌥');
    if (spec.shift) mods.push('⇧');
    if (spec.ctrl) mods.push('⌘');
    return mods;
  }
  const mods: string[] = [];
  if (spec.ctrl) mods.push('Ctrl');
  if (spec.alt) mods.push('Alt');
  if (spec.shift) mods.push('Shift');
  return mods;
}

/** Build the modal's sections from registry specs. Skips unlabeled and
 *  `hideFromHelp` registrations, dedupes by label keeping the FIRST
 *  registration (so Redo shows Ctrl+Shift+Z, not the Ctrl+Y alias, and
 *  multi-key specs like ['backspace','delete'] show one chip). */
export function buildHelpSections(specs: ShortcutSpec[], isMac: boolean): HelpSection[] {
  const sections = new Map<string, HelpShortcut[]>();
  const seenLabels = new Set<string>();

  const push = (spec: { key: string | string[]; ctrl?: boolean; shift?: boolean; alt?: boolean; label?: string; category?: string; helpKeys?: string[] }) => {
    if (!spec.label || seenLabels.has(spec.label)) return;
    seenLabels.add(spec.label);
    const title = CATEGORY_TITLES[spec.category ?? ''] ?? 'General';
    const firstKey = Array.isArray(spec.key) ? spec.key[0] : spec.key;
    const entry: HelpShortcut = {
      label: spec.label,
      mods: formatMods(spec, isMac),
      keys: spec.helpKeys ?? [formatKeyChip(firstKey)],
    };
    if (!sections.has(title)) sections.set(title, []);
    sections.get(title)!.push(entry);
  };

  for (const spec of specs) {
    if (spec.hideFromHelp) continue;
    push(spec);
  }
  for (const extra of EXTRA_HELP_SHORTCUTS) push(extra);

  const ordered: HelpSection[] = [];
  for (const title of SECTION_ORDER) {
    const shortcuts = sections.get(title);
    if (shortcuts?.length) ordered.push({ title, shortcuts });
    sections.delete(title);
  }
  // Unknown categories (future registrations) append after the known ones.
  for (const [title, shortcuts] of sections) ordered.push({ title, shortcuts });
  return ordered;
}
