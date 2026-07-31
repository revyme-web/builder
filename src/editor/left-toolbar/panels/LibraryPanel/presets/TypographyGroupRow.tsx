// TypographyGroupRow — one row in the typography category representing a
// group of related tokens (heading/body/etc). SidebarRow-based so the ⋯ /
// right-click menu is the same design-system DropdownMenu every other preset
// row uses (the old custom More button opened the legacy PresetContextMenu
// and right-click did nothing).

import React from 'react';
import SidebarRow from '@/design-system/SidebarRow';
import { type DropdownMenuEntry } from '@/design-system/DropdownMenu';
import { type PresetUsage } from '@/code/stores/preset-store';
import type { TypoGroup as TypographyGroup } from '@/editor/tools/typography-utils';
import { getTypoTag } from '@/editor/tools/typography-utils';
import { TypoTagBadge } from '@/editor/controls';
import { MULTI_SELECT_OUTLINE } from '../shared/section-utils';
import { UsageBadge } from './UsagePopup';

interface TypographyGroupRowProps {
  group: TypographyGroup;
  isEditing: boolean;
  onEdit: () => void;
  /** Deletes the WHOLE group (every constituent token) — wired to the
   *  section's deletePresetById(`typo-group:<name>`). */
  onDelete: () => void;
  /** Aggregated consumers across every constituent token in the group
   *  (deduped by node id), since typography presets are compound. */
  usages: PresetUsage[];
  /** Shift+click multi-select toggle — receives the group's multi-select
   *  id (`typo-group:<name>`), same set as the simple preset rows. */
  onShiftClick?: (id: string) => void;
  /** True when this group is part of the active multi-select set. */
  isMultiSelected?: boolean;
  /** Bulk-mode replacement menu ("Delete N presets") — same collapse the
   *  other preset rows apply while the multi-select set is non-empty. */
  menuOverride?: DropdownMenuEntry[];
}

export function TypographyGroupRow({ group, isEditing, onEdit, onDelete, usages, onShiftClick, isMultiSelected, menuOverride }: TypographyGroupRowProps) {
  // No Rename entry: group rename was never functional (a group is a token
  // PREFIX — renaming needs a prefix rewrite across all tokens + usages).
  const menuItems: DropdownMenuEntry[] = menuOverride ?? [
    { id: 'edit', label: 'Edit', onClick: onEdit },
    { type: 'separator' },
    { id: 'delete', label: 'Delete', onClick: onDelete },
  ];

  return (
    <div style={isMultiSelected ? MULTI_SELECT_OUTLINE : undefined}>
      <SidebarRow
        icon={<TypoTagBadge tag={getTypoTag(group)} active={isEditing} />}
        label={group.label}
        isActive={isEditing}
        iconColor="inherit"
        menuItems={menuItems}
        onClick={(e: React.MouseEvent) => {
          // Shift+click → toggle in the shared multi-select set instead of edit.
          if (e.shiftKey && onShiftClick) {
            e.preventDefault();
            e.stopPropagation();
            onShiftClick(`typo-group:${group.name}`);
            return;
          }
          onEdit();
        }}
        style={{ cursor: 'pointer' }}
        right={<UsageBadge count={usages.length} usages={usages} />}
      />
    </div>
  );
}
