// editor/left-toolbar/panels/plugins/index.tsx — Library "Plugins" section.
//
// Lists three distinct kinds of plugins:
//   1. Project plugins (Tier 2) — `plugins/{Name}.tsx` files authored
//      in-browser via the Monaco editor. Click → opens the editor.
//   2. Installed plugins (Tier 1) — sideloaded from a dev URL. Click
//      → opens that plugin's runtime popup.
//   3. Cloud plugins (Tier 3) — marketplace installs. Grouped under
//      per-creator folders, click → launches the iframe runtime.
//
// Layout matches Components / Vectors:
//   ┌ Project (collapsible header)
//   │  └ FolderTree (Tier 2 source files + user-defined sub-folders)
//   │  └ Tier 1 dev-URL installs (flat — not foldered)
//   └ <Creator name> (one folder per Tier 3 author)
//      └ Cloud plugin rows
//
// User folders only hold Tier 2 plugins (file paths). Tier 1 lives in
// localStorage outside projectFS, and Tier 3 self-groups by author, so
// neither participates in the project folder system.
//
// Accent-color choice: plain `var(--accent)`, same as Vectors.

import React, { useState, useCallback, useRef, useMemo } from 'react';
import { CLOUD_ENABLED } from '@/shared/cloud-flag';
import { useAtomValue, useSetAtom } from 'jotai';
import { toast } from 'sonner';
import SidebarRow from '@/design-system/SidebarRow';
import SectionLabel from '@/design-system/SectionLabel';
import AddButton from '@/design-system/AddButton';
import DropdownMenu, { type DropdownMenuEntry } from '@/design-system/DropdownMenu';
import {
  FolderTree,
  folderTreeIndicatorAtom,
  type FolderTreeFolder,
} from '@/design-system/FolderTree';
import {
  installedPluginsAtom,
  uninstallPlugin,
  installPluginFromUrl,
  getInstalledPlugin,
  openPluginIdAtom,
  launchedProjectPluginAtom,
} from '@/plugins/registry';
import {
  installedCloudPluginsAtom,
  launchedCloudPluginAtom,
  uninstallCloudPlugin,
  type InstalledCloudPlugin,
} from '@/plugins/cloud-plugins';
import {
  listPluginFiles,
  createPluginFile,
  deletePluginFile,
  renamePluginFile,
  getPluginDisplayName,
} from '@/editor/plugin-editor/plugin-files';
import { importCloudPluginLocally, downloadCloudPluginArchive } from '@/plugins/cloud-plugin-actions';
import { copyLocalPluginUrl } from '@/plugins/copy-url-action';
import { uploadInstructionsForAtom } from '@/plugins/UploadInstructionsModal';
import { pluginEditorFileAtom } from '@/editor/plugin-editor/plugin-editor-store';
import { getFileDisplayName } from '@/code/project/active-file-store';
import { projectVersionAtom } from '@/code/project/project-fs';
import {
  listPluginFolders,
  getPluginRootOrder,
  isPluginFolderId,
  createPluginFolder,
  renamePluginFolder,
  deletePluginFolder,
  movePluginToFolder,
  movePluginItem,
  type PluginFolder,
} from '@/code/project/plugin-folder-ops';
import NameInputModal from '@/editor/ui/NameInputModal';
import { trace } from '@/shared/debug-trace';
import type { InstalledPlugin } from '@/plugins/registry';

const PluginIcon = () => (
  // Generic puzzle-piece glyph — the "extension / plugin" universal
  // visual. Uses currentColor so SidebarRow.iconColor flows through.
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
    <path d="M14 4a2 2 0 1 1 4 0v3h3a2 2 0 0 1 2 2v3h-1.5a2.5 2.5 0 1 0 0 5H23v3a2 2 0 0 1-2 2h-3v-1.5a2.5 2.5 0 1 0-5 0V21H10a2 2 0 0 1-2-2v-3H6.5a2.5 2.5 0 1 1 0-5H8V8a2 2 0 0 1 2-2h3V4z" />
  </svg>
);

const FolderIcon = React.memo(function FolderIcon({ color = 'currentColor' }: { color?: string }) {
  // Same folder glyph used by every other Library section. `currentColor`
  // by default so SidebarRow's `iconColor` wrapper carries through; we
  // pass `var(--accent)` explicitly on the Project header + user-folder
  // rows to match the Vectors / Plugins blue accent.
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" style={{ color }}>
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M2.07 5.258C2 5.626 2 6.068 2 6.95V14c0 3.771 0 5.657 1.172 6.828S6.229 22 10 22h4c3.771 0 5.657 0 6.828-1.172S22 17.771 22 14v-2.202c0-2.632 0-3.949-.77-4.804a3 3 0 0 0-.224-.225C20.151 6 18.834 6 16.202 6h-.374c-1.153 0-1.73 0-2.268-.153a4 4 0 0 1-.848-.352C12.224 5.224 11.816 4.815 11 4l-.55-.55c-.274-.274-.41-.41-.554-.53a4 4 0 0 0-2.18-.903C7.53 2 7.336 2 6.95 2c-.883 0-1.324 0-1.692.07A4 4 0 0 0 2.07 5.257M12.25 10a.75.75 0 0 1 .75-.75h5a.75.75 0 0 1 0 1.5h-5a.75.75 0 0 1-.75-.75"
        clipRule="evenodd"
      />
    </svg>
  );
});

export default function PluginsSection({ searchQuery }: { searchQuery?: string } = {}) {
  const allInstalled = useAtomValue(installedPluginsAtom);
  const allCloudPlugins = useAtomValue(installedCloudPluginsAtom);
  // Top-of-panel search filter. Three populations need filtering: Tier 1
  // dev-URL `installed` (matches `manifest.name`), Tier 3 `cloudPlugins`
  // (matches `name`), and Tier 2 `projectPlugins` (file paths matched
  // via getFileDisplayName below). Empty / undefined query = no filter,
  // pristine arrays pass through.
  const q = searchQuery?.trim().toLowerCase() ?? '';
  const searchActive = q.length > 0;
  const installed = useMemo(
    () => (!searchActive ? allInstalled : allInstalled.filter(p => p.manifest.name.toLowerCase().includes(q))),
    [allInstalled, searchActive, q],
  );
  const cloudPlugins = useMemo(
    () => (!searchActive ? allCloudPlugins : allCloudPlugins.filter(p => p.name.toLowerCase().includes(q))),
    [allCloudPlugins, searchActive, q],
  );
  const setOpenPluginId = useSetAtom(openPluginIdAtom);
  const setLaunchedProject = useSetAtom(launchedProjectPluginAtom);
  const setLaunchedCloud = useSetAtom(launchedCloudPluginAtom);
  const setEditorFile = useSetAtom(pluginEditorFileAtom);
  const setUploadInstructionsFor = useSetAtom(uploadInstructionsForAtom);
  // `projectVersionAtom` bumps on every projectFS write — re-render
  // triggers a fresh `listPluginFiles()` so a "+ New plugin" creates
  // visibly populates the list.
  const version = useAtomValue(projectVersionAtom);
  const setVersion = useSetAtom(projectVersionAtom);
  const allProjectPlugins = useMemo(() => listPluginFiles(), [version]);
  const projectPlugins = useMemo(() => {
    if (!searchActive) return allProjectPlugins;
    // Display name lookup goes through the same `getFileDisplayName`
    // the rows use to label themselves, so a match on the visible label
    // (e.g. a `@name` annotation) wins even when the file basename
    // doesn't share substrings with the query.
    return allProjectPlugins.filter(
      fp => fp.toLowerCase().includes(q) || getFileDisplayName(fp).toLowerCase().includes(q),
    );
  }, [allProjectPlugins, searchActive, q]);

  // ─── Folder system (Tier 2 only) ────────────────────────────────────────
  // User-defined sub-folders inside Project. Tier 1 (dev-URL) and
  // Tier 3 (cloud) plugins don't go into these folders — Tier 1 is
  // localStorage-only and Tier 3 self-groups by author. Folder data
  // lives in `_meta/plugin-folders.json`; entries are plugin file
  // paths (`plugins/Foo.tsx`).
  const userFolders: PluginFolder[] = useMemo(() => listPluginFolders(), [version]);
  const folderById = useMemo(() => {
    const m = new Map<string, PluginFolder>();
    for (const f of userFolders) m.set(f.id, f);
    return m;
  }, [userFolders]);
  const pluginByPath = useMemo(() => new Set(projectPlugins), [projectPlugins]);
  const persistedRootOrder = useMemo(() => getPluginRootOrder(), [version]);
  const effectiveRootOrder = useMemo(() => {
    // Items referenced anywhere (root order or any folder's children)
    // are considered "placed". Anything missing falls back to the root
    // tail — same drift handling as Templates / Vectors.
    const out = persistedRootOrder.filter(id => folderById.has(id) || pluginByPath.has(id));
    const referenced = new Set<string>([...out]);
    for (const f of userFolders) for (const c of f.children) referenced.add(c);
    for (const p of projectPlugins) if (!referenced.has(p)) out.push(p);
    for (const folder of userFolders) {
      if (!referenced.has(folder.id) && folder.parentId === null) out.push(folder.id);
    }
    return out;
  }, [persistedRootOrder, folderById, userFolders, projectPlugins, pluginByPath]);

  // Project folder collapse state — purely cosmetic, the Project row
  // is not a real folder (it's a section header above the FolderTree).
  const [projectFolderOpen, setProjectFolderOpen] = useState(true);

  // Inline folder rename + pending-creation UX. Same dance as the
  // other Library sections: "+ New Folder" creates the folder
  // immediately and enters rename mode with an empty initial value —
  // an empty commit cancels (deletes) the pending folder.
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [pendingNewFolderId, setPendingNewFolderId] = useState<string | null>(null);
  // Inline rename for a Tier 2 plugin row (writes an @name annotation — the
  // file path stays put). Mirrors the folder rename dance above.
  const [renamingPluginPath, setRenamingPluginPath] = useState<string | null>(null);

  const handlePluginRenameCommit = useCallback((filePath: string, newName: string) => {
    setRenamingPluginPath(null);
    const trimmed = newName.trim();
    if (!trimmed || trimmed === getPluginDisplayName(filePath)) return;
    renamePluginFile(filePath, trimmed);
    setVersion(v => v + 1);
    trace.action('plugins:rename', { filePath, newName: trimmed });
  }, [setVersion]);

  const handleStartNewFolder = useCallback(() => {
    const id = createPluginFolder('', null);
    setRenamingFolderId(id);
    setPendingNewFolderId(id);
    setVersion(v => v + 1);
    trace.action('plugins:new-folder-started', { id });
  }, [setVersion]);

  const handleFolderRenameCommit = useCallback((id: string, newName: string) => {
    setRenamingFolderId(null);
    const wasPendingCreation = pendingNewFolderId === id;
    if (wasPendingCreation) setPendingNewFolderId(null);
    const trimmed = newName.trim();
    if (wasPendingCreation && trimmed === '') {
      deletePluginFolder(id);
      setVersion(v => v + 1);
      trace.action('plugins:new-folder-cancelled', { id });
      return;
    }
    const folder = userFolders.find(f => f.id === id);
    if (!folder || trimmed === folder.name || trimmed === '') return;
    renamePluginFolder(id, trimmed);
    setVersion(v => v + 1);
  }, [pendingNewFolderId, userFolders, setVersion]);

  const handleFolderDelete = useCallback((id: string) => {
    deletePluginFolder(id);
    setVersion(v => v + 1);
  }, [setVersion]);

  const handleMove = useCallback((itemId: string, newParentId: string | null, insertIndex: number) => {
    movePluginItem(itemId, newParentId, insertIndex, effectiveRootOrder);
    setVersion(v => v + 1);
  }, [setVersion, effectiveRootOrder]);

  // ─── Modal state ────────────────────────────────────────────────────────
  const [addUrlOpen, setAddUrlOpen] = useState(false);
  // "Edit URL" on a LOCAL (Tier-1 dev) plugin — shows + changes the dev URL it
  // points to. { id, url } of the plugin being edited, or null when closed.
  const [editUrlFor, setEditUrlFor] = useState<{ id: string; url: string } | null>(null);
  const [newNameOpen, setNewNameOpen] = useState(false);
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);
  const plusMenuAnchorRef = useRef<HTMLButtonElement>(null);

  // ─── Open / launch callbacks ────────────────────────────────────────────
  const openInstalled = useCallback((id: string) => {
    setOpenPluginId(id);
    trace.action('plugins-section:open-installed', { id });
  }, [setOpenPluginId]);

  const openProjectPlugin = useCallback((filePath: string) => {
    setEditorFile(filePath);
    trace.action('plugins-section:open-editor', { filePath });
  }, [setEditorFile]);

  // Launch a project plugin as a runtime popup over the canvas.
  // Bypasses the editor — same UX as opening a Tier 1 plugin.
  const runProjectPlugin = useCallback((filePath: string) => {
    setOpenPluginId(null);
    setLaunchedCloud(null);
    setLaunchedProject(filePath);
    trace.action('plugins-section:run-project', { filePath });
  }, [setOpenPluginId, setLaunchedProject, setLaunchedCloud]);

  const launchCloudPlugin = useCallback((id: string) => {
    setOpenPluginId(null);
    setLaunchedProject(null);
    setLaunchedCloud(id);
    trace.action('plugins-section:launch-cloud', { id });
  }, [setOpenPluginId, setLaunchedProject, setLaunchedCloud]);

  // ─── "Move to folder" submenu builder ───────────────────────────────────
  // Appears in each Tier 2 plugin's right-click menu. Hidden when
  // there are no user folders. Mirrors Templates / Vectors.
  const buildMoveToFolderMenuItems = useCallback((filePath: string): DropdownMenuEntry[] => {
    if (userFolders.length === 0) return [];
    const currentFolder = userFolders.find(f => f.children.includes(filePath));
    return [
      {
        id: 'move-to-folder',
        label: 'Move to folder',
        submenuItems: [
          ...userFolders.map<DropdownMenuEntry>(folder => ({
            id: `move-to-${folder.id}`,
            label: folder.name,
            onClick: () => { movePluginToFolder(filePath, folder.id); setVersion(v => v + 1); },
          })),
          ...(currentFolder ? [
            { type: 'separator' as const },
            {
              id: 'move-to-root',
              label: 'Remove from folder',
              onClick: () => { movePluginToFolder(filePath, null); setVersion(v => v + 1); },
            },
          ] : []),
        ],
        onClick: () => { /* parent — submenu opens on hover */ },
      },
    ];
  }, [userFolders, setVersion]);

  // ─── Per-row menu builders ──────────────────────────────────────────────
  const buildInstalledMenuItems = (id: string, name: string): DropdownMenuEntry[] => [
    { id: 'open', label: 'Open', onClick: () => openInstalled(id) },
    {
      id: 'edit-url',
      label: 'Edit URL',
      // Shows the dev URL this LOCAL plugin points at + lets the author change
      // it (moved ports, new machine, etc.). Saving re-fetches the manifest
      // from the new URL; if it resolves to a different plugin id, the old
      // entry is removed so the row doesn't duplicate.
      onClick: () => {
        const p = getInstalledPlugin(id);
        setEditUrlFor({ id, url: p?.url ?? '' });
      },
    },
    {
      id: 'upload-instructions',
      label: 'Upload instructions',
      // Tier 1 plugins can't be shared peer-to-peer (they're local dev
      // URLs) — only path to distribution is the marketplace. The
      // modal walks the user through the CLI pack + dashboard upload.
      onClick: () => setUploadInstructionsFor(name),
    },
    { type: 'separator' },
    {
      id: 'uninstall',
      label: 'Uninstall',
      onClick: () => {
        uninstallPlugin(id);
        toast.success('Plugin removed');
      },
    },
  ];

  const buildProjectMenuItems = (filePath: string): DropdownMenuEntry[] => {
    const moveItems = buildMoveToFolderMenuItems(filePath);
    return [
      // Run = launch the plugin as a runtime popup over the canvas
      // (mirrors how installed Tier 1 plugins behave when clicked).
      // Click on the row itself still opens the editor — Run is the
      // "use it" action, click is the "edit it" action.
      { id: 'run', label: 'Run', onClick: () => runProjectPlugin(filePath) },
      { id: 'edit', label: 'Edit code', onClick: () => openProjectPlugin(filePath) },
      { id: 'rename', label: 'Rename', onClick: () => setRenamingPluginPath(filePath) },
      // Cloud-only: uploads the plugin to /api/plugins/share and copies
      // the hosted URL. Hidden in standalone mode.
      ...(CLOUD_ENABLED ? [{
        id: 'copy-url',
        label: 'Copy URL',
        onClick: async () => { await copyLocalPluginUrl(filePath); },
      }] : []),
      ...(moveItems.length > 0 ? [{ type: 'separator' as const }, ...moveItems] : []),
      { type: 'separator' },
      {
        id: 'delete',
        label: 'Delete',
        onClick: () => {
          deletePluginFile(filePath);
          toast.success('Plugin deleted');
        },
      },
    ];
  };

  /**
   * Cloud plugin menu items branch by visibility + sourceKind:
   *   closed              → Launch / Remove
   *   open + single       → Launch / Import locally / Remove
   *   open + multi        → Launch / Download source / Remove
   * Single-file plugins were authored in Revyme and can be
   * auto-forked into `plugins/<Name>.tsx`. Multi-file plugins were
   * authored externally (CLI pack flow) — we just hand the user the
   * zip URL.
   */
  const buildCloudMenuItems = (plugin: InstalledCloudPlugin): DropdownMenuEntry[] => {
    const items: DropdownMenuEntry[] = [
      { id: 'launch', label: 'Launch', onClick: () => launchCloudPlugin(plugin.id) },
    ];
    if (plugin.visibility === 'open' && plugin.sourceUrl) {
      if (plugin.sourceKind === 'multi') {
        items.push({
          id: 'download-source',
          label: 'Download source',
          onClick: () => { downloadCloudPluginArchive(plugin); },
        });
      } else {
        items.push({
          id: 'import-locally',
          label: 'Import locally',
          onClick: async () => { await importCloudPluginLocally(plugin); },
        });
      }
    }
    items.push({ type: 'separator' });
    items.push({
      id: 'remove',
      label: 'Remove',
      onClick: () => {
        uninstallCloudPlugin(plugin.id);
        toast.success(`Removed ${plugin.name}`);
      },
    });
    return items;
  };

  // ─── `+` button dropdown ────────────────────────────────────────────────
  const plusMenuItems: DropdownMenuEntry[] = [
    {
      id: 'new-plugin',
      label: 'New plugin',
      icon: <PluginIcon />,
      onClick: () => { setPlusMenuOpen(false); setNewNameOpen(true); },
    },
    {
      id: 'add-dev-url',
      label: 'Add dev URL...',
      onClick: () => { setPlusMenuOpen(false); setAddUrlOpen(true); },
    },
    { type: 'separator' },
    {
      id: 'new-folder',
      label: 'New Folder',
      icon: <FolderIcon />,
      onClick: () => { setPlusMenuOpen(false); handleStartNewFolder(); },
    },
  ];

  // ─── FolderTree adapter callbacks ───────────────────────────────────────
  const renderTreeItem = useCallback(({ itemId }: { itemId: string }) => {
    if (!pluginByPath.has(itemId)) return null;
    const isRenaming = renamingPluginPath === itemId;
    return (
      <ProjectPluginRow
        filePath={itemId}
        menuItems={buildProjectMenuItems(itemId)}
        onClick={() => { if (!isRenaming) openProjectPlugin(itemId); }}
        inlineEdit={isRenaming ? {
          initialValue: getPluginDisplayName(itemId),
          onCommit: (val) => handlePluginRenameCommit(itemId, val),
        } : undefined}
      />
    );
    // buildProjectMenuItems closes over userFolders/version; including
    // buildMoveToFolderMenuItems in deps is sufficient (it's the only
    // dynamic piece of the menu).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pluginByPath, openProjectPlugin, buildMoveToFolderMenuItems, renamingPluginPath, handlePluginRenameCommit]);

  const renderTreeFolder = useCallback(({ folder, expanded, toggle }: {
    folder: FolderTreeFolder;
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
        icon={<FolderIcon />}
        label={folder.name}
        iconColor="var(--accent)"
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

  // ─── Render ─────────────────────────────────────────────────────────────
  const isEmpty =
    projectPlugins.length === 0 &&
    installed.length === 0 &&
    cloudPlugins.length === 0 &&
    userFolders.length === 0;
  const showProjectHeader =
    projectPlugins.length > 0 || installed.length > 0 || userFolders.length > 0;

  // Light up the Project header when the FolderTree drag indicator
  // points at the root-level drop zone. Same treatment as Vectors.
  const folderTreeIndicator = useAtomValue(folderTreeIndicatorAtom);
  const isProjectDropTarget = folderTreeIndicator?.rowId === 'plugin-root';

  return (
    <>
      <SectionLabel
        size="md"
        right={
          <>
            <AddButton ref={plusMenuAnchorRef} onClick={() => setPlusMenuOpen((o) => !o)} title="Create plugin" />
            <DropdownMenu
              isOpen={plusMenuOpen}
              onClose={() => setPlusMenuOpen(false)}
              items={plusMenuItems}
              anchorRef={plusMenuAnchorRef}
              position="bottom-left"
            />
          </>
        }
      >
        Plugins
      </SectionLabel>

      {isEmpty ? (
        <div className="flex flex-col items-center gap-1.5 px-4 py-4 text-center">
          <PluginIcon />
          <p className="text-[10px] text-[var(--text-disabled)] max-w-[180px] leading-relaxed">
            No plugins yet. Click + to create one or add from a dev URL.
          </p>
        </div>
      ) : (
        <div className="px-2 pb-2">
          {showProjectHeader && (
            <div
              data-plugin-folder-drop="plugin-root"
              style={{
                outline: isProjectDropTarget ? '1px solid var(--accent)' : 'none',
                outlineOffset: -1,
                borderRadius: 6,
              }}
            >
              <SidebarRow
                icon={<FolderIcon />}
                label="Project"
                iconColor="var(--accent)"
                expandable={{ expanded: projectFolderOpen }}
                onClick={() => setProjectFolderOpen(o => !o)}
              />
            </div>
          )}
          <div
            style={{ paddingLeft: 20 }}
            hidden={!projectFolderOpen}
            data-plugin-folder-drop="plugin-root"
          >
            <FolderTree
              rootOrder={effectiveRootOrder}
              folderById={folderById as Map<string, FolderTreeFolder>}
              isFolderId={isPluginFolderId}
              onMove={handleMove}
              renderItem={renderTreeItem}
              renderFolder={renderTreeFolder}
              // Override the default purple indicator → `var(--accent)`
              // blue, matching the Plugins section's folder icons (same
              // override the Presets panel uses for the same reason).
              indicatorColor="var(--accent)"
            />
            {/* Tier 1 dev-URL installs sit at the Project root, after
                the FolderTree. They don't participate in user folders
                because they live in localStorage, not projectFS. */}
            {installed.map((p) => (
              // +20 leaf chevron-column offset on top of the parent's 20px
              // folder body, so dev-URL rows align with the FolderTree's Tier-2
              // leaf rows instead of sitting a level short (same fix as cloud).
              <div key={p.manifest.id} style={{ paddingLeft: 20 }}>
                <InstalledPluginRow
                  plugin={p}
                  menuItems={buildInstalledMenuItems(p.manifest.id, p.manifest.name)}
                  onClick={() => openInstalled(p.manifest.id)}
                />
              </div>
            ))}
          </div>

          {/* Cloud plugins — grouped by their author name. Mirrors the
              Linked-Components creator-folder pattern (see LibraryPanel:
              LinkedCreatorFolder). Plugins with no author fall under
              "Anonymous". Folders sort alphabetically. */}
          <CloudPluginsByCreator
            cloudPlugins={cloudPlugins}
            buildCloudMenuItems={buildCloudMenuItems}
            launchCloudPlugin={launchCloudPlugin}
          />
        </div>
      )}

      {/* Both dialogs use the shared `NameInputModal` design (same as
          Templates / Vectors / "New Vector Set" / "New Icon
          Set"). Single-input + Cancel/Create row in a portal'd dark
          dialog with purple primary button — uniform across the
          Library panel. The dev-URL flow reuses it as a text input
          with a URL placeholder; the modal is generic enough that
          "name" is just "any string". */}
      <NameInputModal
        isOpen={newNameOpen}
        onClose={() => setNewNameOpen(false)}
        onSubmit={(name) => {
          const filePath = createPluginFile(name);
          setNewNameOpen(false);
          // Open the editor immediately so the user lands on Monaco
          // with the starter template rather than having to click again.
          openProjectPlugin(filePath);
        }}
        title="New plugin"
        placeholder="My Plugin"
        defaultValue="My Plugin"
        submitLabel="Create Plugin"
      />

      <NameInputModal
        isOpen={addUrlOpen}
        onClose={() => setAddUrlOpen(false)}
        onSubmit={async (url) => {
          try {
            const inst = await installPluginFromUrl(url);
            toast.success(`Installed ${inst.manifest.name}`);
            setAddUrlOpen(false);
          } catch (e) {
            toast.error((e as Error).message);
          }
        }}
        title="Add dev plugin"
        placeholder="http://localhost:5180"
        defaultValue="http://localhost:5180"
        submitLabel="Install"
      />

      {/* Edit a LOCAL plugin's dev URL — prefilled with the current one so the
          author can SEE which port/host the row points at. Saving re-installs
          from the new URL (fresh manifest); a changed plugin id removes the
          old registry entry so the list doesn't grow a duplicate row. */}
      <NameInputModal
        isOpen={!!editUrlFor}
        onClose={() => setEditUrlFor(null)}
        onSubmit={async (url) => {
          const prev = editUrlFor;
          try {
            const inst = await installPluginFromUrl(url);
            if (prev && inst.manifest.id !== prev.id) uninstallPlugin(prev.id);
            toast.success(`Now pointing at ${inst.url}`);
            setEditUrlFor(null);
          } catch (e) {
            toast.error((e as Error).message);
          }
        }}
        title="Plugin dev URL"
        placeholder="http://localhost:5180"
        defaultValue={editUrlFor?.url ?? ''}
        submitLabel="Save"
      />
    </>
  );
}

// ─── Per-row plugin components ──────────────────────────────────────────────
//
// Rows are pure SidebarRow trigger entries — clicking the row's
// "Run" menu item writes to `launchedProjectPluginAtom` (Tier 2) or
// `openPluginIdAtom` (Tier 1). The actual runtime window is
// `PluginRuntimeWindow`, mounted globally in App.tsx — that means
// the plugin window survives Library-panel section changes,
// row unmounts, and other tool popups opening.

interface ProjectPluginRowProps {
  filePath: string;
  menuItems: DropdownMenuEntry[];
  onClick: () => void;
  inlineEdit?: { initialValue: string; onCommit: (value: string) => void };
}

function ProjectPluginRow({ filePath, menuItems, onClick, inlineEdit }: ProjectPluginRowProps) {
  return (
    <SidebarRow
      icon={<PluginIcon />}
      label={getPluginDisplayName(filePath)}
      iconColor="var(--accent)"
      menuItems={menuItems}
      onClick={onClick}
      inlineEdit={inlineEdit}
    />
  );
}

interface InstalledPluginRowProps {
  plugin: InstalledPlugin;
  menuItems: DropdownMenuEntry[];
  onClick: () => void;
}

function InstalledPluginRow({ plugin, menuItems, onClick }: InstalledPluginRowProps) {
  return (
    <SidebarRow
      icon={<PluginIcon />}
      label={plugin.manifest.name}
      iconColor="var(--accent)"
      menuItems={menuItems}
      onClick={onClick}
      // Small chip that distinguishes dev-URL (Tier 1) plugins from
      // project-source (Tier 2) and cloud (Tier 3) installs. Helps the
      // author remember which row is pointing at a localhost dev server
      // that won't work for other people / other machines.
      right={<LocalBadge />}
    />
  );
}

function LocalBadge() {
  return (
    <span
      className="ml-1.5 px-1.5 py-0.5 text-[8.5px] font-bold tracking-[0.06em] rounded-[3px] uppercase"
      style={{
        background: 'rgba(255,255,255,0.08)',
        color: 'rgba(255,255,255,0.85)',
        border: '1px solid rgba(255,255,255,0.12)',
        lineHeight: 1,
      }}
    >
      Local
    </span>
  );
}

interface CloudPluginRowProps {
  plugin: InstalledCloudPlugin;
  menuItems: DropdownMenuEntry[];
  onClick: () => void;
}

const CloudIcon = () => (
  // A cloud glyph distinguishes Tier 3 cloud-installed plugins from
  // local (Tier 2 / Tier 1) ones at a glance in the LibraryPanel.
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
    <path d="M19.35 10.04A7.49 7.49 0 0 0 12 4C9.11 4 6.6 5.64 5.35 8.04A5.994 5.994 0 0 0 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z" />
  </svg>
);

function CloudPluginRow({ plugin, menuItems, onClick }: CloudPluginRowProps) {
  return (
    <SidebarRow
      icon={<CloudIcon />}
      label={plugin.name}
      iconColor="var(--accent)"
      menuItems={menuItems}
      onClick={onClick}
    />
  );
}

// ─── Cloud plugins — author-grouped ─────────────────────────────────────────
//
// Each unique author name gets its own collapsible folder header.
// Plugins with a null/empty author bucket under "Anonymous". Folders
// sort alphabetically with Anonymous always at the bottom (matches how
// the Linked Components section sinks unknown authors).

function CloudPluginsByCreator({
  cloudPlugins,
  buildCloudMenuItems,
  launchCloudPlugin,
}: {
  cloudPlugins: InstalledCloudPlugin[];
  buildCloudMenuItems: (plugin: InstalledCloudPlugin) => DropdownMenuEntry[];
  launchCloudPlugin: (id: string) => void;
}) {
  const groups = useMemo(() => {
    const byAuthor = new Map<string, { label: string; plugins: InstalledCloudPlugin[] }>();
    for (const p of cloudPlugins) {
      const label = (p.author ?? '').trim() || 'Anonymous';
      let group = byAuthor.get(label);
      if (!group) {
        group = { label, plugins: [] };
        byAuthor.set(label, group);
      }
      group.plugins.push(p);
    }
    return Array.from(byAuthor.values()).sort((a, b) => {
      // Always sort "Anonymous" last — known authors win.
      if (a.label === 'Anonymous' && b.label !== 'Anonymous') return 1;
      if (a.label !== 'Anonymous' && b.label === 'Anonymous') return -1;
      return a.label.localeCompare(b.label);
    });
  }, [cloudPlugins]);

  if (groups.length === 0) return null;

  return (
    <>
      {groups.map((group) => (
        <CreatorFolder
          key={group.label}
          label={group.label}
          plugins={group.plugins}
          buildCloudMenuItems={buildCloudMenuItems}
          launchCloudPlugin={launchCloudPlugin}
        />
      ))}
    </>
  );
}

function CreatorFolder({
  label,
  plugins,
  buildCloudMenuItems,
  launchCloudPlugin,
}: {
  label: string;
  plugins: InstalledCloudPlugin[];
  buildCloudMenuItems: (plugin: InstalledCloudPlugin) => DropdownMenuEntry[];
  launchCloudPlugin: (id: string) => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <SidebarRow
        icon={<FolderIcon />}
        label={label}
        iconColor="var(--accent)"
        expandable={{ expanded: open }}
        onClick={() => setOpen((o) => !o)}
      />
      {open &&
        plugins.map((plugin) => (
          // 40 = folder-body indent (20) + leaf chevron-column offset (20),
          // matching FolderTree's `depth * indentStep + 20` for a LEAF under a
          // depth-0 folder. The Project folder's Tier-2 rows land at 40 (20px
          // wrapper + FolderTree's +20 leaf offset); cloud rows had only the
          // 20px wrapper, so they sat a level short of their creator folder.
          <div key={plugin.id} style={{ paddingLeft: 40 }}>
            <CloudPluginRow
              plugin={plugin}
              menuItems={buildCloudMenuItems(plugin)}
              onClick={() => launchCloudPlugin(plugin.id)}
            />
          </div>
        ))}
    </>
  );
}
