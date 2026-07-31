// template-folder-ops.ts — Library panel "Templates" section folder
// layer. Thin wrapper around the shared `createFolderOps` factory.
// Storage: `_meta/template-folders.json`. Folder ids prefixed
// `tfld-`. All logic lives in `folder-ops.ts`.

import { createFolderOps, type Folder } from './folder-ops';

const ops = createFolderOps({
  storagePath: '_meta/template-folders.json',
  idPrefix: 'tfld-',
  traceNamespace: 'template-folder',
});

export type TemplateFolder = Folder;

export const listTemplateFolders = ops.listFolders;
export const getTemplateRootOrder = ops.getRootOrder;
export const isTemplateFolderId = ops.isFolderId;
export const createTemplateFolder = ops.createFolder;
export const renameTemplateFolder = ops.renameFolder;
export const deleteTemplateFolder = ops.deleteFolder;
export const moveTemplateToFolder = ops.moveItemToFolder;
export const moveTemplateItem = ops.moveItem;
