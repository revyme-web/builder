// extract-component-gen.ts — author a design-component master file from a
// plain page subtree (the file half of the agent's `extract_component` tool).
//
// Pure `(code, …args) => result` generator, house style: Babel locates spans,
// source-preserving surgery keeps the original formatting (no reprint), and
// the emitted master follows the oracle-canonical shape the panels operate:
// `"use client"` + runtime import + `/** @name */` + variantConfig ARRAY
// (serializeVariantConfig — the shape `set_variant` reads) + destructured
// props with defaults + root `...style` spread + withResponsiveProps export.
//
// SCOPE (deliberately narrow — CAP-01 [FIGÉE], P4):
// - Only literal JSXText leaves become props (named camelCase(data-id),
//   deduplicated). JSX expressions ({x}, ternaries) stay hardwired.
// - The ROOT loses `position` + inset props (COMPONENT_ROOT_POSITION and the
//   inset-leak rule forbid them on a master root) and gains the trailing
//   `...style` spread (ROOT_STYLE_SPREAD).
// - Nested project components are copied by tag WITHOUT imports — extract
//   flat sections first.

import { parseJSX, findFirstElementByDataId } from '@/code/parsing/ast-utils';
import { serializeVariantConfig } from '@/code/variants/variant-config';
import { trace } from '@/shared/debug-trace';

export interface ExtractedProp {
  /** Prop name as authored (`{heroTitle}` in JSX, `heroTitle` in signature). */
  name: string;
  /** Current text — becomes the prop default, so the instance renders identically with no props. */
  defaultValue: string;
  /** Source data-id the prop was derived from. */
  dataId: string;
}

export type ExtractMasterResult =
  | { masterCode: string; props: ExtractedProp[] }
  | { error: string };

const COMPONENT_NAME_RE = /^[A-Z][A-Za-z0-9]*$/;

/** `hero-title-line-1` → `heroTitleLine1` (deduped by caller via `used`). */
export function propNameForDataId(dataId: string, used: Set<string>): string {
  const parts = dataId.split(/[^A-Za-z0-9]+/).filter(Boolean);
  let base = parts.map((p, i) => (i === 0 ? p.charAt(0).toLowerCase() + p.slice(1) : p.charAt(0).toUpperCase() + p.slice(1))).join('');
  if (!base) base = 'text';
  if (/^[0-9]/.test(base)) base = 't' + base;
  let name = base;
  let n = 2;
  while (used.has(name)) name = `${base}${n++}`;
  used.add(name);
  return name;
}

const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
};

function decodeEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#39|apos);/g, (m) => HTML_ENTITIES[m] ?? m);
}

/** Remove the minimal common indent, then indent every line by `spaces`. */
function reindent(slice: string, spaces: number): string {
  const lines = slice.split('\n');
  const indents = lines
    .filter((l) => l.trim() !== '')
    .map((l) => l.match(/^ */)?.[0].length ?? 0);
  const min = indents.length > 0 ? Math.min(...indents) : 0;
  const pad = ' '.repeat(spaces);
  return lines.map((l) => (l.trim() === '' ? '' : pad + l.slice(min))).join('\n');
}

interface TextSpan {
  start: number;
  end: number;
  prop: string;
}

/**
 * Build `components/<name>.tsx` source from the `nodeId` subtree of a page
 * file's code. Returns `{ error }` when the node is missing, already a
 * component instance (PascalCase tag), or the name is not PascalCase.
 */
export function buildExtractedMaster(
  sourceCode: string,
  nodeId: string,
  name: string,
  opts: { rootSize?: Record<string, string> } = {},
): ExtractMasterResult {
  trace.fn('generator.buildExtractedMaster', { nodeId, name });
  if (!COMPONENT_NAME_RE.test(name)) {
    return { error: `Invalid component name "${name}" — use PascalCase letters and digits, starting with a capital (e.g. Hero, PricingCard).` };
  }
  const ast = parseJSX(sourceCode);
  if (!ast) return { error: 'Could not parse the active file.' };

  // Locate the subtree root and snapshot its source span + tag.
  let rootStart = -1;
  let rootEnd = -1;
  let rootTag = '';
  const texts: { start: number; end: number; value: string; ownerId: string }[] = [];
  const idStack: string[] = [];
  findFirstElementByDataId(ast, nodeId, (path, element) => {
    const opening: any = element.openingElement;
    const tag = opening.name;
    rootTag = tag?.type === 'JSXIdentifier' ? (tag.name as string) : '';
    if (element.loc) {
      rootStart = element.loc.start.index;
      rootEnd = element.loc.end.index;
    }
    path.traverse({
      JSXElement: {
        enter(childPath: any) {
          const childOpening = childPath.node.openingElement;
          const idAttr = (childOpening.attributes ?? []).find(
            (a: any) => a.type === 'JSXAttribute' && a.name?.name === 'data-id',
          );
          idStack.push(
            idAttr?.value?.type === 'StringLiteral' ? (idAttr.value.value as string) : '',
          );
        },
        exit() {
          idStack.pop();
        },
      },
      JSXText(textPath: any) {
        const raw: string = textPath.node.value ?? '';
        if (raw.trim() === '') return;
        const loc = textPath.node.loc;
        if (!loc) return;
        // Replace only the trimmed core — surrounding whitespace/newlines
        // (indentation) stay byte-identical.
        const lead = raw.length - raw.trimStart().length;
        const trail = raw.length - raw.trimEnd().length;
          texts.push({
            start: loc.start.index + lead,
            end: loc.end.index - trail,
            value: decodeEntities(raw.trim()),
            // Nearest ancestor-or-self data-id (anonymous wrappers inherit).
            ownerId: [...idStack].reverse().find((id) => id !== '') || nodeId,
          });
      },
    });
  });
  if (rootStart === -1 || rootEnd === -1 || !rootTag) {
    return { error: `No node with data-id="${nodeId}" in the active file.` };
  }
  if (rootTag[0] === rootTag[0].toUpperCase() && rootTag[0] !== rootTag[0].toLowerCase()) {
    return { error: `"${nodeId}" is already a component instance (<${rootTag}>) — extract only plain elements.` };
  }

  // Assign props (first-seen order), then splice `{prop}` spans descending.
  const used = new Set<string>();
  const spans: TextSpan[] = [];
  const props: ExtractedProp[] = [];
  const inSubtree = texts.filter((t) => t.start >= rootStart && t.end <= rootEnd);
  // Deterministic order: document order.
  inSubtree.sort((a, b) => a.start - b.start);
  for (const t of inSubtree) {
    const prop = propNameForDataId(t.ownerId, used);
    spans.push({ start: t.start, end: t.end, prop });
    props.push({ name: prop, defaultValue: t.value, dataId: t.ownerId });
  }
  let slice = sourceCode.slice(rootStart, rootEnd);
  const ordered = spans
    .map((s) => ({ ...s, start: s.start - rootStart, end: s.end - rootStart }))
    .sort((a, b) => b.start - a.start);
  for (const s of ordered) {
    slice = slice.slice(0, s.start) + `{${s.prop}}` + slice.slice(s.end);
  }

  // ROOT style surgery on the sliced source: drop `position` + insets (banned
  // on a master root), ensure the trailing `...style` spread.
  slice = convertRootStyleForMaster(slice, opts.rootSize);

  const body = reindent(slice, 4);
  const params = ['style', ...props.map((p) => `${p.name} = ${JSON.stringify(p.defaultValue)}`)].join(',\n  ');
  const types = ['style?: React.CSSProperties', ...props.map((p) => `${p.name}?: string`)].join(';\n  ');
  // Nested project-component instances in the slice keep working only with
  // their imports: copy the SOURCE file's import line for every PascalCase
  // tag the slice uses (framer-motion / runtime tags are auto-imported at
  // commit; project components are not).
  const nestedImports = nestedComponentImports(sourceCode, slice);
  const masterCode = `"use client";

import { withResponsiveProps } from "@revyme/runtime";
${nestedImports.map((l) => `${l}\n`).join('')}
/** @name "${name}" */
export ${serializeVariantConfig([{ name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true }])}

function ${name}({
  ${params},
}: {
  ${types};
}) {
  return (
${body}
  );
}

export default withResponsiveProps(${name});
`;
  return { masterCode, props };
}

const BANNED_ROOT_STYLE_PROPS = new Set(['position', 'left', 'top', 'right', 'bottom']);

/** Drop banned props from a style-object body, preserving other formatting.
 *  Depth-aware: only top-level `prop:` segments match (never inside nested
 *  objects/strings), and exactly ONE adjacent comma goes with the removal, so
 *  `{a: 1, position: 'x', b: 2}` → `{a: 1, b: 2}` (eating both commas produced
 *  `a: 1 b: 2` — a syntax error that broke every mid-object extraction). */
function dropBannedStyleProps(styleBody: string): { body: string; dropped: string[] } {
  const dropped: string[] = [];
  // Top-level `prop: value,` spans (values may contain commas inside parens,
  // brackets, braces or quotes — depth-tracked like findTopLevelPropSpan).
  let body = styleBody;
  for (const prop of BANNED_ROOT_STYLE_PROPS) {
    // Split top-level segments at depth-0 commas, then match `prop:` heads.
    let depth = 0;
    let str = '';
    let segStart = 0;
    let found: { start: number; valueEnd: number } | null = null;
    const scanValueEnd = (from: number): number => {
      let pd = 0;
      let bd = 0;
      let cd = 0;
      let st = '';
      let i = from;
      for (; i < body.length; i++) {
        const ch = body[i];
        if (st) {
          if (ch === '\\') { i++; continue; }
          if (ch === st) st = '';
          continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') { st = ch; continue; }
        if (ch === '(') pd++;
        else if (ch === ')') pd--;
        else if (ch === '[') bd++;
        else if (ch === ']') bd--;
        else if (ch === '{') cd++;
        else if (ch === '}') {
          if (cd === 0) break;
          cd--;
        } else if (ch === ',' && pd === 0 && bd === 0 && cd === 0) break;
      }
      return i;
    };
    const scanSegment = (end: number): { start: number; valueEnd: number } | null => {
      const head = body.slice(segStart, end).match(/^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*:/);
      if (!head || head[1] !== prop) return null;
      return { start: segStart, valueEnd: scanValueEnd(segStart + head[0].length) };
    };
    for (let i = 0; i < body.length; i++) {
      const ch = body[i];
      if (str) {
        if (ch === '\\') { i++; continue; }
        if (ch === str) str = '';
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') { str = ch; continue; }
      if (ch === '{' || ch === '(' || ch === '[') depth++;
      else if (ch === '}' || ch === ')' || ch === ']') depth--;
      else if (ch === ',' && depth === 0) {
        const hit = scanSegment(i);
        if (hit) {
          found = hit;
          break;
        }
        segStart = i + 1;
      }
    }
    if (!found) found = scanSegment(body.length);
    if (!found) continue;
    // Keep exactly one adjacent comma. First segment (only whitespace
    // before it): swallow one FOLLOWING comma. Otherwise: drop back over
    // the PRECEDING comma, keep the following one.
    if (/^\s*$/.test(body.slice(0, found.start))) {
      let end = found.valueEnd;
      if (body[end] === ',') end++;
      body = body.slice(end);
    } else {
      const before = body.slice(0, found.start);
      const back = before.match(/,\s*$/);
      body = back
        ? before.slice(0, before.length - back[0].length) + body.slice(found.valueEnd)
        : body.slice(0, found.start) + body.slice(found.valueEnd);
    }
    dropped.push(prop);
  }
  return { body, dropped };
}

/**
 * Adapt the sliced root element's `style={{…}}` for master duty: strip banned
 * root props, ensure the trailing `...style` spread. Operates on the element
 * source slice (root opening tag first).
 */
/** The source file's import lines for the component tags a slice renders. */
function nestedComponentImports(sourceCode: string, slice: string): string[] {
  const tags = new Set<string>();
  for (const m of slice.matchAll(/<([A-Z][A-Za-z0-9]*)\b/g)) tags.add(m[1]);
  const out: string[] = [];
  for (const tag of tags) {
    const line = sourceCode.match(new RegExp(`^import\\s+(?:\\{\\s*${tag}\\s*\\}|${tag})\\s+from\\s+['"][^'"]+['"];?`, 'm'))?.[0];
    if (line && !/from ['"](framer-motion|react|next\/link)['"]/.test(line)) out.push(line);
  }
  return out;
}

export function convertRootStyleForMaster(elementSource: string, rootSize: Record<string, string> = {}): string {
  // Find the root opening tag's style object: first `style={{` in the slice
  // belongs to the root element itself.
  const styleIdx = elementSource.indexOf('style={{');
  if (styleIdx === -1) {
    // No style at all — add a spread-only one before the tag close.
    const tagEnd = elementSource.indexOf('>');
    if (tagEnd === -1) return elementSource;
    const selfClose = elementSource[tagEnd - 1] === '/';
    const at = selfClose ? tagEnd - 1 : tagEnd;
    return elementSource.slice(0, at) + ' style={{ ...style }}' + elementSource.slice(at);
  }
  const objStart = styleIdx + 'style={{'.length;
  let depth = 1;
  let i = objStart;
  let str = '';
  for (; i < elementSource.length; i++) {
    const ch = elementSource[i];
    if (str) {
      if (ch === '\\') { i++; continue; }
      if (ch === str) str = '';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { str = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) return elementSource;
  let inner = elementSource.slice(objStart, i);
  // Parent-relative root sizes → the px the caller measured (or 'auto'): an
  // artboard has no parent to be a percentage of (oracle COMPONENT_ROOT_PERCENT_SIZE).
  for (const [k, v] of Object.entries(rootSize)) {
    const re = new RegExp(`(^|[,{\\s])${k}\\s*:\\s*(['"\`])[^'"\`]*\\2`);
    inner = re.test(inner) ? inner.replace(re, `$1${k}: '${v}'`) : `${k}: '${v}', ${inner}`;
  }
  const { body } = dropBannedStyleProps(inner);
  if (/\.\.\.style\b/.test(body)) return elementSource;
  if (body.trim() === '') {
    return elementSource.slice(0, objStart) + ' ...style ' + elementSource.slice(i);
  }
  // Align the spread with the existing entries; reuse the original trailing
  // whitespace (newline + indent) before the closing braces.
  const entryIndent = body.match(/\n( *)[A-Za-z_$]/)?.[1] ?? '';
  const tailMatch = body.match(/,\s*$/);
  const trail = tailMatch ? tailMatch[0].slice(1) || '\n' : '\n';
  const stripped = body.replace(/,\s*$/, '').replace(/\s*$/, '');
  const next = `${stripped},\n${entryIndent}...style,${trail}`;
  return elementSource.slice(0, objStart) + next + elementSource.slice(i);
}
