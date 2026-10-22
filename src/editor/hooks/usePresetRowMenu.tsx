// usePresetRowMenu — the right-click menu of a preset row inside a PICKER
// (colour picker, image / video preset lists, the typography preset popup):
// Edit / Rename / Duplicate / Delete, the same entries as the Presets panel's
// row menu, through the same shared usePresetActions. One copy instead of
// one per picker, so a new action lands in every list at once (2026-10-22:
// Duplicate was missing everywhere).
//
// Ids are token names (`color-brand`) for simple presets, GROUP names (`body`)
// for typography / border.

import { useCallback, useRef, useState } from 'react';
import type React from 'react';
import DropdownMenu, { MENU_Z_ABOVE_POPUPS, type DropdownMenuEntry } from '@/design-system/DropdownMenu';
import { usePresetActions } from './usePresetActions';
import type { PresetGroupKind } from '@/code/project/preset-rename';
import { trace } from '@/shared/debug-trace';

export function usePresetRowMenu({ kind, labelFor, onEdit, onRenamed, onDeleted, traceTag }: {
  /** `token` for simple presets; the group kind for compound ones. */
  kind: 'token' | PresetGroupKind;
  /** The name the rename input starts from ("Brand Light"). */
  labelFor: (id: string) => string;
  /** Adds an Edit entry when given. */
  onEdit?: (id: string) => void;
  onRenamed?: (from: string, to: string) => void;
  onDeleted?: (id: string) => void;
  traceTag: string;
}) {
  const actions = usePresetActions();
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  // The open rename, cleared the moment it is submitted or cancelled: the
  // input also submits on blur, and a blur arriving as it unmounts (after
  // Enter / Escape) must not rename twice or undo the cancel.
  const renamingRef = useRef<string | null>(null);

  const openMenu = useCallback((id: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ id, x: e.clientX, y: e.clientY });
    trace.action(`${traceTag}:row-menu`, { id });
  }, [traceTag]);

  const endRename = (commit: boolean) => {
    const from = renamingRef.current;
    renamingRef.current = null;
    setRenamingId(null);
    if (!commit || !from) return;
    const to = kind === 'token'
      ? actions.renamePreset(from, renameValue)
      : actions.renamePresetGroup(kind, from, renameValue);
    if (to) onRenamed?.(from, to);
  };

  const items: DropdownMenuEntry[] = menu ? [
    ...(onEdit ? [{ id: 'edit', label: 'Edit', onClick: () => onEdit(menu.id) }] : []),
    { id: 'rename', label: 'Rename', onClick: () => {
      renamingRef.current = menu.id;
      setRenamingId(menu.id);
      setRenameValue(labelFor(menu.id));
    } },
    { id: 'duplicate', label: 'Duplicate', onClick: () => {
      if (kind === 'token') actions.duplicatePreset(menu.id);
      else actions.duplicatePresetGroup(kind, menu.id);
    } },
    { type: 'separator' },
    { id: 'delete', label: 'Delete', onClick: () => {
      if (kind === 'token') actions.deletePresets([menu.id]);
      else actions.deletePresetGroup(kind, menu.id);
      onDeleted?.(menu.id);
    } },
  ] : [];

  const menuElement = (
    <DropdownMenu
      isOpen={!!menu}
      onClose={() => setMenu(null)}
      items={items}
      anchorPoint={menu ? { x: menu.x, y: menu.y } : null}
      position="bottom-left"
      zIndexBase={MENU_Z_ABOVE_POPUPS}
    />
  );

  /** The inline rename input, for the row whose id is `renamingId`. */
  const renameInput = (className: string) => (
    <input
      autoFocus
      value={renameValue}
      onChange={(e) => setRenameValue(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={() => endRename(true)}
      onKeyDown={(e) => {
        // The popup closes on Escape too — keep these keys in the input.
        e.stopPropagation();
        if (e.key === 'Enter') endRename(true);
        if (e.key === 'Escape') endRename(false);
      }}
      className={className}
    />
  );

  return { menuId: menu?.id ?? null, renamingId, openMenu, renameInput, menuElement };
}
