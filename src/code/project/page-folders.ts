// page-folders.ts — FOLDERS in the Pages panel, in `_meta/page-folders.json`.
//
// A page folder is a route segment that groups pages without being a page
// itself: `/fonctionnalites` holding `/fonctionnalites/capture`, the way
// Framer's "New folder" works. Nothing on disk represents it — the folder
// IS the shared directory of its children — so the Pages tree derives
// folder rows from the page paths (see `nestPagesByPath`).
//
// Derivation alone can't represent an EMPTY folder, though: make one, and
// it would vanish on the next render because no page lives under it. So
// the names of folders the user created are kept here, and the tree merges
// them in. Once a folder has pages the entry is redundant but harmless —
// the tree would derive the same row either way.
//
// `_meta/` is editor metadata: it rides the normal project save and is
// excluded from export / publish, which is right — a folder is a way of
// looking at routes, not a route.

import { projectFS } from './project-fs';

/** Path of the page-folders JSON inside ProjectFS. Single global file. */
export const PAGE_FOLDERS_FILE_PATH = '_meta/page-folders.json';

/** Directory paths, `app`-relative and complete (`app/fonctionnalites`). */
export function listPageFolders(): string[] {
  const json = projectFS.readFile(PAGE_FOLDERS_FILE_PATH);
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((d): d is string => typeof d === 'string' && d.startsWith('app/'));
  } catch {
    // A hand-edited or half-written file must not take the Pages panel
    // down with it — an unreadable list just means no empty folders.
    return [];
  }
}

function save(dirs: string[]): void {
  projectFS.writeFile(PAGE_FOLDERS_FILE_PATH, `${JSON.stringify([...new Set(dirs)].sort(), null, 2)}\n`);
}

/** A directory moved (a template rename moves its whole route group) — move
 *  every declared folder at or under `oldDir` with it. Without this an EMPTY
 *  folder inside the group vanished on rename: nothing derives it any more. */
export function retargetPageFolders(oldDir: string, newDir: string): void {
  const dirs = listPageFolders();
  const next = dirs.map((d) => (d === oldDir || d.startsWith(`${oldDir}/`) ? newDir + d.slice(oldDir.length) : d));
  if (next.every((d, i) => d === dirs[i])) return;
  save(next);
}

/** Slug a folder name the same way a page route is slugged. */
function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'folder';
}

/**
 * Create a folder under `parentDir` (default `app`), returning its path.
 *
 * The name is made unique against BOTH declared folders and real page
 * directories, so a new folder can never shadow an existing route.
 */
export function createPageFolder(name = 'Folder', parentDir = 'app'): string {
  const taken = new Set(listPageFolders());
  for (const f of projectFS.listFiles('app/')) {
    if (f.endsWith('/page.client.tsx')) taken.add(f.replace(/\/page\.client\.tsx$/, ''));
  }
  const base = slugify(name);
  let slug = base;
  for (let i = 2; taken.has(`${parentDir}/${slug}`); i++) slug = `${base}-${i}`;

  const dir = `${parentDir}/${slug}`;
  save([...listPageFolders(), dir]);
  return dir;
}

/** True when any page lives inside this folder (directly or deeper). */
export function pageFolderHasPages(dir: string): boolean {
  return projectFS.listFiles('app/').some((f) => f.startsWith(`${dir}/`) && f.endsWith('page.client.tsx'));
}

/**
 * Forget a folder. Refuses while it still holds pages — deleting the row
 * would otherwise orphan real routes behind a name nobody can see.
 */
export function deletePageFolder(dir: string): boolean {
  if (pageFolderHasPages(dir)) return false;
  save(listPageFolders().filter((d) => d !== dir && !d.startsWith(`${dir}/`)));
  return true;
}

/** Rename an EMPTY folder. Holding pages means real files would have to
 *  move, which is a page operation, not a metadata one. */
export function renamePageFolder(dir: string, name: string): string | null {
  if (pageFolderHasPages(dir)) return null;
  const parent = dir.substring(0, dir.lastIndexOf('/'));
  const rest = listPageFolders().filter((d) => d !== dir);
  save(rest);
  return createPageFolder(name, parent);
}
