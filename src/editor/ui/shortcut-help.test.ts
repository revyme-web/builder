import { describe, test, expect } from 'vitest';
import { buildHelpSections, formatKeyChip, formatMods } from './shortcut-help';
import type { ShortcutSpec } from '@/canvas/KeyboardManager';

const spec = (s: Partial<ShortcutSpec> & { key: ShortcutSpec['key'] }): ShortcutSpec =>
  ({ handler: () => {}, ...s });

describe('formatKeyChip', () => {
  test('uppercases single letters', () => {
    expect(formatKeyChip('v')).toBe('V');
  });
  test('maps special e.key values to friendly chips', () => {
    expect(formatKeyChip(' ')).toBe('Space');
    expect(formatKeyChip('escape')).toBe('Esc');
    expect(formatKeyChip('backspace')).toBe('⌫');
    expect(formatKeyChip('arrowup')).toBe('↑');
  });
  test('title-cases other named keys', () => {
    expect(formatKeyChip('tab')).toBe('Tab');
  });
});

describe('formatMods', () => {
  test('mac uses symbols in ⌥ ⇧ ⌘ order', () => {
    expect(formatMods({ ctrl: true, shift: true, alt: true }, true)).toEqual(['⌥', '⇧', '⌘']);
  });
  test('non-mac uses words in Ctrl Alt Shift order', () => {
    expect(formatMods({ ctrl: true, shift: true, alt: true }, false)).toEqual(['Ctrl', 'Alt', 'Shift']);
  });
  test('no modifiers → empty', () => {
    expect(formatMods({}, true)).toEqual([]);
  });
});

describe('buildHelpSections', () => {
  test('groups by category with display titles, in section order', () => {
    const sections = buildHelpSections([
      spec({ key: 'z', ctrl: true, label: 'Undo', category: 'general' }),
      spec({ key: 'v', label: 'Select tool', category: 'tools' }),
    ], true);
    // 'View' is always present: the extra "Toggle preview" shortcut lands there.
    expect(sections.map(s => s.title)).toEqual(['Tools', 'General', 'View']);
  });

  test('merges zoom and navigation into one View section', () => {
    const sections = buildHelpSections([
      spec({ key: '+', ctrl: true, label: 'Zoom in', category: 'zoom' }),
      spec({ key: ' ', label: 'Pan (hold)', category: 'navigation' }),
    ], true);
    const view = sections.find(s => s.title === 'View')!;
    expect(view.shortcuts.map(x => x.label)).toContain('Zoom in');
    expect(view.shortcuts.map(x => x.label)).toContain('Pan (hold)');
  });

  test('dedupes by label keeping the FIRST registration (Redo alias)', () => {
    const sections = buildHelpSections([
      spec({ key: 'z', ctrl: true, shift: true, label: 'Redo', category: 'general' }),
      spec({ key: 'y', ctrl: true, label: 'Redo', category: 'general' }),
    ], true);
    const general = sections.find(s => s.title === 'General')!;
    const redos = general.shortcuts.filter(x => x.label === 'Redo');
    expect(redos).toHaveLength(1);
    expect(redos[0].keys).toEqual(['Z']);
    expect(redos[0].mods).toEqual(['⇧', '⌘']);
  });

  test('skips hideFromHelp and unlabeled registrations', () => {
    const sections = buildHelpSections([
      spec({ key: 'arrowdown', label: 'Nudge down 1px', category: 'general', hideFromHelp: true }),
      spec({ key: 'q' }),
    ], true);
    expect(sections.filter(s => s.shortcuts.some(x => x.label.startsWith('Nudge down')))).toHaveLength(0);
  });

  test('helpKeys overrides the key chips (nudge arrow cluster)', () => {
    const sections = buildHelpSections([
      spec({ key: 'arrowup', label: 'Nudge 1px', category: 'general', helpKeys: ['↑', '↓', '←', '→'] }),
    ], true);
    expect(sections[0].shortcuts[0].keys).toEqual(['↑', '↓', '←', '→']);
  });

  test('multi-key specs show the first key only', () => {
    const sections = buildHelpSections([
      spec({ key: ['backspace', 'delete'], label: 'Delete', category: 'general' }),
    ], false);
    expect(sections[0].shortcuts[0].keys).toEqual(['⌫']);
  });

  test('appends the extra non-manager shortcuts (Quick Actions, preview)', () => {
    const sections = buildHelpSections([], true);
    const labels = sections.flatMap(s => s.shortcuts.map(x => x.label));
    expect(labels).toContain('Quick Actions');
    expect(labels).toContain('Toggle preview');
  });
});
