import { describe, test, expect } from 'vitest';
import { collectMatchingLeaves, type DropdownMenuEntry } from './DropdownMenu';

const item = (id: string, label: string, extra: Partial<Extract<DropdownMenuEntry, { id: string }>> = {}) =>
  ({ id, label, onClick: () => {}, ...extra });

const TREE: DropdownMenuEntry[] = [
  item('dashboard', 'Go to Dashboard'),
  { type: 'separator' },
  item('file', 'File', {
    submenuItems: [
      item('file-new', 'New project'),
      item('file-export', 'Export…'),
    ],
  }),
  item('edit', 'Edit', {
    submenuItems: [
      item('edit-undo', 'Undo'),
      item('edit-copy', 'Copy'),
      item('edit-nested', 'More', { submenuItems: [item('edit-copy-style', 'Copy Style')] }),
    ],
  }),
  item('view', 'View', {
    submenuItems: [
      item('view-zoom-in', 'Zoom in'),
      item('view-disabled', 'Zoom to nowhere', { disabled: true }),
    ],
  }),
];

describe('collectMatchingLeaves', () => {
  test('matches leaves across ALL submenus, case-insensitive', () => {
    const out = collectMatchingLeaves(TREE, 'copy');
    expect(out.map(i => i.id)).toEqual(['edit-copy', 'edit-copy-style']);
  });

  test('recurses into nested submenus', () => {
    const out = collectMatchingLeaves(TREE, 'style');
    expect(out.map(i => i.id)).toEqual(['edit-copy-style']);
  });

  test('includes matching TOP-LEVEL leaves but never parent items', () => {
    const out = collectMatchingLeaves(TREE, 'dash');
    expect(out.map(i => i.id)).toEqual(['dashboard']);
    // 'File' is a parent (has submenu) — searching its label yields nothing.
    expect(collectMatchingLeaves(TREE, 'file').map(i => i.id)).toEqual([]);
  });

  test('skips disabled items and separators', () => {
    const out = collectMatchingLeaves(TREE, 'zoom');
    expect(out.map(i => i.id)).toEqual(['view-zoom-in']);
  });

  test('empty / whitespace query returns nothing', () => {
    expect(collectMatchingLeaves(TREE, '')).toEqual([]);
    expect(collectMatchingLeaves(TREE, '   ')).toEqual([]);
  });

  test('dedupes by id when the same item appears in two submenus', () => {
    const shared = item('shared-undo', 'Undo');
    const dup: DropdownMenuEntry[] = [
      item('a', 'A', { submenuItems: [shared] }),
      item('b', 'B', { submenuItems: [shared] }),
    ];
    expect(collectMatchingLeaves(dup, 'undo')).toHaveLength(1);
  });
});
