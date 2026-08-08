// component-ops.ts — Create, detach, and manage components.
//
// "Make Component" (Ctrl+Alt+K):
//   1. Extract selected node subtree from current page code
//   2. Create components/Name.tsx with the extracted JSX
//   3. Replace the subtree in the page with <Name />
//   4. Add import statement to the page
//
// Uses Babel AST for reliable JSX extraction (no regex on JSX).

import { projectFS } from '../project/project-fs';
import { generateSyllableName } from '@/code/project/name-gen';
import { syncQueueCode, flushNow, queueMutation, syncImports } from '../mutation/mutation-queue';
import { parseJSX, findFirstElementByDataId, findAttribute, traverse } from '../parsing/ast-utils';
import { clearComponentCache } from './component-registry';
import { WRAPPER_ONLY_STYLE_PROPS, CONDITIONAL_LAYOUT_PROPS } from '@/shared/constants';
import { cssTransformToMotionProps } from '@/shared/motion-transform';
import { toCamel } from '@/shared/css-utils';
import { updateVariantStyleInCode, setConditionalStyleInCode, syncLinkHandlerInCode, clearContainerStylesForNode, updateContainerQueryStyle } from '../generation/generator-styles';
import { parseContainerRules } from '../stores/container-query-store';
import { extractStyleCSS } from '../parsing/parser';
import { rehydrateInstanceFx, setInstanceFxInCode } from '../generation/instance-fx-gen';
import { ensureResponsiveTextHook } from '../generation/text-override-gen';
import { rehydrateScrollVariant, setScrollVariantInCode } from '../generation/scroll-variant-gen';
import { healMissingFormStateDeclarations } from '../generation/form-state-gen';
import { collectTransferableVariables, applyVariableTransfer, buildInstanceVariableAttrs } from './component-variable-transfer';
import { hoistMapBindingsToProps, createLinkAttrVariableInCode } from '../features/variable-ops';
import { addPageVariableInCode } from '../features/page-variables';
import { transferRootOverlayToInstanceInCode, transferDescendantOverlaysToMasterInCode } from '../generation/overlay-gen';
import { generate, findTagClose } from '../generation/generator-utils';
import { convertToMotionLinkInCode } from '../generation/generator-attrs';
import { getEnclosingMapParamsForNode } from '../generation/map-gen';
import * as t from '@babel/types';
import { trace } from '@/shared/debug-trace';
import { setPropTypeInCode } from './prop-meta';
import { getCollectionData, getCollectionSchema } from '../project/cms-ops';

/** Strip a CSS `url('…')`/`url(…)` wrapper → bare URL. Local copy on purpose —
 *  the editor runtime stubs `cms-ops`, so importing a helper from it crashes
 *  ("does not provide an export named …"). */
function stripUrlWrapper(value: string): string {
  const m = value.trim().match(/^url\(\s*(['"]?)([\s\S]*?)\1\s*\)$/i);
  return m ? m[2] : value;
}

/** CMS field type → component-variable @propMeta type, so a hoisted collection field
 *  carries the right data type (image → real Fill image var, text → Plain Text, etc.). */
const CMS_FIELD_TO_PROP_TYPE: Record<string, string> = {
  text: 'plainText', textarea: 'formattedText', number: 'number', boolean: 'toggle',
  date: 'date', image: 'image', file: 'file', url: 'link', link: 'link',
  color: 'color', enum: 'option', tags: 'plainText', slug: 'plainText',
  reference: 'plainText', 'multi-reference': 'plainText',
};

/** `item.field` / `item?.field` / `item['field']` → 'field' (else null). */
function navMemberField(node: t.Node, itemVar: string): string | null {
  if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
    if (t.isIdentifier(node.object) && node.object.name === itemVar) {
      if (!node.computed && t.isIdentifier(node.property)) return node.property.name;
      if (node.computed && t.isStringLiteral(node.property)) return node.property.value;
    }
  }
  return null;
}

/** Does this expression read anything off the `.map()` iterator (`item.x`, `item`)? */
function exprReferencesItem(node: t.Node | null | undefined, itemVar: string): boolean {
  let found = false;
  const visit = (n: t.Node | null | undefined): void => {
    if (!n || found) return;
    if (navMemberField(n, itemVar) != null) { found = true; return; }
    if (t.isIdentifier(n) && n.name === itemVar) { found = true; return; }
    if (t.isTemplateLiteral(n)) n.expressions.forEach((e) => visit(e as t.Node));
    else if (t.isLogicalExpression(n) || t.isBinaryExpression(n)) { visit(n.left as t.Node); visit(n.right); }
    else if (t.isConditionalExpression(n)) { visit(n.test); visit(n.consequent); visit(n.alternate); }
    else if (t.isMemberExpression(n) || t.isOptionalMemberExpression(n)) { visit(n.object); }
    else if (t.isCallExpression(n) || t.isOptionalCallExpression(n)) { visit(n.callee as t.Node); n.arguments.forEach((a) => visit(a as t.Node)); }
  };
  visit(node);
  return found;
}

/** Resolve a nav-href expression against the collection's FIRST item so the master's
 *  link variable has a concrete default (`/advisors/${item._slug}` → `/advisors/sarah`).
 *  Exported for unit tests. */
function resolveExprDefault(node: t.Node, itemVar: string, first: Record<string, any> | undefined): string {
  if (t.isStringLiteral(node)) return node.value;
  if (t.isTemplateLiteral(node)) {
    let out = '';
    node.quasis.forEach((q, i) => {
      out += q.value.cooked ?? q.value.raw;
      const e = node.expressions[i];
      if (e) out += resolveExprDefault(e as t.Node, itemVar, first);
    });
    return out;
  }
  if (t.isLogicalExpression(node) && node.operator === '??') {
    const left = resolveExprDefault(node.left as t.Node, itemVar, first);
    return left !== '' ? left : resolveExprDefault(node.right, itemVar, first);
  }
  const field = navMemberField(node, itemVar);
  if (field != null) { const v = first?.[field]; return v != null ? String(v) : ''; }
  return '';
}

/**
 * Detect the row's NAVIGATION link inside a collection-list item being made into a
 * component: the first `<Link>` / `<MotionLink>` / `<a>` whose `href` references the
 * `.map()` iterator (e.g. `href={`/advisors/${item._slug}`}`). Returns its node id, the
 * original href expression (verbatim, to bind per-row on the instance) and a concrete
 * default resolved from the first item — so makeComponent can turn that href into a
 * `linkHref` text variable (the master shows the Link control; each instance row links
 * to its own slug). Returns null when there is no item-bound link.
 * Exported for unit tests.
 */
export function detectCmsNavLink(
  code: string, itemVar: string, first: Record<string, any> | undefined,
): { nodeId: string; tag: string; hrefExprCode: string; defaultValue: string } | null {
  const ast = parseJSX(code);
  if (!ast) return null;
  let result: { nodeId: string; tag: string; hrefExprCode: string; defaultValue: string } | null = null;
  traverse(ast, {
    JSXElement(path: any) {
      if (result) return;
      const opening = path.node.openingElement;
      if (!t.isJSXIdentifier(opening.name)) return;
      const tag = opening.name.name;
      if (tag !== 'Link' && tag !== 'MotionLink' && tag !== 'a') return;
      const attrs = opening.attributes;
      const hrefAttr = attrs.find((a: t.Node) => t.isJSXAttribute(a) && t.isJSXIdentifier(a.name) && a.name.name === 'href') as t.JSXAttribute | undefined;
      if (!hrefAttr || !t.isJSXExpressionContainer(hrefAttr.value)) return;
      const expr = hrefAttr.value.expression;
      if (t.isJSXEmptyExpression(expr) || !exprReferencesItem(expr, itemVar)) return;
      const idAttr = attrs.find((a: t.Node) => t.isJSXAttribute(a) && t.isJSXIdentifier(a.name) && a.name.name === 'data-id') as t.JSXAttribute | undefined;
      const nodeId = idAttr && t.isStringLiteral(idAttr.value) ? idAttr.value.value : null;
      if (!nodeId) return;
      result = {
        nodeId,
        tag,
        hrefExprCode: generate(expr as t.Expression).code,
        defaultValue: resolveExprDefault(expr as t.Expression, itemVar, first),
      };
      path.stop();
    },
  });
  return result;
}

/** Collect the data-ids of every element carrying a `data-instance-fx` or `data-scroll-variant`
 *  spec. Used by makeComponent: such an instance's page-level animation HOOKS
 *  (useMotionValue/useScroll/useEffect + Sv state) don't travel with the extracted JSX, so the
 *  new component would reference undefined identifiers (`<cn>FxCScale`, `<cn>Ref`, `<cn>Sv`) — we
 *  regenerate them inside the component from the preserved specs (rehydrate). Attr order varies
 *  (`data-instance-fx` precedes `data-id`), so this is tag-scoped via the AST, not a flat regex. */
function collectAnimatedInstanceIds(code: string): string[] {
  const ast = parseJSX(code);
  if (!ast) return [];
  const ids: string[] = [];
  traverse(ast, {
    JSXOpeningElement(path) {
      const attrs = path.node.attributes;
      const hasAttr = (n: string) => attrs.some(
        (a) => t.isJSXAttribute(a) && t.isJSXIdentifier(a.name) && a.name.name === n,
      );
      if (!hasAttr('data-instance-fx') && !hasAttr('data-scroll-variant')) return;
      const idAttr = attrs.find(
        (a): a is t.JSXAttribute => t.isJSXAttribute(a) && t.isJSXIdentifier(a.name) && a.name.name === 'data-id',
      );
      if (idAttr && t.isStringLiteral(idAttr.value)) ids.push(idAttr.value.value);
    },
  });
  return ids;
}

// ─── Random PascalCase name generator ──────────────────────────────────────

/** Unique node-id generator for inlined detach nodes. Local copy of shared/id-utils' generateNodeId
 *  (NOT imported from there — creator-utils pulls in canvas/node-ops, which would drag DOM-only
 *  modules into component-ops + the sandbox bundle, breaking it with a missing-export error). */
let _detachIdCounter = 0;
function generateNodeId(prefix = 'det'): string {
  return `${prefix}-${Date.now().toString(36)}-${(++_detachIdCounter).toString(36)}`;
}

export function generateInternalName(): string {
  return generateSyllableName('components', 'Comp');
}

// ─── @name annotation helpers ──────────────────────────────────────────────

const NAME_REGEX = /\/\*\*?\s*@name\s+"([^"]*)"\s*\*\//;

/** Read the @name annotation from a component file. Returns null if not found. */
export function getComponentDisplayName(filePath: string): string | null {
  const code = projectFS.readFile(filePath);
  if (!code) return null;
  const match = code.match(NAME_REGEX);
  return match ? match[1] : null;
}

/** Read the @name annotation from component code string. */
export function parseComponentName(code: string): string | null {
  const match = code.match(NAME_REGEX);
  return match ? match[1] : null;
}

/**
 * The component's EXPORT/function identifier — the JSX TAG instances use (`<KuWoCo …/>`), NOT the
 * `@name` display label. Canonical pattern in this codebase: `export default withResponsiveProps(Name)`
 * (CLAUDE.md). Falls back to `export default function Name` / `export default Name`. Used by the
 * "remove prop at source → strip every instance" cascade to find `<Name>` instances project-wide.
 */
export function getComponentExportName(code: string): string | null {
  return (
    code.match(/export\s+default\s+withResponsiveProps\(\s*([A-Za-z_$][\w$]*)\s*\)/)?.[1]
    ?? code.match(/export\s+default\s+function\s+([A-Za-z_$][\w$]*)/)?.[1]
    ?? code.match(/export\s+default\s+([A-Za-z_$][\w$]*)\s*;/)?.[1]
    ?? null
  );
}

/**
 * Update the @name annotation in a component file's code. Replaces the
 * existing `/** @name "..." *\/` block if present, or inserts a new one
 * at the top of the file (after `'use client'` if present, otherwise as
 * the first line). Used by the Library panel's Rename action — the
 * display label users see comes from this annotation, not from the
 * internal function name (`function YuPoMa(...)` stays unchanged).
 *
 * Embedded double quotes in the new name are escaped to keep the
 * annotation block parseable. Empty / whitespace-only names are ignored
 * (returns the original code unchanged).
 */
export function setComponentName(code: string, newName: string): string {
  const trimmed = newName.trim();
  if (!trimmed) return code;
  const escaped = trimmed.replace(/"/g, '\\"');
  const annotation = `/** @name "${escaped}" */`;

  if (NAME_REGEX.test(code)) {
    return code.replace(NAME_REGEX, annotation);
  }

  // No existing annotation — insert one after the last leading import /
  // 'use client' / comment block. Mirrors the same anchor logic that
  // `addComponentCursorInCode` and the design-component templates use:
  // keep annotations clustered with the other top-of-file metadata
  // rather than buried inside the component body.
  const lines = code.split('\n');
  let insertAt = 0;
  let inBlockComment = false; // inside a /* … */ that spans MULTIPLE lines
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (inBlockComment) {
      // Walk through the BODY of a multi-line block comment (e.g. the
      // `/** @controls { … } */` JSON). We must NEVER insert here — the
      // annotation's own `*/` would close the comment early and corrupt the
      // file (imports + JSON spill out as broken code).
      insertAt = i + 1;
      if (t.includes('*/')) inBlockComment = false;
      continue;
    }
    if (t.startsWith('/*') && !t.includes('*/')) {
      // Opens a multi-line block comment (`/** @controls {`). Skip to its close.
      inBlockComment = true;
      insertAt = i + 1;
      continue;
    }
    if (
      t.startsWith('import ') ||
      t.startsWith("'use client'") ||
      t.startsWith('"use client"') ||
      t === '' ||
      t.startsWith('//') ||
      t.startsWith('/*') // single-line block comment (opens AND closes on this line)
    ) {
      insertAt = i + 1;
      continue;
    }
    break; // first line of real code — insert the annotation just above it
  }
  lines.splice(insertAt, 0, '', annotation);
  return lines.join('\n');
}

// ─── Types ─────────────────────────────────────────────────────────────────

export interface ViewportDimensions {
  vpId: string;
  vpLabel: string;
  width: number;   // computed element width in px
  height: number;  // computed element height in px
  vpWidth: number;  // viewport config breakpoint width (e.g. 1440, 768, 375)
}

// ─── Make Component ─────────────────────────────────────────────────────────

/**
 * Extract a node subtree into a new component file.
 * Returns the new component file path + updated page code, or null on failure.
 *
 * @param isDirectViewportChild — true if the node is a direct child of the page root.
 *   Creates one variant per viewport with computed dimensions for each.
 * @param viewportDimensions — computed px dimensions from each viewport's DOM element.
 *   Used to replace auto/fill/100% with real px values on the master root.
 */
/** Strip canvas-workspace residue from a node's JSX before it becomes a
 *  component-master ROOT: the `data-canvas-node` marker (a master root is
 *  never a canvas node) and the page-canvas left/top/right/bottom (the
 *  master positions itself via variantConfig — and those coords are already
 *  re-captured onto the instance tag via WRAPPER_ONLY_STYLE_PROPS, so the
 *  instance keeps its placement). A no-op for nodes extracted from inside a
 *  viewport, which carry neither. */
/**
 * Rebind a parent's `variant` useState references in an extracted subtree to the
 * `initialVariant` prop. When you Make Component from a subtree of a variant-driven
 * parent (e.g. the Header's logo dots), the carried children still reference the
 * PARENT's `variant` state — `animate={['default', variant]}`, `variant === 'x' ? …`.
 * The new component follows the make-time convention: `initialVariant` only, NO
 * `variant`/`setVariant` state (addConnection migrates initialVariant→variant when a
 * connection is later wired). An un-rewritten `variant` is therefore an UNDEFINED
 * identifier that crashes the new component and blocks every edit ("undefined
 * variant"). Rebind both forms to `initialVariant`. No-op when nothing references it.
 * `variants` / `setVariant` / `initialVariant` / `variantConfig` stay untouched
 * (word boundary + the uppercase `V` in those names).
 */
export function rewriteVariantStateRefsToInitialVariant(jsx: string): string {
  const out = jsx
    // variant-list wiring: initial/animate={['default', variant]}
    .replace(/\[\s*'default'\s*,\s*variant\s*\]/g, "['default', initialVariant]")
    // comparison ternaries / conditions: `variant === 'x'` / `variant !== 'x'`
    .replace(/\bvariant\s*(===|!==)/g, 'initialVariant $1');
  if (out !== jsx) trace.fn('component-ops.rewriteVariantStateRefs', { changed: true });
  return out;
}

// Matches a single `on<Event>={ … setVariant … }` handler (with its leading whitespace), no nested braces —
// a variant-toggle arrow uses parens, never braces. Shared by the strip + extract below.
const VARIANT_TOGGLE_HANDLER_RE = /\s+on[A-Z]\w*=\{[^{}]*\bsetVariant\b[^{}]*\}/;

/**
 * Strip event handlers that TOGGLE the parent's variant state from the EXTRACTED COMPONENT's JSX. When you Make
 * Component from a subtree that carried an `onTap={() => setVariant(…)}` (a variant-transition CONNECTION wired
 * on the parent — e.g. the Header's hamburger toggling open/closed), the new STANDALONE component has no
 * `variant`/`setVariant` state (make-time convention is `initialVariant`-only). Left in, the handler references
 * undefined `setVariant`/`variant` → crash + the oracle blocks every edit. The interaction belongs to the
 * PARENT: `extractRootVariantToggleHandler` lifts the root's handler onto the INSTANCE tag (where `variant`/
 * `setVariant` ARE in scope), so the connection keeps working; this strips it from the component body.
 */
export function stripParentVariantToggleHandlers(jsx: string): string {
  const out = jsx.replace(new RegExp(VARIANT_TOGGLE_HANDLER_RE.source, 'g'), '');
  if (out !== jsx) trace.fn('component-ops.stripParentVariantToggleHandlers', { changed: true });
  return out;
}

/**
 * Lift the ROOT's variant-toggle handler off an extracted subtree so it can be re-attached to the INSTANCE tag.
 * The extracted root becomes the component root (which loses the handler via `stripParentVariantToggleHandlers`),
 * but the variant-transition CONNECTION must survive — on the INSTANCE the parent's `variant`/`setVariant` are
 * in scope, so `<Inst onTap={() => setVariant(…)} …/>` keeps firing the connection (the `connections` array
 * entry that references this node still resolves). Returns the handler WITH its leading space (ready to splice
 * into the instance tag), or '' if the root has none. Captures the FIRST handler (the root's, since its attrs
 * precede any child); keep `variant`/`setVariant` un-rewritten (the instance lives in the parent's scope).
 */
export function extractRootVariantToggleHandler(jsx: string): string {
  const m = jsx.match(VARIANT_TOGGLE_HANDLER_RE);
  if (m) trace.fn('component-ops.extractRootVariantToggleHandler', { found: true });
  return m ? m[0] : '';
}

export function cleanComponentRootJSX(jsx: string): string {
  // Drop the data-canvas-node marker — only the root canvas node carries it.
  let out = jsx.replace(/\s+data-canvas-node=(?:"[^"]*"|\{[^}]*\})/, '');
  // Drop left/top/right/bottom from the root's first style object, then tidy
  // any comma left dangling where a removed prop sat — a stray comma would
  // collide with the `...style` spread injected later and break the JSX.
  const open = out.indexOf('style={{');
  if (open !== -1) {
    const inner = open + 'style={{'.length;
    const close = out.indexOf('}}', inner);
    if (close !== -1) {
      const block = out.slice(inner, close)
        // Strip left/top/right/bottom in ANY value form — single quotes,
        // DOUBLE quotes, or unquoted numeric. (Single-quote-only missed a
        // `left: "952px"` and it leaked onto the instance as a relative
        // offset, throwing the nested instance off the parent in live preview.)
        .replace(/\b(?:left|top|right|bottom)\s*:\s*(?:'[^']*'|"[^"]*"|-?\d+(?:\.\d+)?)\s*,?\s*/g, '')
        .replace(/,\s*,/g, ', ')   // collapse a double comma
        .replace(/^\s*,\s*/, '')   // drop a leading comma
        .replace(/,\s*$/, '');     // drop a trailing comma
      out = out.slice(0, inner) + block + out.slice(close);
    }
  }
  return out;
}

/**
 * Resolve a MASTER-ROOT variant's width/height from the viewport's authored
 * value. A root variant can only be PX or AUTO:
 *   - authored px       → keep the px (the design value, not the measurement)
 *   - authored auto-ish → 'min-content' (the canvas root-auto canonical) so
 *     the variant stays content-driven, exactly like the page section it came
 *     from (a tablet/mobile INHERITING the primary's height:auto used to get
 *     the measured 537/553px frozen in — user report 2026-07-28)
 *   - anything fluid (%/vh/vw/clamp/calc) → the measured px (those units are
 *     meaningless on a free-floating master tile).
 * `override` is the viewport's @media value; absent → the primary's inline
 * value; absent too → auto. Exported for tests.
 */
export function resolveRootVariantDim(
  authoredBase: string | undefined,
  override: string | undefined,
  measuredPx: number,
  axis: 'width' | 'height',
): string {
  // WIDTH: the variant IS the viewport — its tile width is always the
  // viewport's width, whatever the page authored (a 1440px/100%/auto section
  // is full-desktop-width; on the tablet variant that means 768px).
  if (axis === 'width') return `${measuredPx}px`;
  const authored = (override ?? authoredBase ?? '').trim();
  const isAutoLike = authored === '' || authored === 'auto' || authored === 'min-content'
    || authored === 'max-content' || authored === 'fit-content';
  if (isAutoLike) return 'min-content'; // content-driven stays content-driven
  if (/^\d+(?:\.\d+)?px$/.test(authored)) return authored;
  return `${measuredPx}px`; // %, vh, clamp… — fluid units freeze to the measurement
}

/**
 * Bake every NESTED design-component instance's per-viewport variant picks
 * (`data-responsive` initialVariant entries) into a PARENT-variant ternary:
 *
 *   <LeCeJo data-responsive='{"375":{"initialVariant":"variant-4"},…}' …/>
 *     →  <LeCeJo initialVariant={initialVariant === 'variant-1' ? 'variant-4'
 *          : initialVariant === 'variant-2' ? 'variant-4' : 'default'} …/>
 *
 * On the PAGE, data-responsive keys on the viewport width — but inside a
 * master the tiles are PARENT VARIANTS, not viewports, so without this the
 * tablet/mobile variant tiles rendered the nested instance at its PRIMARY
 * variant (user report 2026-07-28). The data-responsive attr is kept — the
 * live site still resolves by breakpoint; the ternary drives the master
 * canvas (parsed into attrConditional → perParentOverrides). An authored
 * `initialVariant="x"` string prop becomes the ternary's else branch.
 * Exported for tests.
 */
export function bakeNestedInstanceVariantTernaries(
  code: string,
  viewportDimensions: Array<{ vpWidth: number }>,
): string {
  const bpToParent = new Map<number, string>();
  viewportDimensions.forEach((vp, i) => { if (i > 0) bpToParent.set(vp.vpWidth, `variant-${i}`); });
  if (bpToParent.size === 0) return code;
  let out = code;
  let searchFrom = 0;
  for (;;) {
    const respIdx = out.indexOf("data-responsive='", searchFrom);
    if (respIdx === -1) break;
    searchFrom = respIdx + 1;
    const tagStart = out.lastIndexOf('<', respIdx);
    if (tagStart === -1) continue;
    const tagName = out.slice(tagStart + 1).match(/^([A-Za-z][\w.]*)/)?.[1] ?? '';
    // Design-component instances only: uppercase, not motion.* / MotionLink.
    if (!/^[A-Z]/.test(tagName) || tagName.startsWith('motion') || tagName === 'MotionLink' || tagName === 'Link') continue;
    const tagEnd = findTagClose(out, respIdx);
    if (tagEnd === -1) continue;
    const tagText = out.slice(tagStart, tagEnd);
    if (/\binitialVariant=\{/.test(tagText)) continue; // already conditional — leave alone
    const jsonMatch = out.slice(respIdx).match(/^data-responsive='(\{[^']*\})'/);
    if (!jsonMatch) continue;
    let resp: Record<string, { initialVariant?: string }>;
    try { resp = JSON.parse(jsonMatch[1]); } catch { continue; }
    const defaultBranch = tagText.match(/\binitialVariant="([^"]+)"/)?.[1] ?? 'default';
    const branches: Array<[string, string]> = [];
    for (const [bp, parentVariant] of bpToParent) {
      const v = resp[String(bp)]?.initialVariant;
      if (v) branches.push([parentVariant, v]);
    }
    if (branches.length === 0 || branches.every(([, v]) => v === defaultBranch)) continue;
    branches.sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
    const ternary = branches.map(([pv, v]) => `initialVariant === '${pv}' ? '${v}' : `).join('') + `'${defaultBranch}'`;
    // Drop an authored string prop (now the else branch) and inject the ternary
    // right before data-responsive.
    let newTag = tagText.replace(/\s+initialVariant="[^"]+"/, '');
    const respInTag = newTag.indexOf("data-responsive='");
    newTag = newTag.slice(0, respInTag) + `initialVariant={${ternary}} ` + newTag.slice(respInTag);
    out = out.slice(0, tagStart) + newTag + out.slice(tagEnd);
    searchFrom = tagStart + newTag.length;
    trace.action('component-ops:bake-nested-variant-ternary', { tag: tagName, branches, defaultBranch });
  }
  return out;
}

/** The extracted subtree ROOT's authored inline dimension — read from the
 *  first style object of the extracted JSX (the root tag opens the string). */
function readRootInlineDim(jsx: string, prop: 'width' | 'height'): string | undefined {
  const styleIdx = jsx.indexOf('style={{');
  if (styleIdx === -1) return undefined;
  let depth = 0, end = -1;
  for (let i = styleIdx + 'style={'.length; i < jsx.length; i++) {
    if (jsx[i] === '{') depth++;
    else if (jsx[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) return undefined;
  const body = jsx.slice(styleIdx, end);
  const m = body.match(new RegExp(`\\b${prop}\\s*:\\s*'([^']*)'`));
  return m?.[1];
}

export function makeComponent(
  pageFilePath: string,
  nodeId: string,
  displayName: string,
  isDirectViewportChild?: boolean,
  viewportDimensions?: ViewportDimensions[],
  /** When the source node lives inside a `.map()` collection list, the iterator
   *  var name (e.g. 'item'). Its `item.field` bindings are hoisted into component
   *  props and the instance is passed `field={item.field}` per item — the reference
   *  "create component from the first collection item" auto-wire (Mechanism B). */
  cmsItemVar?: string,
  /** The collection-list `source` of the nearest collectionList ancestor — a CMS
   *  slug (or `__inline:<var>`). Used to seed each hoisted prop's DEFAULT from the
   *  collection's first item and TYPE it from the schema (image → image var, …). */
  cmsSource?: string,
): { componentFilePath: string; updatedPageCode: string } | null {
  try {
    // Flush pending mutations so we read the latest code
    const preFlushCode = projectFS.readFile(pageFilePath);
    if (preFlushCode) syncQueueCode(preFlushCode);
    flushNow();

    const pageCode = projectFS.readFile(pageFilePath);
    if (!pageCode) return null;

    // Generate random PascalCase internal name (React requires uppercase component names)
    const componentName = generateInternalName();

    // Use AST to extract the node's JSX string
    const ast = parseJSX(pageCode);
    if (!ast) return null;

    let nodeJSX: string | null = null;
    let nodeStart = -1;
    let nodeEnd = -1;
    // Wrapper-only style props captured from the original JSX node. These
    // describe HOW the original element sat in its parent (position,
    // left/top, transform, order, flex placement, margin, alignSelf, ...)
    // and need to be re-injected on the new `<Component />` instance tag —
    // otherwise the instance collapses into the parent's natural flow with
    // none of its prior placement, and the canvas visibly jumps.
    //
    // Format: `propName: value` pairs, suitable for embedding into a JSX
    // style object literal verbatim.
    const wrapperStyleEntries: Array<{ key: string; jsx: string }> = [];

    findFirstElementByDataId(ast, nodeId, (path) => {
      const node = path.node;
      if (node.start != null && node.end != null) {
        nodeStart = node.start;
        nodeEnd = node.end;
        nodeJSX = pageCode.substring(nodeStart, nodeEnd);
      }

      // Extract wrapper-only style props from the original element's
      // `style={{ ... }}`. We slice the SOURCE TEXT of each property's value
      // so expressions, var() references, template literals, etc. survive
      // unchanged on the instance tag.
      const opening = node.openingElement;
      const styleAttr = findAttribute(opening, 'style') as t.JSXAttribute | null;
      if (!styleAttr || styleAttr.value?.type !== 'JSXExpressionContainer') return;
      const expr = styleAttr.value.expression;
      if (!t.isObjectExpression(expr)) return;
      for (const prop of expr.properties) {
        if (!t.isObjectProperty(prop)) continue;
        const key = t.isIdentifier(prop.key) ? prop.key.name
                  : t.isStringLiteral(prop.key) ? prop.key.value
                  : null;
        if (!key) continue;
        // PARENT-RELATIVE sizes (100%, 50vw, …) describe how the node fills
        // its parent's cell — placement, not content size. The master file
        // freezes them to measured px (replaceNonPxDimensions), so unless
        // they ALSO ride the instance tag the node stops filling its
        // grid/flex cell after Make Component (a width/height 100% grid
        // child came back as an auto×auto instance hugging the master's
        // frozen size — user report 2026-07-29). px/auto sizes keep the old
        // behavior: the master owns them, the instance stays unsized.
        const isRelativeSize = (key === 'width' || key === 'height')
          && t.isStringLiteral(prop.value)
          && /^\d+(?:\.\d+)?(?:%|vw|vh|svh|dvh)$/.test(prop.value.value);
        if (!WRAPPER_ONLY_STYLE_PROPS.has(key) && !isRelativeSize) continue;
        if (prop.value.start == null || prop.value.end == null) continue;
        const valueText = pageCode.slice(prop.value.start, prop.value.end);
        wrapperStyleEntries.push({ key, jsx: `${key}: ${valueText}` });
      }
    });

    if (!nodeJSX || nodeStart === -1) {
      trace.error('component-ops:node-not-found', { nodeId });
      return null;
    }

    // If we have computed dimensions from the primary viewport, replace auto/fill/100%
    // with computed px values in the root's style object.
    let processedJSX = nodeJSX as string;
    const primaryDims = viewportDimensions?.find(v => v.vpId === 'desktop') ?? viewportDimensions?.[0];
    if (primaryDims) {
      processedJSX = replaceNonPxDimensions(processedJSX, primaryDims.width, primaryDims.height);
    }

    // A node made into a component from the FREE CANVAS (not inside a
    // viewport) carries `data-canvas-node` and page-canvas left/top on its
    // root. A component-master ROOT must be neither — left in, the parser
    // treats the root as a canvas node and the variant system never engages.
    processedJSX = cleanComponentRootJSX(processedJSX);

    // A handler that TOGGLES the parent's variant (`onTap={() => setVariant(…)}`, e.g. the Header's hamburger)
    // is a CONNECTION — it must MOVE to the INSTANCE (where the parent's `variant`/`setVariant` are in scope),
    // not stay in the new component (which has no variant state). CAPTURE the root's handler here BEFORE the
    // strip below removes it from the component body, then splice it onto the instance tag (see instanceTag).
    // Without this, Make Component silently drops the interaction — the `connections` array stays but nothing
    // fires it (the user-reported "connection stayed visually but doesn't actually work").
    const transferredVariantToggleHandler = extractRootVariantToggleHandler(processedJSX);
    processedJSX = stripParentVariantToggleHandlers(processedJSX);
    // SAME for the root's `key`: a conditionally-rendered node inside <AnimatePresence> carries `key="<id>"`,
    // which must live on the INSTANCE (AnimatePresence tracks the instance, not the component's inner root) —
    // else the oracle's ANIMATEPRESENCE_KEY fires and the show/hide snaps. Lift it to the instance and drop it
    // from the component body (a key on the lone component-root element is inert anyway). The root's key is its
    // data-id, which is `nodeId`, so `key="${nodeId}"` uniquely identifies it (no child shares that id).
    let transferredKeyAttr = '';
    if (processedJSX.includes(` key="${nodeId}"`)) {
      transferredKeyAttr = ` key="${nodeId}"`;
      processedJSX = processedJSX.replace(` key="${nodeId}"`, '');
    }
    // Children carried from a variant-driven PARENT (e.g. the Header's logo dots)
    // still reference the parent's `variant` useState. The new component has none
    // (make-time convention is `initialVariant`-only), so rebind those refs or the
    // file references an undefined `variant` and blocks every edit.
    processedJSX = rewriteVariantStateRefsToInitialVariant(processedJSX);

    // Carry over any `const xxxVariants = { ... };` consts referenced by the
    // extracted JSX. Without this, the new component file references an
    // identifier that only existed in the parent's scope, and the live
    // preview crashes with `ReferenceError: xxxVariants is not defined`.
    const extractedConsts = extractReferencedVariantConsts(processedJSX, pageCode);
    // Slot connections — if the extracted subtree contains code-component
    // instances with `{cn_<id>}` slot refs (e.g. a Marquee with connected
    // canvas nodes), duplicate those canvas-node decls into the new
    // component file with fresh data-ids, repositioned left of the master
    // viewport. The extracted JSX is rewritten to point at the duplicates.
    // Runs BEFORE the import scan so any user-component instances inside
    // the duplicated cn-decls (e.g. `<CeDuFe />`, `<PaLiCe />`) get their
    // imports carried over too — otherwise they'd resolve to undefined.
    const slotInfo = extractReferencedSlotConsts(processedJSX, pageCode);
    processedJSX = slotInfo.rewrittenJSX;
    const carriedConsts = [...extractedConsts.consts, ...slotInfo.consts];

    // Carry over any imports for components referenced by the extracted JSX
    // — INCLUDING references inside the duplicated slot consts. Without
    // scanning those too, a Marquee whose slot contains a user-component
    // instance would compile but render blank (undefined identifier).
    const importScanText = processedJSX + '\n' + slotInfo.consts.join('\n');
    const carriedImports = extractReferencedComponentImports(importScanText, pageCode);

    // Build component file
    const componentFilePath = `components/${componentName}.tsx`;
    let componentCode: string;

    if (isDirectViewportChild && viewportDimensions && viewportDimensions.length > 1) {
      // Direct viewport child: create multi-variant component with one variant per viewport
      componentCode = buildMultiVariantComponentFile(componentName, displayName, processedJSX, viewportDimensions, carriedImports, carriedConsts);

      // Nested design-component instances: map their per-viewport variant picks
      // (data-responsive) into a PARENT-variant ternary so each master tile
      // shows the same variant the page viewport showed (see the helper's doc).
      componentCode = bakeNestedInstanceVariantTernaries(componentCode, viewportDimensions);

      // ROOT per-variant SIZE → inline-style ternary, NOT the variants object.
      // A size in the variants object value-tweens on motion's own clock, out of
      // sync with the children's `layout` FLIP — so when the root grows between
      // variants while a child enters/exits via AnimatePresence in the same
      // transition, the entering child shoves its siblings on the grow direction.
      // Routing size to a ternary makes React apply it synchronously, so the
      // resize + child enter + sibling reflow are ONE coordinated layout pass.
      // setConditionalStyleInCode derives the default branch from the inline
      // primary size and strips width/height from every variant entry. Keyed on
      // `initialVariant` here (no connections at make-time); the connection-add
      // path migrates it to `variant` when a connection is later wired.
      //
      // Each variant's value mirrors the viewport's RESOLVED AUTHORED size —
      // not the measured px. A section with height AUTO that tablet/mobile
      // INHERIT must produce auto (min-content) variants too; freezing the
      // measured 537/553px broke the content-driven sizing the page had
      // (user report 2026-07-28). A root variant can only be PX or AUTO:
      // authored px stays px, authored auto stays auto, anything fluid
      // (%/vh/vw/clamp) freezes to the measured px. Resolution per viewport =
      // that breakpoint's @media override ?? the primary's inline value.
      const containerRulesMV = parseContainerRules(extractStyleCSS(pageCode));
      const rootFnIdx = componentCode.indexOf(`function ${componentName}`);
      const rootIdMatch = rootFnIdx !== -1 ? componentCode.slice(rootFnIdx).match(/data-id="([^"]+)"/) : null;
      const rootDataId = rootIdMatch?.[1];
      if (rootDataId) {
        const rootAuthoredW = readRootInlineDim(nodeJSX as string, 'width');
        const rootAuthoredH = readRootInlineDim(nodeJSX as string, 'height');
        viewportDimensions.forEach((vp, i) => {
          if (i === 0) return; // default = the inline primary size (ternary fallback)
          const variantName = `variant-${i}`;
          const ov = containerRulesMV.get(vp.vpWidth)?.get(nodeId);
          componentCode = setConditionalStyleInCode(componentCode, rootDataId, 'width', variantName,
            resolveRootVariantDim(rootAuthoredW, ov?.get('width'), vp.width, 'width'));
          componentCode = setConditionalStyleInCode(componentCode, rootDataId, 'height', variantName,
            resolveRootVariantDim(rootAuthoredH, ov?.get('height'), vp.height, 'height'));
        });
      }

      // Carry per-viewport responsive @media overrides (e.g. a child rotated
      // ONLY on tablet) into the new component's VARIANT objects. Without this
      // the responsive transforms are silently stripped on componentize.
      // parseContainerRules → Map<maxWidthBreakpoint, Map<dataId, Map<prop,val>>>;
      // map each non-primary breakpoint to its variant and reuse
      // updateVariantStyleInCode (it converts transform→motion props, adds the
      // neutral defaults, and builds the per-element variants const).
      if (containerRulesMV.size > 0) {
        // breakpoint width → variant name (tablet 768 → variant-1, mobile 375 → variant-2)
        const bpToVariant = new Map<number, string>();
        viewportDimensions.forEach((vp, i) => { if (i > 0) bpToVariant.set(vp.vpWidth, `variant-${i}`); });
        for (const [bp, byElement] of containerRulesMV) {
          const variantName = bpToVariant.get(bp);
          if (!variantName) continue;
          for (const [dataId, props] of byElement) {
            // Only elements that actually live inside this component subtree.
            if (!componentCode.includes(`data-id="${dataId}"`)) continue;
            // Split layout-affecting props (flexDirection/gap/width/height/…) out
            // to inline-style ternaries so they ride the `layout` FLIP, and keep
            // the genuinely tweenable paint/transform props in the variants
            // object — same routing as replica-context.styleUpdate.
            const variantStyles: Record<string, string> = {};
            const condEntries: Array<[string, string]> = [];
            for (const [k, v] of props) {
              const camel = toCamel(k);  // kebab → camel for the writers
              // The extracted ROOT's PLACEMENT props (order / flex / margins /
              // align-self / grid placement) describe the INSTANCE's slot in
              // the PAGE's layout — they stay on the page as @media overrides
              // for the instance id (re-written after the strip below), never
              // migrated into the master (there they'd land on the INNER root,
              // layout-inert inside the wrapper). Stripping them lost the
              // MOBILE viewport's independent section `order: 10` and the new
              // instance fell to order 0, jumping up under the hero — only on
              // mobile, the one viewport with per-viewport section orders
              // (user report 2026-07-28).
              if (dataId === nodeId && WRAPPER_ONLY_STYLE_PROPS.has(camel)) continue;
              // The ROOT's width/height are fully owned by the PX-or-AUTO size
              // loop above (resolved per viewport) — migrating the raw @media
              // value here would overwrite it (a mobile `height: 50vh` landed
              // verbatim in the ternary instead of the frozen px).
              if (dataId === nodeId && (camel === 'width' || camel === 'height')) continue;
              if (CONDITIONAL_LAYOUT_PROPS.has(camel)) condEntries.push([camel, v]);
              else variantStyles[camel] = v;
            }
            for (const [prop, value] of condEntries) {
              componentCode = setConditionalStyleInCode(componentCode, dataId, prop, variantName, value);
            }
            if (Object.keys(variantStyles).length > 0) {
              componentCode = updateVariantStyleInCode(componentCode, dataId, variantName, variantStyles);
            }
          }
        }
      }
    } else {
      componentCode = buildComponentFile(componentName, displayName, processedJSX, carriedConsts, carriedImports);
    }

    // The extracted JSX may CALL the page's file-local `useResponsiveText`
    // hook (per-viewport text overrides) — its definition lives on the PAGE,
    // so the new component must get its own copy or it ReferenceError-crashes
    // on the live site (2026-07-28). No-op when the hook isn't referenced.
    componentCode = ensureResponsiveTextHook(componentCode);

    // PORT CHILD ANIMATIONS INTO COMPONENT MODE. The extracted JSX may contain
    // descendant instances with `data-instance-fx`/`data-scroll-variant` whose
    // page-level hooks (useMotionValue/useScroll/useEffect + the `<cn>Sv` state)
    // stayed in the PAGE — so the new component's `scale: <cn>FxCScale` /
    // `ref={<cn>Ref}` / `initialVariant={<cn>Sv}` bindings reference undefined
    // identifiers and crash. Regenerate the hooks INSIDE the component from the
    // preserved specs (rehydrate strips the stale bindings + rebuilds canonical
    // hooks before `return (`), then sync the framer-motion/React hook imports.
    const animatedIds = collectAnimatedInstanceIds(componentCode);
    if (animatedIds.length) {
      for (const id of animatedIds) {
        componentCode = rehydrateScrollVariant(componentCode, id);
        componentCode = rehydrateInstanceFx(componentCode, id);
      }
      componentCode = syncImports(componentCode);
      trace.action('component-ops:port-child-animations', { componentName, animatedIds });
    }

    // A <form> made into a component carries its onSubmit + FormSubmit
    // initialVariant (both reference `formState<X>`) into the master, but the
    // page's `useState` declaration stayed behind → "formState<X> is not
    // defined". Re-declare the lifecycle var(s) inside the master so the submit
    // loading/success behavior keeps working in the component (design-tool parity).
    componentCode = healMissingFormStateDeclarations(componentCode);

    // TRANSFER PARENT VARIABLES — the extracted subtree may reference parent variables (a child's bound
    // Fill / Shadow / Transform / per-viewport binding) plus the `__mq` gates those bindings use. Carry them
    // into the master as PROPS (params + @propMeta + __mq hooks + useMediaQuery) so the file isn't left with
    // undefined identifiers, and pass each through on the INSTANCE (`prop={parentVar}`) so the PARENT's
    // variable still drives it — which the panel reads as an auto-hoisted variable on the instance (the reference
    // parity).
    const { vars: transferVars, mqs: transferMqs } = collectTransferableVariables(componentCode, pageCode, pageFilePath);
    if (transferVars.length > 0 || transferMqs.length > 0) {
      componentCode = applyVariableTransfer(componentCode, componentName, transferVars, transferMqs);
      componentCode = syncImports(componentCode);
      trace.action('component-ops:transfer-variables', { componentName, vars: transferVars.map(v => v.name), mqs: transferMqs.map(m => m.id) });
    }
    const instanceVarAttrs = buildInstanceVariableAttrs(transferVars);

    // CMS COMPONENT (Mechanism B) — if the source node lived inside a `.map()`
    // collection list, hoist its `item.field` bindings into component props so the
    // master is data-agnostic, then pass `field={item.field}` (+ relocate `key={idx}`)
    // on the INSTANCE, which lands inside the surviving `.map()`. Runs LAST so it sees
    // the fully-built component (variants, ported animations) before the write.
    let instanceFieldAttrs = '';
    let instanceKeyAttr = '';
    if (cmsItemVar) {
      // A collection-list item is a FLOW child (it lives inside the `.map()` of a
      // flex/grid container), but the component master ROOT is forced
      // position:absolute (for the canvas master-tile view via variantConfig).
      // Without an explicit instance position, EVERY rendered row inherits that
      // absolute and they all stack at the same spot on the LIVE site (the
      // "collection doesn't render / overlaps" bug — the editor canvas hides it
      // because its ghost machinery repositions each row). Pin the instance to
      // position:relative (flow) unless the source child already carried one.
      if (!wrapperStyleEntries.some(e => e.key === 'position')) {
        wrapperStyleEntries.push({ key: 'position', jsx: "position: 'relative'" });
      }
      // Seed each hoisted prop's DEFAULT from the collection's first item + its TYPE
      // from the schema, so the master variant renders real content (not empty) and the
      // photo becomes a real image variable. Inline `.map()` arrays have no schema/slug
      // → fall back to empty defaults (the old behaviour).
      const fieldDefaults: Record<string, string> = {};
      const imageFields = new Set<string>();
      const fieldTypes: Record<string, string> = {};
      let first: Record<string, any> | undefined;
      if (cmsSource && !cmsSource.startsWith('__inline:')) {
        const schema = getCollectionSchema(cmsSource);
        first = getCollectionData(cmsSource)[0] as Record<string, any> | undefined;
        if (schema) {
          for (const f of schema.fields) {
            fieldTypes[f.id] = CMS_FIELD_TO_PROP_TYPE[f.type] ?? 'plainText';
            if (f.type === 'image') imageFields.add(f.id);
            const raw = first?.[f.id];
            if (raw != null && raw !== '') {
              // Pass image/file defaults as PLAIN URLs — hoistMapBindingsToProps
              // decides per field: a field used ONLY as `url(${x})` converts to
              // the WHOLE-VALUE convention (bare `backgroundImage: x`, default
              // wrapped to `url(...)`, instance binds `x={\`url(\${item.x})\`}`)
              // so the panel shows the image PICKER; an `<img src>` field keeps
              // the plain URL. Strip any legacy `url(...)` wrapper from older
              // collection data; a wrapped input here would double-wrap.
              fieldDefaults[f.id] = (f.type === 'image' || f.type === 'file')
                ? String(stripUrlWrapper(String(raw)))
                : String(raw);
            }
          }
        }
        // `_slug` (the data-cms-nav detail link) is a meta field, not in the schema.
        if (first?._slug != null) fieldDefaults['_slug'] = String(first._slug);
      }

      // CMS NAV LINK → `linkHref` text variable. The row's navigation link
      // (`href={`/advisors/${item._slug}`}`) becomes a proper link variable so the
      // master shows the Navigation > Link To control (matching the manual flow), and
      // each instance binds the per-row URL. Done BEFORE the field hoist so the slug —
      // now consumed by the link variable — is NOT also hoisted as a dead plain prop.
      let navLinkAttr = '';
      const nav = detectCmsNavLink(componentCode, cmsItemVar, first);
      if (nav) {
        // A next/link `<Link>` becomes `<MotionLink>` (motion.create(Link)) first —
        // client-side nav + framer-motion props — matching the manual LinkTool flow.
        // A plain `<a>` stays an `<a>` (no Link wrapper).
        const converted = nav.tag === 'a' ? componentCode : convertToMotionLinkInCode(componentCode, nav.nodeId);
        componentCode = syncLinkHandlerInCode(
          addPageVariableInCode(
            createLinkAttrVariableInCode(converted, nav.nodeId, {
              attrName: 'href', propName: 'linkHref', kind: 'string', defaultValue: nav.defaultValue,
            }),
            { name: 'linkHref', type: 'text', default: nav.defaultValue },
          ),
          nav.nodeId,
        );
        navLinkAttr = ` linkHref={${nav.hrefExprCode}}`;
        trace.action('component-ops:cms-nav-link-var', { componentName, nodeId: nav.nodeId, href: nav.hrefExprCode, default: nav.defaultValue });
      }

      // The map callback's INDEX param — a bare stagger reference in the subtree
      // (`delay: index * 0.1`) must hoist as a prop or the master crashes with
      // "undefined index" (the identifier only exists in the page's map callback).
      const mapIndexVar = getEnclosingMapParamsForNode(pageCode, nodeId)?.indexVar ?? null;
      const hoisted = hoistMapBindingsToProps(componentCode, cmsItemVar, fieldDefaults, imageFields, mapIndexVar);
      componentCode = hoisted.code;
      // Tag each hoisted field's @propMeta type so its pill shows the right data type.
      for (const field of hoisted.fields) {
        const pt = fieldTypes[field];
        if (pt) componentCode = setPropTypeInCode(componentCode, field, pt);
      }
      if (hoisted.indexField) componentCode = setPropTypeInCode(componentCode, hoisted.indexField, 'number');
      // Whole-value image fields bind WRAPPED at the instance (the master binds
      // the bare identifier; CMS stores plain URLs): image={\`url(\${item.x})\`}.
      // A hoisted stagger index passes the live map index → per-row stagger survives.
      instanceFieldAttrs = hoisted.fields.map((f) => hoisted.wholeValueImageFields.includes(f)
        ? ' ' + f + '={\`url(\${' + cmsItemVar + '.' + f + '})\`}'
        : ` ${f}={${cmsItemVar}.${f}}`).join('')
        + (hoisted.indexField ? ` ${hoisted.indexField}={${hoisted.indexField}}` : '')
        + navLinkAttr;
      if (hoisted.keyExpr) instanceKeyAttr = ` key={${hoisted.keyExpr}}`;
      trace.action('component-ops:cms-hoist', { componentName, itemVar: cmsItemVar, fields: hoisted.fields, indexField: hoisted.indexField, slug: cmsSource });
    }
    // A non-CMS node conditionally rendered inside <AnimatePresence> → carry its lifted root key to the instance
    // (CMS keyExpr above wins for collection rows; this only fires for the plain AnimatePresence case).
    if (!instanceKeyAttr && transferredKeyAttr) instanceKeyAttr = transferredKeyAttr;

    // Write to projectFS immediately so the parser can expand the instance
    projectFS.writeFile(componentFilePath, componentCode);
    clearComponentCache();
    queueMutation({ type: 'writeFile', filePath: componentFilePath, content: componentCode });

    // Replace the node in page code with <ComponentName />
    // For multi-variant viewport children: add data-responsive so each viewport
    // shows its corresponding variant (tablet→variant-1, mobile→variant-2).
    const beforeNode = pageCode.substring(0, nodeStart);
    const afterNode = pageCode.substring(nodeEnd);
    // Re-inject the wrapper-only positioning/layout-parent props (position,
    // left/top, transform, order, flex/grid placement, margin, alignSelf,
    // ...) onto the instance tag as a `style={{ ... }}` attribute so the
    // instance keeps its prior placement after the JSX swap. Without this
    // the instance falls back to the parent's natural flow and the canvas
    // visibly jumps right after Make Component.
    const styleAttrFragment = wrapperStyleEntries.length > 0
      ? ` style={{ ${wrapperStyleEntries.map(e => e.jsx).join(', ')} }}`
      : '';

    let instanceTag: string;
    if (isDirectViewportChild && viewportDimensions && viewportDimensions.length > 1) {
      // Build data-responsive: map each non-primary viewport breakpoint to its variant
      const responsive: Record<string, any> = {};
      const bpWidths: number[] = [];
      viewportDimensions.forEach((vp, i) => {
        bpWidths.push(vp.vpWidth);
        if (i > 0) {
          responsive[String(vp.vpWidth)] = { initialVariant: `variant-${i}` };
        }
      });
      responsive._bp = bpWidths;
      const respJson = JSON.stringify(responsive);
      instanceTag = `<${componentName}${instanceKeyAttr}${transferredVariantToggleHandler} data-id="${nodeId}" data-name="${displayName}" data-responsive='${respJson}'${styleAttrFragment}${instanceVarAttrs}${instanceFieldAttrs} />`;
    } else {
      instanceTag = `<${componentName}${instanceKeyAttr}${transferredVariantToggleHandler} data-id="${nodeId}" data-name="${displayName}"${styleAttrFragment}${instanceVarAttrs}${instanceFieldAttrs} />`;
    }
    let replacedCode = beforeNode + instanceTag + afterNode;

    // Strip the variant consts we carried into the new component file from
    // the page — leaving them behind is dead code. Only safe to drop the
    // ones not referenced anywhere else (e.g. by other elements still on
    // the page that share the same variants object — rare, but possible).
    for (const constName of extractedConsts.constNames) {
      const refRegex = new RegExp(`\\b${constName}\\b`, 'g');
      const refsAfterReplace = (replacedCode.match(refRegex) || []).length;
      // 1 reference == the const declaration line itself; anything more means
      // another consumer still depends on it and we leave it alone.
      if (refsAfterReplace <= 1) {
        const declRegex = new RegExp(`const\\s+${constName}\\s*=\\s*\\{[\\s\\S]*?\\};\\s*`, 'g');
        replacedCode = replacedCode.replace(declRegex, '');
      }
    }

    // Strip the extracted subtree's responsive @media rules from the PAGE —
    // they were migrated into the component's variant objects above. Left
    // behind they keep matching: the internal data-ids still exist INSIDE
    // the instance, and the ROOT id now names the instance WRAPPER — so a
    // migrated `padding` rule pads the wrapper AND the master root, drawing
    // a page-colored ring around the instance on replica tiles (the Footer
    // make-component report), while internal rules fight the variants.
    {
      const extractedIds = new Set<string>();
      for (const m of (nodeJSX as string).matchAll(/data-id="([^"]+)"/g)) extractedIds.add(m[1]);
      // The extracted ROOT's per-viewport PLACEMENT overrides survive the strip:
      // they now belong to the INSTANCE tag (same data-id) — its slot in the
      // page layout. See the migration loop's comment (mobile order 10, 2026-07-28).
      const rootPlacementByBp = new Map<number, Record<string, string>>();
      for (const [bp, byElement] of parseContainerRules(extractStyleCSS(pageCode))) {
        const rootProps = byElement.get(nodeId);
        if (!rootProps) continue;
        for (const [k, v] of rootProps) {
          const camel = toCamel(k);
          if (WRAPPER_ONLY_STYLE_PROPS.has(camel)) {
            const bucket = rootPlacementByBp.get(bp) ?? {};
            bucket[camel] = v;
            rootPlacementByBp.set(bp, bucket);
          }
        }
      }
      for (const id of extractedIds) {
        replacedCode = clearContainerStylesForNode(replacedCode, id);
      }
      for (const [bp, styles] of rootPlacementByBp) {
        replacedCode = updateContainerQueryStyle(replacedCode, nodeId, bp, styles);
      }
      trace.action('component-ops:strip-migrated-media-rules', {
        count: extractedIds.size,
        rootPlacementKept: Object.fromEntries([...rootPlacementByBp].map(([bp, s]) => [bp, Object.keys(s)])),
      });
    }

    // The animated descendants' JSX left the page (it's in the component now), so
    // their page-level hooks are orphaned dead code (useMotionValue/useScroll/
    // useEffect + `<cn>Sv` state, no consumer). Strip them — the same specs were
    // rehydrated inside the component above. Sibling instances NOT extracted keep
    // their hooks (their ids aren't in `animatedIds`, which came from the component).
    for (const id of animatedIds) {
      replacedCode = setScrollVariantInCode(replacedCode, id, null);
      replacedCode = setInstanceFxInCode(replacedCode, id, null);
    }

    // Add import statement
    let finalPageCode = addImportIfNeeded(replacedCode, componentName, componentFilePath);

    // OVERLAY TRANSFER — if the extracted ROOT was an overlay TRIGGER, the overlay
    // stays on the PAGE attached to the new INSTANCE (not baked into the master).
    // Moves the trigger attr + open handler off the master root onto the instance
    // tag; the overlay element + state + effect were already page-level so they
    // stay. Re-write the master file when it changed. (Descendant-trigger overlays
    // — migrating them INTO the master — are a separate, still-pending step.)
    const ovTransfer = transferRootOverlayToInstanceInCode(componentCode, finalPageCode, pageCode, nodeId);
    if (ovTransfer.moved) {
      finalPageCode = ovTransfer.instancePageCode;
      componentCode = ovTransfer.componentCode;
    }

    // DESCENDANT-trigger overlays migrate INTO the master (the trigger child is now
    // there). Adds the useState + effect, ensures the element + handler, and strips
    // the orphaned page hooks. `nodeJSX` (the original extracted subtree) identifies
    // which triggers are descendants.
    const descTransfer = transferDescendantOverlaysToMasterInCode(componentCode, finalPageCode, pageCode, nodeId, nodeJSX as string);
    if (descTransfer.moved) {
      finalPageCode = descTransfer.instancePageCode;
      componentCode = descTransfer.componentCode;
    }

    // Re-write the master if either transfer changed it — and syncImports so the
    // extracted AnimatePresence's carried `import { motion, AnimatePresence }` merges
    // with the generated `import { motion, LayoutGroup }` (no duplicate `motion`),
    // and the added useState/useLayoutEffect get their React import.
    if (ovTransfer.moved || descTransfer.moved) {
      componentCode = syncImports(componentCode);
      projectFS.writeFile(componentFilePath, componentCode);
      clearComponentCache();
      queueMutation({ type: 'writeFile', filePath: componentFilePath, content: componentCode });
    }

    trace.action('component-ops:make-component', {
      componentName,
      componentFilePath,
      nodeId,
      pageFilePath,
      jsxLength: (nodeJSX as string).length,
      isDirectViewportChild,
      variantCount: isDirectViewportChild && viewportDimensions ? viewportDimensions.length : 1,
    });

    return { componentFilePath, updatedPageCode: finalPageCode };
  } catch (err) {
    trace.error('component-ops:makeComponent-failed', { pageFilePath, nodeId, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

// ─── Detach Component ───────────────────────────────────────────────────────

/**
 * Replace a component instance with its inline JSX (reverse of makeComponent).
 */
export function detachComponent(
  pageFilePath: string,
  instanceNodeId: string,
  componentFilePath: string,
): string | null {
  try {
    const pageCode = projectFS.readFile(pageFilePath);
    const componentCode = projectFS.readFile(componentFilePath);
    if (!pageCode || !componentCode) return null;

    // Extract the component's return JSX
    const returnMatch = componentCode.match(/return\s*\(\s*([\s\S]*?)\s*\);\s*\}/);
    if (!returnMatch) return null;
    const componentJSX = returnMatch[1].trim();

    // Find and replace the <Component /> instance using AST
    const ast = parseJSX(pageCode);
    if (!ast) return null;

    let instanceStart = -1;
    let instanceEnd = -1;

    findFirstElementByDataId(ast, instanceNodeId, (path) => {
      if (path.node.start != null && path.node.end != null) {
        instanceStart = path.node.start;
        instanceEnd = path.node.end;
      }
    });

    if (instanceStart === -1) return null;

    const result = pageCode.substring(0, instanceStart) + componentJSX + pageCode.substring(instanceEnd);

    trace.action('component-ops:detach', { instanceNodeId, componentFilePath, pageFilePath });
    return result;
  } catch (err) {
    trace.error('component-ops:detachComponent-failed', { pageFilePath, instanceNodeId, componentFilePath, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

// ─── Detach Instance ─────────────────────────────────────────────────────────
//
// "Detach Instance" inlines a component instance's master content into the page as NORMAL nodes,
// resolving everything that depended on the component scope:
//   • the `{...style}` spread → the instance's own wrapper styles (width/height/position/order/…);
//   • the chosen variant's styles (variants object) baked into each element;
//   • `(variant|initialVariant) === 'X' ? a : b` ternaries → the chosen variant's branch;
//   • hoisted `const NAME = <literal>` variables referenced in styles → inlined;
//   • `motion.*` → plain tags, motion variant props (variants/initial/animate/layout/layoutId) dropped.
// NESTED component instances (a `<OtherComp/>` inside the master) are KEPT as instances — only the
// detached instance becomes a normal node; its nested instances stay as instance tags. Every inlined
// element gets a FRESH data-id so it doesn't collide with the master or other instances.

/** Resolve `(variant|initialVariant) === 'V' ? cons : alt` chains in an expression to the branch for
 *  `variant`. Returns the resolved expression (or the input unchanged when it's not such a ternary). */
function resolveVariantConditional(expr: t.Expression, variant: string): t.Expression {
  let cur: t.Expression = expr;
  while (t.isConditionalExpression(cur)) {
    const test = cur.test;
    if (t.isBinaryExpression(test) && test.operator === '===' && t.isIdentifier(test.left)
        && (test.left.name === 'variant' || test.left.name === 'initialVariant')
        && t.isStringLiteral(test.right)) {
      cur = test.right.value === variant ? (cur.consequent as t.Expression) : (cur.alternate as t.Expression);
    } else break;
  }
  return cur;
}

/** A node's positioning/wrapper style props the instance overrode — these win over the master base. */
const wrapperKeys = new Set(['width', 'height', ...WRAPPER_ONLY_STYLE_PROPS]);

export function detachInstance(
  pageFilePath: string,
  instanceNodeId: string,
  componentFilePath: string,
  resolvedVariant = 'default',
  // Optional output: receives the NEW root node's data-id (the detached instance
  // becomes a normal node with a fresh `det-*` id) so the caller can re-select it.
  out?: { rootId?: string },
): string | null {
  try {
    const pageCode = projectFS.readFile(pageFilePath);
    const componentCode = projectFS.readFile(componentFilePath);
    if (!pageCode || !componentCode) return null;

    // 1. Read the instance tag from the page: its span + wrapper style props + data-name.
    const pageAst = parseJSX(pageCode);
    if (!pageAst) return null;
    let instStart = -1, instEnd = -1, instName = '';
    const wrapperStyle: t.ObjectProperty[] = [];
    const instanceProps = new Map<string, t.Expression>();   // prop name → override value on the instance tag
    findFirstElementByDataId(pageAst, instanceNodeId, (path) => {
      const n = path.node;
      if (n.start != null && n.end != null) { instStart = n.start; instEnd = n.end; }
      for (const a of n.openingElement.attributes) {
        if (!t.isJSXAttribute(a) || !t.isJSXIdentifier(a.name)) continue;
        const an = a.name.name;
        if (an === 'style') {
          if (a.value?.type === 'JSXExpressionContainer' && t.isObjectExpression(a.value.expression)) {
            for (const p of a.value.expression.properties) if (t.isObjectProperty(p)) wrapperStyle.push(p);
          }
          continue;
        }
        if (an === 'data-name') { if (t.isStringLiteral(a.value)) instName = a.value.value; continue; }
        if (an === 'data-id' || an === 'ref' || an === 'key' || an === 'initialVariant' || an === 'data-responsive') continue;
        // Everything else is a PROP override (e.g. azefazef="#244e70") — capture its value.
        let val: t.Expression | null = null;
        if (a.value == null) val = t.booleanLiteral(true);
        else if (t.isStringLiteral(a.value)) val = a.value;
        else if (a.value.type === 'JSXExpressionContainer' && t.isExpression(a.value.expression)) val = a.value.expression;
        if (val) instanceProps.set(an, val);
      }
    });
    if (instStart === -1) return null;

    // 2. Parse the component: collect variant objects + simple const-literal variables, find root JSX.
    const compAst = parseJSX(componentCode);
    if (!compAst) return null;
    const variantObjs = new Map<string, Map<string, t.ObjectProperty[]>>();  // varName → variant → props
    const constLiterals = new Map<string, t.Expression>();                   // hoisted literal/object consts
    // `const MotionLink = motion.create(Link)` — a motion-wrapped PRIMITIVE (not a
    // component instance). It's capitalised, so the nested-instance gate below would
    // misread it as a black-box instance and leave the master's internals dangling
    // (`{...style}`, `{title}`, `variant`, …). Map localName → base tag so detach
    // converts `<MotionLink>` → `<Link>` and inlines it like any motion element.
    const motionCreateLocals = new Map<string, string>();
    // Every identifier the COMPONENT declares (hooks, refs, variant state, the `style`/`initialVariant`
    // params, …). A detached node lives at PAGE scope where none of these exist, so any binding that
    // references one (a `ref={…Ref}`, a `scale: …FxCScale` motion value, `initialVariant={variant === …}`,
    // an `onTap={() => setVariant(…)}` handler) must be neutralized — else the page crashes with an
    // undefined identifier and the nested instances never render (the user-reported "they disappear").
    const scopeIds = new Set<string>(['variant', 'initialVariant', 'setVariant', 'style']);
    const propDefaults = new Map<string, t.Expression>();   // prop name → default value in the param list
    let rootJSX: t.JSXElement | null = null;
    traverse(compAst, {
      Function(path) {
        for (const p of path.node.params) {
          if (t.isObjectPattern(p)) for (const pr of p.properties) {
            if (t.isObjectProperty(pr) && t.isIdentifier(pr.key)) {
              scopeIds.add(pr.key.name);
              // `azefazef = "#97cffc"` → ObjectProperty value is an AssignmentPattern carrying the default.
              if (t.isAssignmentPattern(pr.value) && t.isExpression(pr.value.right)) propDefaults.set(pr.key.name, pr.value.right);
            } else if (t.isRestElement(pr) && t.isIdentifier(pr.argument)) {
              // `...rest` — the master's DOM-prop forwarder. Mark it component-scope
              // so the `{...rest}` spread attr is dropped when inlining (it has no
              // meaning on the detached page node).
              scopeIds.add(pr.argument.name);
            }
          } else if (t.isIdentifier(p)) scopeIds.add(p.name);
        }
      },
      VariableDeclarator(path) {
        // Record EVERY binding name (Identifier / destructured array+object) as component scope.
        const idn = path.node.id;
        if (t.isIdentifier(idn)) scopeIds.add(idn.name);
        else if (t.isArrayPattern(idn)) for (const e of idn.elements) { if (e && t.isIdentifier(e)) scopeIds.add(e.name); }
        else if (t.isObjectPattern(idn)) for (const pr of idn.properties) {
          if (t.isObjectProperty(pr) && t.isIdentifier(pr.value)) scopeIds.add(pr.value.name);
          else if (t.isRestElement(pr) && t.isIdentifier(pr.argument)) scopeIds.add(pr.argument.name);
        }
        if (!t.isIdentifier(path.node.id) || !path.node.init) return;
        const name = path.node.id.name;
        const init = path.node.init;
        // `const MotionLink = motion.create(Link)` → record MotionLink → Link.
        if (t.isCallExpression(init) && t.isMemberExpression(init.callee)
            && t.isIdentifier(init.callee.object, { name: 'motion' })
            && t.isIdentifier(init.callee.property, { name: 'create' })
            && init.arguments.length === 1 && t.isIdentifier(init.arguments[0])) {
          motionCreateLocals.set(name, init.arguments[0].name);
          return;
        }
        if (/Variants$/.test(name) && t.isObjectExpression(init)) {
          const byVariant = new Map<string, t.ObjectProperty[]>();
          for (const vp of init.properties) {
            if (!t.isObjectProperty(vp)) continue;
            const vName = t.isIdentifier(vp.key) ? vp.key.name : t.isStringLiteral(vp.key) ? vp.key.value : null;
            if (vName && t.isObjectExpression(vp.value)) {
              byVariant.set(vName, vp.value.properties.filter((p): p is t.ObjectProperty => t.isObjectProperty(p)));
            }
          }
          variantObjs.set(name, byVariant);
        } else if (t.isStringLiteral(init) || t.isNumericLiteral(init) || t.isObjectExpression(init)) {
          constLiterals.set(name, init);
        }
      },
      ReturnStatement(path) {
        if (rootJSX) return;
        const arg = path.node.argument;
        if (arg && t.isJSXFragment(arg)) return;
        // Unwrap transparent wrappers (LayoutGroup / MotionConfig) down to the first real element.
        const unwrap = (el: t.JSXElement | null): t.JSXElement | null => {
          if (!el) return null;
          const tag = el.openingElement.name;
          const tagName = t.isJSXIdentifier(tag) ? tag.name : '';
          if (tagName === 'LayoutGroup' || tagName === 'MotionConfig') {
            const child = el.children.find((c): c is t.JSXElement => t.isJSXElement(c));
            return unwrap(child ?? null);
          }
          return el;
        };
        if (arg && t.isJSXElement(arg)) rootJSX = unwrap(arg);
      },
    });
    if (!rootJSX) return null;

    // 3. Transform a clone of the root subtree.
    const clone = t.cloneNode(rootJSX, true) as t.JSXElement;

    // 3a. Deep-substitute component-scope PROP/const references with their concrete
    // values BEFORE the structural transform. A prop bound to a CMS field (e.g.
    // `image={item.image}`, `title={item.title}`) must resolve everywhere it's
    // referenced — inside a `url(${image})` template literal, a `{title}` text
    // child, a nested attr — not only when the whole expression is a bare
    // identifier. Without this, detaching a CMS-row instance left `image`/`title`
    // dangling (undefined at page scope) and the row crashed. `item` (the .map()
    // var) lives at page scope so it survives untouched; `style` is left for the
    // dedicated `...style` style-block below; variant state (`variant`/`setVariant`/
    // `initialVariant`) has no value here, so it stays for the transform to drop
    // along with the motion-only attrs (variants/initial/animate/on*).
    {
      const subFile = t.file(t.program([t.expressionStatement(clone)]));
      traverse(subFile, {
        Identifier(path) {
          if (!path.isReferencedIdentifier()) return;
          const nm = path.node.name;
          if (nm === 'style') return;
          const pv = instanceProps.get(nm) ?? propDefaults.get(nm);
          if (pv) { path.replaceWith(t.cloneNode(pv, true)); path.skip(); return; }
          if (constLiterals.has(nm)) { path.replaceWith(t.cloneNode(constLiterals.get(nm)!, true)); path.skip(); }
        },
      });
    }

    const idMap = new Map<string, string>();
    const freshId = (orig: string) => {
      if (!idMap.has(orig)) idMap.set(orig, generateNodeId('det'));
      return idMap.get(orig)!;
    };

    // Does an expression reference a component-scope identifier (a binding that won't exist on the
    // page)? `constLiterals` are exempt — they get inlined, not dropped. Must use REFERENCED-identifier
    // detection (not raw `traverseFast`): after the prop substitution above, a CMS binding reads as
    // `item.image` — the `image` here is a MEMBER PROPERTY, not a scope ref, so a naive name-match would
    // wrongly flag it and drop the whole style prop (symptom: `backgroundImage` vanished on detach).
    const refsScope = (node: t.Node): boolean => {
      let hit = false;
      const wrap = t.file(t.program([t.expressionStatement(t.cloneNode(node, true) as t.Expression)]));
      traverse(wrap, {
        Identifier(path) {
          if (path.isReferencedIdentifier() && scopeIds.has(path.node.name) && !constLiterals.has(path.node.name)) hit = true;
        },
      });
      return hit;
    };
    // Resolve a PROP (component param) to a concrete value: the instance's override if it passed one,
    // else the param's default. Props with neither (no override, no default) → undefined → caller drops.
    const propValue = (name: string): t.Expression | undefined =>
      instanceProps.get(name) ?? propDefaults.get(name);

    // Resolve an expression for the detached node:
    //   1. pick the chosen variant's ternary branch;
    //   2. a bare PROP identifier → inline its value (instance override ⊳ param default) — this is the
    //      "trace the variable's value" step the user wants (e.g. `backgroundColor: azefazef` → "#244e70");
    //   3. a hoisted const-literal → inline;
    //   4. still references component scope (a hook/ref/state, or a prop with no value) → null (drop).
    const neutralizeExpr = (expr: t.Expression): t.Expression | null => {
      const e = resolveVariantConditional(expr, resolvedVariant);
      if (t.isIdentifier(e)) {
        const pv = propValue(e.name);
        if (pv) return t.cloneNode(pv, true);
        if (constLiterals.has(e.name)) return t.cloneNode(constLiterals.get(e.name)!, true);
      }
      if (refsScope(e)) return null;
      return e;
    };

    // Statically evaluate a variant RENDER-GATE test against the detach's resolved
    // variant. `{variant !== "default" && <el/>}` is the canonical AnimatePresence-
    // conditional dialect (design-component reveal rows) — supports ===/!== on
    // variant/initialVariant vs a string literal. Returns null when it isn't one.
    const evalVariantTest = (test: t.Expression): boolean | null => {
      if (t.isBinaryExpression(test) && (test.operator === '===' || test.operator === '!==')
          && t.isIdentifier(test.left) && (test.left.name === 'variant' || test.left.name === 'initialVariant')
          && t.isStringLiteral(test.right)) {
        const eq = test.right.value === resolvedVariant;
        return test.operator === '===' ? eq : !eq;
      }
      // CHAINED gates: a master that hides an element on several variants emits
      // `variant !== "default-hover" && variant !== "default-pressed" && <svg/>`
      // (and the `||` mirror). Only the single-comparison form resolved, so the
      // chained one was copied VERBATIM into the page — where `variant` doesn't
      // exist, so the page died with "variant is not defined" and rendered
      // nothing at all (2026-08-08). Recurse through the operands; a `null`
      // (unrecognisable) side is only fatal when it can still decide the result.
      if (t.isLogicalExpression(test) && (test.operator === '&&' || test.operator === '||')
          && t.isExpression(test.left) && t.isExpression(test.right)) {
        const l = evalVariantTest(test.left);
        const r = evalVariantTest(test.right);
        if (test.operator === '&&') {
          if (l === false || r === false) return false;   // short-circuits regardless of the other
          return l === true && r === true ? true : null;
        }
        if (l === true || r === true) return true;
        return l === false && r === false ? false : null;
      }
      // Parenthesised / negated forms.
      if (t.isUnaryExpression(test) && test.operator === '!' && t.isExpression(test.argument)) {
        const v = evalVariantTest(test.argument);
        return v === null ? null : !v;
      }
      return null;
    };

    // the reference STRUCTURAL wrappers orchestrate variant/layout animation that no
    // longer exists on a detached node — unwrap them to their (resolved) children.
    const MOTION_WRAPPERS = new Set(['AnimatePresence', 'LayoutGroup', 'MotionConfig']);

    // Resolve a children list for the detached tree:
    //   • `{variant !== 'default' && <el/>}` gates → statically kept (unwrapped)
    //     or dropped for the resolved variant (live find 2026-07-13: Detach
    //     Instance kept the whole `<AnimatePresence>{variant !== "default" && …}`
    //     block verbatim — `variant`/`wtMetaVariants` undefined on the page,
    //     crash);
    //   • ternary renders `{variant === 'x' ? <A/> : <B/>}` → the chosen branch;
    //   • AnimatePresence/LayoutGroup/MotionConfig wrappers → replaced by their
    //     resolved children.
    const resolveDetachedChildren = (children: t.JSXElement['children']): t.JSXElement['children'] =>
      children.flatMap((c): t.JSXElement['children'] => {
        if (t.isJSXExpressionContainer(c)) {
          const e = c.expression;
          if (t.isLogicalExpression(e) && e.operator === '&&' && t.isExpression(e.left)
              && (t.isJSXElement(e.right) || t.isJSXFragment(e.right))) {
            const verdict = evalVariantTest(e.left);
            if (verdict === false) return [];
            if (verdict === true) {
              return t.isJSXFragment(e.right) ? resolveDetachedChildren(e.right.children) : resolveDetachedChildren([e.right]);
            }
          }
          if (t.isConditionalExpression(e) && t.isExpression(e.test)) {
            const verdict = evalVariantTest(e.test);
            // JSX branches → inline the chosen element.
            if (t.isJSXElement(e.consequent) || t.isJSXElement(e.alternate)) {
              if (verdict === true && t.isJSXElement(e.consequent)) return resolveDetachedChildren([e.consequent]);
              if (verdict === false) return t.isJSXElement(e.alternate) ? resolveDetachedChildren([e.alternate]) : [];
            } else if (verdict !== null) {
              // VALUE branches — per-variant TEXT is emitted as a nested ternary
              // chain: `{variant === "variant-4" ? "Get Started" : variant ===
              // "variant-7" ? "Get Started" : "Book a Call"}`. Only JSX branches
              // resolved, so the chain survived verbatim onto the page and threw
              // "variant is not defined" (2026-08-08). Walk the chain to the
              // branch this variant selects; a string lands as plain text, and
              // anything still unresolvable is left for the guards below.
              let cur: t.Expression = verdict ? e.consequent : e.alternate;
              for (let guard = 0; guard < 50 && t.isConditionalExpression(cur); guard++) {
                const v = evalVariantTest(cur.test);
                if (v === null) break;
                cur = v ? cur.consequent : cur.alternate;
              }
              if (t.isStringLiteral(cur)) return [t.jsxText(cur.value)];
              if (t.isJSXElement(cur) || t.isJSXFragment(cur)) return resolveDetachedChildren([cur as t.JSXElement]);
              if (!t.isConditionalExpression(cur)) return [t.jsxExpressionContainer(cur)];
            }
          }
          return [c];
        }
        if (t.isJSXElement(c)) {
          const nm = c.openingElement.name;
          const tn = t.isJSXIdentifier(nm) ? nm.name : '';
          if (MOTION_WRAPPERS.has(tn)) return resolveDetachedChildren(c.children);
        }
        return [c];
      });

    const transform = (el: t.JSXElement, isRoot: boolean) => {
      const op = el.openingElement;
      const tagName = t.isJSXIdentifier(op.name) ? op.name.name
        : t.isJSXMemberExpression(op.name) && t.isJSXIdentifier(op.name.property) ? op.name.property.name : '';
      // `motion.div` (member expr) OR a `motion.create(X)` local (`MotionLink`) — both
      // are motion-wrapped primitives, not nested instances. The latter converts to its
      // base tag (`MotionLink` → `Link`).
      const motionCreateBase = motionCreateLocals.get(tagName);
      const isMotion = (t.isJSXMemberExpression(op.name) && t.isJSXIdentifier(op.name.object) && op.name.object.name === 'motion')
        || !!motionCreateBase;
      // A NESTED component instance: a capitalised tag that ISN'T a motion.* element. Keep it as an
      // instance — just remap its data-id and STOP (its children come from its own master).
      const isNestedInstance = !isMotion && /^[A-Z]/.test(tagName);

      if (isMotion) {
        const newTag = motionCreateBase ?? tagName;   // <motion.div …> → <div …>; <MotionLink …> → <Link …>
        op.name = t.jsxIdentifier(newTag);
        if (el.closingElement) el.closingElement.name = t.jsxIdentifier(newTag);
      }

      // Clean the attributes. This runs on inlined nodes AND nested instances (the nested instance
      // must shed the PARENT's bindings — ref/handlers/dynamic initialVariant — to render standalone).
      let variantVar: string | null = null;
      op.attributes = op.attributes.flatMap((a): (t.JSXAttribute | t.JSXSpreadAttribute)[] => {
        // JSX SPREAD attr (`{...rest}` / `{...props}`): the master forwards DOM props
        // to its root via `...rest`, but that param doesn't exist on the detached PAGE
        // node — drop a spread that references component scope (else the inlined div
        // carries a meaningless `{...rest}` and crashes with "rest is not defined").
        if (t.isJSXSpreadAttribute(a)) return refsScope(a.argument) ? [] : [a];
        if (!t.isJSXAttribute(a) || !t.isJSXIdentifier(a.name)) return [a];
        const an = a.name.name;
        // `variants` — capture the bound const (for the variant-style merge), then drop motion-only
        // props on inlined nodes (nested instances keep `variants` since they're still motion-driven? no
        // — a detached page has no variants object, so drop everywhere except we already keep the spec).
        if (an === 'variants') {
          if (a.value?.type === 'JSXExpressionContainer' && t.isIdentifier(a.value.expression)) variantVar = a.value.expression.name;
          return [];
        }
        if (an === 'initial' || an === 'animate' || an === 'layout' || an === 'layoutId') return [];
        // React `key` (a conditional-render dialect artifact) and the solo-replica
        // marker are component-scoped concepts — meaningless on a detached page node.
        if (an === 'key' || an === 'data-replica-solo') return [];
        // `style` is handled by the dedicated style block below (it resolves the `...style` spread +
        // variant merge); leave it here so the generic scope-check doesn't drop it for containing `style`.
        if (an === 'style') return [a];
        // Refs + framer-motion event handlers bind into component scope (gesture animate, variant
        // connections) — they can't survive detach.
        if (an === 'ref') return [];
        if (/^on[A-Z]/.test(an)) return [];
        // `initialVariant` → resolve to a STATIC variant string (its ternary/hook binding is gone).
        if (an === 'initialVariant') {
          const resolved = a.value?.type === 'JSXExpressionContainer' && t.isExpression(a.value.expression)
            ? neutralizeExpr(a.value.expression) : null;
          const lit = resolved && (t.isStringLiteral(resolved)) ? resolved : t.stringLiteral(resolvedVariant);
          return [t.jsxAttribute(a.name, t.stringLiteral(t.isStringLiteral(lit) ? lit.value : resolvedVariant))];
        }
        // Any other expression-valued attr that references component scope → drop. String-literal attrs
        // (data-name, data-scroll-variant JSON, src, …) and resolvable expressions pass through.
        if (a.value?.type === 'JSXExpressionContainer' && t.isExpression(a.value.expression)) {
          const r = neutralizeExpr(a.value.expression);
          if (r === null) return [];
          return [t.jsxAttribute(a.name, t.jsxExpressionContainer(r))];
        }
        return [a];
      });

      // Remap data-id (+ stamp data-name on the root).
      for (const a of op.attributes) {
        if (t.isJSXAttribute(a) && t.isJSXIdentifier(a.name) && a.name.name === 'data-id'
            && t.isStringLiteral(a.value)) a.value = t.stringLiteral(freshId(a.value.value));
      }

      if (!isNestedInstance) {
        // Merge/resolve the style object: base ⊕ variant[resolvedVariant], resolve ternaries + vars,
        // and (root only) replace the `...style` spread with the instance's wrapper styles.
        const styleAttr = op.attributes.find((a): a is t.JSXAttribute =>
          t.isJSXAttribute(a) && t.isJSXIdentifier(a.name) && a.name.name === 'style');
        if (styleAttr && styleAttr.value?.type === 'JSXExpressionContainer' && t.isObjectExpression(styleAttr.value.expression)) {
          const obj = styleAttr.value.expression;
          const merged: t.ObjectProperty[] = [];
          const seen = new Set<string>();
          const keyOf = (p: t.ObjectProperty) => t.isIdentifier(p.key) ? p.key.name : t.isStringLiteral(p.key) ? p.key.value : '';
          const pushProp = (p: t.ObjectProperty) => {
            const k = keyOf(p); if (!k) return;
            let v = p.value;
            if (t.isExpression(v)) {
              // Drop motion-value / hook-bound style props (`scale: <cn>FxCScale`, `y: …SpeedY`) — they
              // reference component-scope hooks that don't exist on the detached page node.
              const n = neutralizeExpr(v);
              if (n === null) return;
              v = n;
            }
            const out = t.objectProperty(t.isStringLiteral(p.key) ? t.stringLiteral(k) : t.identifier(k), v as t.Expression);
            const i = merged.findIndex(m => keyOf(m) === k);
            if (i >= 0) merged[i] = out; else merged.push(out);
            seen.add(k);
          };
          for (const p of obj.properties) if (t.isObjectProperty(p)) pushProp(p);
          // Variant object styles for this element (resolvedVariant entry).
          const vEntry = variantVar ? variantObjs.get(variantVar)?.get(resolvedVariant) : null;
          if (vEntry) for (const p of vEntry) pushProp(p);
          // Root: the instance's wrapper styles win (they replace the `...style` spread).
          if (isRoot) for (const p of wrapperStyle) if (wrapperKeys.has(keyOf(p))) pushProp(p);
          obj.properties = merged;
        }
      }

      // Recurse into children EXCEPT for nested instances (their content is their own master's).
      // Children first resolve through the variant render-gate / motion-wrapper pass — an
      // `<AnimatePresence>{variant !== 'default' && <row/>}</AnimatePresence>` reveal either
      // disappears (variant not active) or inlines as a normal transformed subtree.
      if (!isNestedInstance) {
        el.children = resolveDetachedChildren(el.children);
        for (const c of el.children) if (t.isJSXElement(c)) transform(c, false);
      }
    };
    transform(clone, true);

    // FINAL RESOLVE SWEEP — runs LAST, after every inline/bake pass, so it can
    // only touch what those left behind. Nested INSTANCES survive detach as
    // instances (they aren't inlined), so their props were copied verbatim from
    // the master — including per-variant style ternaries like
    // `width: variant === 'variant-2' ? '100%' : ''`. On the page `variant`
    // doesn't exist, so the whole <Page> threw "variant is not defined" and
    // rendered nothing (2026-08-08, detaching a Header whose children are
    // instances). Resolve every remaining variant conditional to the branch
    // this detach's variant selects, and neutralize any other component-scope
    // identifier to `undefined` — a value the page can evaluate instead of a
    // reference that throws.
    {
      const sweepFile = t.file(t.program([t.expressionStatement(clone)]));
      traverse(sweepFile, {
        ConditionalExpression(path) {
          const verdict = evalVariantTest(path.node.test as t.Expression);
          if (verdict === null) return;
          path.replaceWith(verdict ? path.node.consequent : path.node.alternate);
        },
        LogicalExpression(path) {
          const verdict = evalVariantTest(path.node as t.Expression);
          if (verdict === null) return;
          path.replaceWith(t.booleanLiteral(verdict));
        },
      });
      traverse(sweepFile, {
        Identifier(path) {
          if (!path.isReferencedIdentifier()) return;
          const nm = path.node.name;
          if (nm === 'variant' || nm === 'initialVariant') {
            path.replaceWith(t.stringLiteral(resolvedVariant));
            path.skip();
            return;
          }
          if (scopeIds.has(nm) && !constLiterals.has(nm)) {
            path.replaceWith(t.identifier('undefined'));
            path.skip();
          }
        },
      });
    }

    // Report the detached root's fresh data-id so the caller can re-select it (the
    // instance is gone; its replacement is a normal node the user expects selected).
    if (out) {
      for (const a of clone.openingElement.attributes) {
        if (t.isJSXAttribute(a) && t.isJSXIdentifier(a.name) && a.name.name === 'data-id' && t.isStringLiteral(a.value)) {
          out.rootId = a.value.value;
        }
      }
    }

    // 4. Generate + splice into the page.
    const inlined = generate(clone, { concise: false, retainLines: false }).code;
    let result = pageCode.slice(0, instStart) + inlined + pageCode.slice(instEnd);

    // 5. Carry the NESTED instances' imports into the page — the inlined `<JiPaVu/>` etc. reference
    //    components the page didn't import (only the master did), so without this they'd be undefined
    //    and the nested instances wouldn't render. `extractReferencedComponentImports` pulls each
    //    referenced PascalCase tag's import LINE from the master; add any the page is missing.
    const carried: string[] = [];
    for (const importLine of extractReferencedComponentImports(inlined, componentCode)) {
      const local = importLine.match(/import\s+(?:\{\s*)?([A-Za-z_]\w*)/)?.[1];
      if (!local) continue;
      // Skip if the page already imports this local name (default OR named).
      if (new RegExp(`\\bimport\\b[^\\n]*\\b${local}\\b[^\\n]*from`).test(result)) continue;
      const line = importLine.trim().endsWith(';') ? importLine.trim() : importLine.trim() + ';';
      const lastImportIdx = result.lastIndexOf('\nimport ');
      if (lastImportIdx !== -1) {
        const eol = result.indexOf('\n', lastImportIdx + 1);
        result = result.slice(0, eol + 1) + line + '\n' + result.slice(eol + 1);
      } else {
        result = line + '\n' + result;
      }
      carried.push(local);
    }

    trace.action('component-ops:detach-instance', { instanceNodeId, componentFilePath, resolvedVariant, instName, idCount: idMap.size, carriedImports: carried });
    return result;
  } catch (err) {
    trace.error('component-ops:detachInstance-failed', { pageFilePath, instanceNodeId, componentFilePath, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

// ─── Delete Component ──────────────────────────────────────────────────────

/**
 * Delete a component file and remove all its instances + imports from the project.
 * Returns the list of files that were modified.
 */
export function deleteComponent(componentFilePath: string): string[] {
  const internalName = componentFilePath.replace('components/', '').replace('.tsx', '');
  trace.action('component-ops:delete', { componentFilePath, internalName });

  const modifiedFiles: string[] = [];

  // Find all project files that import this component and clean them
  const allFiles = projectFS.listFiles();
  for (const file of allFiles) {
    if (file === componentFilePath) continue;
    if (!file.endsWith('.tsx') && !file.endsWith('.ts')) continue;

    const code = projectFS.readFile(file);
    if (!code) continue;

    // Check if this file imports the component
    const importPattern = new RegExp(`import\\s+${internalName}\\s+from\\s+['"].*?${internalName}['"];?\\n?`);
    if (!importPattern.test(code)) continue;

    // Remove all JSX instances: self-closing <Name ... /> and open/close <Name ...>...</Name>
    let cleaned = code;

    // Self-closing: <InternalName ... />
    const selfClosingRe = new RegExp(`<${internalName}\\b[^>]*?\\/>\\s*`, 'g');
    cleaned = cleaned.replace(selfClosingRe, '');

    // Open/close: <InternalName ...>...</InternalName> (handles nested content)
    // Use a simple balanced-tag approach for non-nested same-tag cases
    const openCloseRe = new RegExp(`<${internalName}\\b[^>]*>[\\s\\S]*?<\\/${internalName}>\\s*`, 'g');
    cleaned = cleaned.replace(openCloseRe, '');

    // Run syncImports to remove the now-unused import line
    cleaned = syncImports(cleaned);

    if (cleaned !== code) {
      projectFS.writeFile(file, cleaned);
      modifiedFiles.push(file);
      trace.action('component-ops:delete-cleaned-file', { file, internalName });
    }
  }

  // Delete the component file itself
  projectFS.deleteFile(componentFilePath);
  clearComponentCache();

  trace.action('component-ops:delete-complete', { componentFilePath, modifiedFiles: modifiedFiles.length });
  return modifiedFiles;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Replace non-px dimension values (100%, auto, fill) in the root element's style
 * with computed pixel values. Only affects width and height on the FIRST style={{ block.
 */
export function replaceNonPxDimensions(jsx: string, computedWidth: number, computedHeight: number): string {
  const styleIdx = jsx.indexOf('style={{');
  if (styleIdx === -1) return jsx;

  // Find the matching }} for the root style
  const objStart = styleIdx + 'style={{'.length;
  let depth = 1, pos = objStart;
  while (pos < jsx.length && depth > 0) {
    if (jsx[pos] === '{') depth++;
    else if (jsx[pos] === '}') depth--;
    if (depth > 0) pos++;
  }
  const styleContent = jsx.slice(objStart, pos);

  let newStyleContent = styleContent;

  // Replace width if it's not a fixed px value
  const widthMatch = newStyleContent.match(/(width\s*:\s*)'([^']*?)'/);
  if (widthMatch) {
    const val = widthMatch[2];
    if (val === '100%' || val === 'auto' || val === 'fill' || val.endsWith('%')) {
      newStyleContent = newStyleContent.replace(widthMatch[0], `${widthMatch[1]}'${computedWidth}px'`);
    }
  }

  // Replace height if it's not a fixed px value
  const heightMatch = newStyleContent.match(/(height\s*:\s*)'([^']*?)'/);
  if (heightMatch) {
    const val = heightMatch[2];
    if (val === '100%' || val === 'auto' || val === 'fill' || val.endsWith('%')) {
      newStyleContent = newStyleContent.replace(heightMatch[0], `${heightMatch[1]}'${computedHeight}px'`);
    }
  }

  // FILL nodes (`flex: '1 0 0px'` — any grow with a ZERO basis) carry NO
  // width/height key at all: their size comes from growing in the parent's
  // flex layout. On the master ARTBOARD there is no flex parent, so basis-0
  // collapsed the root to 0px wide (live find 2026-07-08: Make Component on a
  // Fill row → master Width 0). Inject the COMPUTED px for whichever axis has
  // no key so the master matches the page visually. The instance tag keeps
  // its own `flex: '1 0 0px'` placement, which beats the injected px on the
  // published page (a zero flex-basis takes precedence over width as the
  // flex base size), so instances still fill.
  const fillFlex = /flex\s*:\s*['"][1-9][\d.]*\s+[\d.]+\s+0(?:px|%)?['"]/.test(newStyleContent);
  if (fillFlex) {
    if (!/(?<![\w-])width\s*:/.test(newStyleContent) && computedWidth > 0) {
      newStyleContent = ` width: '${computedWidth}px',` + newStyleContent;
    }
    if (!/(?<![\w-])height\s*:/.test(newStyleContent) && computedHeight > 0) {
      newStyleContent = ` height: '${computedHeight}px',` + newStyleContent;
    }
    // Resolve the fill itself to FIXED on the master root: the artboard has no
    // flex parent, so `flex: '1 0 0px'` is meaningless there — the panel reads
    // the root as "Fill" with a nonsense basis-0. Fill placement belongs to the
    // INSTANCE tag, which carries its own `flex: '1 0 0px'` in wrapper style
    // (spread LAST via ...style, so it wins) — page rows still fill.
    newStyleContent = newStyleContent.replace(/(flex\s*:\s*)['"][1-9][\d.]*\s+[\d.]+\s+0(?:px|%)?['"]/, "$1'0 0 auto'");
  }

  if (newStyleContent === styleContent) return jsx;
  return jsx.slice(0, objStart) + newStyleContent + jsx.slice(pos);
}

/**
 * Find all `variants={someName}` references in the extracted JSX and return
 * the matching `const someName = {...};` declarations from the source page,
 * verbatim. Used during Make Component to carry per-element variant style
 * objects into the new component file — otherwise `<motion.div
 * variants={frameXxxVariants}>` lands in a file where that const doesn't
 * exist and the runtime crashes with ReferenceError on first render.
 */
/**
 * Find all PascalCase JSX tags used in `jsx` and return any matching
 * import statements from `pageCode`. Used by `makeComponent` so that
 * when a wrapped fragment references a code component (e.g. <MeshGradient />)
 * or another in-project component, the generated component file ALSO
 * imports those identifiers — otherwise the new file references an
 * undefined identifier and the live preview crashes with
 * `ReferenceError: MeshGradient is not defined`.
 *
 * Returns the verbatim `import ... from '...';` lines so quote style /
 * default-vs-named / member specifiers all survive unchanged.
 *
 * Built-ins already provided by `buildComponentFile`'s template
 * (`React`, `motion`, `LayoutGroup`, `withResponsiveProps`) are stripped
 * to avoid duplicate imports.
 */
function extractReferencedComponentImports(jsx: string, pageCode: string): string[] {
  // Collect every PascalCase opening-tag identifier in the JSX. Excludes
  // `motion.div` / `motion.span` / etc. (the motion conversion happens
  // AFTER this step in `buildComponentFile`, so the JSX we see here has
  // raw `<MeshGradient>` not `<motion.MeshGradient>` — but we filter on
  // `.` just in case future callers pass already-converted JSX in).
  const referenced = new Set<string>();
  const tagRegex = /<([A-Z][A-Za-z0-9_]*)(?=[\s/>])/g;
  let m: RegExpExecArray | null;
  while ((m = tagRegex.exec(jsx)) !== null) {
    const tag = m[1];
    if (tag.includes('.')) continue;
    referenced.add(tag);
  }
  // VALUE imports referenced in EXPRESSIONS — the tag scan above only sees
  // PascalCase TAGS, so a page's CMS data import
  // (`import collection1 from '@/cms/collection-1.json'`) was never carried
  // and the extracted collection lists rendered EMPTY in the new master
  // (undefined `collection1`; user report 2026-07-28: "made the blog section
  // a component and all the blogs are just empty"). Word-boundary usage is
  // tested against the JSX with STRING LITERALS stripped, so a
  // `data-name="Link-…"` / `data-id` value never counts as a reference.
  const jsxNoStrings = jsx.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '""');
  const usedInExpr = (id: string) => new RegExp(`\\b${id}\\b`).test(jsxNoStrings);

  // Built-ins shipped by `buildComponentFile`'s hardcoded import block.
  // Skip them so we don't end up with two `motion` imports etc.
  const builtIn = new Set(['React', 'motion', 'LayoutGroup']);
  const carried: string[] = [];
  // Match each top-of-file `import ... from '...';` line. Default and
  // named-member imports are both handled by checking the match against
  // each referenced identifier.
  const importRegex = /^[ \t]*import\s+([\s\S]*?)\s+from\s+['"][^'"]+['"];?/gm;
  let im: RegExpExecArray | null;
  while ((im = importRegex.exec(pageCode)) !== null) {
    const fullLine = im[0];
    const specPart = im[1].trim();
    // Skip side-effect imports (no specifier); we never need to re-emit
    // those in extracted components since they're page-level concerns.
    if (!specPart) continue;
    // Collect all identifiers this import line introduces:
    //   `import Foo from '...'`              → ['Foo']
    //   `import { A, B as C } from '...'`    → ['A', 'C']
    //   `import Foo, { A } from '...'`       → ['Foo', 'A']
    //   `import * as Ns from '...'`          → ['Ns']
    const ids: string[] = [];
    const namedMatch = specPart.match(/\{([^}]+)\}/);
    if (namedMatch) {
      for (const part of namedMatch[1].split(',')) {
        const piece = part.trim();
        if (!piece) continue;
        // Handle `A as B` — the LOCAL name is the post-`as`.
        const asMatch = piece.match(/^\w+\s+as\s+(\w+)$/);
        ids.push(asMatch ? asMatch[1] : piece.split(/\s+/)[0]);
      }
    }
    const defaultPart = specPart.split('{')[0].replace(/,$/, '').trim();
    if (defaultPart) {
      const nsMatch = defaultPart.match(/^\*\s+as\s+(\w+)$/);
      if (nsMatch) ids.push(nsMatch[1]);
      else if (/^[A-Za-z_]\w*$/.test(defaultPart)) ids.push(defaultPart);
    }
    // Carry over ONLY if at least one of this import's locals is referenced
    // in the JSX AND it isn't shadowing a built-in.
    if (ids.some(id => (referenced.has(id) || usedInExpr(id)) && !builtIn.has(id))) {
      carried.push(fullLine);
    }
  }
  return carried;
}

/**
 * Slot-connection support for Make Component.
 *
 * When the extracted JSX contains code-component instances with slot
 * connections (e.g. `<Marquee>{cn_frame_xyz_1}{cn_frame_abc_2}</Marquee>`),
 * the page-level `const cn_<id> = …` declarations those refs point to also
 * need to live in the new component file — otherwise the moved code
 * component renders blank (undefined identifier).
 *
 * Behaviour: COPY the connected canvas-node declarations into the component
 * file as its own CONNECTED slot nodes. Each copy gets a fresh suffix
 * appended to its data-id (and nested data-ids) so it never collides with
 * the page original; the moved code-component refs in the extracted JSX are
 * rewritten to the new names. The copies are positioned to the LEFT of the
 * primary viewport (workspace coords, right edges aligned at x = -32),
 * stacked vertically — they live on the MASTER's canvas now. The page
 * originals STAY on the page as normal, now-DISCONNECTED canvas nodes (the
 * referencing slot JSX left with the extraction) — deliberately not removed;
 * the user keeps them as free workspace nodes (confirmed 2026-07-28).
 *
 * Recursive: a duplicated cn-decl may itself contain code-component
 * instances with their own slot refs. Those nested refs are walked and
 * duplicated too, with refs in turn rewritten.
 */
function extractReferencedSlotConsts(
  rootJSX: string,
  pageCode: string,
): { consts: string[]; rewrittenJSX: string } {
  const pageAst = parseJSX(pageCode);
  if (!pageAst) return { consts: [], rewrittenJSX: rootJSX };

  // All `const cn_… = <jsx>` declarations in the page, by const name.
  const allDecls = new Map<string, t.VariableDeclarator>();
  traverse(pageAst, {
    VariableDeclarator(path) {
      const id = path.node.id;
      if (id.type === 'Identifier' && id.name.startsWith('cn_')) {
        allDecls.set(id.name, path.node);
      }
    },
  });
  if (allDecls.size === 0) return { consts: [], rewrittenJSX: rootJSX };

  // Walk the extracted JSX for `{cn_<id>}` refs, then recursively walk each
  // decl's JSX for nested refs (handles slot containers nested inside
  // canvas nodes).
  const referenced = new Set<string>();
  const queue: string[] = [];
  const REF_RX = /\{\s*(cn_\w+)\s*\}/g;
  const seedMatches = (text: string): void => {
    REF_RX.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = REF_RX.exec(text)) !== null) {
      const name = m[1];
      if (!referenced.has(name) && allDecls.has(name)) {
        referenced.add(name);
        queue.push(name);
      }
    }
  };
  seedMatches(rootJSX);
  while (queue.length > 0) {
    const name = queue.shift()!;
    const decl = allDecls.get(name)!;
    if (decl.init?.start != null && decl.init.end != null) {
      seedMatches(pageCode.slice(decl.init.start, decl.init.end));
    }
  }
  if (referenced.size === 0) return { consts: [], rewrittenJSX: rootJSX };

  // Fresh suffix for this Make-Component operation — appended to every
  // duplicated data-id to keep them unique vs the originals on the page.
  const suffix = Math.random().toString(36).slice(2, 8);

  // Build the rename map: oldConstName → newConstName.
  const nameMap = new Map<string, string>();
  for (const oldName of referenced) {
    const decl = allDecls.get(oldName)!;
    if (decl.init?.start == null || decl.init.end == null) continue;
    const declText = pageCode.slice(decl.init.start, decl.init.end);
    const m = declText.match(/data-id="([^"]+)"/);
    if (!m) continue;
    const newDataId = m[1] + '-' + suffix;
    nameMap.set(oldName, 'cn_' + newDataId.replace(/[^a-zA-Z0-9]/g, '_'));
  }

  // Rewrite the extracted JSX so `{cn_<old>}` references point at the
  // duplicated const names (preserves any whitespace inside the braces).
  let rewrittenJSX = rootJSX;
  for (const [oldName, newName] of nameMap) {
    rewrittenJSX = rewrittenJSX.replace(
      new RegExp('\\{\\s*' + oldName + '\\b', 'g'),
      '{' + newName,
    );
  }

  // Build the duplicate const declarations.
  const consts: string[] = [];
  let stackedTop = 0;
  for (const [oldName, newName] of nameMap) {
    const decl = allDecls.get(oldName)!;
    if (decl.init?.start == null || decl.init.end == null) continue;
    let declText = pageCode.slice(decl.init.start, decl.init.end);

    // Suffix every data-id (root + nested children) so the duplicate is
    // unique. The root data-id naturally matches the new const name.
    declText = declText.replace(/data-id="([^"]+)"/g, (_full, did) => `data-id="${did}-${suffix}"`);

    // Rewrite nested cn refs inside this decl to the duplicate names too.
    for (const [innerOld, innerNew] of nameMap) {
      declText = declText.replace(
        new RegExp('\\{\\s*' + innerOld + '\\b', 'g'),
        '{' + innerNew,
      );
    }

    // Reposition to the left of the primary viewport, stacked vertically.
    const wMatch = declText.match(/width:\s*['"]?(\d+(?:\.\d+)?)(?:px)?['"]?/);
    const hMatch = declText.match(/height:\s*['"]?(\d+(?:\.\d+)?)(?:px)?['"]?/);
    const w = wMatch ? parseFloat(wMatch[1]) : 200;
    const h = hMatch ? parseFloat(hMatch[1]) : 200;
    const newLeft = -w - 32;
    const newTop = stackedTop;
    stackedTop += h + 16;

    let leftReplaced = false, topReplaced = false;
    declText = declText.replace(/left:\s*['"]?-?\d+(?:\.\d+)?(?:px)?['"]?/, () => {
      leftReplaced = true; return "left: '" + newLeft + "px'";
    });
    declText = declText.replace(/top:\s*['"]?-?\d+(?:\.\d+)?(?:px)?['"]?/, () => {
      topReplaced = true; return "top: '" + newTop + "px'";
    });
    // If the decl had no left/top yet (rare — a component-instance cn whose
    // positioning lives elsewhere), inject them into the first style object.
    if ((!leftReplaced || !topReplaced) && /style=\{\{/.test(declText)) {
      declText = declText.replace(/style=\{\{/, "style={{ left: '" + newLeft + "px', top: '" + newTop + "px', position: 'absolute',");
    }

    consts.push("const " + newName + " = " + declText + ";");
  }

  trace.action('component-ops:duplicate-slot-consts', { count: consts.length, suffix });
  return { consts, rewrittenJSX };
}

function extractReferencedVariantConsts(
  jsx: string,
  pageCode: string,
): { consts: string[]; constNames: string[] } {
  const referenced = new Set<string>();
  // Also unwrap the instance-size-override form `variants={__applyInstanceSize(foo, …)}`.
  const refRegex = /variants=\{(?:__applyInstanceSize\()?(\w+)/g;
  let match: RegExpExecArray | null;
  while ((match = refRegex.exec(jsx)) !== null) {
    referenced.add(match[1]);
  }
  if (referenced.size === 0) return { consts: [], constNames: [] };

  const consts: string[] = [];
  const constNames: string[] = [];
  for (const constName of referenced) {
    // Match `const X = { ... };` — block matched by walking braces so nested
    // objects survive intact. `lastIndex`-style scan would lose nested {}.
    const declStart = pageCode.search(new RegExp(`const\\s+${constName}\\s*=\\s*\\{`));
    if (declStart === -1) continue;
    const braceStart = pageCode.indexOf('{', declStart);
    let depth = 1;
    let pos = braceStart + 1;
    while (pos < pageCode.length && depth > 0) {
      const ch = pageCode[pos];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      pos++;
    }
    if (depth !== 0) continue;
    // Include trailing semicolon if present
    const end = pageCode[pos] === ';' ? pos + 1 : pos;
    consts.push(pageCode.slice(declStart, end));
    constNames.push(constName);
  }
  return { consts, constNames };
}

/**
 * Build a single-variant component file (default behavior).
 */
/**
 * Convert inline CSS `transform: 'rotate()/scale()/skew()…'` in a component's
 * JSX style objects into motion MOTION PROPS (`rotate: 30`, `scale: 1.2`, …).
 * Only touches transforms that carry a rotate/scale/skew (animation
 * transforms); a pure `translate(...)` (position/centering) is left as CSS.
 * Numeric values are emitted unquoted (motion + the generator treat
 * `rotate`/`x`/`y`/`scale` as numeric); percentage values stay quoted.
 */
function normalizeInlineTransformsToMotionProps(jsx: string): string {
  return jsx.replace(/transform:\s*(['"])([^'"]*)\1\s*,?/g, (full, _q: string, value: string) => {
    if (!/\b(rotate|scale|skew)/i.test(value)) return full; // pure translate → leave as CSS
    const motion = cssTransformToMotionProps(value);
    const keys = Object.keys(motion);
    if (keys.length === 0) return full;
    const parts = keys.map((k) => {
      const v = motion[k];
      return /^-?\d+(\.\d+)?$/.test(v) ? `${k}: ${v}` : `${k}: '${v}'`;
    });
    return parts.join(', ') + ', ';
  });
}

/**
 * Normalize the component master ROOT element to `position: 'absolute'`. The
 * canvas places each variant TILE via variantConfig (x/y), so the root must be
 * absolute — `fixed`/`sticky` would pin it to the editor viewport (floating
 * over everything, breaking the tiles), `relative`/`static` don't anchor to the
 * tile. Quote-agnostic. Strips a fixed/sticky bar's viewport-centering
 * artifacts (`left: '50%'` + `translate(-50%)`). Only the FIRST (root) style
 * object. Shared by the single- AND multi-variant build paths.
 */
function normalizeMasterRootPosition(styleSpreadJsx: string): string {
  const firstStyleIdx = styleSpreadJsx.indexOf('style={{');
  if (firstStyleIdx === -1) return styleSpreadJsx;
  const afterStyle = styleSpreadJsx.indexOf('}}', firstStyleIdx);
  if (afterStyle === -1) return styleSpreadJsx;
  let styleBlock = styleSpreadJsx.substring(firstStyleIdx, afterStyle + 2);
  const wasFixed = /position:\s*['"](fixed|sticky)['"]/.test(styleBlock);
  if (/position:\s*['"](relative|fixed|sticky|static)['"]/.test(styleBlock)) {
    styleBlock = styleBlock.replace(/position:\s*['"](relative|fixed|sticky|static)['"]/, "position: 'absolute'");
  } else if (!/position:\s*['"]absolute['"]/.test(styleBlock)) {
    styleBlock = styleBlock.replace('style={{', "style={{ position: 'absolute',");
  }
  if (wasFixed) {
    styleBlock = styleBlock
      .replace(/(?:left|right|top|bottom):\s*['"]50%['"],?\s*/g, '')
      .replace(/transform:\s*['"]translate[XY]?\([^'"]*\)['"],?\s*/g, '');
  }
  return styleSpreadJsx.substring(0, firstStyleIdx) + styleBlock + styleSpreadJsx.substring(afterStyle + 2);
}

/** Convert next/link `<Link>` tags to `MotionLink` (`motion.create(Link)`) so
 *  an extracted Link participates in variants/FLIP like every other master
 *  element. motion props (variants/animate/layout) are SILENTLY IGNORED on a
 *  plain React component — a `<Link>` root made the whole design component
 *  inert: no variants, no connections, no FLIP (live find 2026-07-14:
 *  "Explore CTA" pill via Make Component). Same escape hatch design
 *  components already use (MotionLink const) and updateMotionPropInCode
 *  applies on pages via convertToMotionLinkInCode. */
function convertLinksToMotionLink(jsx: string): { jsx: string; converted: boolean } {
  if (!/<Link[\s/>]/.test(jsx)) return { jsx, converted: false };
  return {
    jsx: jsx.replace(/<Link(?=[\s/>])/g, '<MotionLink').replace(/<\/Link>/g, '</MotionLink>'),
    converted: true,
  };
}

/** The import + module-scope declaration block a `<MotionLink>` needs in a
 *  freshly built master file. Fires when the final JSX REFERENCES MotionLink —
 *  whether `convertLinksToMotionLink` just converted a plain `<Link>` OR the
 *  extracted source already used `<MotionLink>` (its `const MotionLink =
 *  motion.create(Link)` lives at the SOURCE file's module scope and is never
 *  carried by the tag-import scan, so the new master crashed on the live site
 *  with `MotionLink is not defined` — user report 2026-07-28, Sign Up button
 *  componentized out of a header). `import Link from 'next/link'` and the
 *  const are each skipped when the carried imports/consts already provide
 *  them. */
function motionLinkDeclBlock(finalJsx: string, carriedImports: string[], carriedConsts: string[]): string {
  if (!/<MotionLink\b/.test(finalJsx)) return '';
  const constCarried = carriedConsts.some(c => /\bconst\s+MotionLink\s*=/.test(c));
  const needsLinkImport = !carriedImports.some(l => l.includes("'next/link'") || l.includes('"next/link"'));
  const block = `${needsLinkImport ? "import Link from 'next/link';\n" : ''}${constCarried ? '' : '\nconst MotionLink = motion.create(Link);\n'}`;
  if (block) trace.action('component-ops:motionlink-decl-block', { needsLinkImport, constCarried });
  return block;
}

function buildComponentFile(name: string, displayName: string, jsx: string, carriedConsts: string[] = [], carriedImports: string[] = []): string {
  // Convert ALL elements to motion.* for layout FLIP animations between variants.
  // Every element needs to be a motion component so layout={true} works on it.
  const HTML_TAGS = new Set(['div', 'p', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'button', 'section', 'article', 'nav', 'header', 'footer', 'main', 'aside', 'ul', 'ol', 'li', 'img', 'figure', 'figcaption', 'blockquote', 'pre', 'code', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'form', 'input', 'textarea', 'select', 'label', 'video', 'audio', 'canvas', 'details', 'summary']);
  let motionJsx = jsx;
  // Convert opening tags: <div → <motion.div (skip already-converted and self-closing style/br/hr/img)
  // `[\s>]` (not just \s) so a BARE tag with no attributes — `<span>` from a
  // rich-text mark — converts too. The closing-tag pass below converts
  // `</span>` unconditionally, so skipping the attribute-less opening produced
  // MISMATCHED pairs (`<span>…</motion.span>`) and the whole component file
  // failed to parse: blank master, empty layers (2026-07-28).
  motionJsx = motionJsx.replace(/<(\w+)([\s>])/g, (match, tag, ch) => {
    if (tag.startsWith('motion') || !HTML_TAGS.has(tag)) return match;
    return `<motion.${tag}${ch}`;
  });
  // Convert closing tags: </div> → </motion.div>
  motionJsx = motionJsx.replace(/<\/(\w+)>/g, (match, tag) => {
    if (tag.startsWith('motion') || !HTML_TAGS.has(tag)) return match;
    return `</motion.${tag}>`;
  });
  // next/link <Link> → <MotionLink> (the motion.* proxy can't wrap it, but a
  // plain Link silently ignores every motion prop — see convertLinksToMotionLink).
  const linkConv = convertLinksToMotionLink(motionJsx);
  motionJsx = linkConv.jsx;

  const lines = motionJsx.split('\n');
  const indented = lines.map((line, i) => i === 0 ? line : '    ' + line).join('\n');

  let styleSpreadJsx = injectStyleSpread(indented);

  // Normalize the root element to position: 'absolute' for canvas master tiling.
  styleSpreadJsx = normalizeMasterRootPosition(styleSpreadJsx);

  // Convert inline CSS `transform` (rotate / scale / skew) on the now-motion.*
  // elements into motion MOTION PROPS, so they compose with the layout FLIP
  // instead of fighting it (a raw `transform` string clobbers motion's
  // projection → the "animates then reverts" bug). Pure-translate transforms
  // (position / centering) stay as CSS — converting them risks altering pinned
  // layout. The canvas Renderer folds the motion props back to CSS for tiles.
  styleSpreadJsx = normalizeInlineTransformsToMotionProps(styleSpreadJsx);

  // Add layout={true} to ALL motion elements for FLIP animations between variants.
  // STRIP any existing layout={true} first — extracting nodes that ALREADY live
  // inside a component master (nested make-component) carries their layout attr
  // along, and blindly prepending a second one corrupts the file with a duplicate
  // JSX attribute that blocks every later mutation (live find 2026-07-13: nested
  // cross component). Strip-then-add is idempotent.
  styleSpreadJsx = styleSpreadJsx.replace(/\s+layout=\{true\}/g, '');
  styleSpreadJsx = styleSpreadJsx.replace(/<motion\.(\w+)(\s)/g, '<motion.$1 layout={true}$2');
  styleSpreadJsx = styleSpreadJsx.replace(/<MotionLink(\s)/g, '<MotionLink layout={true}$1');
  // NOTE: the fixed/sticky-header fix (`layoutScroll` scroll-boundary on the root)
  // is NOT applied at creation — it's added on-demand by the reactive `updateStyles`
  // hook the moment an instance is actually set to position fixed/sticky (see
  // ensureLayoutRootOnComponentRoot + mutation-queue). So a normal (relative)
  // component is created untouched with plain layout={true}.

  // Forward instance-passed DOM props (onClick / data-overlay-trigger / data-id)
  // to the root so overlays on a component INSTANCE work on the live site.
  styleSpreadJsx = injectRestSpread(styleSpreadJsx);

  // Variant style consts carried over from the parent file (e.g.
  // `const frameXxxVariants = { default: {...}, 'variant-1': {...} };`)
  // — these declarations must live in the same module as the JSX that
  // references them via `variants={...}`. Stitched in below the
  // variantConfig and above the function declaration.
  // Split the carried consts: variants OBJECTS stay above the function (their
  // conventional spot), but slot-connected `cn_` CANVAS-NODE decls go BELOW the
  // export — the page dialect's own convention — so the entry-fit scanner's
  // "first data-id element = component root" assumption holds (a cn_ marquee
  // card declared above the function made component entry fit a ~350px card
  // box at ~200% zoom, 2026-07-28).
  const slotConstsBlockOf = (all: string[]): string => {
    const slots = all.filter((x) => x.startsWith('const cn_'));
    return slots.length > 0 ? `\n${slots.join('\n')}\n` : '';
  };
  const aboveConsts = carriedConsts.filter((x) => !x.startsWith('const cn_'));
  const slotConstsBlock = slotConstsBlockOf(carriedConsts);
  const carriedConstsBlock = aboveConsts.length > 0
    ? `\n${aboveConsts.join('\n')}\n`
    : '';

  // Imports carried over from the parent file for any non-builtin
  // components referenced by the extracted JSX (e.g. <MeshGradient />).
  // Stitched in below the hardcoded React/motion/runtime imports so they
  // sit in the conventional spot at the top of the file.
  const carriedImportsBlock = carriedImports.length > 0
    ? `${carriedImports.join('\n')}\n`
    : '';

  return `import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
${carriedImportsBlock}${motionLinkDeclBlock(styleSpreadJsx, carriedImports, carriedConsts)}
/** @name "${displayName}" */

const variantConfig = [
  { name: 'default', label: '${displayName}', x: 0, y: 0, isPrimary: true },
];
${carriedConstsBlock}
function ${name}({ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  return (
    <LayoutGroup>
    ${styleSpreadJsx}
    </LayoutGroup>
  );
}

export default withResponsiveProps(${name});
${slotConstsBlock}`;
}

/**
 * Build a multi-variant component file for direct viewport children.
 * Creates one variant per viewport, each with computed dimensions.
 * The default (desktop) variant uses the base inline styles.
 * Other variants (tablet, mobile) get width/height overrides in variant objects.
 */
function buildMultiVariantComponentFile(
  name: string,
  displayName: string,
  jsx: string,
  viewportDims: ViewportDimensions[],
  carriedImports: string[] = [],
  carriedConsts: string[] = [],
): string {
  // Convert ALL elements to motion.* for layout FLIP animations
  const HTML_TAGS_MV = new Set(['div', 'p', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'button', 'section', 'article', 'nav', 'header', 'footer', 'main', 'aside', 'ul', 'ol', 'li', 'img', 'figure', 'figcaption', 'blockquote', 'pre', 'code', 'table', 'form', 'input', 'textarea', 'select', 'label', 'video', 'audio']);
  let motionJsx = jsx;
  // `[\s>]` for bare tags — same mismatched-pair fix as buildComponentFile.
  motionJsx = motionJsx.replace(/<(\w+)([\s>])/g, (match, tag, ch) => {
    if (tag.startsWith('motion') || !HTML_TAGS_MV.has(tag)) return match;
    return `<motion.${tag}${ch}`;
  });
  motionJsx = motionJsx.replace(/<\/(\w+)>/g, (match, tag) => {
    if (tag.startsWith('motion') || !HTML_TAGS_MV.has(tag)) return match;
    return `</motion.${tag}>`;
  });
  // next/link <Link> → <MotionLink> — same as buildComponentFile.
  const linkConvMV = convertLinksToMotionLink(motionJsx);
  motionJsx = linkConvMV.jsx;

  // Extract root data-id for variants const naming
  const dataIdMatch = motionJsx.match(/data-id="([^"]*)"/);
  const rootDataId = dataIdMatch ? dataIdMatch[1] : 'root';
  const variantsVarName = rootDataId.replace(/-(.)/g, (_, c: string) => c.toUpperCase()).replace(/-/g, '') + 'Variants';

  const lines = motionJsx.split('\n');
  const indented = lines.map((line, i) => i === 0 ? line : '    ' + line).join('\n');

  let styleSpreadJsx = injectStyleSpread(indented);

  // Normalize the root element to position: 'absolute' for canvas master tiling
  // — same as buildComponentFile. Without this a `position: fixed` root stays
  // fixed and pins to the editor viewport instead of sitting in its tile.
  styleSpreadJsx = normalizeMasterRootPosition(styleSpreadJsx);

  // Add variants={...} prop after data-id
  const idPattern = `data-id="${rootDataId}"`;
  const idIdx = styleSpreadJsx.indexOf(idPattern);
  if (idIdx !== -1) {
    const insertAfter = idIdx + idPattern.length;
    // An appear-carrying root already has an OBJECT-form `initial` — adding the
    // variant-array initial would emit a DUPLICATE JSX attribute (React keeps
    // the last, the parser reads the first, and the pre-flush validator then
    // blocks every edit to the new component; 2026-07-28). Keep the appear
    // initial and inject only `animate` — motion animates from the appear state
    // into the variant labels on mount (connection-config precedent 2026-07-03).
    const rootTagEnd = findTagClose(styleSpreadJsx, idIdx);
    const rootTag = rootTagEnd !== -1 ? styleSpreadJsx.slice(idIdx, rootTagEnd) : '';
    const rootInitial = rootTag.includes(' initial={') ? '' : ` initial={['default', initialVariant]}`;
    styleSpreadJsx = styleSpreadJsx.slice(0, insertAfter) + ` variants={${variantsVarName}}${rootInitial} animate={['default', initialVariant]}` + styleSpreadJsx.slice(insertAfter);
  }

  // Forward instance-passed DOM props (onClick / data-overlay-trigger / data-id) to
  // the root — placed AFTER the variants injection so structural props stay last.
  styleSpreadJsx = injectRestSpread(styleSpreadJsx);

  // Build variantConfig entries
  // Gap = 20% of the variant's own width (min 40px) — a flat 40px looked
  // cramped next to a wide variant ("way too close"); scaling it gives clear
  // breathing room at any size.
  const MIN_VARIANT_GAP = 40;
  const gapFor = (w: number) => Math.max(MIN_VARIANT_GAP, Math.round(w * 0.2));
  const primary = viewportDims.find(v => v.vpId === 'desktop') ?? viewportDims[0];
  let currentX = 0;
  const variantConfigEntries = viewportDims.map((vp, i) => {
    const varName = i === 0 ? 'default' : `variant-${i}`;
    const label = vp.vpLabel || displayName;
    const entry = `  { name: '${varName}', label: '${label}', x: ${Math.round(currentX)}, y: 0${i === 0 ? ', isPrimary: true' : ''} }`;
    // Lay variants out left-to-right, advancing by THIS variant's OWN width +
    // its proportional gap — so each variant sits right after the previous one.
    // (Was `Math.max(vp.width, primary.width)`, which forced every stride to the
    // widest/primary width → narrower variants left a huge gap before the next.)
    currentX += vp.width + gapFor(vp.width);
    return entry;
  });

  // Build variant style objects (default = empty since base styles are inline)
  // Other variants get width/height overrides
  const variantEntries = viewportDims.map((vp, i) => {
    if (i === 0) return `  default: { width: '${primary.width}px', height: '${primary.height}px' }`;
    const varName = `variant-${i}`;
    return `  '${varName}': { width: '${vp.width}px', height: '${vp.height}px' }`;
  });

  // Convert inline CSS `transform` (rotate/scale/skew) on the now-motion.*
  // elements into motion MOTION PROPS — same as buildComponentFile. Without
  // this, a child rotated on the page (`transform: 'rotate(28deg)'`) keeps the
  // CSS string after componentizing, which fights the layout FLIP on the new
  // motion element. The canvas Renderer folds the motion props back to CSS.
  styleSpreadJsx = normalizeInlineTransformsToMotionProps(styleSpreadJsx);

  // Add layout={true} to ALL motion elements for FLIP animations. Strip any
  // existing layout attr first — nested make-component extracts subtrees that
  // already carry it (see buildComponentFile) — so the add stays idempotent.
  styleSpreadJsx = styleSpreadJsx.replace(/\s+layout=\{true\}/g, '');
  styleSpreadJsx = styleSpreadJsx.replace(/<motion\.(\w+)(\s)/g, '<motion.$1 layout={true}$2');
  styleSpreadJsx = styleSpreadJsx.replace(/<MotionLink(\s)/g, '<MotionLink layout={true}$1');
  // NOTE: the fixed/sticky-header fix (`layoutScroll` on the root) is added on-demand
  // by the reactive `updateStyles` hook when an instance is set fixed/sticky — never
  // at creation — so relative components are created untouched. See
  // ensureLayoutRootOnComponentRoot + mutation-queue.

  // Imports carried over from the parent file for any non-builtin
  // components referenced by the extracted JSX. Same rationale as the
  // single-variant builder — without this, any nested code component
  // (e.g. <MeshGradient />) would crash with `ReferenceError: ... is
  // not defined` when the new component file mounts.
  const carriedImportsBlockMV = carriedImports.length > 0
    ? `${carriedImports.join('\n')}\n`
    : '';

  // Variant consts + slot-connected canvas-node decls referenced by the JSX.
  // The single-variant builder always stitched these; this builder DIDN'T —
  // a section with a Marquee's `{cn_…}` slot refs compiled against undefined
  // identifiers and the whole master rendered blank (2026-07-28). Same split
  // as buildComponentFile: cn_ decls go BELOW the export (entry-fit scanner
  // relies on the first data-id being the root).
  const aboveConstsMV = carriedConsts.filter((x) => !x.startsWith('const cn_'));
  const slotConstsMV = carriedConsts.filter((x) => x.startsWith('const cn_'));
  const carriedConstsBlockMV = aboveConstsMV.length > 0
    ? `\n${aboveConstsMV.join('\n')}\n`
    : '';
  const slotConstsBlockMV = slotConstsMV.length > 0
    ? `\n${slotConstsMV.join('\n')}\n`
    : '';

  return `import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
${carriedImportsBlockMV}${motionLinkDeclBlock(styleSpreadJsx, carriedImports, carriedConsts)}
/** @name "${displayName}" */

const variantConfig = [
${variantConfigEntries.join(',\n')},
];

const ${variantsVarName} = {
${variantEntries.join(',\n')},
};
${carriedConstsBlockMV}
function ${name}({ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  return (
    <LayoutGroup>
    ${styleSpreadJsx}
    </LayoutGroup>
  );
}

export default withResponsiveProps(${name});
${slotConstsBlockMV}`;
}

/** Inject ...style spread at the end of the root element's style object. */
/** Spread the component's extra props (`{...rest}`) onto its ROOT element, right
 *  after the root `data-id`. This forwards instance-passed DOM props — `onClick`,
 *  `data-overlay-trigger`, the instance's own `data-id`, hover handlers — to a real
 *  DOM node so overlays / interactions placed on a component INSTANCE actually
 *  work on the live site. `rest`'s `data-id` (the instance's) overrides the
 *  master's; structural props (variants/initial/animate/style) come after and win. */
function injectRestSpread(jsx: string): string {
  return jsx.replace(/(data-id="[^"]*")/, '$1 {...rest}');
}

/**
 * Configure a component's ROOT motion element for a per-instance fixed/sticky
 * layout fix.
 *
 * framer-motion `layout={true}` on a `position: fixed`/`sticky` element FLIP-animates
 * POSITION on scroll changes (App Router scroll-to-top on navigation) — a fixed
 * header "jumps up the screen" on every route switch.
 *
 * The fix that keeps the root's OWN in-page animation (a mobile menu expanding
 * 72px→auto IS the root's layout FLIP) is `layout="size"`:
 *   layout={isFixed ? "size" : true}
 * "size" animates SIZE only and SNAPS position — so the height expand still
 * animates, but the navigation scroll-driven POSITION change snaps instantly (no
 * jump). Relative instances keep `layout={true}`. (Prior dead ends, healed here if
 * present: `layoutRoot` ANCHORS the element and suppresses its own animation →
 * kills the expand; `layoutDependency` can't fix the jump because it can't change
 * the page-vs-viewport projection space.)
 *
 * The root is the element whose STYLE OBJECT spreads the instance style (`...style`,
 * or `...__instStyle` on instance-size components like a responsive Header). NOT a
 * plain indexOf — `...__instStyle` also appears in the destructuring
 * `const { …, ...__instStyle } = style`, which isn't a style attribute.
 *
 * Idempotent: re-running is a no-op once the root is already configured (but it
 * WILL heal a root that previously got `layoutRoot` while keeping `layout={true}`).
 */
/**
 * Apply the per-instance fixed/sticky layout config to a design-component ROOT.
 *
 * The bug: a `position: fixed`/`sticky` component used as a header "slides in" on
 * every page navigation. framer-motion's `layout` projection folds the window
 * scroll offset into its measurements; the App-Router scroll-reset on navigation
 * then looks like a position delta and gets FLIP-animated — and it hits the root
 * AND every `layout` child inside (the nav links), so the whole header slides.
 *
 * FIX (live-verified): `layoutScroll={(CHECK)}` on the root. `layoutScroll` marks
 * the element as a SCROLL BOUNDARY in Motion's projection tree, so Motion stops
 * propagating the window scroll offset through it — the scroll-reset no longer
 * registers as a layout delta for the root or its descendants → no slide.
 * `layout={(CHECK) ? "size" : true}` rides alongside it: "size" still animates the
 * mobile-menu height expand (size only, position snaps). Both are conditional on
 * CHECK, so relative masters / the editor canvas are untouched
 * (layoutScroll={false}, layout={true}).
 *
 * Dead ends (all proven on the live site, all healed here if a prior pass left one
 * behind): (a) `layoutRoot` + `layout={false}` ANCHORED the root and killed its own
 * expand; (b) `layoutDependency` couldn't change the projection space, the jump
 * persisted; (c) a TWO-element `layoutRoot` root + inner `<motion.div
 * data-fixed-shell>` wrapper (Motion's documented pattern) disrupted motion's
 * layout projection in practice and BROKE the expand. So this helper also strips
 * those and UN-WRAPS any leftover shell, restoring the root's height.
 *
 * NOTE: the name is historical (an early attempt used `layoutRoot`); the live fix
 * is `layoutScroll`. Applied by the reactive `updateStyles` hook when an instance
 * is set fixed/sticky. Idempotent.
 */
export function ensureLayoutRootOnComponentRoot(code: string): string {
  const CHECK = "(style as any)?.position === 'fixed' || (style as any)?.position === 'sticky'";
  const TARGET = `layout={(${CHECK}) ? "size" : true}`;
  const SCROLL = `layoutScroll={(${CHECK})}`;
  const original = code;

  // Heal the abandoned two-element approach: if a prior pass injected an inner
  // `<motion.div data-fixed-shell>` wrapper, remove it (unwrap its children) — that
  // wrapper broke the mobile-menu expand. The root height is restored below.
  code = removeFixedShell(code);

  // Locate the component ROOT (style object spreads ...style / ...__instStyle).
  let searchFrom = 0;
  while (searchFrom <= code.length) {
    const styleAttrIdx = code.indexOf('style={{', searchFrom);
    if (styleAttrIdx === -1) break;
    const objStart = styleAttrIdx + 'style={{'.length;
    let d = 1, p = objStart;
    while (p < code.length && d > 0) {
      const ch = code[p];
      if (ch === '{') d++;
      else if (ch === '}') d--;
      if (d > 0) p++;
    }
    const objBody = code.slice(objStart, p);
    if (!(/\.\.\.style\b/.test(objBody) || /\.\.\.__instStyle\b/.test(objBody))) {
      searchFrom = p + 1;
      continue;
    }

    const tagStart = code.lastIndexOf('<', styleAttrIdx);
    if (tagStart === -1) break;
    const nameMatch = /^<([A-Za-z][\w.]*)/.exec(code.slice(tagStart));
    if (!nameMatch) break;
    const tagName = nameMatch[1];
    // Only a layout-animated MOTION root needs the fixed-header scroll-boundary fix —
    // a plain (non-motion) root can't slide and must not receive framer-motion props.
    // (Editor component roots are always motion.*, so the reactive hook is unaffected;
    // this guards the AI-commit normalizer against a static component's plain root.)
    if (!tagName.startsWith('motion.')) break;
    const openTagEnd = findTagClose(code, tagStart); // index of the opening tag's '>'
    if (openTagEnd === -1) break;

    let newOpenTag = code.slice(tagStart, openTagEnd + 1);

    // Add the scroll-boundary fix + size animation (both conditional on CHECK).
    // Strip any prior layout / layoutRoot / layoutDependency / layoutScroll first
    // (heals the dead-end attempts and a hand-added bare `layoutScroll`), then add.
    if (!newOpenTag.includes(SCROLL) || !newOpenTag.includes(TARGET)) {
      newOpenTag = stripJsxExprAttr(newOpenTag, 'layout');
      newOpenTag = stripJsxExprAttr(newOpenTag, 'layoutRoot');
      newOpenTag = stripJsxExprAttr(newOpenTag, 'layoutDependency');
      newOpenTag = stripJsxExprAttr(newOpenTag, 'layoutScroll');
      newOpenTag = newOpenTag.replace(/\s+layoutScroll(?!\s*=)/g, ''); // bare `layoutScroll`
      newOpenTag = newOpenTag.replace(/\s+layout(?=\s|\/|>)/g, '');    // bare `layout` (AI form) → avoid a dup attr
      newOpenTag = newOpenTag.replace(
        new RegExp(`^<${tagName.replace(/[.]/g, '\\.')}`),
        `<${tagName} ${SCROLL} ${TARGET}`,
      );
    }
    // Restore the root height if a prior pass wrapped it as (CHECK) ? 'auto' : (X).
    newOpenTag = unwrapRootHeightConditional(newOpenTag, CHECK);

    code = code.slice(0, tagStart) + newOpenTag + code.slice(openTagEnd + 1);
    break;
  }

  return code === original ? original : code;
}

/** Remove a JSX `name={ … }` expression attribute (brace/string-aware). No-op if absent. */
function stripJsxExprAttr(tag: string, name: string): string {
  const m = new RegExp(`\\s+${name}=\\{`).exec(tag);
  if (!m) return tag;
  let d = 1, p = m.index + m[0].length, str: string | null = null, esc = false; // p = just past '{'
  while (p < tag.length && d > 0) {
    const ch = tag[p];
    if (esc) { esc = false; p++; continue; }
    if (ch === '\\') { esc = true; p++; continue; }
    if (str) { if (ch === str) str = null; p++; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { str = ch; p++; continue; }
    if (ch === '{') d++;
    else if (ch === '}') d--;
    if (d > 0) p++;
  }
  return tag.slice(0, m.index) + tag.slice(p + 1);
}

/**
 * Locate a style-object value span for `key` in an opening tag's `style={{ … }}`.
 * Returns absolute start/end offsets of the VALUE (key boundary-guarded so
 * minHeight/maxHeight/lineHeight don't match; value capture is paren/string-aware
 * so a ternary `a ? b : c` is taken whole). Null if absent.
 */
function findStyleValueSpan(openTag: string, key: string): { valStart: number; valEnd: number } | null {
  const sIdx = openTag.indexOf('style={{');
  if (sIdx === -1) return null;
  const objStart = sIdx + 'style={{'.length;
  let d = 1, p = objStart;
  while (p < openTag.length && d > 0) {
    const ch = openTag[p];
    if (ch === '{') d++;
    else if (ch === '}') d--;
    if (d > 0) p++;
  }
  const body = openTag.slice(objStart, p);
  const m = new RegExp(`(^|[{,\\s])${key}\\s*:`).exec(body);
  if (!m) return null;
  let q = m.index + m[0].length;
  while (q < body.length && /\s/.test(body[q])) q++;
  const valStart = q;
  let pd = 0, str: string | null = null, esc = false;
  while (q < body.length) {
    const ch = body[q];
    if (esc) { esc = false; q++; continue; }
    if (ch === '\\') { esc = true; q++; continue; }
    if (str) { if (ch === str) str = null; q++; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { str = ch; q++; continue; }
    if (ch === '(' || ch === '{' || ch === '[') { pd++; q++; continue; }
    if (ch === ')' || ch === '}' || ch === ']') { pd--; q++; continue; }
    if (ch === ',' && pd === 0) break;
    q++;
  }
  return { valStart: objStart + valStart, valEnd: objStart + q };
}

/** Recover the original height expression if a prior pass wrapped it as `(CHECK) ? 'auto' : (X)`. */
function unwrapConditionalHeight(value: string | null, CHECK: string): string | null {
  if (!value) return null;
  const prefix = `(${CHECK}) ? 'auto' : (`;
  if (value.startsWith(prefix) && value.endsWith(')')) return value.slice(prefix.length, -1).trim();
  return value;
}

/** Restore a root height a prior pass wrapped as `(CHECK) ? 'auto' : (X)` back to `X`. */
function unwrapRootHeightConditional(openTag: string, CHECK: string): string {
  const s = findStyleValueSpan(openTag, 'height');
  if (!s) return openTag;
  const value = openTag.slice(s.valStart, s.valEnd).trim();
  const orig = unwrapConditionalHeight(value, CHECK);
  if (orig === null || orig === value) return openTag;
  return openTag.slice(0, s.valStart) + orig + openTag.slice(s.valEnd);
}

/**
 * Remove an inner `<motion.div data-fixed-shell>…</motion.div>` wrapper, unwrapping
 * its children back to the root (revert of the abandoned two-element approach).
 */
function removeFixedShell(code: string): string {
  const shellIdx = code.indexOf('<motion.div data-fixed-shell');
  if (shellIdx === -1) return code;
  const shellGt = findTagClose(code, shellIdx);
  if (shellGt === -1) return code;
  const close = findMatchingCloseTag(code, shellGt, 'motion.div');
  if (!close) return code;
  // Remove the close tag first (it's after the open, so the open offsets stay valid).
  let out = code.slice(0, close.closeStart) + code.slice(close.closeEnd + 1);
  out = out.slice(0, shellIdx) + out.slice(shellGt + 1);
  return out;
}

/**
 * From an opening tag's '>' at `openGt`, find the matching `</tagName>` close,
 * accounting for nested same-name tags and self-closing tags. Returns the close
 * tag's span, or null if unbalanced.
 */
function findMatchingCloseTag(
  code: string, openGt: number, tagName: string,
): { closeStart: number; closeEnd: number } | null {
  const openTok = `<${tagName}`;
  const closeTok = `</${tagName}`;
  const isBoundary = (c: string) => c === '' || /\s/.test(c) || c === '>' || c === '/';
  let depth = 1, i = openGt + 1;
  while (i < code.length) {
    const nOpen = code.indexOf(openTok, i);
    const nClose = code.indexOf(closeTok, i);
    if (nClose === -1) return null;
    const openValid = nOpen !== -1 && isBoundary(code[nOpen + openTok.length] ?? '');
    const closeValid = isBoundary(code[nClose + closeTok.length] ?? '');
    if (openValid && nOpen < nClose) {
      const gt = findTagClose(code, nOpen);
      if (gt === -1) return null;
      if (code[gt - 1] !== '/') depth++; // not self-closing → a real nesting level
      i = gt + 1;
    } else if (closeValid) {
      const gt = code.indexOf('>', nClose);
      if (gt === -1) return null;
      depth--;
      if (depth === 0) return { closeStart: nClose, closeEnd: gt };
      i = gt + 1;
    } else {
      // Neither position is a real tag (substring match) — step past the nearest
      // candidate so we never spin.
      i = (nOpen !== -1 ? Math.min(nOpen, nClose) : nClose) + 1;
    }
  }
  return null;
}

function injectStyleSpread(jsx: string): string {
  const styleIdx = jsx.indexOf('style={{');
  if (styleIdx === -1) return jsx;

  const objStart = styleIdx + 'style={{'.length;
  let depth = 1, pos = objStart;
  while (pos < jsx.length && depth > 0) {
    if (jsx[pos] === '{') depth++;
    else if (jsx[pos] === '}') depth--;
    if (depth > 0) pos++;
  }
  return jsx.slice(0, pos) + ', ...style' + jsx.slice(pos);
}

function addImportIfNeeded(code: string, componentName: string, componentFilePath: string): string {
  if (code.includes(`import ${componentName}`) || code.includes(`import { ${componentName}`)) {
    return code;
  }

  // Remove 'components/' prefix and '.tsx' for import path
  const importPath = '@/' + componentFilePath.replace(/\.tsx$/, '');
  const importStatement = `import ${componentName} from '${importPath}';\n`;

  // Insert after the last existing import
  const lastImportIdx = code.lastIndexOf('\nimport ');
  if (lastImportIdx !== -1) {
    const endOfLine = code.indexOf('\n', lastImportIdx + 1);
    return code.slice(0, endOfLine + 1) + importStatement + code.slice(endOfLine + 1);
  }

  // No imports found — add at top
  return importStatement + code;
}
