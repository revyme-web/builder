// CategorySection family — preset-category render logic. CategoryHeader
// is the collapsible header strip, CategorySection renders the rows for
// data-bearing categories (color/spacing/typography/etc), BorderGroupRow
// is the specialized row for grouped border tokens, and
// DisplayCategorySection renders display-only categories.

import React, { useState, useCallback, useMemo, useRef } from 'react';
import { useAtom } from 'jotai';
import {
  FolderTree,
  type FolderTreeFolder,
} from '@/design-system/FolderTree';
import SidebarRow from '@/design-system/SidebarRow';
import AddButton from '@/design-system/AddButton';
import DropdownMenu, { type DropdownMenuEntry } from '@/design-system/DropdownMenu';
import { projectVersionAtom } from '@/code/project/project-fs';
import {
  getPresetFolderOps,
  isPresetFolderId,
} from '@/code/project/preset-folder-ops';
import { type PresetUsage } from '@/code/stores/preset-store';
import { groupBorderTokens, type BorderGroup } from '@/editor/ui/border-preset-utils';
import type { PresetToken } from '@/shared/types';
import type { TypoGroup as TypographyGroup } from '@/editor/tools/typography-utils';
import { PresetRow } from './PresetRow';
import { TypographyGroupRow } from './TypographyGroupRow';
import { CreatePresetInline } from './CreatePresetInline';
import { UsageBadge } from './UsagePopup';
import { CreatorFolderIcon } from '../shared/icons';
import { bulkDeleteMenuEntry, MULTI_SELECT_OUTLINE } from '../shared/section-utils';
import type { LibraryMultiSelect } from '../shared/useLibraryMultiSelect';
import type { CategoryConfig } from '../shared/types';

/**
 * Accordion-style category header. The label itself is the click target,
 * with a subtle text-color hover as the only affordance — no chevron, no
 * background change. Keeps SectionLabel unchanged for other sidebar uses.
 */
export function CategoryHeader({ label, onToggle, right }: {
  label: string;
  onToggle: () => void;
  right?: React.ReactNode;
}) {
  return (
    <div className="group flex items-center justify-between px-3 pt-3 pb-1.5 select-none">
      <span
        onClick={onToggle}
        className="text-xs font-semibold text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer transition-colors"
      >
        {label}
      </span>
      {right}
    </div>
  );
}

interface CategorySectionProps {
  config: CategoryConfig;
  tokens: PresetToken[];
  typoGroups?: TypographyGroup[];
  editingName: string | null;
  renamingName: string | null;
  renameValue: string;
  onRenameChange: (value: string) => void;
  onRenameSubmit: () => void;
  onRenameCancel: () => void;
  onEdit: (name: string) => void;
  /** Start the inline rename for a simple token row. */
  onStartRename: (name: string) => void;
  /** Delete by multi-select id (token name / `typo-group:x` / `border-group:x`)
   *  — the section's deletePresetById expands compound groups. */
  onDeletePreset: (id: string) => void;
  creating: boolean;
  onStartCreate: () => void;
  onCancelCreate: () => void;
  onSubmitCreate: (displayName: string) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  /** Project-wide preset → consuming-nodes map. Threaded down so each row
   *  can render a count badge without re-deriving the data per row. */
  usageMap: Map<string, PresetUsage[]>;
  /** Shared shift-click multi-select + bulk-delete set. ONE instance
   *  spans every category (owned by LibraryPanel/index), so a shift-pick
   *  can mix colors + spacing + typography groups; ids follow the
   *  editingName scheme (token name / `typo-group:x` / `border-group:x`). */
  multiSelect: LibraryMultiSelect;
}

export function CategorySection({
  config, tokens, typoGroups, editingName, renamingName, renameValue,
  onRenameChange, onRenameSubmit, onRenameCancel,
  onEdit, onStartRename, onDeletePreset,
  creating, onStartCreate, onCancelCreate, onSubmitCreate,
  collapsed, onToggleCollapse, usageMap, multiSelect,
}: CategorySectionProps) {
  const isTypography = config.key === 'typography';
  const isBorder = config.key === 'border';
  const borderGroups = isBorder ? groupBorderTokens(tokens) : [];

  // ─── Folder system (per category) ──────────────────────────────────────
  // Each category gets its own folder tree backed by
  // `_meta/preset-folders-<key>.json`. Item ids stored in the JSON
  // are EITHER token names (simple categories) OR group names
  // (typography / border compound presets) — `renderItem` looks up
  // the right thing.
  const [version, setVersion] = useAtom(projectVersionAtom);
  const folderOps = useMemo(() => getPresetFolderOps(config.key), [config.key]);
  const userFolders = useMemo(() => folderOps.listFolders(), [folderOps, version]);
  const folderById = useMemo(() => {
    const m = new Map<string, FolderTreeFolder>();
    for (const f of userFolders) m.set(f.id, f as FolderTreeFolder);
    return m;
  }, [userFolders]);

  // Top-level item ids the panel knows about (for drift fallback).
  // For typography / border this is the GROUP names; for simple
  // categories, the token names.
  const itemIds = useMemo<string[]>(() => {
    if (isTypography && typoGroups) return typoGroups.map(g => g.name);
    if (isBorder) return borderGroups.map(g => g.name);
    return tokens.map(t => t.name);
  }, [isTypography, isBorder, typoGroups, tokens, borderGroups]);
  const allItemIds = useMemo(() => new Set(itemIds), [itemIds]);

  const persistedRootOrder = useMemo(() => folderOps.getRootOrder(), [folderOps, version]);
  const effectiveRootOrder = useMemo(() => {
    const out = persistedRootOrder.filter(id => folderById.has(id) || allItemIds.has(id));
    const referenced = new Set<string>([...out]);
    for (const f of userFolders) for (const c of f.children) referenced.add(c);
    // Drift fallback — any item / folder not referenced anywhere
    // gets appended at the root tail.
    for (const id of itemIds) if (!referenced.has(id)) out.push(id);
    for (const f of userFolders) {
      if (!referenced.has(f.id) && f.parentId === null) out.push(f.id);
    }
    return out;
  }, [persistedRootOrder, folderById, userFolders, itemIds, allItemIds]);

  // Folder rename / pending-creation state — same UX as Templates.
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [pendingNewFolderId, setPendingNewFolderId] = useState<string | null>(null);
  const handleStartNewFolder = useCallback(() => {
    const id = folderOps.createFolder('', null);
    setRenamingFolderId(id);
    setPendingNewFolderId(id);
    setVersion(v => v + 1);
  }, [folderOps, setVersion]);
  const handleFolderRenameCommit = useCallback((id: string, newName: string) => {
    setRenamingFolderId(null);
    const wasPendingCreation = pendingNewFolderId === id;
    if (wasPendingCreation) setPendingNewFolderId(null);
    const trimmed = newName.trim();
    if (wasPendingCreation && trimmed === '') {
      folderOps.deleteFolder(id);
      setVersion(v => v + 1);
      return;
    }
    const folder = userFolders.find(f => f.id === id);
    if (!folder || trimmed === folder.name || trimmed === '') return;
    folderOps.renameFolder(id, trimmed);
    setVersion(v => v + 1);
  }, [pendingNewFolderId, userFolders, folderOps, setVersion]);
  const handleFolderDelete = useCallback((id: string) => {
    folderOps.deleteFolder(id);
    setVersion(v => v + 1);
  }, [folderOps, setVersion]);

  // `+` dropdown — New <Preset> / New Folder.
  const plusDropdownRef = useRef<HTMLButtonElement>(null);
  const [plusDropdownOpen, setPlusDropdownOpen] = useState(false);
  const plusDropdownItems: DropdownMenuEntry[] = [
    {
      id: 'new-preset',
      label: `New ${config.label}`,
      onClick: () => onStartCreate(),
    },
    {
      id: 'new-folder',
      label: 'New Folder',
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24">
          <path
            fill="currentColor"
            fillRule="evenodd"
            d="M2.07 5.258C2 5.626 2 6.068 2 6.95V14c0 3.771 0 5.657 1.172 6.828S6.229 22 10 22h4c3.771 0 5.657 0 6.828-1.172S22 17.771 22 14v-2.202c0-2.632 0-3.949-.77-4.804a3 3 0 0 0-.224-.225C20.151 6 18.834 6 16.202 6h-.374c-1.153 0-1.73 0-2.268-.153a4 4 0 0 1-.848-.352C12.224 5.224 11.816 4.815 11 4l-.55-.55c-.274-.274-.41-.41-.554-.53a4 4 0 0 0-2.18-.903C7.53 2 7.336 2 6.95 2c-.883 0-1.324 0-1.692.07A4 4 0 0 0 2.07 5.257M12.25 10a.75.75 0 0 1 .75-.75h5a.75.75 0 0 1 0 1.5h-5a.75.75 0 0 1-.75-.75"
            clipRule="evenodd"
          />
        </svg>
      ),
      onClick: handleStartNewFolder,
    },
  ];

  // FolderTree adapter callbacks. Pass `effectiveRootOrder` so
  // moveItem bakes the user's visible order into the JSON before
  // the splice — required when reordering drift-fallback items
  // (items the panel surfaces but that aren't yet in the persisted
  // rootOrder).
  const handleMove = useCallback((itemId: string, newParentId: string | null, insertIndex: number) => {
    folderOps.moveItem(itemId, newParentId, insertIndex, effectiveRootOrder);
    setVersion(v => v + 1);
  }, [folderOps, setVersion, effectiveRootOrder]);

  // Pre-compute lookups so renderItem stays cheap.
  const typoGroupByName = useMemo(() => {
    const m = new Map<string, TypographyGroup>();
    for (const g of (typoGroups ?? [])) m.set(g.name, g);
    return m;
  }, [typoGroups]);
  const borderGroupByName = useMemo(() => {
    const m = new Map<string, BorderGroup>();
    for (const g of borderGroups) m.set(g.name, g);
    return m;
  }, [borderGroups]);
  const tokenByName = useMemo(() => {
    const m = new Map<string, PresetToken>();
    for (const t of tokens) m.set(t.name, t);
    return m;
  }, [tokens]);

  // Multi-select wiring shared by all three row kinds. While the set is
  // non-empty the per-row ⋯ / right-click menu collapses to a single
  // "Delete N presets" entry, and a NORMAL click clears the set before
  // opening the edit popup ("back to single selection" — same as the
  // Components section).
  const inBulk = multiSelect.size > 0;
  const bulkItems = inBulk ? bulkDeleteMenuEntry(multiSelect, 'preset') : undefined;
  const editClearingSelection = useCallback((name: string) => {
    multiSelect.clearSelection();
    onEdit(name);
  }, [multiSelect, onEdit]);

  const renderTreeItem = useCallback(({ itemId }: { itemId: string }) => {
    if (isTypography) {
      const group = typoGroupByName.get(itemId);
      if (!group) return null;
      const seen = new Set<string>();
      const groupUsages: PresetUsage[] = [];
      for (const t of group.tokens) {
        for (const u of usageMap.get(t.name) ?? []) {
          const k = `${u.filePath}::${u.nodeId}`;
          if (seen.has(k)) continue;
          seen.add(k);
          groupUsages.push(u);
        }
      }
      return (
        <TypographyGroupRow
          group={group}
          isEditing={editingName === `typo-group:${group.name}`}
          onEdit={() => editClearingSelection(`typo-group:${group.name}`)}
          onDelete={() => onDeletePreset(`typo-group:${group.name}`)}
          usages={groupUsages}
          onShiftClick={multiSelect.togglePath}
          isMultiSelected={multiSelect.isMultiSelected(`typo-group:${group.name}`)}
          menuOverride={bulkItems}
        />
      );
    }
    if (isBorder) {
      const group = borderGroupByName.get(itemId);
      if (!group) return null;
      const seen = new Set<string>();
      const groupUsages: PresetUsage[] = [];
      for (const t of group.tokens) {
        for (const u of usageMap.get(t.name) ?? []) {
          const k = `${u.filePath}::${u.nodeId}`;
          if (seen.has(k)) continue;
          seen.add(k);
          groupUsages.push(u);
        }
      }
      return (
        <BorderGroupRow
          group={group}
          isEditing={editingName === `border-group:${group.name}`}
          onEdit={() => editClearingSelection(`border-group:${group.name}`)}
          onDelete={() => onDeletePreset(`border-group:${group.name}`)}
          usages={groupUsages}
          onShiftClick={multiSelect.togglePath}
          isMultiSelected={multiSelect.isMultiSelected(`border-group:${group.name}`)}
          menuOverride={bulkItems}
        />
      );
    }
    const token = tokenByName.get(itemId);
    if (!token) return null;
    return (
      <PresetRow
        token={token}
        isEditing={editingName === token.name}
        isRenaming={renamingName === token.name}
        renameValue={renamingName === token.name ? renameValue : ''}
        onRenameChange={onRenameChange}
        onRenameSubmit={onRenameSubmit}
        onRenameCancel={onRenameCancel}
        onEdit={editClearingSelection}
        onStartRename={onStartRename}
        onDelete={onDeletePreset}
        usages={usageMap.get(token.name) ?? []}
        onShiftClick={multiSelect.togglePath}
        isMultiSelected={multiSelect.isMultiSelected(token.name)}
        menuOverride={bulkItems}
      />
    );
  }, [
    isTypography, isBorder,
    typoGroupByName, borderGroupByName, tokenByName,
    editingName, renamingName, renameValue,
    onRenameChange, onRenameSubmit, onRenameCancel,
    editClearingSelection, onStartRename, onDeletePreset, usageMap,
    multiSelect, inBulk, bulkItems,
  ]);

  const renderTreeFolder = useCallback(({ folder, expanded, toggle }: {
    folder: { id: string; name: string; children: string[] };
    expanded: boolean;
    toggle: () => void;
  }) => {
    const isRenaming = renamingFolderId === folder.id;
    const isPendingCreation = pendingNewFolderId === folder.id;
    const isEmpty = folder.children.length === 0;
    const menuItems: DropdownMenuEntry[] = [
      { id: 'rename', label: 'Rename', onClick: () => setRenamingFolderId(folder.id) },
      { type: 'separator' },
      { id: 'delete', label: 'Delete', onClick: () => handleFolderDelete(folder.id) },
    ];
    return (
      <SidebarRow
        icon={<CreatorFolderIcon color="var(--accent)" />}
        label={folder.name}
        expandable={isEmpty ? undefined : { expanded }}
        menuItems={menuItems}
        onClick={() => {
          if (isRenaming) return;
          if (isEmpty) return;
          toggle();
        }}
        inlineEdit={isRenaming ? {
          initialValue: isPendingCreation ? '' : folder.name,
          onCommit: (name) => handleFolderRenameCommit(folder.id, name),
        } : undefined}
      />
    );
  }, [renamingFolderId, pendingNewFolderId, handleFolderDelete, handleFolderRenameCommit]);

  return (
    <div className="mb-1">
      <CategoryHeader
        label={config.label}
        onToggle={onToggleCollapse}
        right={
          <span onClick={(e) => e.stopPropagation()}>
            <AddButton ref={plusDropdownRef} onClick={() => setPlusDropdownOpen(o => !o)} title={`Create new ${config.label.toLowerCase()} preset`} />
            <DropdownMenu
              isOpen={plusDropdownOpen}
              onClose={() => setPlusDropdownOpen(false)}
              items={plusDropdownItems}
              anchorRef={plusDropdownRef}
              position="bottom-left"
            />
          </span>
        }
      />

      {(!collapsed || creating) && (
        <div className="px-2">
          {effectiveRootOrder.length === 0 && !creating ? (
            <div className="text-[10px] text-[var(--text-tertiary,var(--text-disabled))] py-2 px-2">
              No {config.label.toLowerCase()} presets
            </div>
          ) : (
            <FolderTree
              rootOrder={effectiveRootOrder}
              folderById={folderById}
              isFolderId={isPresetFolderId}
              onMove={handleMove}
              renderItem={renderTreeItem}
              renderFolder={renderTreeFolder}
              indicatorColor="var(--accent)"
            />
          )}
          {creating && (
            <CreatePresetInline
              category={config}
              onSubmit={onSubmitCreate}
              onCancel={onCancelCreate}
            />
          )}
        </div>
      )}
    </div>
  );
}

interface BorderGroupRowProps {
  group: BorderGroup;
  isEditing: boolean;
  onEdit: () => void;
  /** Deletes the WHOLE group (every constituent token). The old context-menu
   *  path passed only tokens[0] and deleted a single facet. */
  onDelete: () => void;
  /** Aggregated consumers across every constituent token in the group
   *  (deduped by node id), since border presets are compound. */
  usages: PresetUsage[];
  /** Shift+click multi-select toggle — receives `border-group:<name>`,
   *  same set as the simple preset rows. */
  onShiftClick?: (id: string) => void;
  /** True when this group is part of the active multi-select set. */
  isMultiSelected?: boolean;
  /** Bulk-mode replacement menu ("Delete N presets"). */
  menuOverride?: DropdownMenuEntry[];
}

/** One row per compound border preset group. Same shape as TypographyGroupRow,
 *  with a swatch that previews the resolved border (longhand styles applied
 *  inline so the parent UI doesn't need the canvas iframe's CSS variables). */
export function BorderGroupRow({ group, isEditing, onEdit, onDelete, usages, onShiftClick, isMultiSelected, menuOverride }: BorderGroupRowProps) {
  const widthPx = parseInt(group.tokens.find(t => t.name.endsWith('-width'))?.value || '1') || 1;
  const previewWidth = `${Math.min(widthPx, 3)}px`;
  const styleVal = group.tokens.find(t => t.name.endsWith('-style'))?.value || 'solid';
  const colorVal = group.tokens.find(t => t.name.endsWith('-color'))?.value || '#000';
  const gradVal = group.tokens.find(t => t.name.endsWith('-image-source'))?.value || '';
  const sliceVal = group.tokens.find(t => t.name.endsWith('-image-slice'))?.value || '1';

  const previewStyle: React.CSSProperties = group.flavor === 'gradient'
    ? { borderWidth: previewWidth, borderStyle: 'solid', borderImageSource: gradVal, borderImageSlice: sliceVal, borderRadius: '3px' }
    : { borderWidth: previewWidth, borderStyle: styleVal, borderColor: colorVal, borderRadius: '3px' };

  const menuItems: DropdownMenuEntry[] = menuOverride ?? [
    { id: 'edit', label: 'Edit', onClick: onEdit },
    { type: 'separator' },
    { id: 'delete', label: 'Delete', onClick: onDelete },
  ];

  return (
    <SidebarRow
      label={group.label}
      icon={<span className="w-3.5 h-3.5 rounded bg-transparent block" style={previewStyle} />}
      isActive={isEditing}
      onClick={(e: React.MouseEvent) => {
        // Shift+click → toggle in the shared multi-select set instead of edit.
        if (e.shiftKey && onShiftClick) {
          e.preventDefault();
          e.stopPropagation();
          onShiftClick(`border-group:${group.name}`);
          return;
        }
        onEdit();
      }}
      style={isMultiSelected ? MULTI_SELECT_OUTLINE : undefined}
      menuItems={menuItems}
      right={<UsageBadge count={usages.length} usages={usages} />}
    />
  );
}

export function DisplayCategorySection({ label, emptyLabel, collapsed, onToggleCollapse }: {
  label: string;
  emptyLabel: string;
  collapsed: boolean;
  onToggleCollapse: () => void;
}) {
  return (
    <div className="mb-1">
      <CategoryHeader label={label} onToggle={onToggleCollapse} />
      {!collapsed && (
        <div className="px-2">
          <div className="text-[10px] text-[var(--text-tertiary,var(--text-disabled))] py-2 px-2">
            {emptyLabel}
          </div>
        </div>
      )}
    </div>
  );
}
