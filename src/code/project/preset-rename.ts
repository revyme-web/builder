// preset-rename.ts — rename a design-token preset EVERYWHERE it is named.
//
// A preset's only identity is its CSS custom-property name: elements apply it
// as `var(--color-brand)`, the token lives as `--color-brand: …` in
// app/globals.css (plus its `:root.dark` value). The Library panel's old
// rename removed the token and re-added it under the new name, so every
// element still pointing at `var(--color-brand)` lost its value the moment
// the rename landed ("apply it, rename it, and it breaks instantly" — Discord
// report, 2026-10-21). It also used the raw input as the new name, so typing
// "Primary" for `color-brand` produced `--primary`, which the colour field no
// longer recognises as a colour preset (it keys off `var(--color-`).
//
// This renames the declaration in place (category section, dark value and
// any token that references it all follow) and rewrites every reference in
// the project's code, keeping the category prefix.

import { projectFS } from './project-fs';
import { modifyProjectFile } from './modify-file';
import { parsePresetTokens } from '../generation/preset-gen';
import { renameCustomPropertyInText, presetRefRewriteMode } from '../generation/preset-refs-gen';
import { getPresetFolderOps } from './preset-folder-ops';
import { groupTypoTokens } from '@/editor/tools/typography-utils';
import { groupBorderTokens } from '@/editor/ui/border-preset-utils';
import type { PresetToken } from '@/shared/types';
import { trace } from '@/shared/debug-trace';

export { renameCustomPropertyInText };

const TOKENS_PATH = 'app/globals.css';

/** Name prefixes the Library gives each category (CATEGORY_CONFIGS). A rename
 *  keeps the old name's prefix so the token stays in its category for every
 *  consumer that keys off it (the colour field reads `var(--color-…)`). */
const CATEGORY_PREFIXES = ['color', 'typo', 'image', 'video', 'radius', 'space', 'margin', 'shadow', 'border'];

/** Slug a user-typed name the way the Library does (sanitizeName). */
function slug(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

/** The full token name a rename of `fromName` to the user's `input` produces:
 *  slugged, with the old category prefix kept (typing the prefix yourself is
 *  fine — it isn't doubled). Null when the input slugs to nothing. */
export function presetRenameTarget(fromName: string, input: string): string | null {
  const prefix = CATEGORY_PREFIXES.find((p) => fromName.startsWith(`${p}-`));
  let s = slug(input);
  if (prefix && (s === prefix || s.startsWith(`${prefix}-`))) s = s.slice(prefix.length + 1);
  if (!s) return null;
  return prefix ? `${prefix}-${s}` : s;
}

export type PresetRenameResult =
  | { ok: true; to: string; files: string[] }
  | { ok: false; reason: 'invalid' | 'missing' | 'exists' | 'unchanged' };

/** Rename preset `from` → `to` (both full token names, no `--`) across the
 *  whole project. Refuses an unknown source, an empty target and a target that
 *  already exists (renaming onto it would merge two presets). Every write goes
 *  through modifyProjectFile (flush, fresh read, active-file queue sync).
 *  Callers own history (seal before, push after) and the UI refresh. */
export function renamePresetToken(from: string, to: string): PresetRenameResult {
  const res = renamePresetTokens([[from, to]]);
  if (!res.ok) return res;
  // The panel's folder tree files a simple preset under its token name — the
  // renamed preset keeps its folder and position. (Typography / border trees
  // hold GROUP names; renamePresetGroup retargets those.)
  const category = parsePresetTokens(projectFS.readFile(TOKENS_PATH) ?? '').find((t) => t.name === to)?.category;
  if (category && !GROUP_CATEGORIES.has(category)) getPresetFolderOps(category).renameItem(from, to);
  return { ok: true, to, files: res.files };
}

/** Rename several tokens at once — all validated before any file is written,
 *  then each file rewritten in ONE pass. A compound preset (typography /
 *  border) is a set of tokens that must move together or not at all. */
export function renamePresetTokens(pairs: [string, string][]): PresetRenameResult {
  if (pairs.length === 0) return { ok: false, reason: 'missing' };
  if (pairs.some(([, to]) => !to || !/^[a-z0-9][a-z0-9-]*$/.test(to))) return { ok: false, reason: 'invalid' };
  if (pairs.every(([from, to]) => from === to)) return { ok: false, reason: 'unchanged' };
  const tokens = parsePresetTokens(projectFS.readFile(TOKENS_PATH) ?? '');
  const names = new Set(tokens.map((t) => t.name));
  if (pairs.some(([from]) => !names.has(from))) return { ok: false, reason: 'missing' };
  // ANY existing target — even one of the tokens being renamed — would merge
  // two presets mid-loop.
  if (pairs.some(([, to]) => names.has(to))) return { ok: false, reason: 'exists' };

  const rewrite = (text: string, varOnly: boolean) =>
    pairs.reduce((acc, [from, to]) => renameCustomPropertyInText(acc, from, to, varOnly), text);
  const files: string[] = [];
  // globals.css first: the declaration must exist under its new name before
  // any reference to it is rewritten.
  const ordered = [TOKENS_PATH, ...projectFS.listFiles().filter((p) => p !== TOKENS_PATH)];
  for (const path of ordered) {
    const mode = presetRefRewriteMode(path);
    if (!mode) continue;
    const before = projectFS.readFile(path);
    if (!before || !pairs.some(([from]) => before.includes(`--${from}`))) continue;
    if (rewrite(before, mode === 'data') === before) continue;
    modifyProjectFile(path, (code) => rewrite(code, mode === 'data'));
    files.push(path);
  }
  trace.action('preset-rename:done', { pairs, files });
  return { ok: true, to: pairs[0][1], files };
}

// ─── Compound presets ────────────────────────────────────────────────────────
// A typography or border preset is a GROUP of tokens sharing a name:
// `typo-body-font`, `typo-body-size`, `typo-body-size-md` … The panel shows
// (and files in folders) the group name `body`; renaming it renames every
// token in the group.

export type PresetGroupKind = 'typography' | 'border';

const GROUP_CATEGORIES = new Set<string>(['typography', 'border']);
const GROUP_PREFIX: Record<PresetGroupKind, string> = { typography: 'typo', border: 'border' };
const groupTokens = (kind: PresetGroupKind, tokens: PresetToken[]) =>
  kind === 'typography' ? groupTypoTokens(tokens) : groupBorderTokens(tokens);

/** Every token name of compound preset `group` (empty when there is none). */
export function presetGroupTokenNames(kind: PresetGroupKind, group: string): string[] {
  const tokens = parsePresetTokens(projectFS.readFile(TOKENS_PATH) ?? '');
  return groupTokens(kind, tokens).find((g) => g.name === group)?.tokens.map((t) => t.name) ?? [];
}

/** The group name a rename of group `fromGroup` to the user's `input`
 *  produces — slugged; typing the category prefix is fine. Null when the
 *  input slugs to nothing. */
export function presetGroupRenameTarget(kind: PresetGroupKind, fromGroup: string, input: string): string | null {
  const prefix = GROUP_PREFIX[kind];
  const full = presetRenameTarget(`${prefix}-${fromGroup}`, input);
  return full ? full.slice(prefix.length + 1) : null;
}

/** Rename compound preset `fromGroup` → `toGroup` (group names, e.g. `body`
 *  → `body-large`): every token of the group and every reference to it, plus
 *  the group's place in the panel's folder tree. Refused ('invalid') when the
 *  new name would not read back as ONE group — `x-stroke` would split
 *  its colour token `typo-x-stroke-color` off as group `x`. */
export function renamePresetGroup(kind: PresetGroupKind, fromGroup: string, toGroup: string): PresetRenameResult {
  if (fromGroup === toGroup) return { ok: false, reason: 'unchanged' };
  if (!/^[a-z0-9][a-z0-9-]*$/.test(toGroup)) return { ok: false, reason: 'invalid' };
  const prefix = GROUP_PREFIX[kind];
  const tokens = parsePresetTokens(projectFS.readFile(TOKENS_PATH) ?? '');
  const groups = groupTokens(kind, tokens);
  const group = groups.find((g) => g.name === fromGroup);
  if (!group) return { ok: false, reason: 'missing' };
  if (groups.some((g) => g.name === toGroup)) return { ok: false, reason: 'exists' };

  const oldBase = `${prefix}-${fromGroup}`;
  const newBase = `${prefix}-${toGroup}`;
  const pairs: [string, string][] = group.tokens.map((t) => [
    t.name,
    t.name === oldBase ? newBase : `${newBase}${t.name.slice(oldBase.length)}`,
  ]);
  if (group.tokens.some((t) => t.name !== oldBase && !t.name.startsWith(`${oldBase}-`))) return { ok: false, reason: 'invalid' };
  const regrouped = groupTokens(kind, group.tokens.map((t, i) => ({ ...t, name: pairs[i][1] })));
  if (regrouped.length !== 1 || regrouped[0].name !== toGroup) return { ok: false, reason: 'invalid' };

  const res = renamePresetTokens(pairs);
  if (!res.ok) return res;
  getPresetFolderOps(kind).renameItem(fromGroup, toGroup);
  trace.action('preset-rename:group', { kind, fromGroup, toGroup, tokens: pairs.length });
  return { ok: true, to: toGroup, files: res.files };
}
