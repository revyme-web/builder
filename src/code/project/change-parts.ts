// change-parts.ts — what changed INSIDE a file that is not made of layers.
//
// A turn's diff was per-file id sets: which `data-id`s were added, removed or
// rewritten. That is the right unit for a page or a component and says nothing
// at all about the rest of a project — the design tokens in `app/globals.css`,
// a collection's items and fields, the translated strings. Those files showed
// up in the Changes card as a bare path with no count, or (the CMS) not as
// themselves at all, so "the agent restyled your links and added 8 posts" read
// as "globals.css, blog.json".
//
// A PART is one countable kind of change inside one file, in the unit the user
// thinks in: styles, items, fields, strings. Pure: text in, parts out.

import { parsePresetTokens } from '@/code/generation/preset-gen';

export type ChangeUnit = 'style' | 'item' | 'field' | 'string';

export interface ChangePart {
  unit: ChangeUnit;
  /** Styles only: the token category (`color`, `typography`, …). */
  group?: string;
  /** How many of that unit were added, removed or changed. */
  count: number;
  /** A few of their names, for a row that can then say WHICH ("color-brand")
   *  instead of just how many. Capped — this rides every turn's event. */
  names: string[];
}

export const TOKENS_PATH = 'app/globals.css';
const COLLECTION_ITEMS = /^cms\/([^/]+)\.json$/;
const COLLECTION_SCHEMA = /^cms\/([^/]+)\.schema\.json$/;
const MESSAGES = /^messages\/([^/]+)\.json$/;
const NAMES_CAP = 4;

/** Keys present on one side only, or whose value differs. */
function changedKeys(before: Map<string, string>, after: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [k, v] of after) if (before.get(k) !== v) out.push(k);
  for (const k of before.keys()) if (!after.has(k)) out.push(k);
  return out;
}

function part(unit: ChangeUnit, names: string[], group?: string): ChangePart {
  return { unit, ...(group ? { group } : {}), count: names.length, names: names.slice(0, NAMES_CAP) };
}

function tokenParts(before: string | undefined, after: string | undefined): ChangePart[] {
  const index = (css: string | undefined) => {
    const values = new Map<string, string>();
    const category = new Map<string, string>();
    for (const t of css ? parsePresetTokens(css) : []) {
      values.set(t.name, t.value);
      category.set(t.name, t.category);
    }
    return { values, category };
  };
  const a = index(before);
  const b = index(after);
  const byGroup = new Map<string, string[]>();
  for (const name of changedKeys(a.values, b.values)) {
    const group = b.category.get(name) ?? a.category.get(name) ?? 'other';
    byGroup.set(group, [...(byGroup.get(group) ?? []), name]);
  }
  return [...byGroup].map(([group, names]) => part('style', names, group));
}

function parseJson(text: string | undefined): unknown {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/** A list of records → `key → stable text of the record`. */
function indexRecords(list: unknown, idKey: string, labelKey?: (r: Record<string, unknown>) => string): { byId: Map<string, string>; label: Map<string, string> } {
  const byId = new Map<string, string>();
  const label = new Map<string, string>();
  for (const r of Array.isArray(list) ? list : []) {
    if (!r || typeof r !== 'object') continue;
    const rec = r as Record<string, unknown>;
    const id = typeof rec[idKey] === 'string' ? (rec[idKey] as string) : null;
    if (!id) continue;
    byId.set(id, JSON.stringify(rec));
    label.set(id, labelKey?.(rec) || id);
  }
  return { byId, label };
}

function itemParts(before: string | undefined, after: string | undefined): ChangePart[] {
  const title = (r: Record<string, unknown>) => {
    const first = Object.entries(r).find(([k, v]) => !k.startsWith('_') && typeof v === 'string' && v.trim());
    return first ? String(first[1]).slice(0, 40) : '';
  };
  const a = indexRecords(parseJson(before), '_id', title);
  const b = indexRecords(parseJson(after), '_id', title);
  const ids = changedKeys(a.byId, b.byId);
  return ids.length ? [part('item', ids.map((id) => b.label.get(id) ?? a.label.get(id) ?? id))] : [];
}

function fieldParts(before: string | undefined, after: string | undefined): ChangePart[] {
  const fields = (text: string | undefined) => {
    const schema = parseJson(text) as { fields?: unknown } | null;
    return indexRecords(schema?.fields, 'id', (r) => (typeof r.name === 'string' ? r.name : ''));
  };
  const a = fields(before);
  const b = fields(after);
  const ids = changedKeys(a.byId, b.byId);
  return ids.length ? [part('field', ids.map((id) => b.label.get(id) ?? a.label.get(id) ?? id))] : [];
}

function flatten(value: unknown, prefix = '', out = new Map<string, string>()): Map<string, string> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else if (prefix) {
    out.set(prefix, JSON.stringify(value));
  }
  return out;
}

function stringParts(before: string | undefined, after: string | undefined): ChangePart[] {
  const keys = changedKeys(flatten(parseJson(before)), flatten(parseJson(after)));
  return keys.length ? [part('string', keys)] : [];
}

/**
 * The parts of one file's change — `undefined` for a file made of layers (a
 * page, a component) or one this does not understand. Never throws: a file
 * that cannot be parsed simply has no parts, and is still listed as changed.
 */
export function partsForFile(path: string, before: string | undefined, after: string | undefined): ChangePart[] | undefined {
  try {
    let parts: ChangePart[] | null = null;
    if (path === TOKENS_PATH) parts = tokenParts(before, after);
    else if (COLLECTION_SCHEMA.test(path)) parts = fieldParts(before, after);
    else if (COLLECTION_ITEMS.test(path)) parts = itemParts(before, after);
    else if (MESSAGES.test(path)) parts = stringParts(before, after);
    return parts && parts.length > 0 ? parts : undefined;
  } catch {
    return undefined;
  }
}
