// IconSetRow — clickable/draggable row for an icon set (.tsx with
// @iconSet annotation). IconSetIcon is the section glyph; it's also
// exported because the main LibraryPanel render uses it for the
// vectors empty-state graphic.

import React from 'react';
import SidebarRow from '@/design-system/SidebarRow';
import type { DropdownMenuEntry } from '@/design-system/DropdownMenu';
import { useComponentDrag } from '../shared/useComponentDrag';
import { useIsViewer } from '@/code/stores/viewer-mode-store';
import { MULTI_SELECT_OUTLINE } from '../shared/section-utils';

// Filled triangle — chosen because it matches the reference's icon-set glyph in
// the layers/library tree (image #36 / #37 reference). Distinguishes
// icon-set rows from component rows at a glance.
export const IconSetIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24">
    <polygon fill="currentColor" points="12,3 22,21 2,21" />
  </svg>
);

export const IconSetRow = React.memo(function IconSetRow({
  label, filePath, isActive, onEdit, menuItems, onShiftClick, isMultiSelected, right,
}: {
  label: string;
  filePath: string;
  isActive: boolean;
  onEdit: () => void;
  menuItems: DropdownMenuEntry[];
  /** Shift+click toggles this row in/out of the Library section's
   *  shared multi-select set. See `useLibraryMultiSelect`. */
  onShiftClick?: (filePath: string) => void;
  /** True when this row is part of the active multi-select. */
  isMultiSelected?: boolean;
  /** Right-aligned usage-count badge (UsageBadge). */
  right?: React.ReactNode;
}) {
  const internalName = filePath.replace('icons/', '').replace('.tsx', '');
  // Icon sets reuse the component drag handler — drag-from-library
  // creates an instance JSX tag of the dragged file's default export.
  // The tag lookup goes through the regular import resolver, which
  // already handles `icons/` (resolveImportPath uses path-based stripping
  // of '@/').
  const handleDrag = useComponentDrag(filePath, internalName);
  // Viewers may click into a vector set's master to inspect/comment,
  // but dragging an instance onto the canvas is an edit — disable drag.
  const isViewer = useIsViewer();

  const handleClick = (e: React.MouseEvent) => {
    if (e.shiftKey && onShiftClick) {
      e.preventDefault();
      e.stopPropagation();
      onShiftClick(filePath);
      return;
    }
    onEdit();
  };

  return (
    <div
      onPointerDown={isViewer ? undefined : handleDrag}
      style={isMultiSelected ? MULTI_SELECT_OUTLINE : undefined}
    >
      <SidebarRow
        icon={<IconSetIcon />}
        label={label}
        isActive={isActive}
        iconColor="var(--accent)"
        menuItems={isViewer ? undefined : menuItems}
        onClick={handleClick}
        right={right}
      />
    </div>
  );
});
