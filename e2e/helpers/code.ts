// Source readers for assertions. The document IS the source, so most checks
// read what the builder wrote — through Babel, not regexes: a `>` inside an
// arrow function or a `}` inside a style object can't fool an AST.

import { parse } from '@babel/parser';

type AnyNode = { type: string; start?: number | null; end?: number | null; [k: string]: unknown };

export interface JsxNode {
  id: string;
  tag: string;
  /** Nearest ancestor element that carries a data-id (null at the top). */
  parentId: string | null;
  /** Nearest data-id descendants, in source order (wrappers without a
   *  data-id — conditionals, fragments, `.map` bodies — are looked through). */
  childIds: string[];
  /** Raw attribute values: string literals unquoted, everything else as source. */
  attrs: Record<string, string>;
  /** The inline `style={{…}}` object: literals unquoted, expressions as source. */
  style: Record<string, string>;
  start: number;
  end: number;
}

export interface ParsedSource {
  code: string;
  nodes: JsxNode[];
  byId: Map<string, JsxNode>;
  /** Every data-id occurrence, duplicates included. */
  allIds: string[];
  imports: string[];
}

export function parseSource(code: string): ParsedSource {
  const ast = parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'], errorRecovery: true }) as unknown as AnyNode;
  const nodes: JsxNode[] = [];
  const imports: string[] = [];
  const src = (n: AnyNode | null | undefined) => (n && n.start != null && n.end != null ? code.slice(n.start, n.end) : '');

  const visit = (n: unknown, parent: JsxNode | null): void => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { for (const c of n) visit(c, parent); return; }
    const node = n as AnyNode;
    if (node.type === 'ImportDeclaration') imports.push(src(node));
    if (node.type === 'JSXElement') {
      const opening = node.openingElement as AnyNode;
      const attrs: Record<string, string> = {};
      const style: Record<string, string> = {};
      for (const a of (opening.attributes as AnyNode[]) ?? []) {
        if (a.type !== 'JSXAttribute') continue;
        const name = jsxName(a.name as AnyNode);
        const v = a.value as AnyNode | null;
        if (!v) { attrs[name] = 'true'; continue; }
        if (v.type === 'StringLiteral') { attrs[name] = String(v.value); continue; }
        const expr = v.type === 'JSXExpressionContainer' ? (v.expression as AnyNode) : v;
        attrs[name] = src(expr);
        if (name === 'style' && expr.type === 'ObjectExpression') readObject(expr, style, src);
      }
      const id = attrs['data-id'];
      if (id) {
        const el: JsxNode = {
          id, tag: jsxName(opening.name as AnyNode), parentId: parent?.id ?? null,
          childIds: [], attrs, style, start: node.start ?? 0, end: node.end ?? 0,
        };
        parent?.childIds.push(id);
        nodes.push(el);
        visit(node.children, el);
        // Attribute expressions can hold JSX too (render props, slots).
        visit(opening.attributes, el);
        return;
      }
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'start' || key === 'end' || key === 'extra' || key === 'leadingComments' || key === 'trailingComments') continue;
      visit(node[key], parent);
    }
  };
  visit(ast, null);

  const byId = new Map<string, JsxNode>();
  for (const n of nodes) if (!byId.has(n.id)) byId.set(n.id, n);
  return { code, nodes, byId, allIds: nodes.map(n => n.id), imports };
}

/** data-ids that occur more than once in the file. */
export function duplicateIds(parsed: ParsedSource): string[] {
  const seen = new Map<string, number>();
  for (const id of parsed.allIds) seen.set(id, (seen.get(id) ?? 0) + 1);
  return [...seen].filter(([, n]) => n > 1).map(([id]) => id);
}

/** The CSS text of the `@media (max-width: <width>px)` band, or null. */
export function mediaBand(code: string, width: number): string | null {
  const head = code.search(new RegExp(`@media[^{]*\\(max-width:\\s*${width}(?:\\.\\d+)?px\\)`));
  if (head === -1) return null;
  const open = code.indexOf('{', head);
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') { depth--; if (depth === 0) return code.slice(open + 1, i); }
  }
  return null;
}

/** One declaration for `dataId` inside that band: `{ value, important }`, or null. */
export function bandDecl(code: string, width: number, dataId: string, prop: string): { value: string; important: boolean } | null {
  const band = mediaBand(code, width);
  if (!band) return null;
  const kebab = prop.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`);
  const ruleRe = new RegExp(`\\[data-id="${escapeRe(dataId)}"\\][^{]*\\{([^}]*)\\}`, 'g');
  let m: RegExpExecArray | null;
  let found: { value: string; important: boolean } | null = null;
  while ((m = ruleRe.exec(band))) {
    const decl = new RegExp(`(?:^|[;{\\s])${escapeRe(kebab)}\\s*:\\s*([^;]+)`).exec(m[1]);
    if (decl) {
      const raw = decl[1].trim();
      found = { value: raw.replace(/\s*!important\s*$/, '').trim(), important: /!important\s*$/.test(raw) };
    }
  }
  return found;
}

function readObject(obj: AnyNode, out: Record<string, string>, src: (n: AnyNode) => string): void {
  for (const p of (obj.properties as AnyNode[]) ?? []) {
    if (p.type !== 'ObjectProperty') continue;
    const k = p.key as AnyNode;
    const key = k.type === 'Identifier' ? String(k.name) : k.type === 'StringLiteral' ? String(k.value) : src(k);
    const v = p.value as AnyNode;
    if (v.type === 'StringLiteral') out[key] = String(v.value);
    else if (v.type === 'NumericLiteral') out[key] = String(v.value);
    else if (v.type === 'TemplateLiteral' && (v.expressions as unknown[]).length === 0) {
      out[key] = ((v.quasis as AnyNode[])[0]?.value as { cooked: string }).cooked;
    } else out[key] = src(v);
  }
}

function jsxName(n: AnyNode): string {
  if (n.type === 'JSXIdentifier') return String(n.name);
  if (n.type === 'JSXMemberExpression') return `${jsxName(n.object as AnyNode)}.${jsxName(n.property as AnyNode)}`;
  if (n.type === 'JSXNamespacedName') return `${jsxName(n.namespace as AnyNode)}:${jsxName(n.name as AnyNode)}`;
  return '?';
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
