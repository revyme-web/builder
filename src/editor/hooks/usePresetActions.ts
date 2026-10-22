// usePresetActions — the preset Delete / Rename / Duplicate actions, shared by
// the Library's Presets panel and every inline picker (typography preset list,
// colour picker preset list, image / video preset lists) so a right-click there
// does exactly what the panel's menu does (Discord report 2026-10-21: no way to
// delete or rename a preset from the picker popups; 2026-10-22: no Duplicate).

import { useCallback } from 'react';
import { getDefaultStore, useSetAtom } from 'jotai';
import { toast } from 'sonner';
import { projectVersionAtom } from '@/code/project/project-fs';
import { activeFilePathAtom } from '@/code/project/active-file-store';
import { queueMutation, flushNow } from '@/code/mutation/mutation-queue';
import { sealPendingHistory, pushHistoryFileOp } from '@/code/mutation/history';
import {
  renamePresetToken, presetRenameTarget, renamePresetGroup as renameGroup, presetGroupRenameTarget,
  presetGroupTokenNames, type PresetGroupKind, type PresetRenameResult,
} from '@/code/project/preset-rename';
import { duplicatePresetToken, duplicatePresetGroup as duplicateGroup } from '@/code/project/preset-duplicate';
import { refreshCanvasTokens } from '@/canvas/node-ops';
import { trace } from '@/shared/debug-trace';

export function usePresetActions() {
  const bumpVersion = useSetAtom(projectVersionAtom);

  /** Land the queued token writes and re-derive every preset consumer. FLUSH
   *  FIRST — bumping before the queue lands re-reads the OLD globals.css (the
   *  panel ran one action behind, 2026-07-23). */
  const refresh = useCallback(() => {
    flushNow();
    bumpVersion((v) => v + 1);
    refreshCanvasTokens();
  }, [bumpVersion]);

  /** Delete presets by full token name (a typography preset is a group of
   *  tokens — pass them all). Same mutation as the panel, so undo works. */
  const deletePresets = useCallback((names: string[]) => {
    if (names.length === 0) return;
    trace.action('preset-actions:delete', { names });
    for (const name of names) queueMutation({ type: 'removePresetToken', name });
    refresh();
  }, [refresh]);

  /** Delete a compound preset (typography / border GROUP name) — every token
   *  of the group. */
  const deletePresetGroup = useCallback((kind: PresetGroupKind, group: string) => {
    deletePresets(presetGroupTokenNames(kind, group));
  }, [deletePresets]);

  /** A direct file op (globals.css + the folder tree) as ONE undo step. */
  const runFileOp = useCallback(<T,>(run: () => T): T => {
    sealPendingHistory();
    const out = run();
    if (out !== null) {
      pushHistoryFileOp(getDefaultStore().get(activeFilePathAtom));
      refresh();
    }
    return out;
  }, [refresh]);

  /** Duplicate preset `name` (full token name): `color-brand` → `color-brand-copy`
   *  ("Brand Copy"), listed right below the original. Returns the copy's name. */
  const duplicatePreset = useCallback((name: string): string | null => {
    const to = runFileOp(() => duplicatePresetToken(name));
    trace.action('preset-actions:duplicate', { name, to });
    return to;
  }, [runFileOp]);

  /** Duplicate a compound preset (typography / border GROUP name) — every
   *  token of the group. Returns the new group name. */
  const duplicatePresetGroup = useCallback((kind: PresetGroupKind, group: string): string | null => {
    const to = runFileOp(() => duplicateGroup(kind, group));
    trace.action('preset-actions:duplicate-group', { kind, group, to });
    return to;
  }, [runFileOp]);

  /** Seal → run → one undo step → refresh; a clash is toasted. 'missing' /
   *  'unchanged' are silent: an inline rename input also submits on blur, and
   *  a late blur re-submitting a finished rename finds the old name gone. */
  const runRename = useCallback((input: string, run: () => PresetRenameResult): string | null => {
    sealPendingHistory();
    const result = run();
    if (!result.ok) {
      if (result.reason === 'exists') toast.error(`A preset named "${input.trim()}" already exists`);
      else if (result.reason === 'invalid') toast.error(`"${input.trim()}" isn't a valid preset name`);
      return null;
    }
    pushHistoryFileOp(getDefaultStore().get(activeFilePathAtom));
    refresh();
    return result.to;
  }, [refresh]);

  /** Rename `from` (full token name) to what the user typed. Every element
   *  using the preset follows it (see renamePresetToken); the category prefix
   *  is kept. ONE undo step. Returns the new token name, or null when nothing
   *  changed (empty / same name, or a clash — the clash is toasted). */
  const renamePreset = useCallback((from: string, input: string): string | null => {
    const to = presetRenameTarget(from, input);
    if (!to || to === from) return null;
    const out = runRename(input, () => renamePresetToken(from, to));
    trace.action('preset-actions:rename', { from, to, ok: out !== null });
    return out;
  }, [runRename]);

  /** Rename a compound preset (typography / border GROUP name, e.g. `body`)
   *  to what the user typed — every token of the group moves together. */
  const renamePresetGroup = useCallback((kind: PresetGroupKind, fromGroup: string, input: string): string | null => {
    const to = presetGroupRenameTarget(kind, fromGroup, input);
    if (!to || to === fromGroup) return null;
    const out = runRename(input, () => renameGroup(kind, fromGroup, to));
    trace.action('preset-actions:rename-group', { kind, fromGroup, to, ok: out !== null });
    return out;
  }, [runRename]);

  return { deletePresets, deletePresetGroup, renamePreset, renamePresetGroup, duplicatePreset, duplicatePresetGroup, refresh };
}
