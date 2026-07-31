// folder-ops.ts — Single source of truth for the Library panel's
// folder data layer. Wraps `_meta/<kind>-folders.json` CRUD with
// the FolderTree-compatible shape (rootOrder + mixed children) and
// returns a strongly-typed handle. Per-kind files
// (`component-folder-ops`, `vector-folder-ops`, `template-folder-ops`)
// instantiate this factory with their own storage path + id prefix +
// trace namespace and re-export the resulting handles under
// kind-specific names so existing call sites stay unchanged.
//
// Why a factory: the three folder layers used to be near-identical
// copies — same data shape, same drift handling, same cycle check.
// Centralising lets a future Presets layer (or any other "list of
// items + nestable folders" UI) plug in by passing 3-4 lines of
// config.

import { projectFS } from './project-fs';
import { modifyProjectFile } from './modify-file';
import { trace } from '@/shared/debug-trace';

export interface Folder {
  id: string;
  name: string;
  /** null = root-level. Otherwise parent folder id. */
  parentId: string | null;
  /** Mixed: child item ids + child folder ids in display order. */
  children: string[];
}

interface FoldersFile {
  version: number;
  /** Top-level display order. Mixed: item ids + folder ids. */
  rootOrder: string[];
  folders: Folder[];
}

export interface FolderOpsConfig {
  /** Where the JSON file lives in projectFS, e.g.
   *  `_meta/component-folders.json`. */
  storagePath: string;
  /** Folder id prefix, e.g. `fld-` / `vfld-` / `tfld-`. Used both
   *  to mint new ids and to distinguish folder ids from item ids in
   *  mixed `children` arrays. */
  idPrefix: string;
  /** Prefix for `trace.action` events emitted by the ops, e.g.
   *  `component-folder` → `component-folder:create`. Lets debug
   *  traces show which kind of folder is being mutated without
   *  having to inspect the storage path. */
  traceNamespace: string;
  /** Migrate legacy `folders[].files: string[]` → `children: string[]`
   *  on read. Components had this older field; vectors / templates
   *  never did. Setting `true` is harmless when the legacy field
   *  isn't present (it's a no-op). */
  migrateLegacyFiles?: boolean;
}

export interface FolderOps {
  /** Flat list of every folder in the tree. Display order comes from
   *  `getRootOrder` + each folder's `children` array, NOT this list's
   *  insertion order. */
  listFolders: () => Folder[];
  /** Top-level display order — mixed: item ids + folder ids. */
  getRootOrder: () => string[];
  /** Find a single folder by id. */
  findFolder: (id: string) => Folder | null;
  /** Look up which folder (if any) directly contains a given item id. */
  getFolderForItem: (itemId: string) => Folder | null;
  /** True iff `id` is a folder id (carries this ops handle's prefix). */
  isFolderId: (id: string) => boolean;
  /** Create a new folder. Returns the new id. Empty `name` becomes
   *  "New Folder" — same default the panel UX expects when the user
   *  hits the `+ → New Folder` action and immediately gets dropped
   *  into inline-rename mode. */
  createFolder: (name: string, parentId?: string | null) => string;
  /** Rename a folder. No-op if the id isn't found. */
  renameFolder: (id: string, name: string) => void;
  /** Delete a folder. Children fold up — nested children move into
   *  the deleted folder's slot in its parent (preserves visual order).
   *  Items inside aren't deleted; "delete this group" semantics. */
  deleteFolder: (id: string) => void;
  /** Move an item to a folder (or null = root). Appends. Used by
   *  right-click "Move to folder" menus. */
  moveItemToFolder: (itemId: string, folderId: string | null) => void;
  /** Move ANY item (item id or folder id) to a new parent at a
   *  specific index. Used by drag-and-drop with before / after /
   *  inside drop positions. Cycle-checked for folder moves.
   *
   *  `expectedRootOrder` (optional) — when the caller's display
   *  order includes DRIFT-FALLBACK items (items not yet persisted
   *  in `rootOrder`), pass the current effective display order so
   *  the move bakes that order into the JSON BEFORE the splice.
   *  Without this, `insertIndex` computed against
   *  `effectiveRootOrder` lands the item at the wrong spot in the
   *  empty/short persisted array, and on next render the drift
   *  fallback re-shuffles everything into default positions. */
  moveItem: (itemId: string, newParentId: string | null, insertIndex: number, expectedRootOrder?: string[]) => void;
}

/** Factory — instantiate a kind-specific folder ops handle. Stateless
 *  apart from its `_idCounter` closure, so two handles with different
 *  storagePaths fully isolate from each other. */
export function createFolderOps(config: FolderOpsConfig): FolderOps {
  const { storagePath, idPrefix, traceNamespace, migrateLegacyFiles = false } = config;

  const isFolderId = (id: string): boolean => id.startsWith(idPrefix);

  interface ParsedFile {
    rootOrder: string[];
    folders: Folder[];
  }
  const EMPTY_PARSED: ParsedFile = { rootOrder: [], folders: [] };

  function readParsed(): ParsedFile {
    const raw = projectFS.readFile(storagePath);
    if (!raw) return { rootOrder: [], folders: [] };
    try {
      const parsed = JSON.parse(raw) as FoldersFile;
      const folders = Array.isArray(parsed?.folders) ? parsed.folders : [];
      const rootOrder = Array.isArray(parsed?.rootOrder) ? parsed.rootOrder : [];
      for (const f of folders) {
        if (!Array.isArray(f.children)) {
          if (migrateLegacyFiles) {
            const legacyFiles = (f as unknown as { files?: string[] }).files;
            f.children = Array.isArray(legacyFiles) ? legacyFiles : [];
          } else {
            f.children = [];
          }
        }
      }
      return { rootOrder, folders };
    } catch {
      trace.error(`${traceNamespace}:parse-failed`, { path: storagePath });
      return EMPTY_PARSED;
    }
  }

  function writeParsed(next: ParsedFile): void {
    const body = JSON.stringify({
      version: 1,
      rootOrder: next.rootOrder,
      folders: next.folders,
    } as FoldersFile, null, 2) + '\n';
    if (projectFS.exists(storagePath)) {
      modifyProjectFile(storagePath, () => body);
    } else {
      // First write: file doesn't exist, modifyProjectFile would
      // fail-fast. writeFile direct, next mutation queue flush
      // picks it up.
      projectFS.writeFile(storagePath, body);
    }
  }

  let _idCounter = 0;
  function generateFolderId(): string {
    _idCounter++;
    // Append a 4-char random nonce so two ops handles minting their
    // first folder (counter=1) at the same millisecond can't collide
    // on the suffix portion. Without it, the SAME id could appear in
    // two category JSON files (e.g. Typography + Color folders
    // created back-to-back), and FolderTree's `id === indicator.rowId`
    // check would light up rows in BOTH sections when only one is
    // targeted. The prefix already differentiates kinds, but nothing
    // protected the suffix.
    const nonce = Math.random().toString(36).slice(2, 6);
    return `${idPrefix}${Date.now().toString(36)}-${_idCounter.toString(36)}-${nonce}`;
  }

  function detachItem(parsed: ParsedFile, id: string): void {
    parsed.rootOrder = parsed.rootOrder.filter(x => x !== id);
    for (const f of parsed.folders) {
      f.children = f.children.filter(x => x !== id);
    }
  }

  function attachItem(parsed: ParsedFile, id: string, parentId: string | null, insertIndex: number): void {
    if (parentId === null) {
      const idx = Math.max(0, Math.min(insertIndex, parsed.rootOrder.length));
      parsed.rootOrder.splice(idx, 0, id);
    } else {
      const folder = parsed.folders.find(f => f.id === parentId);
      if (!folder) return;
      const idx = Math.max(0, Math.min(insertIndex, folder.children.length));
      folder.children.splice(idx, 0, id);
    }
    if (isFolderId(id)) {
      const folder = parsed.folders.find(f => f.id === id);
      if (folder) folder.parentId = parentId;
    }
  }

  function wouldCreateCycle(parsed: ParsedFile, id: string, newParentId: string | null): boolean {
    let cursor: string | null = newParentId;
    while (cursor !== null) {
      if (cursor === id) return true;
      const parent = parsed.folders.find(f => f.id === cursor);
      cursor = parent ? parent.parentId : null;
    }
    return false;
  }

  return {
    listFolders: () => readParsed().folders,
    getRootOrder: () => readParsed().rootOrder,
    findFolder: (id) => readParsed().folders.find(f => f.id === id) ?? null,
    getFolderForItem: (itemId) => readParsed().folders.find(f => f.children.includes(itemId)) ?? null,
    isFolderId,

    createFolder(name, parentId = null) {
      const parsed = readParsed();
      const id = generateFolderId();
      parsed.folders.push({ id, name: name.trim() || 'New Folder', parentId, children: [] });
      attachItem(parsed, id, parentId,
        parentId === null
          ? parsed.rootOrder.length
          : (parsed.folders.find(f => f.id === parentId)?.children.length ?? 0));
      writeParsed(parsed);
      trace.action(`${traceNamespace}:create`, { id, name, parentId });
      return id;
    },

    renameFolder(id, name) {
      const parsed = readParsed();
      const folder = parsed.folders.find(f => f.id === id);
      if (!folder) return;
      folder.name = name.trim() || folder.name;
      writeParsed(parsed);
      trace.action(`${traceNamespace}:rename`, { id, name });
    },

    deleteFolder(id) {
      const parsed = readParsed();
      const target = parsed.folders.find(f => f.id === id);
      if (!target) return;
      const newParentId = target.parentId;
      let parentChildren: string[];
      let insertAt: number;
      if (newParentId === null) {
        parentChildren = parsed.rootOrder;
        insertAt = parentChildren.indexOf(id);
      } else {
        const parent = parsed.folders.find(f => f.id === newParentId);
        parentChildren = parent ? parent.children : parsed.rootOrder;
        insertAt = parentChildren.indexOf(id);
      }
      if (insertAt < 0) insertAt = parentChildren.length;
      for (const f of parsed.folders) {
        if (f.parentId === id) f.parentId = newParentId;
      }
      parentChildren.splice(insertAt, 1, ...target.children);
      parsed.folders = parsed.folders.filter(f => f.id !== id);
      writeParsed(parsed);
      trace.action(`${traceNamespace}:delete`, { id, fileCount: target.children.length });
    },

    moveItemToFolder(itemId, folderId) {
      const parsed = readParsed();
      detachItem(parsed, itemId);
      attachItem(parsed, itemId, folderId,
        folderId === null
          ? parsed.rootOrder.length
          : (parsed.folders.find(f => f.id === folderId)?.children.length ?? 0));
      writeParsed(parsed);
      trace.action(`${traceNamespace}:move-item-to-folder`, { itemId, folderId });
    },

    moveItem(itemId, newParentId, insertIndex, expectedRootOrder) {
      const parsed = readParsed();
      if (itemId === newParentId) return;
      if (isFolderId(itemId) && newParentId !== null && wouldCreateCycle(parsed, itemId, newParentId)) {
        trace.error(`${traceNamespace}:move-cycle`, { itemId, newParentId });
        return;
      }
      // Bake the caller's display order into persistedRootOrder
      // before the splice. Required when the consumer derived its
      // `insertIndex` from a drift-augmented display order (items
      // not yet referenced in the persisted JSON appear after every
      // persisted entry at render time). Without baking, the splice
      // lands at the wrong index in the SHORT persisted array, and
      // the next render's drift fallback re-shuffles the move away.
      if (expectedRootOrder) {
        parsed.rootOrder = expectedRootOrder.slice();
      }
      detachItem(parsed, itemId);
      attachItem(parsed, itemId, newParentId, insertIndex);
      writeParsed(parsed);
      trace.action(`${traceNamespace}:move-item`, { itemId, newParentId, insertIndex });
    },
  };
}
