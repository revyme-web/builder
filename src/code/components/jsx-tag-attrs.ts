// jsx-tag-attrs.ts — read the attributes of ONE opening JSX tag, exactly.
//
// The instance-prop writers located a prop with regexes: ` prop="…"`,
// `prop=\{[^}]*\}`. Each spelling they did not foresee became a silent miss,
// and a miss on SET appends the prop again — a duplicate attribute (esbuild:
// "Duplicate 'layout' attribute"; the later one wins at runtime, so the
// write looked ignored). The misses were real-world shapes, not exotica:
//   - an expression holding a nested object / template literal: `items={[{…}]}`
//   - a bare boolean: `<Card featured />`
//   - a prop on its own line after a newline (multi-line tags)
//   - a single-quoted value
// The scanner walks the tag the way the JSX grammar does — name, `=`, then a
// string or a balanced `{…}` (string/template-literal aware) or nothing — so
// every attribute has one exact span and nothing is guessed.

export type TagAttrValue =
  | { kind: 'string'; quote: '"' | "'"; text: string }
  | { kind: 'expr'; source: string }
  | { kind: 'bare' };

export interface TagAttr {
  name: string;
  /** Start of the whitespace that precedes the attribute (remove from here). */
  wsStart: number;
  /** Start of the attribute name. */
  start: number;
  /** Index just past the attribute's value (or its name, when bare). */
  end: number;
  value: TagAttrValue;
}

/**
 * Index just past the `}` that closes the `{` at `open`, skipping braces
 * inside '…', "…" and `…` (including `${…}` nesting inside templates).
 * -1 when unbalanced.
 */
export function skipBalancedBraces(s: string, open: number): number {
  // Stack of contexts: 'b' = inside braces, '`' = inside a template literal.
  const stack: Array<'b' | '`'> = [];
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    const top = stack[stack.length - 1];
    if (top === '`') {
      if (ch === '\\') { i++; continue; }
      if (ch === '`') { stack.pop(); continue; }
      if (ch === '$' && s[i + 1] === '{') { stack.push('b'); i++; continue; }
      continue;
    }
    if (ch === '"' || ch === "'") {
      // A plain string: runs to the matching quote (escapes honoured).
      let j = i + 1;
      for (; j < s.length; j++) {
        if (s[j] === '\\') { j++; continue; }
        if (s[j] === ch) break;
      }
      if (j >= s.length) return -1;
      i = j;
      continue;
    }
    if (ch === '`') { stack.push('`'); continue; }
    if (ch === '{') { stack.push('b'); continue; }
    if (ch === '}') {
      stack.pop();
      if (stack.length === 0) return i + 1;
    }
  }
  return -1;
}

const TAG_NAME_RE = /[A-Za-z_$][\w$.:-]*/y;
const ATTR_NAME_RE = /[A-Za-z_$][\w$:.-]*/y;
const isWs = (c: string | undefined) => c === ' ' || c === '\n' || c === '\t' || c === '\r';

/**
 * Every attribute of the opening tag `tag` (`<Name …>` or `<Name … />`), in
 * source order. Spread attributes (`{...rest}`) are skipped, not reported.
 * Returns null when the tag cannot be read (unbalanced value) — callers must
 * then leave the source alone rather than guess.
 *
 * `from` scans a tag that starts inside a larger string (a whole file)
 * without slicing it; every span is then an index into `tag`.
 */
export function scanTagAttrs(tag: string, from = 0): TagAttr[] | null {
  if (tag[from] !== '<') return null;
  TAG_NAME_RE.lastIndex = from + 1;
  const head = TAG_NAME_RE.exec(tag);
  if (!head) return null;
  const out: TagAttr[] = [];
  let i = from + 1 + head[0].length;
  for (;;) {
    const wsStart = i;
    while (i < tag.length && isWs(tag[i])) i++;
    if (i >= tag.length) return out;
    const ch = tag[i];
    if (ch === '>' || ch === '/') return out;
    if (ch === '{') {
      // `{...spread}` — skip it whole.
      const end = skipBalancedBraces(tag, i);
      if (end === -1) return null;
      i = end;
      continue;
    }
    ATTR_NAME_RE.lastIndex = i;
    const nameMatch = ATTR_NAME_RE.exec(tag);
    if (!nameMatch) return null;
    const name = nameMatch[0];
    const start = i;
    i += name.length;
    let j = i;
    while (j < tag.length && isWs(tag[j])) j++;
    if (tag[j] !== '=') {
      out.push({ name, wsStart, start, end: i, value: { kind: 'bare' } });
      continue;
    }
    j++;
    while (j < tag.length && isWs(tag[j])) j++;
    const q = tag[j];
    if (q === '"' || q === "'") {
      // JSX attribute strings have no escapes: they end at the next same quote.
      const close = tag.indexOf(q, j + 1);
      if (close === -1) return null;
      out.push({ name, wsStart, start, end: close + 1, value: { kind: 'string', quote: q, text: tag.slice(j + 1, close) } });
      i = close + 1;
      continue;
    }
    if (q === '{') {
      const end = skipBalancedBraces(tag, j);
      if (end === -1) return null;
      out.push({ name, wsStart, start, end, value: { kind: 'expr', source: tag.slice(j + 1, end - 1) } });
      i = end;
      continue;
    }
    return null;
  }
}

export interface DuplicateAttrSpan {
  name: string;
  wsStart: number;
  end: number;
  /** Index of the `<` that opens the tag. */
  tagStart: number;
  /** The tag's data-id, when it has one. */
  dataId?: string;
}

/**
 * Spans of every DUPLICATE attribute copy in `code` — all but the LAST copy of
 * a name on one opening tag (the last is the one JSX applies; dropping the
 * earlier ones never changes what renders). Cheap: one pass over `<Tag`
 * openings with the attribute scanner, no parse.
 */
export function findDuplicateAttrSpans(code: string): DuplicateAttrSpan[] {
  const out: DuplicateAttrSpan[] = [];
  const re = /<[A-Za-z][\w.]*(?=[\s/>])/g;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    const attrs = scanTagAttrs(code, m.index);
    if (!attrs || attrs.length < 2) continue;
    const last = new Map<string, number>();
    attrs.forEach((a, idx) => last.set(a.name, idx));
    if (last.size === attrs.length) continue;
    const id = attrs.find((a) => a.name === 'data-id');
    const dataId = id && id.value.kind === 'string' ? id.value.text : undefined;
    attrs.forEach((a, idx) => { if (last.get(a.name) !== idx) out.push({ name: a.name, wsStart: a.wsStart, end: a.end, tagStart: m!.index, dataId }); });
  }
  return out;
}

/** Every attribute named `name` on the tag (more than one = a duplicate). */
export function findTagAttrs(tag: string, name: string): TagAttr[] {
  return (scanTagAttrs(tag) ?? []).filter((a) => a.name === name);
}

/**
 * Set (`attrText` = the full `name=value` text) or remove (`null`) the
 * attribute `name` on the opening tag `tag`. The first copy is replaced in
 * place; any DUPLICATE copies are dropped (they are what made earlier writes
 * look ignored); an absent attribute is inserted right after the tag name.
 * Null when the tag cannot be read — leave the source alone.
 */
export function writeTagAttr(tag: string, name: string, attrText: string | null): string | null {
  const attrs = scanTagAttrs(tag);
  if (!attrs) return null;
  const hits = attrs.filter((a) => a.name === name);
  let out = tag;
  // Later copies first, so the earlier spans stay valid.
  for (const a of hits.slice(1).reverse()) out = out.slice(0, a.wsStart) + out.slice(a.end);
  const first = hits[0];
  if (first) {
    return attrText === null
      ? out.slice(0, first.wsStart) + out.slice(first.end)
      : out.slice(0, first.start) + attrText + out.slice(first.end);
  }
  if (attrText === null) return out;
  TAG_NAME_RE.lastIndex = 1;
  const nameEnd = 1 + TAG_NAME_RE.exec(out)![0].length;
  return `${out.slice(0, nameEnd)} ${attrText}${out.slice(nameEnd)}`;
}

/** The value JSX applies for `name` (the LAST copy when duplicated), or null. */
export function readTagAttr(tag: string, name: string): TagAttrValue | null {
  const hits = findTagAttrs(tag, name);
  return hits.length ? hits[hits.length - 1].value : null;
}

/** JSX attribute text for a STRING value, quote-safe: `"…"`, else `'…'`,
 *  else an escaped JS string expression when the value holds both quotes. */
export function formatStringAttr(name: string, value: string): string {
  if (!value.includes('"')) return `${name}="${value}"`;
  if (!value.includes("'")) return `${name}='${value}'`;
  return `${name}={${JSON.stringify(value)}}`;
}
