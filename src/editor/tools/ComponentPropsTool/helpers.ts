// ComponentPropsTool/helpers.ts — prop-detection + formatting helpers lifted
// verbatim from ComponentPropsTool.tsx (Phase 7 god-file split, item 7.5).

import { projectFS } from '@/code/project/project-fs';
import { buildComponentRegistry } from '@/code/components/component-registry';
import { resolveVariableCssProp, type ResolveChildCode } from '@/code/components/prop-css-mapping';
import { extractImports, resolveImportPath } from '@/code/components/import-resolver';
import type { ComponentControlDef } from '@/code/components/controls-parser';
import type { PageVariableType } from '@/code/features/page-variables';
import { parseJSXToNodes } from '@/code/parsing/parser';
import { getScrollVariant } from '@/code/generation/scroll-variant-gen';

// ─── Prop→CSS Mapping ───────────────────────────────────────────────────────

/**
 * Detect which CSS property a component prop maps to by scanning the
 * component code. Two paths:
 *
 *   1. **Direct CSS use** — the prop is referenced as a value in a style
 *      object: `backgroundColor: poon`. The regex captures the CSS key.
 *
 *   2. **Forwarded to a child component** — the prop is passed down as
 *      another component's prop: `<RoHuVu poon={poon2} />`. We resolve the
 *      child tag to its file via the parent's imports, read the child
 *      file, and recursively detect what CSS property the CHILD's
 *      corresponding prop maps to. This is the hoisted-variable case:
 *      after hoisting `poon` from `RoHuVu` up into `UxTaPa` as `poon2`,
 *      the parent file has no direct CSS use of `poon2`, only a
 *      `<RoHuVu poon={poon2} />` forward. Without the recursion, the
 *      page-level instance editor for `<UxTaPa>` falls back to a plain
 *      text input for `poon2` instead of the color picker.
 *
 * `currentFilePath` + `projectFS` are needed for path resolution. When
 * either is missing (test fixtures, etc.) we just do step 1. `visited`
 * is the cycle guard for mutual-recursion edge cases (A imports B
 * imports A). Depth-limited internally to a sensible value so a
 * pathological component graph can't spin.
 */
/**
 * Convert a transition value to the JSON string TransitionVariableEditor reads. Handles BOTH the deploy-form
 * OBJECT LITERAL (`{ type: 'spring', duration: 0.5 }`, unquoted numeric keys — what the instance stores) AND an
 * already-JSON string (the live-preview form). Returns '' for an empty/`{}` value → the editor shows "Default".
 */
export function transitionLiteralToJSON(v: string): string {
  const t = (v ?? '').trim();
  if (!t || t === '{}') return '';
  let result: Record<string, string> = {};
  try {
    const parsed = JSON.parse(t);
    if (parsed && typeof parsed === 'object') result = parsed;
  } catch {
    const re = /(\w+)\s*:\s*(?:'([^']*)'|"([^"]*)"|(-?\d+(?:\.\d+)?))/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(t)) !== null) result[m[1]] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  if (!Object.keys(result).length) return '';
  // duration 0 (not a spring) = INSTANT — the write stored type:'instant' AS `{ duration: 0 }` (framer-motion
  // has no type:'instant'), so surface it back as instant for the editor's segmented control + summary.
  if (result.duration != null && Number(result.duration) === 0 && result.type !== 'spring') {
    return JSON.stringify({ type: 'instant' });
  }
  return JSON.stringify(result);
}

export function detectPropCSSMapping(
  props: { name: string }[],
  componentCode: string,
  currentFilePath?: string,
  visited: Set<string> = new Set(),
): Map<string, string> {
  const result = new Map<string, string>();
  // Per-prop resolution (local shapes + forwarded-into-child recursion) is now the SHARED
  // `resolveVariableCssProp` — the exact same resolver the VariableModal and Template tool use.
  // We only inject the host-specific child-file reader; the depth bound lives inside the resolver.
  const resolveChildCode: ResolveChildCode | undefined = currentFilePath
    ? (childTag, parentCode, parentFilePath) => {
        const childFile = resolveChildComponentFile(childTag, parentCode, parentFilePath);
        const childCode = childFile ? projectFS.readFile(childFile) : null;
        return (childFile && childCode) ? { code: childCode, filePath: childFile } : null;
      }
    : undefined;
  for (const prop of props) {
    const cssProp = resolveVariableCssProp(prop.name, componentCode, currentFilePath, resolveChildCode);
    if (cssProp) result.set(prop.name, cssProp);
  }
  return result;
}

/**
 * Detect whether a parent component prop is consumed as a component-cursor.
 * Two shapes count as a positive match:
 *
 *   1. **Direct** — `{...withCursor(propName, ...)}` somewhere in the parent
 *      master file. The cursor sits on an element OF the master itself.
 *
 *   2. **Forwarded** — `<ChildTag ... cprop={propName} ... />` where the
 *      child's `cprop` is itself a component-cursor (recursive). This
 *      mirrors `detectPropCSSMapping`'s forward branch and is the multi-
 *      level hoist case — an outer master can pass its `outerCursor` into
 *      an inner master's `innerCursor` slot.
 *
 * Returns true when the prop unambiguously drives a `withCursor(...)` call
 * somewhere down the chain. Used by the page-level instance editor to
 * render a component picker for the prop instead of a plain text input.
 *
 * `visited` is a per-prop cycle guard cloned at each branch — same
 * pattern (and same rationale) as `detectPropCSSMapping`.
 */
export function detectPropAsComponentCursor(
  propName: string,
  parentCode: string,
  parentFilePath: string,
  visited: Set<string> = new Set(),
): boolean {
  if (visited.size > 8) return false;
  // Path 1: direct withCursor call referencing the prop as its first arg.
  // `[^,)]` so we don't accidentally match a longer identifier like
  // `${propName}Foo` or a string literal containing the name.
  const directRegex = new RegExp(`\\bwithCursor\\(\\s*${propName}\\s*[,)]`);
  if (directRegex.test(parentCode)) return true;

  // Path 2: forwarded to a child component instance. Same tag-bound regex
  // shape as the CSS-mapping detector — `[^<>]*?` so we don't leak across
  // sibling tags.
  const forwardRegex = new RegExp(`<(\\w+)([^<>]*?)\\s(\\w+)=\\{${propName}\\}`, 'g');
  let match: RegExpExecArray | null;
  while ((match = forwardRegex.exec(parentCode)) !== null) {
    const childTag = match[1];
    const childPropName = match[3];
    if (!/^[A-Z]/.test(childTag) || childTag.startsWith('motion.')) continue;
    const childFile = resolveChildComponentFile(childTag, parentCode, parentFilePath);
    if (!childFile) continue;
    const branchVisited = new Set(visited);
    branchVisited.add(parentFilePath);
    if (branchVisited.has(childFile)) continue;
    const childCode = projectFS.readFile(childFile);
    if (!childCode) continue;
    if (detectPropAsComponentCursor(childPropName, childCode, childFile, branchVisited)) {
      return true;
    }
  }
  return false;
}

/** Resolve a child component tag name to its file path, using the parent's import map. */
export function resolveChildComponentFile(
  tagName: string,
  parentCode: string,
  parentFilePath: string,
): string | null {
  const imports = extractImports(parentCode);
  const source = imports.get(tagName);
  if (!source) return null;
  return resolveImportPath(source, parentFilePath);
}

/**
 * Detect when a parent component prop is forwarded to a child instance's
 * `initialVariant`. Used by the page-level instance editor to render a
 * variant-select dropdown instead of a plain text input for hoisted
 * variant variables.
 *
 * For a prop hoisted via the variant chevron menu, the parent file gets
 * `<NestedChild initialVariant={propName} ... />`. We scan for that
 * shape, resolve the child tag to its file via the parent's imports, and
 * read the child's `variantConfig` so the caller can render the right
 * options list (`{ value, label }` per variant).
 *
 * Returns the child's resolved file path so the caller can fetch its
 * variantConfig via `parseVariantConfig`. Null when no such forward
 * exists (the prop drives something else, or this isn't a variant hoist).
 */
export function detectPropAsVariantBinding(
  propName: string,
  parentCode: string,
  parentFilePath: string,
  depth = 0,
): string | null {
  if (depth > 6) return null; // forwarding-chain guard
  // AST-based (NOT regex): a `[^<>]` tag scan BREAKS on a `>` inside an attr expression — e.g. an
  // arrow handler `event1={() => setOpen(true)}` on a <Header> — so a later attr (`baPoWeVariant={var}`)
  // is never seen and the variant var falls back to a text box. parseJSXToNodes resolves the binding cleanly.
  let nodes: ReturnType<typeof parseJSXToNodes>;
  try { nodes = parseJSXToNodes(parentCode); } catch { return null; }
  for (const [id, node] of nodes) {
    if (!/^[A-Z]/.test(node.type) || node.type.startsWith('motion.')) continue;
    // DIRECT: propName drives THIS instance's variant — a plain attrPropRef, a per-PARENT-VARIANT conditional
    // var branch, a per-VIEWPORT __mq variable, OR a scroll-variant resting `fromVar`.
    let direct = node.attrPropRefs?.['initialVariant'] === propName;
    if (!direct && node.attrConditionalVarRefs?.['initialVariant']
        && Object.values(node.attrConditionalVarRefs['initialVariant']).includes(propName)) direct = true;
    if (!direct && node.responsiveAttrPropVariables?.['initialVariant']
        && Object.values(node.responsiveAttrPropVariables['initialVariant']).includes(propName)) direct = true;
    if (!direct) {
      const sv = getScrollVariant(parentCode, id);
      if (sv && (sv.fromVar === propName || (sv.responsive ?? []).some((r) => r.fromVar === propName))) direct = true;
    }
    if (direct) {
      const childFile = resolveChildComponentFile(node.type, parentCode, parentFilePath);
      if (childFile) return childFile;
    }
    // FORWARDED: propName is passed into some OTHER prop of this node → recurse into the child with that prop
    // name (the var drives a variant DEEPER, through this intermediate master — TEMPLATE → Header via
    // `baPoWeVariant` → inside Header → Logo Mark's `initialVariant`).
    const fwd = node.attrPropRefs
      ? Object.keys(node.attrPropRefs).find((k) => node.attrPropRefs![k] === propName && k !== 'initialVariant')
      : undefined;
    if (fwd) {
      const childFile = resolveChildComponentFile(node.type, parentCode, parentFilePath);
      const childCode = childFile ? projectFS.readFile(childFile) : null;
      if (childFile && childCode) {
        const deeper = detectPropAsVariantBinding(fwd, childCode, childFile, depth + 1);
        if (deeper) return deeper;
      }
    }
  }
  return null;
}

/**
 * Detect when an instance-prop value is a PRESET reference, so the row can
 * render the blue preset pill (same as the Styles tool) instead of the raw
 * editor. Handles the single-token form `var(--token)` and the composed
 * border shorthand `var(--border-X-width) …` (from `buildPresetSubmenuItems`).
 * Returns the token / border-group name, or null.
 */
export function detectPresetRefValue(value: string | undefined): string | null {
  if (!value) return null;
  const v = value.trim();
  const single = v.match(/^var\(\s*--([^)\s,]+)\s*\)$/);
  if (single) return single[1];
  const border = v.match(/^var\(\s*--border-([a-z0-9-]+)-width\s*\)/);
  if (border) return `border-${border[1]}`;
  return null;
}

/** Display label for a preset ref: the token's own `label`, else the name
 *  with its category prefix stripped and title-cased ("radius-md" → "Md",
 *  "space-section-y" → "Section Y"). */
export function formatPresetRefLabel(name: string, tokens: { name: string; label?: string }[]): string {
  const token = tokens.find(t => t.name === name);
  if (token?.label) return token.label;
  let display = name;
  for (const prefix of ['color-', 'typo-', 'space-', 'spacing-', 'margin-', 'radius-', 'shadow-', 'border-']) {
    if (display.startsWith(prefix)) { display = display.slice(prefix.length); break; }
  }
  return display.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/**
 * Map a Code component `@control` type to the page-variable type a hoist should
 * create. Returns null for control types that don't have a clean single-
 * value variable form (`slot` is canvas-node wiring, `group` nests other
 * controls, `transition` is a framer-motion object) — those rows don't
 * offer "Hoist Variable".
 */
export function codeComponentControlVariableType(type: string): PageVariableType | null {
  switch (type) {
    case 'slider':
    case 'number':
      return 'number';
    case 'color':
      return 'color';
    case 'toggle':
      return 'boolean';
    case 'upload':
      return 'image';
    case 'text':
    case 'select':
    case 'font':
      return 'text';
    default:
      return null; // slot / group / transition / imageList — not a simple hoistable value
  }
}

/**
 * Detect when a parent component prop is forwarded into a Code component (code
 * component) control: `<CodeComponentTag ... someControl={propName} ... />`. Resolves
 * the code component tag to its file, reads its `@controls` metadata, and returns the
 * control definition for the forwarded prop — so the page-instance editor can
 * render the code component's real control (color picker / slider) instead of a text
 * input. Null when the prop isn't forwarded into a code component control.
 *
 * Mirrors `detectPropAsVariantBinding` / `detectPropAsComponentCursor`'s
 * tag-bound `[^<>]*?` regex so it doesn't leak across sibling tags.
 */
export function detectPropAsCodeComponentControl(
  propName: string,
  parentCode: string,
  parentFilePath: string,
  depth = 0,
): ComponentControlDef | null {
  if (depth > 6) return null; // forwarding-chain guard
  const regex = new RegExp(`<(\\w+)([^<>]*?)\\s(\\w+)=\\{${propName}\\}`, 'g');
  let match: RegExpExecArray | null;
  while ((match = regex.exec(parentCode)) !== null) {
    const childTag = match[1];
    const childControlName = match[3];
    if (!/^[A-Z]/.test(childTag) || childTag.startsWith('motion.')) continue;
    const childFile = resolveChildComponentFile(childTag, parentCode, parentFilePath);
    if (!childFile) continue;
    const childInfo = registryEntryForFile(childFile);
    // Direct code component control on this child.
    const def = childInfo?.controlsMeta?.controls?.[childControlName];
    if (def) return def;
    // HOISTED: the child is an intermediate component MASTER (no @controls of
    // its own) that forwards `childControlName` deeper — `<ChildMaster
    // colorprop={prop}/>` → inside ChildMaster `<Code component colorControl={colorprop}/>`.
    // Recurse into the child's code with the forwarded prop name so a hoisted
    // code-component-control variable still resolves to the real control (color picker /
    // slider) at the grandparent, not a bare text input.
    const childCode = projectFS.readFile(childFile);
    if (childCode) {
      const deeper = detectPropAsCodeComponentControl(childControlName, childCode, childFile, depth + 1);
      if (deeper) return deeper;
    }
  }
  return null;
}

/**
 * Detect a navigation-attribute variable (created via the Link tool's
 * "Create Variable"): the prop drives `href`, `target`, or
 * `data-smooth-scroll` on an `<a>`/`<Link>` in the master. Returns the kind
 * so the page-instance editor renders a link input / Yes-No toggle instead
 * of a raw text field. The boolean kinds match the ternary shape written by
 * `createLinkAttrVariableInCode` (`{prop ? '…' : undefined}`).
 */
export function detectPropAsLinkAttr(propName: string, parentCode: string): 'href' | 'newTab' | 'smooth' | 'tracking' | 'rel' | 'params' | null {
  // `href={propName}` (string)
  if (new RegExp(`\\shref=\\{${propName}\\}`).test(parentCode)) return 'href';
  // `target={propName ? '_blank' : undefined}`
  if (new RegExp(`\\starget=\\{${propName}\\s*\\?`).test(parentCode)) return 'newTab';
  // `data-smooth-scroll={propName ? 'true' : undefined}`
  if (new RegExp(`\\sdata-smooth-scroll=\\{${propName}\\s*\\?`).test(parentCode)) return 'smooth';
  // `data-keep-params={propName ? 'true' : undefined}` (Keep/Ignore boolean)
  if (new RegExp(`\\sdata-keep-params=\\{${propName}\\s*\\?`).test(parentCode)) return 'params';
  // `rel={propName}` (space-separated token list)
  if (new RegExp(`\\srel=\\{${propName}\\}`).test(parentCode)) return 'rel';
  // `data-revyme-track={propName}` (A/B tracking id — a plain string)
  if (new RegExp(`\\sdata-revyme-track=\\{${propName}\\}`).test(parentCode)) return 'tracking';
  return null;
}

/** Look up a registry entry by file path. Built lazily and cached per render
 *  cycle via React's memo — see the callsite. */
function registryEntryForFile(filePath: string) {
  const registry = buildComponentRegistry(projectFS);
  for (const info of registry.values()) {
    if (info.filePath === filePath) return info;
  }
  return null;
}

/**
 * Humanize a CSS property name (or our synthetic `initialVariant`) for
 * display as the row's sub-label. `backgroundColor` → `Background`,
 * `borderTopLeftRadius` → `Border Top Left Radius`, `initialVariant`
 * → `Variant`, etc. Falls back to the original string when the input
 * isn't recognised. Returns null for empty / falsy input so the caller
 * can conditionally render the two-line label.
 */
export function humanizeStylePropName(prop: string | undefined | null): string | null {
  if (!prop) return null;
  // Synthetic / custom mappings the camelCase pass would mangle.
  const FRIENDLY: Record<string, string> = {
    backgroundColor: 'Background',
    backgroundImage: 'Background',
    borderColor: 'Border',
    border: 'Border',
    boxShadow: 'Shadow',
    initialVariant: 'Variant',
    flexDirection: 'Direction',
    flexWrap: 'Wrap',
    alignItems: 'Align',
    justifyContent: 'Justify',
    transform: 'Transform',
    transition: 'Transition',
    overflow: 'Overflow',
    opacity: 'Opacity',
    padding: 'Padding',
    margin: 'Margin',
    gap: 'Gap',
    color: 'Text Color',
  };
  if (FRIENDLY[prop]) return FRIENDLY[prop];
  // Generic camelCase → "Words With Spaces"
  return prop
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, c => c.toUpperCase())
    .trim();
}

/** CMS field types a component prop of a given `varType` may bind to (Mechanism A —
 *  instance inside a collection list). Untyped props may bind to any field. */
export const cmsFieldTypesForVarType = (varType?: string): Set<string> => {
  switch (varType) {
    case 'image': return new Set(['image', 'file']);
    case 'link': case 'url': return new Set(['link', 'url', 'text', 'slug']);
    case 'number': return new Set(['number']);
    case 'toggle': case 'boolean': return new Set(['boolean']);
    case 'color': return new Set(['color']);
    case 'date': return new Set(['date']);
    case 'option': case 'enum': return new Set(['enum', 'text']);
    case 'text': case 'plainText': case 'string': return new Set(['text', 'textarea', 'richtext', 'slug']);
    // Untyped / generic prop → offer every field so the user can still connect.
    default: return new Set(['text', 'textarea', 'richtext', 'number', 'image', 'file', 'link', 'url', 'slug', 'color', 'boolean', 'date', 'enum']);
  }
};
