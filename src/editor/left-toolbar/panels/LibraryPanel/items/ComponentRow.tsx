// ComponentRow + CodeComponentRow — clickable/draggable rows for design
// components and code components in the Library panel. The two icons
// (DesignComponentIcon, CodeComponentIcon) live here too since they're
// primarily used by these rows. DesignComponentIcon is also exported
// because LinkedComponentRow (CDN-linked components) reuses it.

import React from 'react';
import SidebarRow from '@/design-system/SidebarRow';
import type { DropdownMenuEntry } from '@/design-system/DropdownMenu';
import { useComponentDrag } from '../shared/useComponentDrag';
import { useIsViewer } from '@/code/stores/viewer-mode-store';
import { MULTI_SELECT_OUTLINE } from '../shared/section-utils';

export const DesignComponentIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24">
    <path fill="currentColor" d="M12.53 2.47a.75.75 0 0 0-1.06 0L8.32 5.62a.75.75 0 0 0 0 1.06l3.15 3.15a.75.75 0 0 0 1.06 0l3.15-3.15a.75.75 0 0 0 0-1.06zm5.85 6.3a.75.75 0 0 0-1.06 0l-3.15 3.15a.75.75 0 0 0 0 1.06l3.15 3.15a.75.75 0 0 0 1.06 0l3.15-3.15a.75.75 0 0 0 0-1.06zm-5.85 5.4a.75.75 0 0 0-1.06 0l-3.15 3.15a.75.75 0 0 0 0 1.06l3.15 3.15a.75.75 0 0 0 1.06 0l3.15-3.15a.75.75 0 0 0 0-1.06zM6.68 8.32a.75.75 0 0 0-1.06 0l-3.15 3.15a.75.75 0 0 0 0 1.06l3.15 3.15a.75.75 0 0 0 1.06 0l3.15-3.15a.75.75 0 0 0 0-1.06z" />
  </svg>
);

const CodeComponentIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24">
    <g fill="none"><path d="M0 0h24v24H0z" /><path fill="currentColor" d="M14.62 2.662a1.5 1.5 0 0 1 1.04 1.85l-4.431 15.787a1.5 1.5 0 0 1-2.889-.81L12.771 3.7a1.5 1.5 0 0 1 1.85-1.039ZM7.56 6.697a1.5 1.5 0 0 1 0 2.12L4.38 12l3.182 3.182a1.5 1.5 0 1 1-2.122 2.121L1.197 13.06a1.5 1.5 0 0 1 0-2.12l4.242-4.243a1.5 1.5 0 0 1 2.122 0Zm8.88 2.12a1.5 1.5 0 1 1 2.12-2.12l4.243 4.242a1.5 1.5 0 0 1 0 2.121l-4.242 4.243a1.5 1.5 0 1 1-2.122-2.121L19.621 12z" /></g>
  </svg>
);

interface RowProps {
  label: string;
  filePath: string;
  isActive: boolean;
  onEdit: () => void;
  menuItems: DropdownMenuEntry[];
  inlineEdit?: { initialValue: string; onCommit: (val: string) => void };
  /** Shift+click handler for the shared multi-select set. When provided
   *  and `e.shiftKey` is true on click, the row toggles itself in/out
   *  of the set instead of firing `onEdit`. */
  onShiftClick?: (filePath: string) => void;
  /** True when this row's file is part of the active multi-select set.
   *  Drives the accent outline so the user sees the bulk pick alongside
   *  the existing `isActive` highlight. */
  isMultiSelected?: boolean;
  /** Right-aligned slot — the usage-count badge (`UsageBadge`) that opens the
   *  "where used" popup, mirroring the preset rows. */
  right?: React.ReactNode;
}

export const ComponentRow = React.memo(function ComponentRow({
  label, filePath, isActive, onEdit, menuItems, inlineEdit, onShiftClick, isMultiSelected, right,
}: RowProps) {
  const internalName = filePath.replace('components/', '').replace('.tsx', '');
  const handleDrag = useComponentDrag(filePath, internalName);
  // Viewers may click a design component to navigate into its master
  // for inspection/comment, but dragging it onto the canvas is an edit
  // — disable the drag handler.
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

  // Wrapper div hosts the pointerdown listener directly — the same
  // pattern as Insert panel's GridCard (`insert/index.tsx:211-213`).
  // Routing the handler through SidebarRow's `{...props}` spread was
  // unreliable for this specific case (the React-delegated synthetic
  // pointerdown was registered but downstream strategy.onMove ticks
  // never produced drop-line indicators when dragging from the
  // Library panel — Insert panel works because its handler sits on
  // a plain div with no forwardRef / memoized component layers
  // between React's listener tree and the DOM target). Mounting
  // pointerdown on a plain wrapper div removes that layer entirely.
  //
  // While the row is in inline-rename mode, the drag handler is
  // disabled so dragging the input text doesn't kick off a toolbar
  // drag. SidebarRow's input swallows pointer events anyway, but
  // skipping the handler entirely is the safer guarantee.
  return (
    <div
      onPointerDown={inlineEdit || isViewer ? undefined : handleDrag}
      style={isMultiSelected ? MULTI_SELECT_OUTLINE : undefined}
    >
      <SidebarRow
        icon={<DesignComponentIcon />}
        label={label}
        isActive={isActive}
        menuItems={isViewer ? undefined : menuItems}
        inlineEdit={inlineEdit}
        onClick={inlineEdit ? undefined : handleClick}
        right={right}
      />
    </div>
  );
});

export const CodeComponentRow = React.memo(function CodeComponentRow({
  label, filePath, isActive, onEdit, menuItems, inlineEdit, onShiftClick, isMultiSelected, right,
}: RowProps) {
  const internalName = filePath.replace('components/', '').replace('.tsx', '');
  const handleDrag = useComponentDrag(filePath, internalName);
  // Code components are fully inert for viewers — there's no inspectable
  // canvas master to navigate into, so clicking, dragging, and the
  // context menu (all edit actions) are all disabled.
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

  // Same wrapper pattern as ComponentRow above — see comment there.
  return (
    <div
      onPointerDown={inlineEdit || isViewer ? undefined : handleDrag}
      style={isMultiSelected ? MULTI_SELECT_OUTLINE : undefined}
    >
      <SidebarRow
        icon={<CodeComponentIcon />}
        label={label}
        isActive={isActive}
        menuItems={isViewer ? undefined : menuItems}
        inlineEdit={inlineEdit}
        onClick={inlineEdit || isViewer ? undefined : handleClick}
        right={right}
      />
    </div>
  );
});
