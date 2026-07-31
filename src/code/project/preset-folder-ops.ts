// preset-folder-ops.ts — Library panel "Presets" section folder
// layer. One folder tree PER CATEGORY (Typography / Color / Image /
// Video / Radius / Padding / Margin / Border / Shadow), each backed
// by `_meta/preset-folders-<category>.json`. Same shape +
// drift-handling as the other folder layers — just a thin wrapper
// around the shared `createFolderOps` factory.
//
// Item ids stored in `rootOrder` + `folder.children` are:
//   • token name (e.g. "color-brand")          for simple categories
//   • group name (e.g. "heading")              for typography
//   • border group name (e.g. "primary")       for border
// CategorySection interprets the strings — folder ops doesn't care.
//
// `getPresetFolderOps(categoryKey)` is memoized so the same handle
// (and its cached `_idCounter`) is returned across calls. Without
// memoization each call would generate a fresh closure and folder
// IDs from concurrent callers could collide on the same millisecond.

import { createFolderOps, type FolderOps } from './folder-ops';

const cache = new Map<string, FolderOps>();

export function getPresetFolderOps(categoryKey: string): FolderOps {
  const existing = cache.get(categoryKey);
  if (existing) return existing;
  const ops = createFolderOps({
    storagePath: `_meta/preset-folders-${categoryKey}.json`,
    // `pfld-<cat>-` so traces / debug snapshots can identify which
    // category a folder belongs to at a glance, AND so cross-category
    // folder ids never collide (matters when ANY UI reads multiple
    // categories' trees in the same render).
    idPrefix: `pfld-${categoryKey}-`,
    traceNamespace: `preset-folder:${categoryKey}`,
  });
  cache.set(categoryKey, ops);
  return ops;
}

/** Convenience — predicate to check if any string is a preset folder
 *  id (across all categories). Used by CategorySection's FolderTree
 *  adapter to distinguish folder ids from item ids in mixed
 *  children arrays. The `pfld-` prefix is unique to preset folders
 *  (components use `fld-`, vectors `vfld-`, templates `tfld-`). */
export function isPresetFolderId(id: string): boolean {
  return id.startsWith('pfld-');
}
