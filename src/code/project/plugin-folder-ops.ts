// plugin-folder-ops.ts — Library panel "Plugins" section folder layer.
// Thin wrapper around the shared `createFolderOps` factory; matches
// the template/vector folder-ops pattern one-for-one.
//
// Storage: `_meta/plugin-folders.json`. Folder ids prefixed `pfld-`.
// Folder `files` entries are plugin file paths (e.g. `plugins/Foo.tsx`)
// — Tier 2 source-file plugins are the only kind that go into Project
// folders. Tier 1 dev-URL installs live in localStorage (not the
// project FS) and Tier 3 cloud plugins group themselves by creator
// name automatically (see PluginsSection > CloudPluginsByCreator), so
// neither participates in this folder system.

import { createFolderOps, type Folder } from './folder-ops';

const ops = createFolderOps({
  storagePath: '_meta/plugin-folders.json',
  idPrefix: 'pfld-',
  traceNamespace: 'plugin-folder',
});

export type PluginFolder = Folder;

export const listPluginFolders = ops.listFolders;
export const getPluginRootOrder = ops.getRootOrder;
export const isPluginFolderId = ops.isFolderId;
export const createPluginFolder = ops.createFolder;
export const renamePluginFolder = ops.renameFolder;
export const deletePluginFolder = ops.deleteFolder;
export const movePluginToFolder = ops.moveItemToFolder;
export const movePluginItem = ops.moveItem;
