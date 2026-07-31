// section-utils — shared non-visual helpers for the Library panel
// sections (Components / Templates / Vectors): the "Move to folder"
// context-menu submenu, the bulk-delete menu collapse, the FolderTree
// effective-root-order derivation, and the selected-instance →
// master-row highlight set. Each used to be duplicated per section;
// per-section differences (ops functions, nouns) flow in as
// parameters.

import { type CSSProperties } from 'react';
import { useAtomValue } from 'jotai';
import { type DropdownMenuEntry } from '@/design-system/DropdownMenu';
import { selectedIdsAtom } from '@/code/stores/store';
import { useNodesComputed } from '@/code/stores/node-family';
import type { LibraryMultiSelect } from './useLibraryMultiSelect';

// Dropdown menu entries for "Move to → <folder>". Adds a `Remove from
// folder` entry when the file is currently in some folder. Returns []
// when the section has no folders yet (no submenu to show).
// `moveToFolder(filePath, folderId | null)` is the section's move op
// (null = move back to root) — Templates / Vectors wrap theirs with a
// `projectVersionAtom` bump, Components' `moveFileToFolder` handles
// that internally.
export function buildMoveToFolderMenuItems(
  filePath: string,
  folders: { id: string; name: string; children: string[] }[],
  moveToFolder: (filePath: string, folderId: string | null) => void,
): DropdownMenuEntry[] {
  if (folders.length === 0) return [];
  const currentFolder = folders.find(f => f.children.includes(filePath));
  return [
    {
      id: 'move-to-folder',
      label: 'Move to folder',
      submenuItems: [
        ...folders.map<DropdownMenuEntry>(folder => ({
          id: `move-to-${folder.id}`,
          label: folder.name,
          onClick: () => moveToFolder(filePath, folder.id),
        })),
        ...(currentFolder ? [
          { type: 'separator' as const },
          {
            id: 'move-to-root',
            label: 'Remove from folder',
            onClick: () => moveToFolder(filePath, null),
          },
        ] : []),
      ],
      onClick: () => { /* parent — submenu opens on hover */ },
    },
  ];
}

// Accent outline applied to a row that is part of a shift-click multi-
// select. One shared constant so every Library row kind (components,
// icon sets, presets, …) reads as one continuous selection style —
// mirrors the FileExplorer Pages-panel outline colour. (Was duplicated
// in ComponentRow + IconSetRow before the presets multi-select landed.)
export const MULTI_SELECT_OUTLINE: CSSProperties = {
  outline: '1.5px solid var(--accent, #4c8df6)',
  outlineOffset: -1,
  borderRadius: 6,
};

// When multi-select is active, every per-row ⋯ menu collapses to a
// single "Delete N <noun>s" entry — the same UX the Pages panel uses.
// Per-row actions (Edit, Rename, Copy URL / Import, Move to…) are all
// per-file and would be ambiguous with N selected; the unambiguous one
// is bulk delete, so that's all we surface. `noun` is the singular
// item label ('component' / 'template' / 'vector').
export function bulkDeleteMenuEntry(
  multiSelect: LibraryMultiSelect,
  noun: string,
): DropdownMenuEntry[] {
  return [
    { id: 'delete', label: `Delete ${multiSelect.size} ${noun}${multiSelect.size === 1 ? '' : 's'}`, onClick: () => multiSelect.requestBulkDelete() },
  ];
}

// Compute the effective FolderTree root — persisted rootOrder entries
// that still exist, plus drift fallbacks: any file / root-level folder
// not referenced anywhere gets appended at the root tail so deletes /
// renames don't leave items hidden. Stable ordering so DnD reorders
// are persistent across reloads. `fileLists` preserves the section's
// fallback ordering (e.g. design components before code components);
// `allFiles` is the section's precomputed union Set (also used by its
// renderItem guard). Used by Components + Vectors — Templates keeps
// its own divergent copy (its `referenced` set intentionally includes
// the FULL persisted order so search-filtered templates don't
// re-append at the tail).
export function buildEffectiveRootOrder(
  persistedRootOrder: string[],
  folderById: Map<string, unknown>,
  userFolders: { id: string; parentId: string | null; children: string[] }[],
  fileLists: string[][],
  allFiles: Set<string>,
): string[] {
  const out = persistedRootOrder.filter(id => folderById.has(id) || allFiles.has(id));
  const referenced = new Set<string>([...out]);
  for (const f of userFolders) for (const c of f.children) referenced.add(c);
  for (const list of fileLists) {
    for (const f of list) if (!referenced.has(f)) out.push(f);
  }
  for (const folder of userFolders) {
    if (!referenced.has(folder.id) && folder.parentId === null) out.push(folder.id);
  }
  return out;
}

// Highlight the master row of any component instance currently
// selected on the canvas. Collects every selected node's
// `componentFile` (set by the parser when an instance tag resolves to
// a registry entry) into a Set; each row checks membership for its own
// `filePath` to decide active styling. Both local components
// (filePath = `components/X.tsx`) and CDN-linked components (filePath
// = the `https://…` URL) flow through the same Set. Updates reactively
// as the user changes selection.
export function useSelectedComponentFiles(): Set<string> {
  const selectedIds = useAtomValue(selectedIdsAtom);
  return useNodesComputed((allNodes) => {
    const set = new Set<string>();
    for (const id of selectedIds) {
      const node = allNodes.get(id);
      if (node?.componentFile) set.add(node.componentFile);
    }
    return set;
  }, [selectedIds]);
}
