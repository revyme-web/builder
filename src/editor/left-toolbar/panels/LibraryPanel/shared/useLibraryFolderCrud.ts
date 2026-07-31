// useLibraryFolderCrud — shared folder create / rename / delete state
// machine for the Library panel sections (Components / Templates /
// Vectors). Each section persists its folders through its own ops
// module (component-folder-ops / template-folder-ops /
// vector-folder-ops); the UX on top is identical:
//   • "New Folder" creates the folder immediately (no modal) and puts
//     the row into inline-rename mode. The row's input renders with an
//     EMPTY `initialValue` (no pre-fill) so an empty commit (Enter /
//     blur / Escape with nothing typed) is unambiguously "user typed
//     nothing → cancel", which deletes the just-created folder. Same
//     semantics as Finder / VS Code.
//   • Rename commits trim whitespace; an unchanged or empty name on an
//     EXISTING folder is a no-op.
//   • Every write bumps `projectVersionAtom` so the section (and every
//     other consumer of the atom) re-derives its folder list.

import { useCallback, useState } from 'react';
import { useSetAtom } from 'jotai';
import { projectVersionAtom } from '@/code/project/project-fs';
import { trace } from '@/shared/debug-trace';

export function useLibraryFolderCrud({
  userFolders, createFolder, renameFolder, deleteFolder, tracePrefix,
}: {
  /** The section's current folder list (re-derived on version bumps). */
  userFolders: { id: string; name: string }[];
  /** Ops-module folder create — returns the new folder's id. */
  createFolder: (name: string, parentId: string | null) => string;
  renameFolder: (id: string, newName: string) => void;
  deleteFolder: (id: string) => void;
  /** When set, folder creation / cancellation emit the section's
   *  pre-existing debug traces `<prefix>:new-folder-started` /
   *  `<prefix>:new-folder-cancelled` (Components → 'library',
   *  Templates → 'templates'; Vectors had none, so it omits this). */
  tracePrefix?: string;
}) {
  const bumpVersion = useSetAtom(projectVersionAtom);
  // Inline rename target — which folder row currently shows the input.
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  // Tracks a freshly-created folder that's waiting for its first name
  // commit, so commit can distinguish "user typed nothing → cancel =
  // delete the folder" from "user is renaming an existing folder and
  // Escaped → no-op". Cleared after the first commit either way.
  const [pendingNewFolderId, setPendingNewFolderId] = useState<string | null>(null);

  const handleStartNewFolder = useCallback(() => {
    const id = createFolder('', null);
    setRenamingFolderId(id);
    setPendingNewFolderId(id);
    bumpVersion(v => v + 1);
    if (tracePrefix) trace.action(`${tracePrefix}:new-folder-started`, { id });
  }, [createFolder, bumpVersion, tracePrefix]);

  const handleFolderRenameCommit = useCallback((id: string, newName: string) => {
    setRenamingFolderId(null);
    const wasPendingCreation = pendingNewFolderId === id;
    if (wasPendingCreation) setPendingNewFolderId(null);
    const trimmed = newName.trim();
    // Empty commit on a brand-new folder = cancel the creation. For an
    // existing folder an empty commit is just a no-op (the data
    // layer's own fallback would preserve the current name anyway).
    if (wasPendingCreation && trimmed === '') {
      deleteFolder(id);
      bumpVersion(v => v + 1);
      if (tracePrefix) trace.action(`${tracePrefix}:new-folder-cancelled`, { id });
      return;
    }
    const folder = userFolders.find(f => f.id === id);
    if (!folder || trimmed === folder.name || trimmed === '') return;
    renameFolder(id, trimmed);
    bumpVersion(v => v + 1);
  }, [pendingNewFolderId, userFolders, renameFolder, deleteFolder, bumpVersion, tracePrefix]);

  const handleFolderDelete = useCallback((id: string) => {
    deleteFolder(id);
    bumpVersion(v => v + 1);
  }, [deleteFolder, bumpVersion]);

  return {
    renamingFolderId,
    setRenamingFolderId,
    pendingNewFolderId,
    handleStartNewFolder,
    handleFolderRenameCommit,
    handleFolderDelete,
  };
}
