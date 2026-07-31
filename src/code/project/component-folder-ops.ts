// component-folder-ops.ts — Library panel "Components" section
// folder layer. Thin wrapper around the shared `createFolderOps`
// factory. Storage: `_meta/component-folders.json`. Folder ids
// prefixed `fld-` (legacy compatibility — older projects already
// have this prefix in their JSON, and `migrateLegacyFiles: true`
// converts pre-rootOrder shapes on read).
//
// All folder logic lives in `folder-ops.ts`. This file just exports
// kind-specific names so existing call sites (LibraryPanel etc.) stay
// unchanged.

import { createFolderOps, type Folder } from './folder-ops';

const ops = createFolderOps({
  storagePath: '_meta/component-folders.json',
  idPrefix: 'fld-',
  traceNamespace: 'component-folder',
  // Older projects stored `folders[].files: string[]`. The shared
  // factory migrates that to `children` on read so the UI sees one
  // shape regardless of file age.
  migrateLegacyFiles: true,
});

export type ComponentFolder = Folder;

export const listComponentFolders = ops.listFolders;
export const getComponentRootOrder = ops.getRootOrder;
export const getFolderForFile = ops.getFolderForItem;
export const isComponentFolderId = ops.isFolderId;
export const createComponentFolder = ops.createFolder;
export const renameComponentFolder = ops.renameFolder;
export const deleteComponentFolder = ops.deleteFolder;
export const moveFileToFolder = ops.moveItemToFolder;
export const moveComponentItem = ops.moveItem;
