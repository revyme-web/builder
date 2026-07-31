// PresetRow — one row in the preset list (icon, label, value preview,
// usage badge, edit/rename UI).

import React from 'react';
import SidebarRow from '@/design-system/SidebarRow';
import { type DropdownMenuEntry } from '@/design-system/DropdownMenu';
import { type PresetUsage } from '@/code/stores/preset-store';
import type { PresetToken } from '@/shared/types';
import { formatTokenLabel } from '../shared/format-utils';
import { MULTI_SELECT_OUTLINE } from '../shared/section-utils';
import { ValuePreview } from './ValuePreview';
import { UsageBadge } from './UsagePopup';

interface PresetRowProps {
  token: PresetToken;
  isEditing: boolean;
  isRenaming: boolean;
  renameValue: string;
  onRenameChange: (value: string) => void;
  onRenameSubmit: () => void;
  onRenameCancel: () => void;
  onEdit: (name: string) => void;
  /** Start the inline rename for this token (sets renamingName upstream). */
  onStartRename: (name: string) => void;
  /** Delete this token (routed to the section's deletePresetById). */
  onDelete: (name: string) => void;
  /** Project-wide consumers of this preset — drives the count badge. */
  usages: PresetUsage[];
  /** Shift+click handler for the shared multi-select set (see
   *  useLibraryMultiSelect). When provided and `e.shiftKey` is true on
   *  click, the row toggles itself in/out of the set instead of opening
   *  the edit popup. */
  onShiftClick?: (name: string) => void;
  /** True when this preset is part of the active multi-select set —
   *  draws the shared accent outline. */
  isMultiSelected?: boolean;
  /** Bulk-mode replacement for the per-row ⋯ / right-click menu
   *  ("Delete N presets"). Per-row Edit/Rename/Delete are ambiguous with
   *  N selected, so the caller collapses the menu while the set is
   *  non-empty. */
  menuOverride?: DropdownMenuEntry[];
}

export function PresetRow({ token, isEditing, isRenaming, renameValue, onRenameChange, onRenameSubmit, onRenameCancel, onEdit, onStartRename, onDelete, usages, onShiftClick, isMultiSelected, menuOverride }: PresetRowProps) {
  const displayLabel = token.label ?? formatTokenLabel(token.name);
  // Direct actions — the old entries routed through the legacy
  // PresetContextMenu (opened at 0,0 and needed a second click).
  const menuItems: DropdownMenuEntry[] = menuOverride ?? [
    { id: 'edit', label: 'Edit', onClick: () => onEdit(token.name) },
    { id: 'rename', label: 'Rename', onClick: () => onStartRename(token.name) },
    { type: 'separator' },
    { id: 'delete', label: 'Delete', onClick: () => onDelete(token.name) },
  ];

  // When renaming, show inline input instead of SidebarRow
  if (isRenaming) {
    return (
      <div className="group flex items-center gap-1.5 py-1.5 px-2 rounded-md bg-[var(--bg-hover)] select-none">
        <span className="shrink-0 flex items-center justify-center w-4 h-4"><ValuePreview token={token} /></span>
        <input
          autoFocus
          value={renameValue}
          onChange={(e) => onRenameChange(e.target.value)}
          onBlur={onRenameSubmit}
          onKeyDown={(e) => { if (e.key === 'Enter') onRenameSubmit(); if (e.key === 'Escape') onRenameCancel(); }}
          className="flex-1 w-full bg-transparent text-xs font-medium text-[var(--text-primary)] outline-none border-b border-[var(--accent)]"
          onClick={(e) => e.stopPropagation()}
        />
      </div>
    );
  }

  return (
    <SidebarRow
      icon={<ValuePreview token={token} />}
      label={displayLabel}
      isActive={isEditing}
      menuItems={menuItems}
      iconColor="inherit"
      onClick={(e: React.MouseEvent) => {
        // Shift+click → toggle in the shared multi-select set (same UX as
        // the Components / Vectors / Pages rows) instead of opening edit.
        if (e.shiftKey && onShiftClick) {
          e.preventDefault();
          e.stopPropagation();
          onShiftClick(token.name);
          return;
        }
        onEdit(token.name);
      }}
      style={isMultiSelected ? { cursor: 'pointer', ...MULTI_SELECT_OUTLINE } : { cursor: 'pointer' }}
      right={<UsageBadge count={usages.length} usages={usages} />}
    />
  );
}
