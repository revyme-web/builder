// preset-duplicate.ts — Duplicate a design-token preset (user report
// 2026-10-22: no Duplicate in any preset menu).
//
// The copy is a NEW token with the same value(s) — `color-brand` →
// `color-brand-copy` ("Brand Copy"), then `-copy-2`, `-copy-3` … — declared
// right below the original in app/globals.css (its `:root.dark` value too)
// and filed right after it in the panel's folder tree, so it shows up next to
// the original in the panel and in every picker. Nothing in the pages changes:
// elements keep pointing at the original.
//
// A typography / border preset is a token GROUP (`typo-body-font`,
// `typo-body-size`, …); duplicating copies every token of the group under the
// new group name.

import { projectFS } from './project-fs';
import { modifyProjectFile } from './modify-file';
import { getPresetFolderOps } from './preset-folder-ops';
import { parsePresetTokens, duplicatePresetTokensInCSS } from '../generation/preset-gen';
import { groupTypoTokens } from '@/editor/tools/typography-utils';
import { groupBorderTokens } from '@/editor/ui/border-preset-utils';
import type { PresetGroupKind } from './preset-rename';
import type { PresetToken } from '@/shared/types';
import { trace } from '@/shared/debug-trace';

const TOKENS_PATH = 'app/globals.css';
const GROUP_PREFIX: Record<PresetGroupKind, string> = { typography: 'typo', border: 'border' };
const groupTokens = (kind: PresetGroupKind, tokens: PresetToken[]) =>
  kind === 'typography' ? groupTypoTokens(tokens) : groupBorderTokens(tokens);

/** `<base>-copy`, then `-copy-2`, `-copy-3` … — the first one `free` accepts.
 *  A copy of a copy numbers on from the original (`brand-copy` → `brand-copy-2`). */
export function presetCopyName(base: string, free: (candidate: string) => boolean): string | null {
  const root = base.replace(/-copy(?:-\d+)?$/, '');
  for (let n = 1; n <= 999; n++) {
    const candidate = n === 1 ? `${root}-copy` : `${root}-copy-${n}`;
    if (free(candidate)) return candidate;
  }
  return null;
}

function writeCopies(pairs: [string, string][]): void {
  modifyProjectFile(TOKENS_PATH, (css) => duplicatePresetTokensInCSS(css, pairs));
}

/** Duplicate preset `name` (full token name). Returns the copy's name, or
 *  null when there is no such token. Callers own history and the UI refresh. */
export function duplicatePresetToken(name: string): string | null {
  const tokens = parsePresetTokens(projectFS.readFile(TOKENS_PATH) ?? '');
  const token = tokens.find((t) => t.name === name);
  if (!token) return null;
  const names = new Set(tokens.map((t) => t.name));
  const to = presetCopyName(name, (c) => !names.has(c));
  if (!to) return null;
  writeCopies([[name, to]]);
  getPresetFolderOps(token.category).insertItemAfter(to, name);
  trace.action('preset-duplicate:token', { from: name, to });
  return to;
}

/** Duplicate compound preset `group` (group name, e.g. `body`): every token of
 *  the group, under one new group name. Returns the new group name, or null
 *  when there is no such group. */
export function duplicatePresetGroup(kind: PresetGroupKind, group: string): string | null {
  const prefix = GROUP_PREFIX[kind];
  const tokens = parsePresetTokens(projectFS.readFile(TOKENS_PATH) ?? '');
  const groups = groupTokens(kind, tokens);
  const source = groups.find((g) => g.name === group);
  if (!source) return null;
  const names = new Set(tokens.map((t) => t.name));
  const groupNames = new Set(groups.map((g) => g.name));
  const oldBase = `${prefix}-${group}`;
  const pairsFor = (to: string): [string, string][] => source.tokens.map((t) => [
    t.name,
    t.name === oldBase ? `${prefix}-${to}` : `${prefix}-${to}${t.name.slice(oldBase.length)}`,
  ]);
  // Free = no such group, no such token, and the copies read back as ONE group
  // named `to` (a name ending like a suffix would split the group).
  const to = presetCopyName(group, (c) => {
    if (groupNames.has(c)) return false;
    const pairs = pairsFor(c);
    if (pairs.some(([, n]) => names.has(n))) return false;
    const regrouped = groupTokens(kind, source.tokens.map((t, i) => ({ ...t, name: pairs[i][1] })));
    return regrouped.length === 1 && regrouped[0].name === c;
  });
  if (!to) return null;
  writeCopies(pairsFor(to));
  getPresetFolderOps(kind).insertItemAfter(to, group);
  trace.action('preset-duplicate:group', { kind, from: group, to, tokens: source.tokens.length });
  return to;
}
