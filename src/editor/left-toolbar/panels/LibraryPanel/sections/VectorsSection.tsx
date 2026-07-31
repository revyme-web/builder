// VectorsSection — "Vectors" section of the Library panel. Lists icon
// sets and standalone vector files. Click → enter the master canvas;
// drag → drop a single vector onto the page.

import { useState, useCallback, useMemo } from 'react';
import { CLOUD_ENABLED } from '@/shared/cloud-flag';
import { useAtom } from 'jotai';
import { getFileDisplayName } from '@/code/project/active-file-store';
import NameInputModal from '@/editor/ui/NameInputModal';
import { type DropdownMenuEntry } from '@/design-system/DropdownMenu';
import {
  FolderTree,
  type FolderTreeFolder,
} from '@/design-system/FolderTree';
import { scanLinkedComponentUrls } from '@/cloud/components/linked-components-scanner';
import { projectFS, projectVersionAtom } from '@/code/project/project-fs';
import {
  listVectorFolders,
  getVectorRootOrder,
  createVectorFolder,
  renameVectorFolder,
  deleteVectorFolder,
  moveVectorToFolder,
  moveVectorItem,
  isVectorFolderId,
  type VectorFolder,
} from '@/code/project/vector-folder-ops';
import { shareAndCopy } from '../shared/share';
import { NewFolderMenuIcon } from '../shared/icons';
import {
  LibrarySectionHeader,
  LibraryEmptyState,
  LibraryProjectHeader,
  LibraryFolderRow,
} from '../shared/SectionChrome';
import {
  buildMoveToFolderMenuItems,
  bulkDeleteMenuEntry,
  buildEffectiveRootOrder,
  useSelectedComponentFiles,
} from '../shared/section-utils';
import { useLibraryFolderCrud } from '../shared/useLibraryFolderCrud';
import { IconSetRow, IconSetIcon } from '../items/IconSetRow';
import { LibraryUsageBadge } from '../items/LibraryUsageBadge';
import { LinkedComponentsList } from '../items/LinkedComponents';
import { useLibraryMultiSelect } from '../shared/useLibraryMultiSelect';

// ─── Vectors Section ────────────────────────────────────────────────────────
// Top-level sibling of Components and Templates. Lists every icon-set
// file (`icons/{Pascal}.tsx` carrying the `@iconSet` annotation) with
// the same row affordances as components: click to enter the master,
// menu to copy import / delete. The header `+` opens a name modal and
// creates a fresh icon set with one default vector + auto-navigates
// into the master so the user lands on the editing surface.
export function VectorsSection({
  iconSetFiles, activeFile,
  onSwitchToIconSet,
  onCreateIconSet,
  onDeleteIconSet,
  onBulkDeleteIconSet,
}: {
  iconSetFiles: string[];
  activeFile: string;
  onSwitchToIconSet: (f: string) => void;
  onCreateIconSet: (name: string) => void;
  /** Per-row delete — opens the single-item confirm. */
  onDeleteIconSet: (filePath: string) => void;
  /** Bulk delete — runs the actual delete WITHOUT a per-item confirm
   *  (the shared "Delete N vectors?" modal already gathered consent).
   *  Falls back to `onDeleteIconSet` when omitted. */
  onBulkDeleteIconSet?: (filePath: string) => void;
}) {
  const [nameModal, setNameModal] = useState(false);
  const [version, setVersion] = useAtom(projectVersionAtom);

  const hasLinkedVectors = useMemo(
    () => Array.from(scanLinkedComponentUrls(projectFS)).some(u => u.includes('/vectors/')),
    [version],
  );
  const allEmpty = iconSetFiles.length === 0 && !hasLinkedVectors;

  // Selection-driven row highlight (same as ComponentsSection).
  const selectedComponentFiles = useSelectedComponentFiles();

  // Folder tree state. Vector folders live in `_meta/vector-folders.json`;
  // same shape templates + components use, plugged into the shared
  // `<FolderTree>` design-system component.
  const userFolders: VectorFolder[] = useMemo(() => listVectorFolders(), [version]);
  const folderById = useMemo(() => {
    const m = new Map<string, VectorFolder>();
    for (const f of userFolders) m.set(f.id, f);
    return m;
  }, [userFolders]);
  const persistedRootOrder = useMemo(() => getVectorRootOrder(), [version]);
  const allIconFiles = useMemo(() => new Set(iconSetFiles), [iconSetFiles]);
  const effectiveRootOrder = useMemo(
    () => buildEffectiveRootOrder(persistedRootOrder, folderById, userFolders, [iconSetFiles], allIconFiles),
    [persistedRootOrder, folderById, userFolders, iconSetFiles, allIconFiles],
  );

  // Project folder collapse state (purely cosmetic — Project itself
  // isn't a real folder, just a section header above the FolderTree).
  const [projectFolderOpen, setProjectFolderOpen] = useState(true);

  // Folder rename / pending-creation state — same UX as Components
  // (shared hook; Vectors never emitted folder traces, so no prefix).
  const {
    renamingFolderId, setRenamingFolderId, pendingNewFolderId,
    handleStartNewFolder, handleFolderRenameCommit, handleFolderDelete,
  } = useLibraryFolderCrud({
    userFolders,
    createFolder: createVectorFolder,
    renameFolder: renameVectorFolder,
    deleteFolder: deleteVectorFolder,
  });

  // `+` dropdown — New Vector + New Folder.
  const plusDropdownItems: DropdownMenuEntry[] = [
    {
      id: 'new-vector',
      label: 'New Vector',
      onClick: () => setNameModal(true),
    },
    {
      id: 'new-folder',
      label: 'New Folder',
      icon: <NewFolderMenuIcon />,
      onClick: handleStartNewFolder,
    },
  ];

  // FolderTree adapter callbacks. Pass `effectiveRootOrder` so
  // drift-fallback items reorder correctly (see folder-ops.ts
  // `moveItem` doc).
  const handleMove = useCallback((itemId: string, newParentId: string | null, insertIndex: number) => {
    moveVectorItem(itemId, newParentId, insertIndex, effectiveRootOrder);
    setVersion(v => v + 1);
  }, [setVersion, effectiveRootOrder]);

  // "Move to folder" submenu op — shared builder, vector move + bump.
  const handleMoveToFolder = (filePath: string, folderId: string | null) => {
    moveVectorToFolder(filePath, folderId);
    setVersion(v => v + 1);
  };

  // Shared shift-click multi-select + bulk-delete confirm. Same hook
  // the Components section uses — Delete / Backspace works section-
  // wide while a multi-pick is active.
  const multiSelect = useLibraryMultiSelect({
    itemLabel: 'vectors',
    getDisplayName: getFileDisplayName,
    onDelete: onBulkDeleteIconSet ?? onDeleteIconSet,
  });

  const renderTreeItem = ({ itemId }: { itemId: string }) => {
    if (!allIconFiles.has(itemId)) return null;
    const filePath = itemId;
    const name = getFileDisplayName(filePath);
    const internalName = filePath.replace('icons/', '').replace('.tsx', '');
    const inBulk = multiSelect.size > 0;
    const menuItems: DropdownMenuEntry[] = inBulk ? bulkDeleteMenuEntry(multiSelect, 'vector') : [
      { id: 'edit', label: 'Edit', onClick: () => onSwitchToIconSet(filePath) },
      ...(CLOUD_ENABLED ? [
      { type: 'separator' } as const,
      { id: 'copy-url-cdn', label: 'Copy URL', onClick: () => { void shareAndCopy(internalName, filePath, 'url', 'vector'); } },
      { id: 'copy-import-cdn', label: 'Copy Import', onClick: () => { void shareAndCopy(internalName, filePath, 'import', 'vector'); } },
      ] : []),
      { type: 'separator' },
      { id: 'copy-import-local', label: 'Copy Local Import', onClick: () => { navigator.clipboard.writeText(`import ${internalName} from '@/icons/${internalName}';`); } },
      { type: 'separator' },
      ...buildMoveToFolderMenuItems(filePath, userFolders, handleMoveToFolder),
      { type: 'separator' },
      { id: 'delete', label: 'Delete', onClick: () => onDeleteIconSet(filePath) },
    ];
    return (
      <IconSetRow
        label={name}
        filePath={filePath}
        isActive={filePath === activeFile || selectedComponentFiles.has(filePath)}
        onEdit={() => {
          multiSelect.clearSelection();
          onSwitchToIconSet(filePath);
        }}
        onShiftClick={multiSelect.togglePath}
        isMultiSelected={multiSelect.isMultiSelected(filePath)}
        menuItems={menuItems}
        right={<LibraryUsageBadge filePath={filePath} />}
      />
    );
  };

  const renderTreeFolder = ({ folder, expanded, toggle }: {
    folder: { id: string; name: string; children: string[] };
    expanded: boolean;
    toggle: () => void;
  }) => (
    <LibraryFolderRow
      folder={folder}
      expanded={expanded}
      toggle={toggle}
      renamingFolderId={renamingFolderId}
      pendingNewFolderId={pendingNewFolderId}
      onStartRename={setRenamingFolderId}
      onCommitRename={handleFolderRenameCommit}
      onDelete={handleFolderDelete}
      iconColor="var(--accent)"
    />
  );

  const showProjectHeader = iconSetFiles.length > 0 || userFolders.length > 0;

  return (
    <>
      <LibrarySectionHeader title="Vectors" addTitle="Create vector" items={plusDropdownItems} />

      {allEmpty ? (
        <LibraryEmptyState icon={<IconSetIcon />} message="No icon sets yet" />
      ) : (
        <div className="px-2 pb-2">
          {/* Project header (purely visual — the FolderTree below is
              the actual root). Sits above the tree so icon-set files
              + user folders read as "inside Project". The shared
              header wraps itself in the `data-vector-folder-drop`
              sentinel + drop-highlight outline (see SectionChrome). */}
          {showProjectHeader && (
            <LibraryProjectHeader
              dropAttr="data-vector-folder-drop"
              rootId="vector-root"
              expanded={projectFolderOpen}
              onToggle={() => setProjectFolderOpen(o => !o)}
              iconColor="var(--accent)"
            />
          )}
          <div
            style={{ paddingLeft: 20 }}
            hidden={!projectFolderOpen}
            // Per-kind attribute keeps section drag traffic isolated
            // from Components — a component-row drag won't find a
            // `[data-vector-folder-drop]` ancestor here, so no
            // false drop into a vector folder. Same pattern the
            // Components panel uses with `data-component-folder-drop`.
            data-vector-folder-drop="vector-root"
          >
            <FolderTree
              rootOrder={effectiveRootOrder}
              folderById={folderById as Map<string, FolderTreeFolder>}
              isFolderId={isVectorFolderId}
              onMove={handleMove}
              renderItem={renderTreeItem}
              renderFolder={renderTreeFolder}
              // Same external-drag setup as Components — see comment
              // there. Vectors use their own DOM namespace so cross-
              // section drag traffic never matches.
              itemDrag="external"
              domNamespace="vector-folder-tree"
            />
          </div>

          {/* Linked vectors (CDN-imported, creator-grouped) sit
              outside Project — siblings, not children. */}
          <LinkedComponentsList kind="vector" />
        </div>
      )}

      <NameInputModal
        isOpen={nameModal}
        onClose={() => setNameModal(false)}
        onSubmit={(name) => { onCreateIconSet(name); setNameModal(false); }}
        title="Name Icon Set"
        placeholder="e.g. Animals, Tools, Logos..."
        defaultValue=""
      />

      {multiSelect.bulkDeleteModal}
    </>
  );
}
