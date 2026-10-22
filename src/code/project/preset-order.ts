// preset-order.ts — the order the Presets panel shows each category in, so
// every preset PICKER lists them the same way (user report 2026-10-22: the
// panel was reordered, the typography popup still listed globals.css order).
//
// The panel's order lives in `_meta/preset-folders-<category>.json`
// (preset-folder-ops): a root order of item ids and folders, each folder with
// its own children. Item ids are token names, or GROUP names for typography /
// border. Items the file doesn't mention yet (new presets) follow at the root
// tail in token order — the panel's drift fallback.
//
// Read-only and import-light on purpose: presetTokensAtom orders through this,
// so it must not pull in folder-ops (→ modify-file → mutation-queue).

import { projectFS } from './project-fs';
import { groupTypoTokens } from '@/editor/tools/typography-utils';
import { groupBorderTokens } from '@/editor/ui/border-preset-utils';
import type { PresetToken } from '@/shared/types';

export interface PresetOrderFolder {
  id: string;
  parentId: string | null;
  children: string[];
}

/** The panel's top-level order: the persisted root order (minus ids that no
 *  longer exist), then any item or root folder nothing references. Shared with
 *  CategorySection so the panel and the pickers can never disagree. */
export function effectivePresetRootOrder(rootOrder: string[], folders: PresetOrderFolder[], itemIds: string[]): string[] {
  const folderIds = new Set(folders.map((f) => f.id));
  const items = new Set(itemIds);
  const out = rootOrder.filter((id) => folderIds.has(id) || items.has(id));
  const referenced = new Set<string>(out);
  for (const f of folders) for (const c of f.children) referenced.add(c);
  for (const id of itemIds) if (!referenced.has(id)) out.push(id);
  for (const f of folders) if (!referenced.has(f.id) && f.parentId === null) out.push(f.id);
  return out;
}

/** Every item in panel order: root order, each folder's children in place
 *  (depth-first, whether or not the folder is expanded). An item no reachable
 *  folder holds still comes out, last, so a picker never loses one. */
export function flattenPresetOrder(rootOrder: string[], folders: PresetOrderFolder[], itemIds: string[]): string[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const items = new Set(itemIds);
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (ids: string[]) => {
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const folder = byId.get(id);
      if (folder) walk(folder.children);
      else if (items.has(id)) out.push(id);
    }
  };
  walk(effectivePresetRootOrder(rootOrder, folders, itemIds));
  for (const id of itemIds) if (!seen.has(id)) out.push(id);
  return out;
}

/** The persisted folder file of a category, or an empty one. */
export function readPresetFolderFile(category: string): { rootOrder: string[]; folders: PresetOrderFolder[] } {
  const raw = projectFS.readFile(`_meta/preset-folders-${category}.json`);
  if (!raw) return { rootOrder: [], folders: [] };
  try {
    const parsed = JSON.parse(raw) as { rootOrder?: unknown; folders?: unknown };
    const rootOrder = Array.isArray(parsed.rootOrder) ? parsed.rootOrder.filter((x): x is string => typeof x === 'string') : [];
    const folders = (Array.isArray(parsed.folders) ? parsed.folders : [])
      .filter((f): f is PresetOrderFolder => !!f && typeof (f as PresetOrderFolder).id === 'string')
      .map((f) => ({ id: f.id, parentId: f.parentId ?? null, children: Array.isArray(f.children) ? f.children : [] }));
    return { rootOrder, folders };
  } catch {
    return { rootOrder: [], folders: [] };
  }
}

/** Token → the item id the panel files it under. */
function itemIdsByToken(tokens: PresetToken[]): Map<PresetToken, string> {
  const ids = new Map<PresetToken, string>();
  for (const g of groupTypoTokens(tokens)) for (const t of g.tokens) ids.set(t, g.name);
  for (const g of groupBorderTokens(tokens)) for (const t of g.tokens) ids.set(t, g.name);
  for (const t of tokens) if (!ids.has(t)) ids.set(t, t.name);
  return ids;
}

/** `tokens` with each category in the Presets panel's order. Tokens keep the
 *  SLOTS their category had (only the order within a category changes), and
 *  a group's tokens stay in their own order. */
export function orderPresetTokens(
  tokens: PresetToken[],
  readFolders: (category: string) => { rootOrder: string[]; folders: PresetOrderFolder[] } = readPresetFolderFile,
): PresetToken[] {
  const itemOf = itemIdsByToken(tokens);
  const slots = new Map<string, number[]>();
  tokens.forEach((t, i) => {
    const list = slots.get(t.category) ?? [];
    list.push(i);
    slots.set(t.category, list);
  });
  const out = tokens.slice();
  for (const [category, indices] of slots) {
    const members = indices.map((i) => tokens[i]);
    const itemIds = [...new Set(members.map((t) => itemOf.get(t)!))];
    const { rootOrder, folders } = readFolders(category);
    if (rootOrder.length === 0 && folders.length === 0) continue;
    const rank = new Map(flattenPresetOrder(rootOrder, folders, itemIds).map((id, r) => [id, r]));
    const sorted = members
      .map((t, i) => ({ t, i, r: rank.get(itemOf.get(t)!) ?? Infinity }))
      .sort((a, b) => a.r - b.r || a.i - b.i);
    indices.forEach((slot, k) => { out[slot] = sorted[k].t; });
  }
  return out;
}
