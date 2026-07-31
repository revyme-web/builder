// component-registry.ts — Discover and cache component files from ProjectFS.
// Scans components/ directory, extracts component name, props, and defaults.
// Cached by file content hash — only re-parses when file changes.

import * as t from '@babel/types';
import { simpleHash } from '@/shared/hash-utils';
import type { ProjectFS } from '../project/project-fs';
import { parseJSX, traverse } from '../parsing/ast-utils';
import { parseVariantConfig } from '../variants/variant-config';
import { parseComponentControlsMeta, parseCodeComponentDefaultSize, type ComponentControlsMeta } from './controls-parser';
import { parsePropMeta } from './prop-meta';
import { getPageVariables } from '../features/page-variables';
import { trace } from '@/shared/debug-trace';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ComponentProp {
  name: string;
  defaultValue: string | null; // null = required prop
  /** Authoring note from the `@propMeta` block (see prop-meta.ts). Absent when none. */
  description?: string;
  /** Variable type id from `@propMeta` ('number' | 'option' | 'color' | …). Absent when untyped. */
  varType?: string;
  /** Friendly display name from `@propMeta` (e.g. "Overflow 2"). Absent → use `name`. */
  label?: string;
}

/**
 * Reserved/structural component-function params that are NOT user variables and
 * must never be offered as bindable variables. Binding a style to one of these
 * corrupts the component: `style` is the instance-style spread, `initialVariant`
 * is the framer-motion variant SWITCHER (`initial={initialVariant}` /
 * `animate={initialVariant}`) — wiring a boxShadow/border onto it overwrites the
 * variant name with a CSS string and silently breaks variant switching (the
 * value also vanishes from the component tool, which renders `initialVariant` as
 * the "Variant" dropdown). Shared by ControlLabel's "Set Variable" submenu and
 * the VariableModal's existing-variable list so neither can bind to them.
 */
export const STRUCTURAL_PROPS = new Set(['style', 'initialVariant', 'ref', 'children', 'className', 'key']);

/** True when `name` is a reserved/structural prop (see {@link STRUCTURAL_PROPS}). */
export function isStructuralProp(name: string): boolean {
  return STRUCTURAL_PROPS.has(name);
}

export interface ComponentInfo {
  name: string;           // 'Navbar', 'Hero', etc.
  filePath: string;       // 'components/Navbar.tsx' or 'components/Counter.tsx'
  props: ComponentProp[]; // extracted from function params
  contentHash: string;    // for cache invalidation
  controlsMeta: ComponentControlsMeta | null;  // null for regular components, populated for Code components
}

// ─── Registry ───────────────────────────────────────────────────────────────

const cache = new Map<string, { hash: string; info: ComponentInfo }>();

// FULL-registry memo keyed by the caller's project version. Every ControlLabel in the properties panel calls
// buildComponentRegistry (~14 per render), and even with the per-file content-hash cache below, each call still
// re-lists + re-reads + re-hashes every component file — O(files) × O(ControlLabels) per change. On a TEMPLATE
// (isComponentFileAtom=true) that fires for EVERY style row; a normal page skips it (isComponentFile=false),
// which is why template drag/edit is far slower. When the caller passes `version` (projectVersionAtom — bumps
// only on a real code change), all the same-version calls share ONE build. WeakMap not usable (key is a number);
// a single-slot cache is enough since version is monotonic.
let fullRegistryCache: { version: number; registry: Map<string, ComponentInfo> } | null = null;

/**
 * Build a component registry from all .tsx files in components/.
 * Cached by content hash — only re-parses changed files. Pass `version` (projectVersion) to also share the
 * whole registry across same-version callers (avoids O(files)×O(callers) re-listing on the properties panel).
 */
export function buildComponentRegistry(fs: ProjectFS, version?: number): Map<string, ComponentInfo> {
  if (version != null && fullRegistryCache && fullRegistryCache.version === version) return fullRegistryCache.registry;
  const registry = new Map<string, ComponentInfo>();

  const componentFiles = fs.listFiles('components/').filter(f => f.endsWith('.tsx'));

  for (const filePath of componentFiles) {
    const code = fs.readFile(filePath);
    if (!code) continue;

    const hash = simpleHash(code);

    // Check cache
    const cached = cache.get(filePath);
    if (cached && cached.hash === hash) {
      registry.set(cached.info.name, cached.info);
      continue;
    }

    // Parse component
    const info = parseComponentFile(filePath, code, hash);
    if (info) {
      registry.set(info.name, info);
      cache.set(filePath, { hash, info });
    }
  }

  // CDN components are no longer source-parseable — they ship as compiled
  // JS bundles consumed via dynamic import. The registry only tracks
  // local TSX files now. CDN component prop signatures are populated
  // at instance level via the parser's JSX-attr scan instead, which is
  // accurate enough for the prop tool without needing source.

  if (version != null) fullRegistryCache = { version, registry };
  trace.fn('buildComponentRegistry', { count: registry.size, files: componentFiles.length });
  return registry;
}

/** Clear the component cache (for tests or reset) */
export function clearComponentCache(): void {
  cache.clear();
  fullRegistryCache = null;
  sourceInfoCache.clear();
}

// ─── Parser ─────────────────────────────────────────────────────────────────

/**
 * Public wrapper for one-off component-info extraction from an in-memory
 * source string. Used by the CDN-linked-component path in
 * ComponentPropsTool — that component isn't in projectFS (it's a remote
 * URL), but we have the source TSX from the source endpoint and want
 * the same name/props/controls metadata the registry produces.
 *
 * `pseudoFilePath` is the URL or any string the caller wants to put in
 * the `filePath` field; not used for I/O. `hash` is the cache key —
 * pass the URL's content-hash so it changes per URL revision.
 */
// Content-hash memo. On a TEMPLATE every ControlLabel falls back to this to read the page-as-component's props,
// so it ran a FULL parseComponentFile — page-variables parse + parseJSXToNodes — ~14× per render (the trace's
// `page-variables:parse ×84`). Same code → one parse, the rest hit the cache. Keyed by content hash so any real
// edit re-parses; single slot per path (the active file is the only one hit in a tight loop).
const sourceInfoCache = new Map<string, { hash: string; info: ComponentInfo | null }>();

export function parseComponentInfoFromSource(
  pseudoFilePath: string,
  code: string,
  hash: string,
): ComponentInfo | null {
  const contentHash = simpleHash(code);
  const cached = sourceInfoCache.get(pseudoFilePath);
  if (cached && cached.hash === contentHash) return cached.info;
  const info = parseComponentFile(pseudoFilePath, code, hash);
  sourceInfoCache.set(pseudoFilePath, { hash: contentHash, info });
  return info;
}

/**
 * Read the master's ROOT node width/height from its inline `style` — i.e. the
 * dimensions of the PRIMARY variant (primary = the base inline style; variants
 * store only deltas, so the root's authored width/height ARE the primary's).
 *
 * Used to seed a freshly-dropped component instance so it matches the master's
 * authored size (e.g. FAQItem → `width: '760px', height: 'auto'`) instead of a
 * generic placeholder box. The root is the FIRST JSX element carrying a
 * `data-id` (transparent wrappers — LayoutGroup / MotionConfig — have none).
 *
 * Plain string dims are read directly. A variant-size ternary
 * (`width: variant === 'mobile' ? '390px' : … : '1280px'`) is RESOLVED for the
 * primary variant: we match a `variant === '<primary>'` branch, and otherwise
 * fall through to the final non-ternary fallback — which is where the default/
 * primary value sits (the generator only lists NON-primary variants as ternary
 * conditions). Non-string results (e.g. a computed value) are left unset.
 */
export function getComponentRootSize(code: string): { width?: string; height?: string } {
  const ast = parseJSX(code);
  if (!ast) return {};
  const cfg = parseVariantConfig(code);
  const primary = cfg.find((v) => v.isPrimary)?.name ?? cfg[0]?.name ?? 'default';
  const out: { width?: string; height?: string } = {};
  let done = false;
  traverse(ast, {
    JSXElement(path: { node: t.JSXElement; stop: () => void }) {
      if (done) return;
      const opening = path.node.openingElement;
      const hasDataId = opening.attributes.some(
        (a) => t.isJSXAttribute(a) && t.isJSXIdentifier(a.name, { name: 'data-id' }),
      );
      if (!hasDataId) return;
      done = true;
      path.stop();
      const styleAttr = opening.attributes.find(
        (a): a is t.JSXAttribute => t.isJSXAttribute(a) && t.isJSXIdentifier(a.name, { name: 'style' }),
      );
      const val = styleAttr?.value;
      if (!val || !t.isJSXExpressionContainer(val) || !t.isObjectExpression(val.expression)) return;
      for (const prop of val.expression.properties) {
        if (!t.isObjectProperty(prop) || prop.computed) continue;
        const key = t.isIdentifier(prop.key) ? prop.key.name
          : t.isStringLiteral(prop.key) ? prop.key.value : null;
        if (key !== 'width' && key !== 'height') continue;
        const resolved = resolveStyleValueForVariant(prop.value, primary);
        if (resolved !== undefined) out[key] = resolved;
      }
    },
  });
  return out;
}

/** Fallback insert size when a code component declares no `@defaultWidth`/
 *  `@defaultHeight` and its root carries no plain px dims. */
export const CODE_COMPONENT_FALLBACK_SIZE = { width: 200, height: 200 };

/**
 * The size a CODE COMPONENT instance is inserted at on the canvas.
 * Code components are FIXED-size (never `auto` — the wrapper must always
 * carry a concrete size because the bundle's internals are a black box):
 *   1. `@defaultWidth` / `@defaultHeight` annotations (per axis)
 *   2. the master root's authored px dims
 *   3. the shared 200×200 fallback
 */
export function getCodeComponentInsertSize(code: string): { width: string; height: string } {
  const declared = parseCodeComponentDefaultSize(code);
  const root = getComponentRootSize(code);
  const rootPx = (v?: string) => (v && /^\d+(?:\.\d+)?px$/.test(v.trim()) ? v.trim() : null);
  const size = {
    width: declared.width != null ? `${declared.width}px`
      : rootPx(root.width) ?? `${CODE_COMPONENT_FALLBACK_SIZE.width}px`,
    height: declared.height != null ? `${declared.height}px`
      : rootPx(root.height) ?? `${CODE_COMPONENT_FALLBACK_SIZE.height}px`,
  };
  trace.fn('component-registry:code-insert-size', { declared, size });
  return size;
}

/** Resolve a style-value AST node to a string for `variantName`. A plain
 *  StringLiteral returns directly; a ternary chain keyed on `variant === '…'`
 *  is walked (matching branch → its value, else the final non-ternary
 *  fallback). Returns undefined for anything non-string. */
function resolveStyleValueForVariant(node: t.Node, variantName: string): string | undefined {
  let cur: t.Node = node;
  while (t.isConditionalExpression(cur)) {
    const name = variantEqName(cur.test);
    if (name !== null && name === variantName) {
      return t.isStringLiteral(cur.consequent) ? cur.consequent.value : undefined;
    }
    cur = cur.alternate;
  }
  return t.isStringLiteral(cur) ? cur.value : undefined;
}

/** Extract `X` from a `variant === 'X'` / `'X' === variant` BinaryExpression. */
function variantEqName(test: t.Expression): string | null {
  if (!t.isBinaryExpression(test) || test.operator !== '===') return null;
  const { left, right } = test;
  if (t.isIdentifier(left, { name: 'variant' }) && t.isStringLiteral(right)) return right.value;
  if (t.isIdentifier(right, { name: 'variant' }) && t.isStringLiteral(left)) return left.value;
  return null;
}

/**
 * Extract component info from a .tsx file.
 * Looks for: export default function ComponentName({ prop1 = 'default', prop2 }: Props)
 * Also handles: const ComponentName = (...) => { ... }; export default ComponentName;
 */
function parseComponentFile(filePath: string, code: string, hash: string): ComponentInfo | null {
  // Extract component name from file path as fallback
  const fileBaseName = filePath.split('/').pop()?.replace(/\.tsx$/, '') ?? '';

  // Parse @controls metadata for code component files (null for regular components)
  const controlsMeta = parseComponentControlsMeta(code);

  // Extract component name + props from function signature.
  // Uses extractDestructuredProps for reliable brace-aware parsing
  // instead of regex (which breaks when } is inside the capture group).
  const hasDefaultExport = code.includes('export default');

  // Try: export default function Name({ ... })  — name is on the export line.
  const funcMatch = code.match(/export\s+default\s+function\s+(\w+)\s*\(/);
  if (funcMatch) {
    const name = funcMatch[1];
    const paramsStart = code.indexOf('(', code.indexOf(funcMatch[0])) + 1;
    const props = extractDestructuredProps(code, paramsStart);
    return { name, filePath, props, contentHash: hash, controlsMeta };
  }

  // Find the EXPORTED name first, then locate THAT function. Don't blindly
  // grab the first `function ...` declaration — Code component templates often have
  // helper functions earlier in the file (e.g. `function hexToVec3Wave(...)`)
  // and we'd pick the wrong name. The exported identifier disambiguates.
  //
  // Patterns we accept:
  //   export default Name;
  //   export default withResponsiveProps(Name);
  //   export default someHOC(Name);   // any single-arg HOC
  //   export default Name as default;
  const exportNameMatch =
    code.match(/export\s+default\s+\w+\s*\(\s*(\w+)\s*\)/) ??   // HOC-wrapped
    code.match(/export\s+default\s+(\w+)\s*;?\s*$/m);            // bare identifier
  const exportedName = exportNameMatch?.[1];

  if (exportedName) {
    // Locate the named function declaration matching the exported name.
    const fnRegex = new RegExp(`function\\s+${exportedName}\\s*\\(`);
    const fnMatch = code.match(fnRegex);
    if (fnMatch) {
      const paramsStart = code.indexOf('(', code.indexOf(fnMatch[0])) + 1;
      const props = extractDestructuredProps(code, paramsStart);
      return { name: exportedName, filePath, props, contentHash: hash, controlsMeta };
    }
    // Or an arrow form: `const Name = (...) => ...`
    const arrowRegex = new RegExp(`(?:const|let)\\s+${exportedName}\\s*=\\s*\\(`);
    const arrowMatchTyped = code.match(arrowRegex);
    if (arrowMatchTyped) {
      const paramsStart = code.indexOf('(', code.indexOf(arrowMatchTyped[0])) + 1;
      const props = extractDestructuredProps(code, paramsStart);
      return { name: exportedName, filePath, props, contentHash: hash, controlsMeta };
    }
    // Couldn't locate a function body matching the exported name — only accept
    // the bare exported identifier if it's PascalCase (React component
    // convention). Otherwise (e.g. `export default jsx;` where `jsx` is a
    // local JSX element binding) fall through to the file-name fallback.
    if (/^[A-Z]/.test(exportedName)) {
      return { name: exportedName, filePath, props: [], contentHash: hash, controlsMeta };
    }
  }

  // No identifiable export name — fall back to first function/arrow.
  // Kept for backwards compat with files that don't follow the patterns above;
  // not ideal but won't crash.
  const namedFuncMatch = code.match(/function\s+(\w+)\s*\(/);
  if (namedFuncMatch && hasDefaultExport) {
    const name = namedFuncMatch[1];
    const paramsStart = code.indexOf('(', code.indexOf(namedFuncMatch[0])) + 1;
    const props = extractDestructuredProps(code, paramsStart);
    return { name, filePath, props, contentHash: hash, controlsMeta };
  }

  const arrowMatch = code.match(/(?:const|let)\s+(\w+)\s*=\s*\(/);
  if (arrowMatch && hasDefaultExport) {
    const name = arrowMatch[1];
    const paramsStart = code.indexOf('(', code.indexOf(arrowMatch[0])) + 1;
    const props = extractDestructuredProps(code, paramsStart);
    return { name, filePath, props, contentHash: hash, controlsMeta };
  }

  // Fallback: use file name, no props
  if (hasDefaultExport) {
    return { name: fileBaseName, filePath, props: [], contentHash: hash, controlsMeta };
  }

  return null;
}

/**
 * Extract destructured props from a function parameter starting at position (after the opening `(`).
 * Finds the `{ ... }` block inside the params, then parses the props from it.
 * Handles: ({ prop1 = 'val', prop2 }) and ({ prop1 = 'val' }: TypeAnnotation)
 */
function extractDestructuredProps(code: string, startPos: number): ComponentProp[] {
  // Find opening { inside the params
  const braceStart = code.indexOf('{', startPos);
  const parenEnd = code.indexOf(')', startPos);
  if (braceStart === -1 || (parenEnd !== -1 && braceStart > parenEnd)) {
    // No destructured params
    return [];
  }

  // Find matching closing } (brace-aware)
  let depth = 1;
  let i = braceStart + 1;
  while (i < code.length && depth > 0) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') depth--;
    i++;
  }

  const propsStr = code.slice(braceStart + 1, i - 1);
  const props = parseProps(propsStr);
  // Attach authoring type + description from the `@propMeta` block (prop-meta.ts).
  const meta = parsePropMeta(code);
  if (Object.keys(meta).length > 0) {
    for (const p of props) {
      const m = meta[p.name];
      if (m?.description) p.description = m.description;
      if (m?.type) p.varType = m.type;
      if (m?.label) p.label = m.label;
    }
  }
  // Fall back to the `@pageVariables` type for any prop @propMeta didn't type. A variable hoisted from a
  // code-component control records its type ('number', …) in @pageVariables but not always in @propMeta —
  // without this the prop is `varType: undefined` → classified 'generic' → invisible to other same-type
  // controls' "Set Variable" menus (a Number var created on a code control wouldn't appear on Opacity).
  const pageVars = getPageVariables(code);
  if (pageVars.length > 0) {
    const byName = new Map(pageVars.map(v => [v.name, v.type]));
    for (const p of props) {
      if (!p.varType && byName.get(p.name)) p.varType = byName.get(p.name);
    }
  }
  return props;
}

/** Parse destructured props string: "title = 'Hello', bgColor, padding = '60px'"
 *
 *  Handles defaults that contain the OTHER quote style — e.g.
 *  `bgImage = "url('https://...')"` (double-quoted string with a single
 *  quote inside). The previous regex `[^'"]*` rejected any inner quote and
 *  silently dropped the whole prop, which made ComponentPropsTool render
 *  empty for any component with a string-default-with-embedded-quote.
 */
function parseProps(paramsStr: string): ComponentProp[] {
  if (!paramsStr.trim()) return [];

  const props: ComponentProp[] = [];
  // Split by comma, handle quoted strings containing commas
  const parts = splitProps(paramsStr);

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    // Bare name (no default): `propName` or `propName?`
    if (/^\w+\??$/.test(trimmed)) {
      props.push({ name: trimmed.replace(/\?$/, ''), defaultValue: null });
      continue;
    }

    // Find the `=` that separates `name` from `value`. Anything before it (up
    // to whitespace) is the name; anything after is the default expression.
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const name = trimmed.slice(0, eqIdx).trim().replace(/\?$/, '');
    if (!/^\w+$/.test(name)) continue;
    const valueStr = trimmed.slice(eqIdx + 1).trim();

    // String literal in any of the three quote styles. Slice off the
    // matching outer quote char; preserve everything between, including the
    // OTHER quote style (the bug we're fixing).
    let defaultValue: string | null = null;
    if (valueStr.length >= 2) {
      const open = valueStr[0];
      const close = valueStr[valueStr.length - 1];
      if ((open === '"' || open === "'" || open === '`') && open === close) {
        defaultValue = valueStr.slice(1, -1);
      }
    }
    // Numeric / boolean literal defaults (`fontSize = 16`, `wrap = true`) — captured as their string
    // form so the Variable modal seeds the right default (Number variables store raw numbers, so without
    // this their Default field showed empty). Identifiers / objects / functions still get null.
    if (defaultValue === null) {
      if (/^-?\d+(\.\d+)?$/.test(valueStr)) defaultValue = valueStr;
      else if (valueStr === 'true' || valueStr === 'false') defaultValue = valueStr;
    }
    // Non-literal defaults (identifiers, object expressions like `{...}`, function
    // calls) get null — we don't try to evaluate them. ComponentPropsTool falls
    // back to whatever the runtime resolves.

    props.push({ name, defaultValue });
  }

  // `ref` is a reserved React prop (Scroll Variant's layerInView injects it onto the
  // component to forward a real DOM ref) — never a user-editable component prop, so it
  // must not surface in the Component Props tool.
  return props.filter((p) => p.name !== 'ref');
}

/** Split props by comma, respecting nested braces/quotes */
function splitProps(str: string): string[] {
  const result: string[] = [];
  let current = '';
  let depth = 0;
  let inString = false;
  let stringChar = '';

  for (const ch of str) {
    if (inString) {
      current += ch;
      if (ch === stringChar) inString = false;
      continue;
    }
    if (ch === "'" || ch === '"') {
      inString = true;
      stringChar = ch;
      current += ch;
      continue;
    }
    if (ch === '{' || ch === '(' || ch === '[') { depth++; current += ch; continue; }
    if (ch === '}' || ch === ')' || ch === ']') { depth--; current += ch; continue; }
    if (ch === ',' && depth === 0) {
      result.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) result.push(current);
  return result;
}

