// instance-auto-size.ts — "auto" on a DESIGN-COMPONENT instance = hug the master.
//
// The Size tool's auto unit on a plain element writes min-content (Fit). On a
// design-component instance that was wrong twice over: the instance's style
// spread overrides the master's baked size (min-content measures an EMPTY
// background-image root → 0), and on a non-primary variant the '' hug-master
// write got variant-scoped into `cond ? '' : …` — an empty-string OVERRIDE,
// not a removal (the Adore grid collapse, 2026-08-15). Native semantics (v4):
//
//   primary press, no other branches → remove the dim from the instance style
//       entirely. Absence is native everywhere: live, the root's own baked
//       value survives the spread; on canvas the wrapper adopts the master
//       root's resolved dim (patchElement size-sync).
//   any press that leaves OTHER variants pinned → the ordinary style ternary
//       carries an 'auto' branch: `height: variant === 'v1' ? 'auto' : '419px'`.
//       expandComponent BAKES 'auto' branches to the master root's concrete
//       value at parse time (instance hug bake, project-parser.ts), so the
//       whole canvas pipeline only ever sees definite dims that TRACK the
//       master. Live, `data-size-hug` tells @revyme/runtime's
//       withResponsiveProps to lift placement onto a wrapper so real CSS
//       `auto` wraps the root at its natural (master) size.
//
// An earlier dialect (2026-08-14/15) routed hug through a master PROP
// (`height={variant === 'v1' ? undefined : '419px'}` + a hoisted defaulted
// param + a style '100%' pin). It could not survive the live spread on
// non-animated instances. migrateInstanceDimPropToStyle converts those files
// back on first touch — every dim write path runs it before writing.

import { trace } from '@/shared/debug-trace';

const q = (v: string) => `'${v}'`;

/** Hug-the-master style value. */
export const HUG = 'auto';
/** Legacy PROP-dialect sentinel (kept for migration reads only). */
export const HUG_MASTER = 'undefined';

/** Balanced scan from `{` (or `{{`) at `open`; returns index just past the
 *  matching close. String-aware. */
function skipBraces(code: string, open: number): number {
  let depth = 0, inStr = '';
  for (let i = open; i < code.length; i++) {
    const ch = code[i];
    if (inStr) { if (ch === inStr && code[i - 1] !== '\\') inStr = ''; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { inStr = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return i + 1; }
  }
  return -1;
}

/** The opening tag carrying data-id=nodeId: [tagStart, tagEnd) (past `>`). */
function findTagByDataId(code: string, nodeId: string): { start: number; end: number } | null {
  const idIdx = code.indexOf(`data-id="${nodeId}"`);
  if (idIdx === -1) return null;
  const start = code.lastIndexOf('<', idIdx);
  if (start === -1) return null;
  let depth = 0, inStr = '';
  for (let i = start; i < code.length; i++) {
    const ch = code[i];
    if (inStr) { if (ch === inStr && code[i - 1] !== '\\') inStr = ''; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { inStr = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (ch === '>' && depth === 0) return { start, end: i + 1 };
  }
  return null;
}

/** The `style={{ … }}` object's inner span within a tag slice: [bodyStart, bodyEnd). */
function styleBodySpan(tag: string): { start: number; end: number } | null {
  const m = tag.indexOf('style={{');
  if (m === -1) return null;
  // scan starts on the INNER `{` (index m+7), so `close` is one past the inner
  // close brace — the body ends one char before it.
  const close = skipBraces(tag, m + 'style={'.length);
  if (close === -1) return null;
  return { start: m + 'style={{'.length, end: close - 1 };
}

/** One top-level entry `key: <expr>` inside a style body: its full span
 *  (including a leading comma when present, so removal leaves valid JS) and
 *  the raw expression. */
function findStyleEntry(body: string, key: string): { start: number; end: number; expr: string } | null {
  const re = new RegExp(`(^|[,{\\s])${key}\\s*:`);
  const m = re.exec(body);
  if (!m) return null;
  const keyStart = m.index + m[1].length;
  const exprStart = body.indexOf(':', keyStart) + 1;
  // expression runs to the next top-level comma or end of body
  let depth = 0, inStr = '';
  let i = exprStart;
  for (; i < body.length; i++) {
    const ch = body[i];
    if (inStr) { if (ch === inStr && body[i - 1] !== '\\') inStr = ''; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { inStr = ch; continue; }
    if (ch === '{' || ch === '(' || ch === '[') depth++;
    else if (ch === '}' || ch === ')' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) break;
  }
  const expr = body.slice(exprStart, i).trim();
  // absorb the separating comma (trailing if present, else the leading one)
  let start = keyStart, end = i;
  if (body[i] === ',') end = i + 1;
  else {
    const before = body.slice(0, keyStart);
    const lastComma = before.lastIndexOf(',');
    if (lastComma !== -1 && before.slice(lastComma + 1).trim() === '') start = lastComma;
  }
  return { start, end, expr };
}

/** Parse `'v'`, `undefined`, or an `(initialVariant|variant) === 'x' ? A : B`
 *  chain into branches (A/B are quoted values, or the legacy `undefined`
 *  sentinel which reads as HUG). Returns null for shapes we don't own
 *  (bindings, motion values, calc …). */
// Masters WITHOUT connection state write per-variant ternaries on
// `initialVariant`; masters WITH connections use the `variant` useState —
// both are dialect (VARIANT_IDENTS). Preserve whichever the file uses.
export type DimBranches = { branches: { variant: string | null; value: string }[]; ident: string };

export function parseDimBranchesFull(expr: string): DimBranches | null {
  const leaf = (s: string): string | null => {
    const m = s.match(/^'([^']*)'$/);
    if (m) return m[1];
    if (s === 'undefined') return HUG;
    return null;
  };
  const flat = leaf(expr.trim());
  if (flat !== null) return { branches: [{ variant: null, value: flat }], ident: 'initialVariant' };
  const branches: { variant: string | null; value: string }[] = [];
  let ident = 'initialVariant';
  let rest = expr.trim();
  for (let guard = 0; guard < 12; guard++) {
    const m = rest.match(/^(initialVariant|variant)\s*===\s*'([^']+)'\s*\?\s*('[^']*'|undefined)\s*:\s*([\s\S]+)$/);
    if (!m) break;
    const v = leaf(m[3]);
    if (v === null) return null;
    ident = m[1];
    branches.push({ variant: m[2], value: v });
    rest = m[4].trim();
  }
  const tail = leaf(rest);
  if (tail === null || branches.length === 0) {
    return branches.length === 0 && tail !== null ? { branches: [{ variant: null, value: tail }], ident } : null;
  }
  branches.push({ variant: null, value: tail });
  return { branches, ident };
}

export function parseDimBranches(expr: string): { variant: string | null; value: string }[] | null {
  return parseDimBranchesFull(expr)?.branches ?? null;
}

/** Serialize branches to a STYLE expression — every leaf is a quoted value
 *  ('auto' included; the style channel never carries `undefined`). Default
 *  (variant:null) becomes the trailing else. */
export function branchesToStyleExpr(branches: { variant: string | null; value: string }[], ident: string = 'initialVariant'): string {
  const def = branches.find((b) => b.variant === null);
  let expr = q(def?.value ?? HUG);
  for (const b of branches.filter((b) => b.variant !== null).reverse()) {
    expr = `${ident} === ${q(b.variant!)} ? ${q(b.value)} : ${expr}`;
  }
  return expr;
}

/** Read the instance's `<dim>={…}` attr expression, if present (legacy
 *  prop-dialect files only — nothing writes this anymore). */
export function getInstanceDimAttrExpr(code: string, nodeId: string, dim: 'width' | 'height'): string | null {
  const tagSpan = findTagByDataId(code, nodeId);
  if (!tagSpan) return null;
  const tagText = code.slice(tagSpan.start, tagSpan.end);
  const attrM = new RegExp(`\\s${dim}=\\{`).exec(tagText);
  if (!attrM) return null;
  const open = tagSpan.start + attrM.index + attrM[0].length - 1;
  const close = skipBraces(code, open);
  if (close === -1) return null;
  return code.slice(open + 1, close - 1).trim();
}

/** Current branch state of the dim on an instance: from the legacy PROP attr
 *  when present, else from the style entry. `channel` says where it lives.
 *  Legacy `undefined` branches read as HUG ('auto'). */
export function readInstanceDimBranches(code: string, nodeId: string, dim: 'width' | 'height'):
  { channel: 'prop' | 'style' | 'none'; branches: { variant: string | null; value: string }[]; ident: string } {
  const attrExpr = getInstanceDimAttrExpr(code, nodeId, dim);
  if (attrExpr !== null) {
    const full = parseDimBranchesFull(attrExpr);
    return { channel: 'prop', branches: full?.branches ?? [], ident: full?.ident ?? 'initialVariant' };
  }
  const tagSpan = findTagByDataId(code, nodeId);
  if (tagSpan) {
    const tag = code.slice(tagSpan.start, tagSpan.end);
    const span = styleBodySpan(tag);
    const entry = span ? findStyleEntry(tag.slice(span.start, span.end), dim) : null;
    if (entry) {
      const full = parseDimBranchesFull(entry.expr);
      if (full) return { channel: 'style', branches: full.branches, ident: full.ident };
    }
  }
  return { channel: 'none', branches: [], ident: 'initialVariant' };
}

/** The raw style expression for a dim on the instance tag, or null when the
 *  tag has no style entry for it. */
function styleDimEntry(code: string, nodeId: string, dim: 'width' | 'height'): { expr: string } | null {
  const tagSpan = findTagByDataId(code, nodeId);
  if (!tagSpan) return null;
  const tag = code.slice(tagSpan.start, tagSpan.end);
  const span = styleBodySpan(tag);
  const entry = span ? findStyleEntry(tag.slice(span.start, span.end), dim) : null;
  return entry ? { expr: entry.expr } : null;
}

/** Write (or replace) the instance style's `<dim>:` entry; null removes it. */
function writeInstanceStyleDim(code: string, nodeId: string, dim: 'width' | 'height', expr: string | null): string {
  const tagSpan = findTagByDataId(code, nodeId);
  if (!tagSpan) return code;
  const tag = code.slice(tagSpan.start, tagSpan.end);
  const span = styleBodySpan(tag);
  if (!span) return code;
  const entry = findStyleEntry(tag.slice(span.start, span.end), dim);
  if (entry) {
    const absStart = tagSpan.start + span.start + entry.start;
    const absEnd = tagSpan.start + span.start + entry.end;
    if (expr === null) {
      return code.slice(0, absStart) + code.slice(absEnd);
    }
    const lead = code[absStart] === ',' ? ', ' : '';
    return code.slice(0, absStart) + `${lead}${dim}: ${expr}` + code.slice(absEnd);
  }
  if (expr === null) return code;
  const insertAt = tagSpan.start + span.end;
  return code.slice(0, insertAt) + `, ${dim}: ${expr}` + code.slice(insertAt);
}

/** Write (or replace) a plain string attr on the instance tag; null removes it. */
function writeStringAttr(code: string, nodeId: string, name: string, value: string | null): string {
  const tagSpan = findTagByDataId(code, nodeId);
  if (!tagSpan) return code;
  const tagText = code.slice(tagSpan.start, tagSpan.end);
  const attrRe = new RegExp(`\\s${name}="[^"]*"`);
  const attrM = attrRe.exec(tagText);
  if (attrM) {
    const attrStart = tagSpan.start + attrM.index;
    const attrEnd = attrStart + attrM[0].length;
    return value === null
      ? code.slice(0, attrStart) + code.slice(attrEnd)
      : code.slice(0, attrStart) + ` ${name}="${value}"` + code.slice(attrEnd);
  }
  if (value === null) return code;
  const nameM = tagText.match(/^<([A-Za-z][\w.]*)/);
  const insertAt = tagSpan.start + (nameM ? nameM[0].length : 1);
  return code.slice(0, insertAt) + ` ${name}="${value}"` + code.slice(insertAt);
}

/** Remove a legacy `<dim>={…}` attr from the instance tag. */
function removeInstanceDimAttr(code: string, nodeId: string, dim: 'width' | 'height'): string {
  const tagSpan = findTagByDataId(code, nodeId);
  if (!tagSpan) return code;
  const tagText = code.slice(tagSpan.start, tagSpan.end);
  const attrM = new RegExp(`\\s${dim}=\\{`).exec(tagText);
  if (!attrM) return code;
  const attrStart = tagSpan.start + attrM.index;
  const open = attrStart + attrM[0].length - 1;
  const close = skipBraces(code, open);
  if (close === -1) return code;
  return code.slice(0, attrStart) + code.slice(close);
}

/** The variant ident this FILE's dialect uses in conditionals: masters with
 *  connection state destructure `[variant, setVariant] = useState(...)` and
 *  every ternary must test `variant` (the live switch), plain masters test
 *  `initialVariant`. Needed when a write starts from an ABSENT entry — there
 *  is no existing expression to learn the ident from, and guessing
 *  `initialVariant` in a connections master would freeze the live variant. */
function fileVariantIdent(code: string): string {
  return /\[\s*variant\s*,\s*setVariant\s*\]\s*=\s*useState\(/.test(code) ? 'variant' : 'initialVariant';
}

/** Sync the `data-size-hug` marker with the CURRENT style state of both dims:
 *  listed when the dim's style ternary carries an 'auto' branch alongside
 *  pinned ones (live needs the runtime placement wrapper), removed otherwise.
 *  All-hug needs no marker — the key is absent and the root's own value
 *  survives natively. */
function syncHugMarker(code: string, nodeId: string): string {
  const dims: string[] = [];
  for (const dim of ['width', 'height'] as const) {
    const state = readInstanceDimBranches(code, nodeId, dim);
    if (state.channel === 'style' && state.branches.some((b) => b.value === HUG)) dims.push(dim);
  }
  return writeStringAttr(code, nodeId, 'data-size-hug', dims.length ? dims.join(',') : null);
}

/** Convert a legacy PROP-dialect dim back into the style channel:
 *  `height={variant === 'v1' ? undefined : '419px'}` + style `height: '100%'`
 *  pin → style `height: variant === 'v1' ? 'auto' : '419px'`, attr removed,
 *  marker synced. No-op on files without the attr. The master's hoisted
 *  defaulted param is harmless left in place (nothing passes the prop after
 *  this), so masters are not touched. */
export function migrateInstanceDimPropToStyle(code: string, nodeId: string, dim: 'width' | 'height'): string {
  const attrExpr = getInstanceDimAttrExpr(code, nodeId, dim);
  if (attrExpr === null) return code;
  const full = parseDimBranchesFull(attrExpr);
  if (!full) { trace.action('instance-auto-size:migrate-unowned', { nodeId, dim }); return code; }
  let out = removeInstanceDimAttr(code, nodeId, dim);
  const branches = full.branches;
  const allHug = branches.every((b) => b.value === HUG);
  // The old dialect pinned the style dim to '100%' as the placement box; the
  // migrated ternary REPLACES that pin. A style expr we don't own (motion
  // value) is left alone — the attr removal already ends the conflict.
  const entry = styleDimEntry(out, nodeId, dim);
  const entryOwned = !entry || parseDimBranchesFull(entry.expr) !== null;
  if (entryOwned) {
    out = writeInstanceStyleDim(out, nodeId, dim, allHug ? null : branchesToStyleExpr(branches, full.ident));
  }
  out = syncHugMarker(out, nodeId);
  trace.action('instance-auto-size:migrate-prop-to-style', { nodeId, dim, allHug, branches: branches.length });
  return out;
}

/**
 * EVERY dim style-write on a design-component instance routes through here
 * (mutation-queue updateStyles/updateVariantStyle) instead of the legacy
 * generators. The legacy variant writer represents "no base value" as an
 * EMPTY-STRING else branch (`cond ? '219px' : ''`) — benign on a plain div,
 * poison on an instance: '' merges into the root through the expansion and
 * DELETES the master's dim (primary collapse, user report 2026-08-15). Here
 * the hug semantics are first-class: an absent entry means the instance was
 * hugging, so a variant write pins that variant and writes an explicit
 * 'auto' else; '' branches from older writes normalize to 'auto'; a '' value
 * (reset) removes the branch. Legacy prop-dialect files migrate on the way in.
 */
export function setInstanceDimStyleWriteInCode(
  code: string, nodeId: string, dim: 'width' | 'height', variant: string | null, value: string,
): string {
  let out = migrateInstanceDimPropToStyle(code, nodeId, dim);
  const state = readInstanceDimBranches(out, nodeId, dim);
  if (state.channel === 'none' && styleDimEntry(out, nodeId, dim)) {
    // A style entry we can't parse (motion value / binding) — not ours to touch.
    trace.action('instance-auto-size:unowned-expr', { nodeId, dim });
    return code;
  }
  const branches = state.branches.map((b) => (b.value === '' ? { ...b, value: HUG } : b));
  const target = variant && variant !== 'default' ? variant : null;
  const idx = branches.findIndex((b) => b.variant === target);
  if (value === '') {
    if (idx >= 0) branches.splice(idx, 1);
    // Deleting the base while replicas stay pinned: per-variant absence is
    // inexpressible, so the faithful base is an explicit hug.
    if (target === null && branches.some((b) => b.variant !== null) && !branches.some((b) => b.variant === null)) {
      branches.push({ variant: null, value: HUG });
    }
  } else {
    if (idx >= 0) branches[idx] = { variant: target, value };
    else branches.push({ variant: target, value });
    if (target !== null && !branches.some((b) => b.variant === null)) {
      branches.push({ variant: null, value: HUG });
    }
  }
  const allHug = branches.length === 0 || branches.every((b) => b.value === HUG);
  const ident = state.branches.length > 0 ? state.ident : fileVariantIdent(out);
  out = writeInstanceStyleDim(out, nodeId, dim, allHug ? null : branchesToStyleExpr(branches, ident));
  out = syncHugMarker(out, nodeId);
  trace.action('instance-auto-size:dim-style-write', { nodeId, dim, variant: target, value, allHug, ident });
  return out;
}

/**
 * Apply the auto press to the instance's dim in the STYLE channel.
 *  - No other pinned branches → remove the style entry (hug on all variants).
 *  - Other variants pinned → 'auto' branch for the active variant (null =
 *    primary/else), marker synced for the live runtime wrapper.
 * Legacy prop-dialect files migrate first, so the press also self-heals them.
 */
export function autoSizeInstanceDimInCode(
  code: string, nodeId: string, dim: 'width' | 'height', activeVariant: string | null,
): string {
  let out = migrateInstanceDimPropToStyle(code, nodeId, dim);
  const state = readInstanceDimBranches(out, nodeId, dim);
  if (state.channel === 'none' && styleDimEntry(out, nodeId, dim)) {
    // A style entry we can't parse (motion value / binding) — not ours to touch.
    trace.action('instance-auto-size:unowned-expr', { nodeId, dim });
    return code;
  }

  const target = activeVariant && activeVariant !== 'default' ? activeVariant : null;
  // '' branches (the legacy variant writer's "no base" else) read as hug.
  const branches = state.branches.map((b) => (b.value === '' ? { ...b, value: HUG } : b));
  const idx = branches.findIndex((b) => b.variant === target);
  if (idx >= 0) branches[idx] = { variant: target, value: HUG };
  else branches.push({ variant: target, value: HUG });

  const allHug = branches.every((b) => b.value === HUG);
  out = writeInstanceStyleDim(out, nodeId, dim, allHug ? null : branchesToStyleExpr(branches, state.ident));
  out = syncHugMarker(out, nodeId);
  trace.action('instance-auto-size:apply', { nodeId, dim, activeVariant, channel: state.channel, allHug });
  return out;
}
