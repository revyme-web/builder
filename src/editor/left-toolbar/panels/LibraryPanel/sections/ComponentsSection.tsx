// ComponentsSection — the "Components" section of the Library panel.
// Top-level home for all design components, code components, and icon
// sets in the user's project. Mirrors the Templates/Vectors
// section pattern with project header + folder tree + per-row menus +
// drag-into-folder + drag-to-canvas. ProjectChildren renders the
// per-folder content; the shared section skeleton (header, empty
// state, Project drop header, folder rows, "Move to…" submenu) lives
// in ../shared/SectionChrome + ../shared/section-utils.

import { useState, useCallback, useMemo } from 'react';
import { CLOUD_ENABLED } from '@/shared/cloud-flag';
import { useAtomValue, useSetAtom } from 'jotai';
import { getFileDisplayName } from '@/code/project/active-file-store';
import NameInputModal from '@/editor/ui/NameInputModal';
import { type DropdownMenuEntry } from '@/design-system/DropdownMenu';
import {
  FolderTree,
  type FolderTreeFolder,
} from '@/design-system/FolderTree';
import { scanLinkedComponentUrls } from '@/cloud/components/linked-components-scanner';
import { setComponentName } from '@/code/components/component-ops';
import { componentEditorFileAtom } from '@/code/stores/component-editor-store';
import { projectFS, projectVersionAtom } from '@/code/project/project-fs';
import { modifyProjectFile } from '@/code/project/modify-file';
import {
  listComponentFolders,
  getComponentRootOrder,
  createComponentFolder,
  renameComponentFolder,
  deleteComponentFolder,
  moveFileToFolder,
  moveComponentItem,
  isComponentFolderId,
  type ComponentFolder,
} from '@/code/project/component-folder-ops';
import { ComponentClusterIcon } from '@/shared/icons';
import { trace } from '@/shared/debug-trace';
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
import { ComponentRow, CodeComponentRow } from '../items/ComponentRow';
import { LibraryUsageBadge } from '../items/LibraryUsageBadge';
import { LinkedComponentsList } from '../items/LinkedComponents';
import { useLibraryMultiSelect, type LibraryMultiSelect } from '../shared/useLibraryMultiSelect';

// ─── Unified Components Section ─────────────────────────────────────────────
// The "Move to → <folder>" submenu builder and the folder-row /
// section-chrome skeletons live in `../shared/section-utils` and
// `../shared/SectionChrome` — shared with Templates + Vectors.

// ─── Project section content (folders + ungrouped rows) ────────────────────
// Renders the children of the implicit "Project" folder in the Library
// panel. Files that the user has organized into a sub-folder render
// inside that folder's collapsible header; files NOT in any folder
// render flat at the Project root. Lives in its own component so the
// parent ComponentsSection stays readable.

interface ProjectChildrenProps {
  componentFiles: string[];
  codeComponentFiles: string[];
  userFolders: ComponentFolder[];
  projectFolderOpen: boolean;
  renamingPath: string | null;
  renamingFolderId: string | null;
  /** Set to the id of a freshly-created folder while it's awaiting its
   *  first commit. UserFolder reads this to render the inline edit
   *  with an empty `initialValue` (no pre-fill) so an empty commit is
   *  unambiguously "user typed nothing → cancel". */
  pendingNewFolderId: string | null;
  /** componentFile values of every node currently selected on the
   *  canvas. Each row checks `.has(filePath)` to render itself active,
   *  so the user can see at a glance which master row corresponds to
   *  the selected instance(s). */
  selectedComponentFiles: Set<string>;
  activeFile: string;
  editorFile: string | null;
  onSwitchToComponent: (f: string) => void;
  onSwitchToCodeComponent: (f: string) => void;
  onDeleteComponent: (f: string) => void;
  setRenamingPath: (p: string | null) => void;
  setRenamingFolderId: (id: string | null) => void;
  handleRenameCommit: (filePath: string, newName: string) => void;
  handleFolderRenameCommit: (id: string, newName: string) => void;
  handleFolderDelete: (id: string) => void;
  /** Shared multi-select state — when `size > 0` the per-row ⋯ menu
   *  collapses to a single "Delete N" entry. Shift-click on any row
   *  toggles its path in the set. See `useLibraryMultiSelect`. */
  multiSelect: LibraryMultiSelect;
}

function ProjectChildren(props: ProjectChildrenProps) {
  const {
    componentFiles, codeComponentFiles, userFolders,
    projectFolderOpen, renamingPath, renamingFolderId, pendingNewFolderId,
    selectedComponentFiles,
    activeFile, editorFile,
    onSwitchToComponent, onSwitchToCodeComponent, onDeleteComponent,
    setRenamingPath, setRenamingFolderId,
    handleRenameCommit, handleFolderRenameCommit, handleFolderDelete,
    multiSelect,
  } = props;

  const allFiles = useMemo(
    () => new Set<string>([...componentFiles, ...codeComponentFiles]),
    [componentFiles, codeComponentFiles],
  );
  // Files claimed by any user folder. The remainder render at root.
  const claimed = useMemo(() => {
    const set = new Set<string>();
    for (const folder of userFolders) {
      for (const c of folder.children) {
        // Skip folder ids — only file paths count as claimed by a
        // folder for purposes of the ungrouped fallback.
        if (!c.startsWith('fld-')) set.add(c);
      }
    }
    return set;
  }, [userFolders]);

  const ungroupedDesign = componentFiles.filter(f => !claimed.has(f));
  const ungroupedCode = codeComponentFiles.filter(f => !claimed.has(f));

  // Helper renderers — same JSX as the previous flat path, factored
  // into closures so we can call them from both folder bodies AND the
  // root-level "ungrouped" list.
  // When multi-select is active, every per-row ⋯ menu collapses to a
  // single "Delete N items" entry — shared skeleton, see
  // `bulkDeleteMenuEntry` in section-utils.
  const bulkMenuItems = (): DropdownMenuEntry[] => bulkDeleteMenuEntry(multiSelect, 'component');

  const renderDesignRow = (filePath: string) => {
    const name = getFileDisplayName(filePath);
    const internalName = filePath.replace('components/', '').replace('.tsx', '');
    const isRenaming = renamingPath === filePath;
    const inBulk = multiSelect.size > 0;
    const menuItems: DropdownMenuEntry[] = inBulk ? bulkMenuItems() : [
      { id: 'edit', label: 'Edit', onClick: () => onSwitchToComponent(filePath) },
      { id: 'rename', label: 'Rename', onClick: () => setRenamingPath(filePath) },
      { id: 'duplicate', label: 'Duplicate', onClick: () => { /* TODO */ } },
      ...(CLOUD_ENABLED ? [
      { type: 'separator' } as const,
      { id: 'copy-url', label: 'Copy URL', onClick: () => { void shareAndCopy(internalName, filePath, 'url', 'design'); } },
      { id: 'copy-import', label: 'Copy Import', onClick: () => { void shareAndCopy(internalName, filePath, 'import', 'design'); } },
      ] : []),
      { type: 'separator' },
      ...buildMoveToFolderMenuItems(filePath, userFolders, moveFileToFolder),
      { type: 'separator' },
      { id: 'delete', label: 'Delete', onClick: () => onDeleteComponent(filePath) },
    ];
    return (
      <ComponentRow
        key={filePath}
        label={name}
        filePath={filePath}
        isActive={filePath === activeFile || filePath === editorFile || selectedComponentFiles.has(filePath)}
        onEdit={() => {
          // Plain click resets any multi-select before navigating —
          // matches Pages-panel behaviour.
          multiSelect.clearSelection();
          onSwitchToComponent(filePath);
        }}
        onShiftClick={multiSelect.togglePath}
        isMultiSelected={multiSelect.isMultiSelected(filePath)}
        menuItems={menuItems}
        right={<LibraryUsageBadge filePath={filePath} />}
        inlineEdit={isRenaming ? {
          initialValue: name,
          onCommit: (val) => handleRenameCommit(filePath, val),
        } : undefined}
      />
    );
  };

  const renderCodeRow = (filePath: string) => {
    const name = getFileDisplayName(filePath);
    const internalName = filePath.replace('components/', '').replace('.tsx', '');
    const isRenaming = renamingPath === filePath;
    const inBulk = multiSelect.size > 0;
    const menuItems: DropdownMenuEntry[] = inBulk ? bulkMenuItems() : [
      { id: 'edit', label: 'Edit', onClick: () => onSwitchToCodeComponent(filePath) },
      { id: 'rename', label: 'Rename', onClick: () => setRenamingPath(filePath) },
      { id: 'duplicate', label: 'Duplicate', onClick: () => { /* TODO */ } },
      ...(CLOUD_ENABLED ? [
      { type: 'separator' } as const,
      { id: 'copy-url-cdn', label: 'Copy URL', onClick: () => { void shareAndCopy(internalName, filePath, 'url'); } },
      { id: 'copy-import-cdn', label: 'Copy Import', onClick: () => { void shareAndCopy(internalName, filePath, 'import'); } },
      ] : []),
      { type: 'separator' },
      ...buildMoveToFolderMenuItems(filePath, userFolders, moveFileToFolder),
      { type: 'separator' },
      { id: 'delete', label: 'Delete', onClick: () => onDeleteComponent(filePath) },
    ];
    return (
      <CodeComponentRow
        key={filePath}
        label={name}
        filePath={filePath}
        isActive={filePath === activeFile || filePath === editorFile || selectedComponentFiles.has(filePath)}
        onEdit={() => {
          multiSelect.clearSelection();
          onSwitchToCodeComponent(filePath);
        }}
        onShiftClick={multiSelect.togglePath}
        isMultiSelected={multiSelect.isMultiSelected(filePath)}
        menuItems={menuItems}
        right={<LibraryUsageBadge filePath={filePath} />}
        inlineEdit={isRenaming ? {
          initialValue: name,
          onCommit: (val) => handleRenameCommit(filePath, val),
        } : undefined}
      />
    );
  };

  const isComponentFile = (f: string) => componentFiles.includes(f);

  // FolderTree integration. Compute the data the centralized
  // component needs:
  //   • `folderById` — id → ComponentFolder lookup
  //   • `effectiveRootOrder` — persisted rootOrder + drift fallback
  //     (any unreferenced file gets appended to the root tail so
  //     deletes / renames don't leave items hidden)
  //   • renderItem / renderFolder — visual-only callbacks; FolderTree
  //     owns the wrapper + DnD handlers
  // Items are not HTML5-draggable (`itemsDraggable: false`) so the
  // existing pointer-based canvas drag (`useComponentDrag`) keeps
  // working — folders gain reorder + nest, items keep their canvas
  // drop affordance.
  const setVersion = useSetAtom(projectVersionAtom);
  const folderById = useMemo(() => {
    const m = new Map<string, ComponentFolder>();
    for (const f of userFolders) m.set(f.id, f);
    return m;
  }, [userFolders]);

  const persistedRootOrder = useMemo(() => getComponentRootOrder(), [userFolders]);
  // Drift fallback — design components first, then code components,
  // matching the previous flat-list ordering.
  const effectiveRootOrder = useMemo(
    () => buildEffectiveRootOrder(persistedRootOrder, folderById, userFolders, [componentFiles, codeComponentFiles], allFiles),
    [persistedRootOrder, folderById, userFolders, componentFiles, codeComponentFiles, allFiles],
  );

  const handleMove = (itemId: string, newParentId: string | null, insertIndex: number) => {
    // Pass `effectiveRootOrder` so drift-fallback items reorder
    // correctly (see folder-ops.ts `moveItem` doc).
    moveComponentItem(itemId, newParentId, insertIndex, effectiveRootOrder);
    setVersion(v => v + 1);
  };

  const renderTreeItem = ({ itemId }: { itemId: string }) => {
    if (!allFiles.has(itemId)) return null;
    return isComponentFile(itemId) ? renderDesignRow(itemId) : renderCodeRow(itemId);
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
    />
  );

  // Project body indents to align icons under the "r" of any creator
  // folder name below — same value the old custom rendering used.
  // Outer `data-component-folder-drop="component-root"` lets the
  // pointer-based `useComponentDrag` route an "into folder" drop to
  // the section root (= ungroup) when the cursor is over the body
  // but not over a specific folder row. The PER-KIND attribute name
  // (vs. the old shared `data-folder-drop`) keeps cross-section
  // drags isolated — a vector drag never matches this attr, so the
  // Components Project header doesn't highlight from vector traffic.
  return (
    <div
      style={{ paddingLeft: 20 }}
      hidden={!projectFolderOpen}
      data-component-folder-drop="component-root"
    >
      <FolderTree
        rootOrder={effectiveRootOrder}
        folderById={folderById as Map<string, FolderTreeFolder>}
        isFolderId={isComponentFolderId}
        onMove={handleMove}
        renderItem={renderTreeItem}
        renderFolder={renderTreeFolder}
        // External item drag: useComponentDrag's pointer flow
        // drives item drags (so canvas drop still works); FolderTree
        // only owns folder rows here. Both write to the SAME
        // `folderTreeIndicatorAtom`, so the visual feedback is
        // identical regardless of who initiated the drag.
        itemDrag="external"
        domNamespace="component-folder-tree"
      />
    </div>
  );
}

export function ComponentsSection({
  componentFiles, codeComponentFiles, activeFile,
  onSwitchToComponent, onSwitchToCodeComponent,
  onCreateDesignComponent, onCreateCodeComponent,
  onDeleteComponent,
  onBulkDeleteComponent,
}: {
  componentFiles: string[];
  codeComponentFiles: string[];
  activeFile: string;
  onSwitchToComponent: (f: string) => void;
  onSwitchToCodeComponent: (f: string) => void;
  onCreateDesignComponent: (name: string) => void;
  onCreateCodeComponent: (name: string) => void;
  /** Per-row delete — opens the single-item confirm. Used by the
   *  per-row ⋯ "Delete" menu entry. */
  onDeleteComponent: (filePath: string) => void;
  /** Bulk delete — runs the actual delete WITHOUT a per-item confirm
   *  (the bulk-select "Delete N?" modal already gathered consent).
   *  Defaults to `onDeleteComponent` for callers that haven't been
   *  updated, but every in-tree caller now passes the unconfirmed
   *  variant so the bulk flow doesn't stack two modals back-to-back. */
  onBulkDeleteComponent?: (filePath: string) => void;
}) {
  const [nameModal, setNameModal] = useState<'design' | 'code' | null>(null);
  // The empty state hides whenever the user has ANY component-like
  // entry — local components, code components, OR CDN-imported
  // (linked) components. Without checking linked, the section shows
  // "No components yet" PLUS the linked list below it, which is
  // confusing.
  const projectVersionForEmpty = useAtomValue(projectVersionAtom);
  // Only count component-prefixed URLs — vector URLs belong to the
  // Vectors section's empty-state gate, not Components. Without the
  // filter, a project with ONLY a linked vector would hide the
  // Components empty state and render an orphan vector row under
  // Components instead of where the user actually expects it.
  const hasLinked = useMemo(
    () => Array.from(scanLinkedComponentUrls(projectFS)).some(u => u.includes('/components/')),
    [projectVersionForEmpty],
  );
  const allEmpty =
    componentFiles.length === 0 &&
    codeComponentFiles.length === 0 &&
    !hasLinked;
  const editorFile = useAtomValue(componentEditorFileAtom);
  // Highlight the master row of any component instance currently
  // selected on the canvas — `LinkedComponentRow` matches its row's
  // URL through the same Set. See `useSelectedComponentFiles`.
  const selectedComponentFiles = useSelectedComponentFiles();
  // Project folder collapse state — same UX as creator folders below.
  // Open by default so users see their components without an extra
  // click. The header itself uses SidebarRow with the `expandable`
  // affordance for visual consistency.
  const [projectFolderOpen, setProjectFolderOpen] = useState(true);

  // Shared shift-click multi-select + bulk-delete confirm. Wires every
  // ComponentRow / CodeComponentRow to a single set; the per-row ⋯
  // menu collapses to "Delete N components" when the set is non-empty,
  // and Delete / Backspace fires the same confirmation. `onDelete`
  // routes through the existing single-row delete callback so the
  // owning code path (file deletes, registry refresh, etc.) stays in
  // one place.
  const multiSelect = useLibraryMultiSelect({
    itemLabel: 'components',
    getDisplayName: getFileDisplayName,
    // Bulk flow skips the per-component confirm — see prop doc above.
    onDelete: onBulkDeleteComponent ?? onDeleteComponent,
  });
  // Inline rename: tracks which row is currently in edit mode by file path.
  // Mirrors LayersPanel's rename UX. Commit writes the new value to the
  // file's `@name "..."` annotation via `setComponentName` — the display
  // label re-renders next time `projectVersionAtom` bumps.
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const bumpVersion = useSetAtom(projectVersionAtom);

  // User-defined sub-folders inside Project. Stored in
  // `_meta/component-folders.json` (see component-folder-ops.ts). The
  // version atom bumps on every write so this re-derives.
  const projectVersionForFolders = useAtomValue(projectVersionAtom);
  const userFolders = useMemo(
    () => listComponentFolders(),
    [projectVersionForFolders],
  );
  // Inline rename / pending-creation state for user folders — shared
  // create/rename/delete state machine (see useLibraryFolderCrud).
  // "New Folder" creates the folder immediately (no modal) and enters
  // rename mode at once; an empty first commit cancels the creation.
  const {
    renamingFolderId, setRenamingFolderId, pendingNewFolderId,
    handleStartNewFolder, handleFolderRenameCommit, handleFolderDelete,
  } = useLibraryFolderCrud({
    userFolders,
    createFolder: createComponentFolder,
    renameFolder: renameComponentFolder,
    deleteFolder: deleteComponentFolder,
    tracePrefix: 'library',
  });

  const handleRenameCommit = useCallback((filePath: string, newName: string) => {
    const current = getFileDisplayName(filePath);
    setRenamingPath(null);
    if (newName === current) return; // no-op (Escape, or unchanged value)
    modifyProjectFile(filePath, (code) => setComponentName(code, newName));
    // `modifyProjectFile` bumps `projectVersionAtom` internally only when
    // the transform CHANGED the code — which it always does for renames.
    // Bump locally too so any consumers of `projectVersionAtom` that read
    // through a derived atom (e.g. `getFileDisplayName` here) see the new
    // value on the next render. Cheap if redundant.
    bumpVersion(v => v + 1);
    trace.action('library:component-rename', { filePath, newName });
  }, [bumpVersion]);

  const dropdownItems: DropdownMenuEntry[] = [
    {
      id: 'design',
      label: 'Design Component',
      icon: <svg width="14" height="14" viewBox="0 0 24 24"><path fill="currentColor" d="M12.53 2.47a.75.75 0 0 0-1.06 0L8.32 5.62a.75.75 0 0 0 0 1.06l3.15 3.15a.75.75 0 0 0 1.06 0l3.15-3.15a.75.75 0 0 0 0-1.06zm5.85 6.3a.75.75 0 0 0-1.06 0l-3.15 3.15a.75.75 0 0 0 0 1.06l3.15 3.15a.75.75 0 0 0 1.06 0l3.15-3.15a.75.75 0 0 0 0-1.06zm-5.85 5.4a.75.75 0 0 0-1.06 0l-3.15 3.15a.75.75 0 0 0 0 1.06l3.15 3.15a.75.75 0 0 0 1.06 0l3.15-3.15a.75.75 0 0 0 0-1.06zM6.68 8.32a.75.75 0 0 0-1.06 0l-3.15 3.15a.75.75 0 0 0 0 1.06l3.15 3.15a.75.75 0 0 0 1.06 0l3.15-3.15a.75.75 0 0 0 0-1.06z" /></svg>,
      onClick: () => setNameModal('design'),
    },
    {
      id: 'code',
      label: 'Code Component',
      icon: <svg width="14" height="14" viewBox="0 0 24 24"><g fill="none"><path d="M0 0h24v24H0z" /><path fill="currentColor" d="M14.62 2.662a1.5 1.5 0 0 1 1.04 1.85l-4.431 15.787a1.5 1.5 0 0 1-2.889-.81L12.771 3.7a1.5 1.5 0 0 1 1.85-1.039ZM7.56 6.697a1.5 1.5 0 0 1 0 2.12L4.38 12l3.182 3.182a1.5 1.5 0 1 1-2.122 2.121L1.197 13.06a1.5 1.5 0 0 1 0-2.12l4.242-4.243a1.5 1.5 0 0 1 2.122 0Zm8.88 2.12a1.5 1.5 0 1 1 2.12-2.12l4.243 4.242a1.5 1.5 0 0 1 0 2.121l-4.242 4.243a1.5 1.5 0 1 1-2.122-2.121L19.621 12z" /></g></svg>,
      onClick: () => setNameModal('code'),
    },
    { type: 'separator' },
    {
      id: 'folder',
      label: 'New Folder',
      // Same folder glyph as the creator-group icon used for Linked
      // groups (see CreatorFolderIcon in ./LibraryPanel/shared/icons).
      // Visual cue for "this creates an organizational container, not
      // a component".
      icon: <NewFolderMenuIcon />,
      onClick: handleStartNewFolder,
    },
  ];

  return (
    <>
      {/* Header */}
      <LibrarySectionHeader title="Components" addTitle="Create component" items={dropdownItems} />

      {/* Unified component list */}
      {allEmpty ? (
        <LibraryEmptyState
          icon={<ComponentClusterIcon className="w-6 h-6 text-[var(--text-disabled)]" size={24} />}
          message="No components yet"
        />
      ) : (
        <div className="px-2 pb-2">
          {/* Drop-target "Project" header — the shared component tags
              itself with the kind-specific `component-root` sentinel
              (translated back to `null` in `useComponentDrag.onUp`) so
              the user can drag a component OUT of a user folder and
              back to the top level. Vector drags write `'vector-root'`
              so they never light this up. */}
          {(componentFiles.length > 0 || codeComponentFiles.length > 0 || userFolders.length > 0) && (
            <LibraryProjectHeader
              dropAttr="data-component-folder-drop"
              rootId="component-root"
              expanded={projectFolderOpen}
              onToggle={() => setProjectFolderOpen(o => !o)}
            />
          )}
          <ProjectChildren
            componentFiles={componentFiles}
            codeComponentFiles={codeComponentFiles}
            userFolders={userFolders}
            projectFolderOpen={projectFolderOpen}
            renamingPath={renamingPath}
            renamingFolderId={renamingFolderId}
            pendingNewFolderId={pendingNewFolderId}
            selectedComponentFiles={selectedComponentFiles}
            activeFile={activeFile}
            editorFile={editorFile}
            onSwitchToComponent={onSwitchToComponent}
            onSwitchToCodeComponent={onSwitchToCodeComponent}
            onDeleteComponent={onDeleteComponent}
            setRenamingPath={setRenamingPath}
            setRenamingFolderId={setRenamingFolderId}
            handleRenameCommit={handleRenameCommit}
            handleFolderRenameCommit={handleFolderRenameCommit}
            handleFolderDelete={handleFolderDelete}
            multiSelect={multiSelect}
          />

          {/* Linked Components — CDN-imported components grouped by
              creator. Rendered INSIDE the same px-2 pb-2 container as
              local rows so there's no inter-section gap; the user wants
              consistent vertical rhythm across all rows. */}
          <LinkedComponentsList />
        </div>
      )}

      {/* Name Component / Folder Modal — uses the purple
          `--accent-secondary` to match the component-system accent
          (every other Library section uses default `--accent` blue).
          See NameInputModal `accentColor` prop. */}
      <NameInputModal
        isOpen={nameModal !== null}
        onClose={() => setNameModal(null)}
        onSubmit={(name) => {
          if (nameModal === 'design') onCreateDesignComponent(name);
          else if (nameModal === 'code') onCreateCodeComponent(name);
          setNameModal(null);
        }}
        title={nameModal === 'code' ? 'Name Code Component' : 'Name Component'}
        placeholder="e.g. Hero, Navbar, Card..."
        submitLabel="Create Component"
        defaultValue=""
        accent="secondary"
      />

      {/* Shared bulk-delete confirm — driven by `multiSelect`. The hook
          owns the modal copy, button styling, and the per-path delete
          loop so every Library section reads identically. */}
      {multiSelect.bulkDeleteModal}
    </>
  );
}
