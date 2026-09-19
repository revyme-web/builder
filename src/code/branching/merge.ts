// branching/merge.ts — P8 (iv): per-file 3-way merge + conflict matrix.
//
// Merges a branch into main file-by-file (base = branch.baseSnapshot).
// Text merges via diff3 (formatting preserved — never an AST reprint); every
// overlapping hunk becomes an explicit conflict (kind per the §10 matrix),
// never a silent pick and never conflict markers on disk ("conflits jamais
// clean", I6'). Specialized mergers per kind: imports (union), JSON (per
// key), CSS (per rule block), JSX (diff3 + node classification). Merged
// output is parse-validated; an unparseable merge degrades to conflict.
//
// Resolution replays the same deterministic path with per-conflict choices
// (UI: keep ours / keep theirs per hunk, in order) and re-validates the
// result. Data-id collisions on theirs-wins are regenerated explicitly via
// regenerateIds (caller step) with DUP_DATA_ID as filet.
//
// Pure + tested per matrix cell. checkFile/guarantees/syncImports run at
// APPLY time (apply.ts) through the normal gate path.

import { diff3Merge, type Diff3Conflict } from './diff3';
import { parseJSXToNodes } from '@/code/parsing/parser';
import { trace } from '@/shared/debug-trace';

export type ConflictKind =
  | 'same-node'
  | 'same-property'
  | 'delete-vs-edit'
  | 'create-vs-create'
  | 'move'
  | 'imports'
  | 'json-key'
  | 'css-rule'
  | 'file'
  | 'other';

export interface FileConflict {
  path: string;
  /** 0-based order among this file's conflicts (resolution key). */
  index: number;
  kind: ConflictKind;
  /** Human-readable what + machine ids involved. */
  details: string;
  dataIds: string[];
  baseHunk: string[];
  oursHunk: string[];
  theirsHunk: string[];
}

export type MergeFileResult =
  | { status: 'clean'; merged: string | null }
  | { status: 'conflict'; conflicts: FileConflict[] };

export type ConflictChoice = 'ours' | 'theirs';

const DATA_ID_RE = /data-id="([^"]+)"/g;

function idsIn(lines: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    DATA_ID_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = DATA_ID_RE.exec(line)) !== null) {
      if (!seen.has(m[1])) {
        seen.add(m[1]);
        out.push(m[1]);
      }
    }
  }
  return out;
}

function sameMultiset(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const count = new Map<string, number>();
  for (const l of a) count.set(l, (count.get(l) ?? 0) + 1);
  for (const l of b) {
    const n = (count.get(l) ?? 0) - 1;
    if (n < 0) return false;
    count.set(l, n);
  }
  return true;
}

/** Split a style-object body into top-level `key -> value source` (string-aware). */
function splitStyleEntries(body: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let depth = 0;
  let str = '';
  let segStart = 0;
  const segs: string[] = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (str) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === str) str = '';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      str = ch;
      continue;
    }
    if (ch === '{' || ch === '(' || ch === '[') depth++;
    else if (ch === '}' || ch === ')' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      segs.push(body.slice(segStart, i));
      segStart = i + 1;
    }
  }
  segs.push(body.slice(segStart));
  for (const seg of segs) {
    const m = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*:(.*)$/s.exec(seg);
    if (m) out.push([m[1], m[2].trim()]);
  }
  return out;
}

interface ParsedLine {
  tag: string;
  id: string;
  opening: string;
  styleBody: string | null;
  inner: string;
  closing: string;
}

/** Parse a single-line element `<tag data-id="x" ...>inner</tag>` (or self-closing). */
function parseSingleLineElement(line: string): ParsedLine | null {
  const m = /^\s*<([A-Za-z][A-Za-z0-9.]*)((?:[^>"']|"[^"]*"|'[^']*')*)>(.*)$/.exec(line);
  if (!m) return null;
  const [, tag, attrs, rest] = m;
  const idm = /data-id="([^"]+)"/.exec(attrs);
  if (!idm) return null;
  if (rest.endsWith('/>')) {
    return { tag, id: idm[1], opening: `<${tag}${attrs}>`, styleBody: null, inner: '', closing: '' };
  }
  const closeIdx = rest.lastIndexOf(`</${tag}>`);
  if (closeIdx === -1) return null;
  const inner = rest.slice(0, closeIdx);
  const closing = rest.slice(closeIdx);
  if (/<[A-Za-z]/.test(inner)) return null; // nested elements: out of scope
  let styleBody: string | null = null;
  const si = attrs.indexOf('style={{');
  if (si !== -1) {
    let depth = 0;
    let str = '';
    let j = si + 'style={{'.length;
    for (; j < attrs.length; j++) {
      const ch = attrs[j];
      if (str) {
        if (ch === '\\') {
          j++;
          continue;
        }
        if (ch === str) str = '';
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        str = ch;
        continue;
      }
      if (ch === '{') depth++;
      else if (ch === '}') {
        if (depth === 0) break;
        depth--;
      }
    }
    if (j >= attrs.length) return null;
    styleBody = attrs.slice(si + 'style={{'.length, j);
  }
  return { tag, id: idm[1], opening: `<${tag}${attrs}>`, styleBody, inner, closing };
}

type IntraResult = { clean: string[] } | { sameKeys: string[] } | null;

/**
 * Intra-line style merge: single-line elements with the same tag + data-id
 * on all three sides merge per style key (and inner text) 3-way. This is the
 * real generator-output shape (styles inline on one line) — without it every
 * two-sided style touch conflicts. Returns clean lines, a same-property
 * marker (same keys changed differently, everything else equal), or null.
 */
function tryIntraLineStyleMerge(
  baseHunk: string[],
  oursHunk: string[],
  theirsHunk: string[],
): IntraResult {
  if (baseHunk.length !== 1 || oursHunk.length !== 1 || theirsHunk.length !== 1) return null;
  const b = parseSingleLineElement(baseHunk[0]);
  const o = parseSingleLineElement(oursHunk[0]);
  const t = parseSingleLineElement(theirsHunk[0]);
  if (!b || !o || !t) return null;
  if (b.tag !== o.tag || b.tag !== t.tag || b.id !== o.id || b.id !== t.id) return null;
  const blankStyle = (p: ParsedLine): string =>
    p.styleBody === null ? p.opening : p.opening.replace(/style=\{\{.*?\}\}/s, 'style={{}}');
  if (blankStyle(b) !== blankStyle(o) || blankStyle(b) !== blankStyle(t)) return null;
  if (b.closing !== o.closing || b.closing !== t.closing) return null;
  // Inner text 3-way; a text difference alongside clean style merge is still
  // a same-node situation only if text itself conflicts — handle text as one
  // more key below (shared text differing on both sides with clean styles →
  // sameKeys ['text']).
  const textConflict = o.inner !== t.inner && o.inner !== b.inner && t.inner !== b.inner;
  let inner = o.inner;
  if (o.inner === t.inner) inner = o.inner;
  else if (o.inner === b.inner) inner = t.inner;
  else if (t.inner === b.inner) inner = o.inner;
  else inner = o.inner; // placeholder, flagged via textConflict below
  const bm = new Map(splitStyleEntries(b.styleBody ?? ''));
  const om = new Map(splitStyleEntries(o.styleBody ?? ''));
  const tm = new Map(splitStyleEntries(t.styleBody ?? ''));
  const mergedEntries: Array<[string, string]> = [];
  const sameKeys: string[] = [];
  const order: string[] = [];
  for (const k of [...bm.keys(), ...om.keys(), ...tm.keys()]) {
    if (!order.includes(k)) order.push(k);
  }
  for (const k of order) {
    const hasB = bm.has(k);
    const hasO = om.has(k);
    const hasT = tm.has(k);
    const vb = hasB ? bm.get(k) : undefined;
    const vo = hasO ? om.get(k) : undefined;
    const vt = hasT ? tm.get(k) : undefined;
    if (vo === vt) {
      if (hasO) mergedEntries.push([k, vo as string]);
      continue;
    }
    if (vo === vb) {
      if (hasT) mergedEntries.push([k, vt as string]);
      continue;
    }
    if (vt === vb) {
      if (hasO) mergedEntries.push([k, vo as string]);
      continue;
    }
    sameKeys.push(k);
  }
  if (textConflict) sameKeys.push('text');
  if (sameKeys.length > 0) {
    // Same keys changed differently — but only a same-property verdict when
    // NOTHING else is at stake (single shared key, text agreed).
    if (sameKeys.length === 1 && !textConflict) return { sameKeys };
    return null;
  }
  const styleSrc = mergedEntries.map(([k, v]) => `${k}: ${v}`).join(', ');
  const opener =
    b.styleBody === null && mergedEntries.length === 0
      ? o.opening
      : o.opening.replace(/style=\{\{.*?\}\}/s, `style={{ ${styleSrc} }}`);
  if (b.closing === '' && o.closing === '' && t.closing === '') {
    return { clean: [opener.replace(/>$/, ' />').replace(/ \/>$/, '/>')] };
  }
  return { clean: [`${opener}${inner}${o.closing}`] };
}

/** Changed style/text key of a single-line hunk side (for same-property). */
function lineKey(line: string): string | null {
  const m = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*:/.exec(line);
  return m ? m[1] : null;
}

// ─── data-id regeneration (create-vs-create resolution) ────────────────────

/**
 * Rename data-id attributes in `code` that collide with `used`
 * (`id` → `id-m2`, `id-m3`, …). The DUP_DATA_ID oracle rule is the filet for
 * anything reference-shaped this cannot see. Pure.
 */
export function regenerateIds(code: string, used: Set<string>): string {
  const taken = new Set(used);
  return code.replace(/data-id="([^"]+)"/g, (full, id: string) => {
    if (!taken.has(id)) {
      taken.add(id);
      return full;
    }
    let n = 2;
    while (taken.has(`${id}-m${n}`)) n++;
    const fresh = `${id}-m${n}`;
    taken.add(fresh);
    return `data-id="${fresh}"`;
  });
}

// ─── internal conflict body (path/index added by wrappers) ─────────────────

interface ConflictBody {
  kind: ConflictKind;
  details: string;
  dataIds: string[];
  baseHunk: string[];
  oursHunk: string[];
  theirsHunk: string[];
}

type Decide = (body: ConflictBody, index: number) => ConflictChoice | null;

interface InnerResult {
  status: 'clean' | 'conflict';
  merged: string | null;
  conflicts: ConflictBody[];
}

// ─── generic line merge with classification ────────────────────────────────

/** Classify one diff3 conflict hunk (JSX space). `move` auto-resolves. */
function classifyJsxHunk(
  base: string[],
  ours: string[],
  theirs: string[],
  hunk: Diff3Conflict,
  details: string,
): { clean: string[] | null; conflict: ConflictBody | null } {
  const baseHunk = base.slice(hunk.baseStart, hunk.baseEnd);
  const oursHunk = ours.slice(hunk.oursStart, hunk.oursEnd);
  const theirsHunk = theirs.slice(hunk.theirsStart, hunk.theirsEnd);
  // Pure reorder (same multiset, order only): branch wins, documented.
  if (sameMultiset(oursHunk, theirsHunk) && oursHunk.length > 0) {
    return { clean: theirsHunk, conflict: null };
  }
  const baseIds = new Set(idsIn(baseHunk));
  const oursIds = idsIn(oursHunk);
  const theirsIds = idsIn(theirsHunk);
  // Create-vs-create: same new id, different content (absent from base).
  const createdBoth = oursIds.filter((id) => !baseIds.has(id) && theirsIds.includes(id));
  if (createdBoth.length > 0) {
    return {
      clean: null,
      conflict: {
        kind: 'create-vs-create',
        details: `${details}: both sides created data-id "${createdBoth.join(', ')}" with different content — keep one side (theirs-wins regenerates the colliding chain).`,
        dataIds: createdBoth,
        baseHunk,
        oursHunk,
        theirsHunk,
      },
    };
  }
  // Delete-vs-edit: one side empties what the other rewrites.
  if (oursHunk.length === 0 || theirsHunk.length === 0) {
    const ids = [...new Set([...oursIds, ...theirsIds, ...baseIds])];
    return {
      clean: null,
      conflict: {
        kind: 'delete-vs-edit',
        details: `${details}: one side deleted what the other edited — keep the deletion or the edit explicitly.`,
        dataIds: ids,
        baseHunk,
        oursHunk,
        theirsHunk,
      },
    };
  }
  const shared = [...new Set(oursIds.filter((id) => theirsIds.includes(id)))];
  if (shared.length > 0) {
    const intra = tryIntraLineStyleMerge(baseHunk, oursHunk, theirsHunk);
    if (intra && 'clean' in intra) return { clean: intra.clean, conflict: null };
    if (intra && 'sameKeys' in intra) {
      return {
        clean: null,
        conflict: {
          kind: 'same-property',
          details: `${details}: both sides set "${intra.sameKeys.join(', ')}" on ${shared.join(', ')} differently — pick one value.`,
          dataIds: shared,
          baseHunk,
          oursHunk,
          theirsHunk,
        },
      };
    }
    // Same node both sides: same single property → same-property, else same-node.
    if (oursHunk.length === 1 && theirsHunk.length === 1) {
      const ko = lineKey(oursHunk[0]);
      const kt = lineKey(theirsHunk[0]);
      if (ko !== null && ko === kt) {
        return {
          clean: null,
          conflict: {
            kind: 'same-property',
            details: `${details}: both sides set "${ko}" on ${shared.join(', ')} differently — pick one value.`,
            dataIds: shared,
            baseHunk,
            oursHunk,
            theirsHunk,
          },
        };
      }
    }
    return {
      clean: null,
      conflict: {
        kind: 'same-node',
        details: `${details}: both sides edited ${shared.join(', ')} differently — reconcile explicitly.`,
        dataIds: shared,
        baseHunk,
        oursHunk,
        theirsHunk,
      },
    };
  }
  // No shared data-id: structural/logic overlap outside node identity.
  return {
    clean: null,
    conflict: {
      kind: 'other',
      details: `${details}: overlapping edits with no shared data-id (logic, hooks, order) — reconcile explicitly.`,
      dataIds: [],
      baseHunk,
      oursHunk,
      theirsHunk,
    },
  };
}

/** Merge line arrays: clean lines out, or ordered conflict bodies. */
function mergeLineArrays(
  details: string,
  base: string[],
  ours: string[],
  theirs: string[],
  decide: Decide,
  indexBase = 0,
): { clean: string[] | null; conflicts: ConflictBody[]; overflow: string[] } {
  const chunks = diff3Merge(base, ours, theirs);
  const clean: string[] = [];
  const conflicts: ConflictBody[] = [];
  const overflow: string[] = [];
  let index = indexBase;
  for (const c of chunks) {
    if (c.kind === 'clean') {
      clean.push(...c.lines);
      continue;
    }
    const classified = classifyJsxHunk(base, ours, theirs, c, details);
    if (classified.clean) {
      clean.push(...classified.clean);
      continue;
    }
    const choice = decide(classified.conflict!, index);
    if (choice === null) {
      conflicts.push(classified.conflict!);
      index++;
      continue;
    }
    // Resolved now: splice the chosen side into the clean stream. Later
    // conflicts in the same file keep their (base/ours/theirs) hunks — the
    // replay is single-pass, so resolution order equals hunk order.
    const picked = choice === 'ours' ? classified.conflict!.oursHunk : classified.conflict!.theirsHunk;
    clean.push(...picked);
    overflow.push(...picked);
    index++;
  }
  return { clean: conflicts.length > 0 ? null : clean, conflicts, overflow };
}

// ─── import union (JSX pre-pass) ───────────────────────────────────────────

/** File head: directives ('use client'), comments and blanks before the imports. */
function splitHead(lines: string[]): { head: string[]; tail: string[] } {
  const head: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line) || /^\s*\/\//.test(line) || /^\s*\/\*/.test(line) || /^\s*['"]use client['"]/.test(line)) {
      head.push(line);
      i++;
      continue;
    }
    break;
  }
  return { head, tail: lines.slice(i) };
}

/** Split leading import lines from the rest (head already removed). */
function splitImports(lines: string[]): { imports: string[]; rest: string[] } {
  const imports: string[] = [];
  const rest: string[] = [];
  let inBlock = true;
  for (const line of lines) {
    if (inBlock && (/^\s*$/.test(line) || /^\s*import[\s{]/.test(line))) {
      if (!/^\s*$/.test(line)) imports.push(line.trim());
      continue;
    }
    inBlock = false;
    rest.push(line);
  }
  return { imports, rest };
}

/** 3-way pick for the file head (directives/comments): one-sided wins, else conflict body. */
function pickHead(
  details: string,
  base: string[],
  ours: string[],
  theirs: string[],
): { head: string[] | null; conflict: ConflictBody | null } {
  const sb = base.join('\n');
  const so = ours.join('\n');
  const st = theirs.join('\n');
  if (so === st) return { head: ours, conflict: null };
  if (so === sb) return { head: theirs, conflict: null };
  if (st === sb) return { head: ours, conflict: null };
  return {
    head: null,
    conflict: {
      kind: 'other',
      details: `${details}: file head (directives/comments) changed on both sides differently — reconcile explicitly.`,
      dataIds: [],
      baseHunk: base,
      oursHunk: ours,
      theirsHunk: theirs,
    },
  };
}

/** Union import lines (exact-line dedup, ours order then theirs-new). */
function unionImports(a: string[], b: string[]): string[] {
  const seen = new Set(a);
  const out = [...a];
  for (const line of b) {
    if (!seen.has(line)) {
      seen.add(line);
      out.push(line);
    }
  }
  return out;
}

// ─── JSON per-key merge ────────────────────────────────────────────────────

function tryParseJson(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    return null;
  } catch {
    return null;
  }
}

function mergeJsonInner(
  details: string,
  base: string,
  ours: string,
  theirs: string,
  decide: Decide,
): { status: 'clean' | 'conflict'; merged: string | null; conflicts: ConflictBody[] } {
  const b = tryParseJson(base);
  const o = tryParseJson(ours);
  const t = tryParseJson(theirs);
  if (!b || !o || !t) {
    // Unparseable side: fall back to line merge (honest conflicts).
    return mergeTextInner(details, base, ours, theirs, decide, 'other');
  }
  const merged: Record<string, unknown> = {};
  const conflicts: ConflictBody[] = [];
  let index = 0;
  const keys = [...new Set([...Object.keys(b), ...Object.keys(o), ...Object.keys(t)])].sort();
  for (const key of keys) {
    const hasB = key in b;
    const hasO = key in o;
    const hasT = key in t;
    const sb = JSON.stringify(hasB ? b[key] : undefined);
    const so = JSON.stringify(hasO ? o[key] : undefined);
    const st = JSON.stringify(hasT ? t[key] : undefined);
    const pick = (which: 'ours' | 'theirs'): void => {
      if (which === 'ours') {
        if (hasO) merged[key] = o[key];
      } else if (hasT) {
        merged[key] = t[key];
      }
    };
    if (so === st) {
      if (hasO) merged[key] = o[key];
      continue;
    }
    if (so === sb) {
      if (hasT) merged[key] = t[key];
      continue;
    }
    if (st === sb) {
      if (hasO) merged[key] = o[key];
      continue;
    }
    const body: ConflictBody = {
      kind: 'json-key',
      details: `${details}: key "${key}" changed on both sides differently — pick one value.`,
      dataIds: [],
      baseHunk: [JSON.stringify(b[key], null, 2) ?? ''],
      oursHunk: [JSON.stringify(o[key], null, 2) ?? ''],
      theirsHunk: [JSON.stringify(t[key], null, 2) ?? ''],
    };
    const choice = decide(body, index);
    index++;
    if (choice === null) {
      conflicts.push(body);
      continue;
    }
    pick(choice);
  }
  if (conflicts.length > 0) return { status: 'conflict', merged: null, conflicts };
  return { status: 'clean', merged: `${JSON.stringify(merged, null, 2)}\n`, conflicts: [] };
}

// ─── CSS per-rule merge ────────────────────────────────────────────────────

interface CssBlock {
  selector: string;
  lines: string[];
}

/** Split CSS into top-level rule blocks (selector + balanced body). */
function splitCssBlocks(lines: string[]): { prologue: string[]; blocks: CssBlock[] } {
  const prologue: string[] = [];
  const blocks: CssBlock[] = [];
  let i = 0;
  const n = lines.length;
  const isPrologue = (l: string): boolean =>
    /^\s*$/.test(l) || /^\s*\/\//.test(l) || /^\s*\/\*/.test(l) || /^\s*@import/.test(l);
  while (i < n && isPrologue(lines[i])) {
    prologue.push(lines[i]);
    i++;
  }
  while (i < n) {
    const start = i;
    let depth = 0;
    let opened = false;
    for (; i < n; i++) {
      for (const ch of lines[i]) {
        if (ch === '{') {
          depth++;
          opened = true;
        } else if (ch === '}') {
          depth--;
        }
      }
      if (opened && depth === 0) {
        i++;
        break;
      }
    }
    if (!opened) {
      prologue.push(...lines.slice(start));
      break;
    }
    blocks.push({ selector: lines[start].trim(), lines: lines.slice(start, i) });
  }
  return { prologue, blocks };
}

function mergeCssInner(
  details: string,
  base: string,
  ours: string,
  theirs: string,
  decide: Decide,
): { status: 'clean' | 'conflict'; merged: string | null; conflicts: ConflictBody[] } {
  const pb = splitCssBlocks(base.split('\n'));
  const po = splitCssBlocks(ours.split('\n'));
  const pt = splitCssBlocks(theirs.split('\n'));
  const conflicts: ConflictBody[] = [];
  let index = 0;
  const prologueClean =
    pb.prologue.join('\n') === po.prologue.join('\n')
      ? pt.prologue
      : pb.prologue.join('\n') === pt.prologue.join('\n')
        ? po.prologue
        : null;
  if (prologueClean === null) {
    const body: ConflictBody = {
      kind: 'css-rule',
      details: `${details}: file head (imports/comments) changed on both sides differently — reconcile explicitly.`,
      dataIds: [],
      baseHunk: pb.prologue,
      oursHunk: po.prologue,
      theirsHunk: pt.prologue,
    };
    const choice = decide(body, index);
    index++;
    if (choice === null) {
      conflicts.push(body);
    }
  }
  const prologue = prologueClean ?? [];
  const keyOf = (blocks: CssBlock[]): Map<string, string> => {
    const m = new Map<string, string>();
    for (const b of blocks) {
      const body = b.lines.join('\n');
      m.set(b.selector, m.has(b.selector) ? `${m.get(b.selector)}\n${body}` : body);
    }
    return m;
  };
  const mb = keyOf(pb.blocks);
  const mo = keyOf(po.blocks);
  const mt = keyOf(pt.blocks);
  const mergedBlocks: string[] = [];
  const selectors = [...new Set([...mb.keys(), ...mo.keys(), ...mt.keys()])];
  for (const sel of selectors) {
    const hasB = mb.has(sel);
    const hasO = mo.has(sel);
    const hasT = mt.has(sel);
    if (!hasB) {
      // Rule created on one side only (or both identically — caught below).
      if (hasO && hasT && mo.get(sel) === mt.get(sel)) {
        mergedBlocks.push(mo.get(sel)!);
        continue;
      }
      if (hasO && !hasT) {
        mergedBlocks.push(mo.get(sel)!);
        continue;
      }
      if (hasT && !hasO) {
        mergedBlocks.push(mt.get(sel)!);
        continue;
      }
    }
    if (hasO && hasT && mo.get(sel) === mt.get(sel)) {
      mergedBlocks.push(mo.get(sel)!);
      continue;
    }
    if (hasB && mo.get(sel) === mb.get(sel)) {
      if (hasT) mergedBlocks.push(mt.get(sel)!);
      continue;
    }
    if (hasB && mt.get(sel) === mb.get(sel)) {
      if (hasO) mergedBlocks.push(mo.get(sel)!);
      continue;
    }
    const body: ConflictBody = {
      kind: 'css-rule',
      details: `${details}: rule "${sel}" changed on both sides differently — pick one block.`,
      dataIds: [],
      baseHunk: hasB ? mb.get(sel)!.split('\n') : [],
      oursHunk: hasO ? mo.get(sel)!.split('\n') : [],
      theirsHunk: hasT ? mt.get(sel)!.split('\n') : [],
    };
    const choice = decide(body, index);
    index++;
    if (choice === null) {
      conflicts.push(body);
      continue;
    }
    const picked = choice === 'ours' ? mo.get(sel) : mt.get(sel);
    if (picked !== undefined) mergedBlocks.push(picked);
  }
  if (conflicts.length > 0) return { status: 'conflict', merged: null, conflicts };
  return { status: 'clean', merged: [...prologue, ...mergedBlocks].join('\n'), conflicts: [] };
}

// ─── text merge entry (JSX/unknown) ────────────────────────────────────────

function mergeTextInner(
  details: string,
  base: string,
  ours: string,
  theirs: string,
  decide: Decide,
  otherKind: ConflictKind,
): { status: 'clean' | 'conflict'; merged: string | null; conflicts: ConflictBody[] } {
  const { clean, conflicts } = mergeLineArrays(details, base.split('\n'), ours.split('\n'), theirs.split('\n'), decide);
  if (conflicts.length > 0) {
    return {
      status: 'conflict',
      merged: null,
      conflicts: conflicts.map((c) => (c.kind === 'other' && otherKind !== 'other' ? { ...c, kind: otherKind } : c)),
    };
  }
  const merged = clean!.join('\n');
  // Parse-validate JSX-ish sources: an unparseable merge degrades to an
  // honest conflict instead of shipping broken code.
  if (/\.(tsx|ts|jsx|js)$/.test(details) || /return\s*\(/.test(merged)) {
    try {
      parseJSXToNodes(merged);
    } catch (err) {
      return {
        status: 'conflict',
        merged: null,
        conflicts: [
          {
            kind: 'other',
            details: `${details}: merged output does not parse (${(err as Error).message}) — reconcile explicitly.`,
            dataIds: [],
            baseHunk: base.split('\n'),
            oursHunk: ours.split('\n'),
            theirsHunk: theirs.split('\n'),
          },
        ],
      };
    }
  }
  return { status: 'clean', merged, conflicts: [] };
}

// ─── file entry ────────────────────────────────────────────────────────────

function mergeFileInner(
  path: string,
  base: string | null,
  ours: string | null,
  theirs: string | null,
  decide: Decide,
): InnerResult {
  if (ours === theirs) return { status: 'clean', merged: ours, conflicts: [] };
  if (base === null) {
    // Created on one or both sides.
    if (ours === null) return { status: 'clean', merged: theirs, conflicts: [] };
    if (theirs === null) return { status: 'clean', merged: ours, conflicts: [] };
    const body: ConflictBody = {
      kind: 'file',
      details: `${path}: created on both sides with different content — keep one file.`,
      dataIds: [],
      baseHunk: [],
      oursHunk: ours.split('\n'),
      theirsHunk: theirs.split('\n'),
    };
    const choice = decide(body, 0);
    if (choice === null) return { status: 'conflict', merged: null, conflicts: [body] };
    return { status: 'clean', merged: choice === 'ours' ? ours : theirs, conflicts: [] };
  }
  if (ours === null && theirs === null) return { status: 'clean', merged: null, conflicts: [] };
  if (ours === null) {
    // Deleted on main: clean iff branch untouched, else delete-vs-edit.
    if (theirs === base) return { status: 'clean', merged: null, conflicts: [] };
    const body: ConflictBody = {
      kind: 'delete-vs-edit',
      details: `${path}: deleted on main but edited on the branch — keep the deletion or the edit explicitly.`,
      dataIds: idsIn((theirs as string).split('\n')),
      baseHunk: (base as string).split('\n'),
      oursHunk: [],
      theirsHunk: (theirs as string).split('\n'),
    };
    const choice = decide(body, 0);
    if (choice === null) return { status: 'conflict', merged: null, conflicts: [body] };
    return { status: 'clean', merged: choice === 'ours' ? null : theirs, conflicts: [] };
  }
  if (theirs === null) {
    if (ours === base) return { status: 'clean', merged: null, conflicts: [] };
    const body: ConflictBody = {
      kind: 'delete-vs-edit',
      details: `${path}: deleted on the branch but edited on main — keep the deletion or the edit explicitly.`,
      dataIds: idsIn((ours as string).split('\n')),
      baseHunk: (base as string).split('\n'),
      oursHunk: (ours as string).split('\n'),
      theirsHunk: [],
    };
    const choice = decide(body, 0);
    if (choice === null) return { status: 'conflict', merged: null, conflicts: [body] };
    return { status: 'clean', merged: choice === 'ours' ? ours : null, conflicts: [] };
  }
  if (ours === base) return { status: 'clean', merged: theirs, conflicts: [] };
  if (theirs === base) return { status: 'clean', merged: ours, conflicts: [] };

  // Both changed: kind-specific mergers.
  if (path.endsWith('.json')) return mergeJsonInner(path, base, ours, theirs, decide);
  if (path.endsWith('.css')) return mergeCssInner(path, base, ours, theirs, decide);
  if (/\.tsx?$/.test(path) || /return\s*\(/.test(base)) {
    // JSX/TSX: head pick (directives stay first — USE_CLIENT_REQUIRED),
    // import union, then diff3 the body.
    const hb = splitHead(base.split('\n'));
    const ho = splitHead(ours.split('\n'));
    const ht = splitHead(theirs.split('\n'));
    const headPick = pickHead(path, hb.head, ho.head, ht.head);
    const ib = splitImports(hb.tail);
    const io = splitImports(ho.tail);
    const it = splitImports(ht.tail);
    const imports = unionImports(unionImports(ib.imports, io.imports), it.imports);
    const bySource = new Map<string, Set<string>>();
    for (const line of imports) {
      const m = /from\s+['"]([^'"]+)['"]/.exec(line);
      const nm = /import\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(line);
      if (m && nm) {
        if (!bySource.has(m[1])) bySource.set(m[1], new Set());
        bySource.get(m[1])!.add(nm[1]);
      }
    }
    // Import-name collisions resolve first (indices 0..k-1); body hunks
    // continue the same index sequence so detect + replay agree. A resolved
    // import collision needs no splice (the union already carries both lines;
    // syncImports normalizes at commit).
    // Head resolves first (index 0 when conflicted); imports continue the
    // sequence, body hunks after — detect + replay always agree.
    let index = 0;
    const pending: ConflictBody[] = [];
    let head: string[] | null = headPick.head;
    if (!head && headPick.conflict) {
      const choice = decide(headPick.conflict, index);
      index++;
      if (choice === null) {
        pending.push(headPick.conflict);
      } else {
        head = choice === 'ours' ? ho.head : ht.head;
      }
    } else if (!head) {
      head = [];
    }
    for (const [src, names] of bySource) {
      if (names.size > 1) {
        const body: ConflictBody = {
          kind: 'imports',
          details: `${path}: module "${src}" imported under different local names (${[...names].join(', ')}) — pick one.`,
          dataIds: [],
          baseHunk: ib.imports,
          oursHunk: io.imports,
          theirsHunk: it.imports,
        };
        const choice = decide(body, index);
        index++;
        if (choice === null) pending.push(body);
      }
    }
    const bodyMerge = mergeLineArrays(path, ib.rest, io.rest, it.rest, (b, i) => decide(b, index + i));
    const conflicts = [...pending, ...bodyMerge.conflicts];
    if (conflicts.length > 0 || !head) return { status: 'conflict', merged: null, conflicts };
    const clean = bodyMerge.clean;
    const merged = [...head!, ...imports, ...clean!].join('\n');
    try {
      parseJSXToNodes(merged);
    } catch (err) {
      return {
        status: 'conflict',
        merged: null,
        conflicts: [
          {
            kind: 'other',
            details: `${path}: merged output does not parse (${(err as Error).message}) — reconcile explicitly.`,
            dataIds: [],
            baseHunk: base.split('\n'),
            oursHunk: ours.split('\n'),
            theirsHunk: theirs.split('\n'),
          },
        ],
      };
    }
    return { status: 'clean', merged, conflicts: [] };
  }
  return mergeTextInner(path, base, ours, theirs, decide, 'other');
}

// ─── public surface ────────────────────────────────────────────────────────

function withPath(path: string, bodies: ConflictBody[], startIndex: number): FileConflict[] {
  return bodies.map((b, i) => ({ path, index: startIndex + i, ...b }));
}

/**
 * 3-way merge of one file. null = absent (deleted/never created).
 * File-level matrix first (create/delete/equal/one-sided), then content
 * mergers per kind (imports union + JSX diff3, JSON per key, CSS per rule).
 */
export function mergeFile(
  base: string | null,
  ours: string | null,
  theirs: string | null,
  opts: { path: string },
): MergeFileResult {
  const r = mergeFileInner(opts.path, base, ours, theirs, () => null);
  if (r.status === 'clean') return { status: 'clean', merged: r.merged };
  return { status: 'conflict', conflicts: withPath(opts.path, r.conflicts, 0) };
}

/**
 * Resolve a file's conflicts by replaying the same deterministic path with
 * per-conflict choices (index order). Missing choices or a still-unparseable
 * result is an explicit error (never a partial file).
 */
export function resolveFileConflicts(
  base: string | null,
  ours: string | null,
  theirs: string | null,
  opts: { path: string; choices: ConflictChoice[] },
): { merged: string | null } | { error: string } {
  // Count first (same path, detect-only) so a short choices array fails
  // before any substitution — never a half-resolved file.
  const detected = mergeFileInner(opts.path, base, ours, theirs, () => null);
  if (detected.status === 'clean') return { merged: detected.merged };
  if (opts.choices.length < detected.conflicts.length) {
    return { error: `Missing choices: ${detected.conflicts.length} conflicts, ${opts.choices.length} choices.` };
  }
  let used = 0;
  const r = mergeFileInner(opts.path, base, ours, theirs, () => opts.choices[used++] ?? null);
  if (r.status === 'conflict') return { error: 'Unresolved conflicts remain after applying all choices.' };
  return { merged: r.merged };
}

/**
 * 3-way merge of whole file maps (base = branch.baseSnapshot, ours = main,
 * theirs = branch). Returns the merged map (conflicted files OMITTED — never
 * half-merged bytes) + all conflicts.
 */
export function mergeMaps(
  base: Map<string, string>,
  ours: Map<string, string>,
  theirs: Map<string, string>,
): { merged: Map<string, string>; conflicts: FileConflict[] } {
  const merged = new Map<string, string>();
  const conflicts: FileConflict[] = [];
  const paths = [...new Set([...base.keys(), ...ours.keys(), ...theirs.keys()])].sort();
  for (const path of paths) {
    const r = mergeFile(
      base.has(path) ? (base.get(path) as string) : null,
      ours.has(path) ? (ours.get(path) as string) : null,
      theirs.has(path) ? (theirs.get(path) as string) : null,
      { path },
    );
    if (r.status === 'clean') {
      if (r.merged !== null) merged.set(path, r.merged);
    } else {
      conflicts.push(...r.conflicts);
      trace.action('branching-merge:file-conflict', { path, kinds: r.conflicts.map((c) => c.kind) });
    }
  }
  trace.action('branching-merge:maps', { files: paths.length, conflicts: conflicts.length });
  return { merged, conflicts };
}
