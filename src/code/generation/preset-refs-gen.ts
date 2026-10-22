// preset-refs-gen.ts — pure rewrites of the places a design-token preset is
// NAMED in source: rename `--x` everywhere, or replace `var(--x …)` with the
// token's value (detach, before the token is deleted). No ProjectFS access —
// preset-rename (rename) and preset-ops (delete) own the file loops.

import { parse } from '@babel/parser';
import { escapeRegExp } from '@/shared/regex-utils';

/** How a file's references may be rewritten: `code` (TS/JS/CSS — every
 *  occurrence is code), `data` (JSON — only `var(` references; anything else
 *  is user text), or null (`_meta/` editor state, `messages/` copy). */
export function presetRefRewriteMode(path: string): 'code' | 'data' | null {
  if (path.startsWith('_meta/') || path.startsWith('messages/')) return null;
  if (/\.(tsx|ts|jsx|js|css)$/.test(path)) return 'code';
  if (path.endsWith('.json')) return 'data';
  return null;
}

/** Rename every occurrence of the custom property `--from` in `text` to
 *  `--to`. Exact-name boundaries on both sides, so `--color-brand` never
 *  touches `--color-brand-light` or `--x-color-brand`.
 *  `varOnly` limits it to `var(--from …)` references — for data files (CMS
 *  JSON) where anything else is user text, not code. */
export function renameCustomPropertyInText(text: string, from: string, to: string, varOnly = false): string {
  const name = escapeRegExp(from);
  const re = varOnly
    ? new RegExp(`(var\\(\\s*)--${name}(?![\\w-])`, 'g')
    : new RegExp(`(^|[^\\w-])--${name}(?![\\w-])`, 'g');
  return text.replace(re, `$1--${to}`);
}

/** Replace every `var(--name)` / `var(--name, fallback)` expression in `text`
 *  with `replacement` (inserted verbatim). The closing paren is found by depth,
 *  so a fallback like `rgba(0, 0, 0, 0.5)` goes with it. Exact-name boundary. */
export function replaceVarRefsInText(text: string, name: string, replacement: string): string {
  const re = new RegExp(`var\\(\\s*--${escapeRegExp(name)}(?![\\w-])`, 'g');
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    let depth = 1;
    let i = m.index + 4; // just past `var(`
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')') depth--;
    }
    if (depth !== 0) break; // unbalanced — leave the rest as written
    out += text.slice(last, m.index) + replacement;
    last = i;
    re.lastIndex = i;
  }
  return last === 0 ? text : out + text.slice(last);
}

/** A JS string literal for `value`, keeping the source's delimiter unless the
 *  value contains it and not the other quote (`'Inter', sans-serif` → `"…"`). */
function quoteJs(value: string, delim: string): string {
  const other = delim === '"' ? "'" : '"';
  const q = value.includes(delim) && !value.includes(other) ? other : delim;
  const body = value
    .replace(/\\/g, '\\\\')
    .replace(new RegExp(q, 'g'), `\\${q}`)
    .replace(/\n/g, '\\n');
  return q + body + q;
}

type AstNode = { type: string; start: number; end: number; [k: string]: unknown };
const SKIP_KEYS = new Set(['loc', 'start', 'end', 'extra', 'range', 'leadingComments', 'trailingComments', 'innerComments']);

/** Detach `var(--name …)` in a TS/JS(X) source: rewrite only the STRING
 *  LITERALS and template text that carry it, re-quoted for their context, so a
 *  value with quotes (a font stack) can never break the file. Null when the
 *  source does not parse. */
function bakeVarRefsInJs(src: string, name: string, value: string): string | null {
  let ast: { program: AstNode };
  try {
    ast = parse(src, { sourceType: 'module', plugins: ['jsx', 'typescript'] }) as unknown as { program: AstNode };
  } catch {
    return null;
  }
  const needle = `--${name}`;
  const edits: { start: number; end: number; text: string }[] = [];
  const visit = (node: AstNode, parent: AstNode | null) => {
    if (node.type === 'StringLiteral' && typeof node.value === 'string' && node.value.includes(needle)) {
      const next = replaceVarRefsInText(node.value, name, value);
      if (next !== node.value) {
        const delim = src[node.start];
        // A JSX attribute string has no escape sequences — a value carrying
        // the attribute's quote becomes an expression container instead.
        const text = parent?.type === 'JSXAttribute'
          ? (next.includes(delim) ? `{${JSON.stringify(next)}}` : delim + next + delim)
          : quoteJs(next, delim);
        edits.push({ start: node.start, end: node.end, text });
      }
    } else if (node.type === 'TemplateElement') {
      const raw = (node.value as { raw?: string } | undefined)?.raw ?? '';
      if (raw.includes(needle)) {
        const escaped = value.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
        const next = replaceVarRefsInText(raw, name, escaped);
        if (next !== raw) edits.push({ start: node.start, end: node.end, text: next });
      }
    }
    for (const key of Object.keys(node)) {
      if (SKIP_KEYS.has(key)) continue;
      const child = node[key];
      if (Array.isArray(child)) {
        for (const c of child) if (c && typeof (c as AstNode).type === 'string') visit(c as AstNode, node);
      } else if (child && typeof (child as AstNode).type === 'string') {
        visit(child as AstNode, node);
      }
    }
  };
  visit(ast.program, null);
  if (edits.length === 0) return src;
  edits.sort((a, b) => b.start - a.start);
  let out = src;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

/** Replace every `var(--name …)` reference in a project file with `value`,
 *  the token's own value — what "detach" means: each element keeps exactly
 *  what it showed when the preset goes away. Returns `src` unchanged when the
 *  file kind is never rewritten or holds no reference. */
export function bakePresetRefsInSource(src: string, path: string, name: string, value: string): string {
  const mode = presetRefRewriteMode(path);
  if (!mode || !src.includes(`--${name}`)) return src;
  if (path.endsWith('.css')) return replaceVarRefsInText(src, name, value);
  if (mode === 'data') return replaceVarRefsInText(src, name, JSON.stringify(value).slice(1, -1));
  const baked = bakeVarRefsInJs(src, name, value);
  if (baked !== null) return baked;
  // Unparseable mid-edit file: a plain text swap is still safe when the value
  // cannot close or escape the string it lands in.
  return /['"`\\$]/.test(value) ? src : replaceVarRefsInText(src, name, value);
}
