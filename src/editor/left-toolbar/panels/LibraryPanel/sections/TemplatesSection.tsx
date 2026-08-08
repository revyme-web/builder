// TemplatesSection — the "Templates" section of the Library panel.
// Lists user-created templates grouped into folders. Click → switch
// active page to the template's file. Drag → drop a template instance
// onto the canvas. Right-click → rename/delete. Each folder is a
// FolderTree node; the unfiled templates render at the root.

import React, { useState, useCallback, useMemo } from 'react';
import { useAtom } from 'jotai';
import NameInputModal from '@/editor/ui/NameInputModal';
import ConfirmDialog from '@/design-system/ConfirmDialog';
import { type DropdownMenuEntry } from '@/design-system/DropdownMenu';
import {
  FolderTree,
  type FolderTreeFolder,
} from '@/design-system/FolderTree';
import SidebarRow from '@/design-system/SidebarRow';
import { projectVersionAtom } from '@/code/project/project-fs';
import { listTemplates, createTemplate, renameTemplate, deleteTemplate } from '@/code/project/template-ops';
import { sealPendingHistory, pushHistoryFileOp } from '@/code/mutation/history';
import {
  listTemplateFolders,
  getTemplateRootOrder,
  createTemplateFolder,
  renameTemplateFolder,
  deleteTemplateFolder,
  moveTemplateToFolder,
  moveTemplateItem,
  isTemplateFolderId,
  type TemplateFolder,
} from '@/code/project/template-folder-ops';
import { flushNow } from '@/code/mutation/mutation-queue';
import { useIsViewer } from '@/code/stores/viewer-mode-store';
import { NewFolderMenuIcon } from '../shared/icons';
import {
  LibrarySectionHeader,
  LibraryEmptyState,
  LibraryFolderRow,
} from '../shared/SectionChrome';
import { buildMoveToFolderMenuItems, bulkDeleteMenuEntry } from '../shared/section-utils';
import { useLibraryFolderCrud } from '../shared/useLibraryFolderCrud';
import { useLibraryMultiSelect } from '../shared/useLibraryMultiSelect';

const TemplateLibraryIcon = React.memo(function TemplateLibraryIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--accent-secondary)' }}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="3" y1="9" x2="21" y2="9" />
      <line x1="3" y1="15" x2="21" y2="15" />
    </svg>
  );
});




export function TemplatesSection({
  activeFile,
  onEditTemplate,
  onTemplateDeleted,
  searchQuery,
}: {
  activeFile: string;
  onEditTemplate: (clientPath: string) => void;
  /** Fired after a template is deleted. Lets the panel navigate away when
   *  the user was editing that template's LayoutClient (else they'd be
   *  stranded on a now-deleted file). Receives the deleted template name. */
  onTemplateDeleted?: (name: string) => void;
  /** Top-of-panel search query (LibraryPanel owns the input). When
   *  non-empty, the template list narrows to entries whose name
   *  (case-insensitive) contains the query. Empty / undefined keeps
   *  the full list. The filter happens AFTER `listTemplates()` so the
   *  underlying FS scan stays a single pass; only the visible array
   *  re-derives on every keystroke. */
  searchQuery?: string;
}) {
  // Re-derive on every FS change — templates are created/renamed/deleted
  // from this panel AND from the right-panel picker. The setter is
  // captured so we can bump the version after every write below;
  // `projectFS` itself doesn't bump the React atom, callers have to.
  const [version, setVersion] = useAtom(projectVersionAtom);
  // Viewers may click a template to navigate into its layout file for
  // inspection/comment, but the per-row context menu (rename/delete) is
  // an edit affordance — hidden for viewers.
  const isViewer = useIsViewer();
  const allTemplates = useMemo(() => listTemplates(), [version]);
  const templates = useMemo(() => {
    const q = searchQuery?.trim().toLowerCase();
    if (!q) return allTemplates;
    return allTemplates.filter(t => t.name.toLowerCase().includes(q));
  }, [allTemplates, searchQuery]);

  const [nameModalOpen, setNameModalOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const handleCreate = useCallback((name: string) => {
    flushNow();
    // Template ops write ProjectFS directly (no queue flush → no pushHistory),
    // so without this pair the creation was ABSENT from the undo timeline:
    // Cmd+Z skipped it and its diff glued onto the next entry (user report
    // 2026-07-27). Seal pending edits first, then record the op as ONE entry.
    sealPendingHistory();
    // Returns the new template's `LayoutClient.tsx` path (or null on a bad /
    // duplicate name).
    const clientPath = createTemplate(name);
    // Bump the atom so this section + everything else that reads
    // `projectVersionAtom` (right-panel Template picker, page tree)
    // sees the new template without needing a panel switch.
    setVersion(v => v + 1);
    setNameModalOpen(false);
    // Navigate straight into the new template to start designing it —
    // same as clicking an existing template row (and the Template tool's
    // Edit). `onEditTemplate` runs the shared switchActiveFile flow.
    if (clientPath) {
      onEditTemplate(clientPath);
      // Undo-side target: where the user was BEFORE creating (the new
      // LayoutClient they're now on won't exist in the restored state).
      pushHistoryFileOp(activeFile);
    }
  }, [setVersion, onEditTemplate, activeFile]);

  const handleRename = useCallback((newName: string) => {
    if (!renameTarget) return;
    flushNow();
    sealPendingHistory();
    renameTemplate(renameTarget, newName);
    setVersion(v => v + 1);
    setRenameTarget(null);
    // The rename moves every file in the group — the pre-op active path is
    // the one that exists in the restored state.
    pushHistoryFileOp(activeFile);
  }, [renameTarget, setVersion, activeFile]);

  const handleDelete = useCallback(() => {
    if (!confirmDelete) return;
    flushNow();
    sealPendingHistory();
    const beforePath = activeFile; // pre-op; onTemplateDeleted may navigate
    deleteTemplate(confirmDelete);
    setVersion(v => v + 1);
    onTemplateDeleted?.(confirmDelete);
    setConfirmDelete(null);
    pushHistoryFileOp(beforePath);
  }, [confirmDelete, setVersion, onTemplateDeleted, activeFile]);

  // Shared shift-click multi-select + bulk-delete confirm. Templates
  // are keyed by clientPath in the FolderTree; we hand the same path
  // to `onDelete`, which resolves back to the template name and runs
  // the single-template delete (same code path the per-row menu uses).
  // The `templateByPath` lookup is built later in the file, so we
  // re-derive a fresh getter inside the hook callbacks.
  const multiSelectTemplates = useLibraryMultiSelect({
    itemLabel: 'templates',
    getDisplayName: (clientPath: string) => {
      const t = allTemplates.find(x => x.clientPath === clientPath);
      return t?.name ?? clientPath;
    },
    onDelete: (clientPath: string) => {
      const t = allTemplates.find(x => x.clientPath === clientPath);
      if (!t) return;
      flushNow();
      sealPendingHistory();
      const beforePath = activeFile;
      deleteTemplate(t.name);
      setVersion(v => v + 1);
      onTemplateDeleted?.(t.name);
      pushHistoryFileOp(beforePath);
    },
  });

  // ─── Folder system ──────────────────────────────────────────────────────
  // Mirror of the Components / Vectors panel pattern: a collapsible
  // "Project" header above the local templates plus optional user-
  // defined folders. Templates DON'T ship to the marketplace, so this
  // is purely organization — there's no CDN side, no creator-grouped
  // bucket, no Linked-templates list. Folder data lives in
  // `_meta/template-folders.json`; each folder's `files` entries are
  // template `clientPath`s (the LayoutClient.tsx file path, stable
  // across template renames within the same route group).
  const userFolders: TemplateFolder[] = useMemo(
    () => listTemplateFolders(),
    [version],
  );

  // Newly-created folder waiting for its first commit. An empty
  // commit on a pending folder cancels (deletes) it — same UX as the
  // components panel. Shared state machine, see useLibraryFolderCrud.
  const {
    renamingFolderId, setRenamingFolderId, pendingNewFolderId,
    handleStartNewFolder, handleFolderRenameCommit, handleFolderDelete,
  } = useLibraryFolderCrud({
    userFolders,
    createFolder: createTemplateFolder,
    renameFolder: renameTemplateFolder,
    deleteFolder: deleteTemplateFolder,
    tracePrefix: 'templates',
  });

  // Build the `+` button's dropdown — "New Template" + "New Folder".
  // No "Sort Alphabetically" yet (would need sort-state persistence
  // and isn't in scope of the requested feature).
  const plusDropdownItems: DropdownMenuEntry[] = [
    {
      id: 'new-template',
      label: 'New Template',
      onClick: () => setNameModalOpen(true),
    },
    {
      id: 'new-folder',
      label: 'New Folder',
      icon: <NewFolderMenuIcon />,
      onClick: handleStartNewFolder,
    },
  ];

  // ─── Tree traversal ─────────────────────────────────────────────────────
  // Render order is driven by `rootOrder` + each folder's `children`
  // array (mixed: template clientPaths + folder ids). Templates not
  // referenced anywhere fall back to the root tail; folders missing
  // from any parent's children fall back too — drift handling
  // matches the Pages panel's "no orphan state" stance.
  const rootOrder = useMemo(() => getTemplateRootOrder(), [version]);

  const folderById = useMemo(() => {
    const m = new Map<string, TemplateFolder>();
    for (const f of userFolders) m.set(f.id, f);
    return m;
  }, [userFolders]);
  const templateByPath = useMemo(() => {
    const m = new Map<string, typeof templates[number]>();
    for (const t of templates) m.set(t.clientPath, t);
    return m;
  }, [templates]);

  // Compute the effective root — items in `rootOrder` that exist,
  // plus drift fallbacks (templates / folders never referenced
  // anywhere appear at the tail). Stable ordering so DnD reorders
  // are persistent across reloads.
  const effectiveRootOrder: string[] = useMemo(() => {
    const referenced = new Set<string>();
    for (const id of rootOrder) referenced.add(id);
    for (const f of userFolders) for (const c of f.children) referenced.add(c);
    const out = rootOrder.filter(id => folderById.has(id) || templateByPath.has(id));
    // Drift fallback: any folder/template not referenced anywhere
    // gets appended at the root tail so the user can find + reorganize.
    for (const t of templates) {
      if (!referenced.has(t.clientPath)) out.push(t.clientPath);
    }
    for (const f of userFolders) {
      if (!referenced.has(f.id) && f.parentId === null) out.push(f.id);
    }
    return out;
  }, [rootOrder, userFolders, templates, folderById, templateByPath]);

  const allEmpty = templates.length === 0 && userFolders.length === 0;

  // "Move to folder" submenu — shared builder (section-utils) wired to
  // the template move op + version bump; appears in each template
  // row's right-click menu, mirroring components.
  const handleMoveToFolder = (clientPath: string, folderId: string | null) => {
    moveTemplateToFolder(clientPath, folderId);
    setVersion(v => v + 1);
  };

  // FolderTree adapter — `folderById` and `rootOrder` come from
  // `template-folder-ops.ts`; the move callback bumps version after
  // committing. Cycle protection is owned by `moveTemplateItem`.
  // Pass `effectiveRootOrder` so drift-fallback items reorder
  // correctly (see folder-ops.ts `moveItem` doc).
  const handleMove = useCallback((itemId: string, newParentId: string | null, insertIndex: number) => {
    moveTemplateItem(itemId, newParentId, insertIndex, effectiveRootOrder);
    setVersion(v => v + 1);
  }, [setVersion, effectiveRootOrder]);

  // FolderTree's renderItem callback — visual only (the wrapper
  // div + DnD handlers + indicators are owned by FolderTree).
  // `itemId` is the template `clientPath` for non-folder rows.
  const renderTreeItem = useCallback(({ itemId }: { itemId: string }) => {
    const t = templateByPath.get(itemId);
    if (!t) return null;
    const inBulk = multiSelectTemplates.size > 0;
    const menuItems: DropdownMenuEntry[] = inBulk ? bulkDeleteMenuEntry(multiSelectTemplates, 'template') : [
      { id: 'edit', label: 'Edit', onClick: () => onEditTemplate(t.clientPath) },
      { id: 'rename', label: 'Rename', onClick: () => setRenameTarget(t.name) },
      { type: 'separator' },
      ...buildMoveToFolderMenuItems(t.clientPath, userFolders, handleMoveToFolder),
      { type: 'separator' },
      { id: 'delete', label: 'Delete', onClick: () => setConfirmDelete(t.name) },
    ];
    const isPicked = multiSelectTemplates.isMultiSelected(t.clientPath);
    return (
      <div
        style={isPicked ? {
          outline: '1.5px solid var(--accent, #4c8df6)',
          outlineOffset: -1,
          borderRadius: 6,
        } : undefined}
      >
        <SidebarRow
          icon={<TemplateLibraryIcon />}
          label={t.name}
          isActive={t.clientPath === activeFile}
          menuItems={isViewer ? undefined : menuItems}
          onClick={(e: React.MouseEvent) => {
            if (e.shiftKey) {
              e.preventDefault();
              e.stopPropagation();
              multiSelectTemplates.togglePath(t.clientPath);
              return;
            }
            multiSelectTemplates.clearSelection();
            onEditTemplate(t.clientPath);
          }}
        />
      </div>
    );
  }, [templateByPath, activeFile, onEditTemplate, userFolders, handleMoveToFolder, isViewer, multiSelectTemplates]);

  // FolderTree's renderFolder callback — visual only. The expand
  // chevron / open-state / nesting body are owned by FolderTree.
  const renderTreeFolder = useCallback(({ folder, expanded, toggle }: { folder: FolderTreeFolder; expanded: boolean; toggle: () => void }) => (
    <LibraryFolderRow
      folder={folder}
      expanded={expanded}
      toggle={toggle}
      renamingFolderId={renamingFolderId}
      pendingNewFolderId={pendingNewFolderId}
      onStartRename={setRenamingFolderId}
      onCommitRename={handleFolderRenameCommit}
      onDelete={handleFolderDelete}
    />
  ), [renamingFolderId, pendingNewFolderId, handleFolderDelete, handleFolderRenameCommit]);


  return (
    <>
      <LibrarySectionHeader title="Templates" addTitle="Create template" items={plusDropdownItems} />

      {allEmpty ? (
        <LibraryEmptyState icon={<TemplateLibraryIcon />} message="No templates yet" />
      ) : (
        <div className="px-2 pb-2">
          <FolderTree
            rootOrder={effectiveRootOrder}
            folderById={folderById}
            isFolderId={isTemplateFolderId}
            onMove={handleMove}
            renderItem={renderTreeItem}
            renderFolder={renderTreeFolder}
          />
        </div>
      )}

      {/* Templates use the purple `--accent-secondary` accent (same as
          Components) — their folder icons + section visuals are purple
          everywhere else in the Library panel, so the modal matches. */}
      <NameInputModal
        isOpen={nameModalOpen}
        onClose={() => setNameModalOpen(false)}
        onSubmit={handleCreate}
        title="Name Template"
        placeholder="e.g. marketing, dashboard, blog..."
        defaultValue=""
        submitLabel="Create Template"
        accent="secondary"
      />
      <NameInputModal
        isOpen={renameTarget !== null}
        onClose={() => setRenameTarget(null)}
        onSubmit={handleRename}
        title="Rename Template"
        placeholder="New template name"
        defaultValue={renameTarget ?? ''}
        submitLabel="Rename"
        accent="secondary"
      />
      <ConfirmDialog
        isOpen={confirmDelete !== null}
        title="Delete template?"
        message={`Pages assigned to "${confirmDelete}" will be moved out and keep their content. The template's layout file will be removed.`}
        confirmLabel="Delete"
        danger
        onConfirm={handleDelete}
        onClose={() => setConfirmDelete(null)}
      />

      {multiSelectTemplates.bulkDeleteModal}
    </>
  );
}
