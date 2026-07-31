// vector-folder-ops.ts — Library panel "Vectors" section folder
// layer. Thin wrapper around the shared `createFolderOps` factory.
// Storage: `_meta/vector-folders.json`. Folder ids prefixed `vfld-`.
// All logic lives in `folder-ops.ts`.

import { createFolderOps, type Folder } from './folder-ops';

const ops = createFolderOps({
  storagePath: '_meta/vector-folders.json',
  idPrefix: 'vfld-',
  traceNamespace: 'vector-folder',
});

export type VectorFolder = Folder;

export const listVectorFolders = ops.listFolders;
export const getVectorRootOrder = ops.getRootOrder;
export const getFolderForVector = ops.getFolderForItem;
export const isVectorFolderId = ops.isFolderId;
export const createVectorFolder = ops.createFolder;
export const renameVectorFolder = ops.renameFolder;
export const deleteVectorFolder = ops.deleteFolder;
export const moveVectorToFolder = ops.moveItemToFolder;
export const moveVectorItem = ops.moveItem;
