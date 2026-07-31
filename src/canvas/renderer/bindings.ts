// bindings.ts — CMS binding (text / style / attr) + locale-override
// application to rendered DOM trees. Extracted verbatim from Renderer.ts
// (Phase 7 split).

import type { CanvasNode } from '@/code/parsing/parser';
import type { CollectionItem, NodeOverride } from '@/shared/types';
import { resolveActiveVariant } from '../resolve-core';
import { trace } from '@/shared/debug-trace';
import { formatBoundStyleValue } from '@/code/features/cms-style-format';
import { _allViewportWidthsAsc } from './responsive';
import { toKebab } from '@/shared/css-utils';

/** Max image width on canvas — full-res images (5000px+, 10MB) kill scroll performance.
 *  Source code keeps the original URL; only the canvas DOM gets the downsized version. */
const CANVAS_IMG_MAX_WIDTH = 600;

/** Downsize an image URL for canvas rendering. Supports Unsplash/imgix and Cloudinary.
 *  Non-CDN URLs pass through unchanged. */
function canvasImageSrc(src: string): string {
  if (!src) return src;
  // Unsplash uses imgix CDN — append override params at the END (last wins in imgix).
  // Don't modify existing params (they may be signed via ixid).
  if (src.includes('images.unsplash.com')) {
    const sep = src.includes('?') ? '&' : '?';
    return `${src}${sep}w=${CANVAS_IMG_MAX_WIDTH}&q=60&fm=webp`;
  }
  // Cloudinary: /w_800/ → cap
  if (src.includes('res.cloudinary.com')) {
    return src.replace(/\/w_\d+/, `/w_${CANVAS_IMG_MAX_WIDTH}`);
  }
  return src;
}

// `formatBoundStyleValue` lives in `cms-style-format.ts` so the canvas
// Renderer (.map() ghost path, inline-map per-item path) and
// `applyDetailPageBindings` (CMS detail-page substitution) format URL-bearing
// values identically. The Renderer was the original home; moved out so the
// bindings module can reuse it without pulling Renderer's React deps.

/** Heuristic: does this bound text value look like HTML?
 *  TipTap rich-text output is always tag-wrapped (`<p>...</p>` at minimum),
 *  so any closing-tag marker means we should use innerHTML, not textContent.
 *  Plain-text fields never contain `</` literally. */
const HTML_TAG_RE = /<\/[a-z][a-z0-9]*\s*>/i;
function looksLikeHtmlBinding(value: string): boolean {
  return HTML_TAG_RE.test(value);
}

/** Apply a resolved bound text value to an element. Switches between
 *  textContent (plain) and innerHTML (rich-text) based on the value shape.
 *  Idempotent: skips writes when the current content already matches. */
function applyBoundText(el: Element, value: string): void {
  if (looksLikeHtmlBinding(value)) {
    if ((el as HTMLElement).innerHTML !== value) (el as HTMLElement).innerHTML = value;
  } else {
    if (el.textContent !== value) el.textContent = value;
  }
}

/**
 * Apply ALL CMS bindings (text / style / attr) for ONE element from a collection
 * row, honoring per-viewport rebinds + unbind→default (`node.responsiveBindings`)
 * at the exact `vpWidth`. Resolution per axis+key: a per-viewport override wins
 * (`{value}` → render the literal = unbind→default; `{field}` → read a DIFFERENT
 * field); otherwise the base binding field is used. Shared by the ghost-preserve,
 * template-patch, and initial-build paths so they resolve fields identically.
 * Returns `{ textApplied }` so the build path knows whether to skip its
 * non-binding text fallback.
 *   - `resetEmptyStyleToDefault`: reset a bound style to the node default when the
 *     row's field is empty (ghost-preserve only — `syncInlineStyles` may have left
 *     item-0's value behind).
 *   - `skipHref`: never set `href` on canvas DOM (links must not navigate).
 */
export function applyNodeCmsBindings(
  el: HTMLElement,
  node: CanvasNode,
  bindingData: CollectionItem,
  vpWidth: number | undefined,
  variantName: string | null | undefined,
  opts: { resetEmptyStyleToDefault?: boolean; skipHref?: boolean } = {},
): { textApplied: boolean } {
  const rb = node.responsiveBindings;
  const vb = node.variantBindings;
  // The variant whose per-variant bindings apply, resolved the SAME way as
  // resolveVariantStyles: the artboard's `variantName` (component master) →
  // else the instance's PER-VIEWPORT variant (`responsiveVariantMap[vpWidth]`,
  // e.g. an instance set to variant-1 on tablet) → else the instance's static
  // `componentVariant` (baked `initialVariant`). Per-VARIANT override wins over
  // per-VIEWPORT binding override, both over the base binding.
  // A SPECIFIC per-viewport variant (`responsiveVariantMap[vpWidth]`, a page replica) WINS over the
  // passed `variantName` (the base) — SAME precedence as resolveVariantStyles. The map is null on a
  // component master, so the artboard's `variantName` still wins there. Without this, an instance whose
  // base initialVariant resolves to a concrete variant passes it as `variantName` and the per-tile
  // variant never applies (the StartTrialButton tablet stayed 'default' instead of its per-tile variant).
  // Per-tile variant (responsiveVariantMap) wins over the base variantName, then componentVariant —
  // shared precedence in resolve-core.resolveActiveVariant (fallback null, as before).
  const variant = resolveActiveVariant(node, { vpWidth, variant: variantName });
  const vpStyle = { ...(vpWidth !== undefined ? rb?.style?.[vpWidth] : undefined), ...(variant ? vb?.style?.[variant] : undefined) };
  const vpText = (variant ? vb?.text?.[variant] : undefined) ?? (vpWidth !== undefined ? rb?.text?.[vpWidth] : undefined);
  const vpAttr = { ...(vpWidth !== undefined ? rb?.attr?.[vpWidth] : undefined), ...(variant ? vb?.attr?.[variant] : undefined) };

  // ── STYLE ── base style bindings ∪ per-viewport style overrides.
  const styleProps = new Set<string>();
  if (node.styleBindings) for (const sb of node.styleBindings) styleProps.add(sb.styleProp);
  if (vpStyle) for (const k of Object.keys(vpStyle)) styleProps.add(k);
  for (const cssProp of styleProps) {
    const ov = vpStyle?.[cssProp];
    let value: unknown;
    if (ov && 'value' in ov) value = ov.value; // unbind→default literal
    else {
      const field = (ov && 'field' in ov) ? ov.field : node.styleBindings?.find(b => b.styleProp === cssProp)?.field;
      value = field ? bindingData[field] : undefined;
    }
    if (value !== undefined && value !== null && value !== '') {
      try { (el.style as any)[cssProp] = formatBoundStyleValue(cssProp, value); } catch { /* skip invalid */ }
    } else if (opts.resetEmptyStyleToDefault) {
      try { (el.style as any)[cssProp] = (node.styles as any)?.[cssProp] ?? ''; } catch { /* skip invalid */ }
    }
  }

  // ── TEXT ── (binding.property is 'text' | 'src' | 'href' | 'alt')
  let textApplied = false;
  const textBaseField = (node.binding && node.binding.property === 'text') ? node.binding.field : undefined;
  if (vpText || textBaseField) {
    let resolved: string | undefined;
    if (vpText && 'value' in vpText) resolved = vpText.value;
    else {
      const field = (vpText && 'field' in vpText) ? vpText.field : textBaseField;
      if (field !== undefined) { const v = bindingData[field]; if (v !== undefined) resolved = String(v ?? ''); }
    }
    if (resolved !== undefined) { applyBoundText(el, resolved); textApplied = true; }
  }

  // ── ATTR (src / href / alt) ── base attr bindings ∪ node.binding attr ∪ overrides.
  const attrNames = new Set<string>();
  if (node.binding && node.binding.property !== 'text') attrNames.add(node.binding.property);
  if (node.attrBindings) for (const ab of node.attrBindings) attrNames.add(ab.property);
  if (vpAttr) for (const k of Object.keys(vpAttr)) attrNames.add(k);
  for (const attrName of attrNames) {
    if (attrName === 'href' && opts.skipHref) continue;
    const ov = vpAttr?.[attrName];
    let resolved: string | undefined;
    if (ov && 'value' in ov) resolved = ov.value;
    else {
      let field: string | undefined;
      if (ov && 'field' in ov) field = ov.field;
      else field = node.attrBindings?.find(b => b.property === attrName)?.field
        ?? ((node.binding && node.binding.property === attrName) ? node.binding.field : undefined);
      if (field !== undefined) { const v = bindingData[field]; if (v !== undefined) resolved = String(v ?? ''); }
    }
    if (resolved === undefined) continue;
    if (attrName === 'src') { if (resolved) el.setAttribute('src', canvasImageSrc(resolved)); }
    else if (attrName === 'textContent') { applyBoundText(el, resolved); textApplied = true; }
    else if (resolved) el.setAttribute(attrName, resolved);
  }
  return { textApplied };
}

/**
 * Apply binding data (style bindings, text bindings, attr bindings) to a ghost element tree.
 * Walks the template node tree and finds corresponding ghost DOM elements by data-id + suffix.
 * Called during ghost preservation (count unchanged) to sync styles after map data edits.
 */
export function applyBindingDataToTree(
  ghostEl: HTMLElement,
  node: CanvasNode,
  allNodes: Map<string, CanvasNode>,
  bindingData: CollectionItem,
  ghostSuffix: string,
  idPrefix: string = '',
  vpWidth?: number,
  variantName?: string | null,
): void {
  // Resolve + apply this row's bindings, honoring per-viewport rebind / per-variant
  // rebind / unbind→default at `vpWidth` (page replica) or `variantName` (component-
  // master artboard). `resetEmptyStyleToDefault` because `syncInlineStyles` just
  // copied the template (item-0) styles onto this ghost, so an empty field must reset
  // to the node default (else item-0's value leaks). `skipHref` — canvas links never navigate.
  applyNodeCmsBindings(ghostEl, node, bindingData, vpWidth, variantName, { resetEmptyStyleToDefault: true, skipHref: true });

  // Recurse into children. Replica viewports prefix `data-node-id` with
  // their viewport id (e.g. `tablet-card1__1`); without threading idPrefix
  // through, the lookup misses and per-row bindings on replica ghosts
  // never get applied — the symptom was every replica ghost row showing
  // item 0's image / data even though text bindings on the root worked.
  for (const childId of node.children) {
    const childNode = allNodes.get(childId);
    if (!childNode) continue;
    const childEl = ghostEl.querySelector(`[data-node-id="${idPrefix + childNode.id + ghostSuffix}"]`) as HTMLElement;
    if (childEl) {
      applyBindingDataToTree(childEl, childNode, allNodes, bindingData, ghostSuffix, idPrefix, vpWidth, variantName);
    }
  }
}

/**
 * Apply a node's locale overrides (non-default language: text, attrs, styles) to its DOM element.
 * Shared by patchElement (update path) AND buildNodeElement (build path) so both stay in lockstep.
 * Previously buildNodeElement applied `override.text` WITHOUT the per-viewport bucketing patchElement
 * does, so a per-viewport (e.g. tablet-only) translation rendered the PRIMARY text on a full build until
 * the next patch. `tracePrefix` preserves the original distinct trace names ('' → renderer:locale-*,
 * 'build-' → renderer:build-locale-*). NOTE: the agent-audited "Bug 2" (patch doesn't apply locale) was
 * a false positive — BOTH applied it; the real asymmetry was build missing the text bucketing, fixed here.
 */
/** SELF-HEALING RESIDUE: locale style values are applied INLINE
 *  (applyLocaleOverrides below) and are deliberately invisible to
 *  patchElement's stale-clear ledger. The element remembers which keys the
 *  PREVIOUS locale pass styled (data-locale-styled, kebab-case); any key the
 *  CURRENT override no longer carries is removed here — so switching locale
 *  (or back to the default, where the override is gone entirely) reverts
 *  props even when the node has NO base value for them.
 *
 *  MUST run BEFORE patchElement's style application (not after): the removal
 *  strips the whole inline property, and the patch pass is what re-applies
 *  the node's base value on this same visit. Running after the patch wiped
 *  the just-restored base (inner frames went TRANSPARENT instead of back to
 *  pink — the "Done reverts to blue" find, 2026-07-22). */
export function clearLocaleStyleResidue(
  el: HTMLElement,
  override: NodeOverride | undefined,
  nodeId: string,
  tracePrefix: '' | 'build-' = '',
): void {
  const prevStyled = el.getAttribute('data-locale-styled');
  if (!prevStyled) return;
  const nextKeys = new Set(Object.keys(override?.styles ?? {}).map(k => toKebab(k)));
  let removedAny = false;
  for (const kebab of prevStyled.split(',')) {
    if (!kebab || nextKeys.has(kebab)) continue;
    try { el.style.removeProperty(kebab); removedAny = true; } catch { /* skip */ }
  }
  if (removedAny) trace.dom(`renderer:${tracePrefix}locale-style-residue-cleared`, { nodeId });
  if (!override?.styles || Object.keys(override.styles).length === 0) {
    el.removeAttribute('data-locale-styled');
  }
}

export function applyLocaleOverrides(
  el: HTMLElement,
  node: CanvasNode,
  localeOverrides: Map<string, NodeOverride> | undefined,
  vpWidth: number | undefined,
  tracePrefix: '' | 'build-',
): void {
  const override = localeOverrides?.get(node.id);
  if (!override) return;
  // Per-viewport locale text: smallest configured viewport >= the current pass's vpWidth wins; falls
  // back to override.text (the primary-viewport translation) when no bucket matches OR viewports unknown
  // (so the build path safely degrades to its old behavior when `_allViewportWidthsAsc` isn't ready yet).
  let resolvedLocaleText: string | undefined;
  if (override.textOverrides && vpWidth !== undefined && _allViewportWidthsAsc.length > 0) {
    let bucket: number | null = null;
    for (const vw of _allViewportWidthsAsc) {
      if (vpWidth <= vw) { bucket = vw; break; }
    }
    if (bucket !== null) {
      const o = override.textOverrides[String(bucket)];
      if (typeof o === 'string') resolvedLocaleText = o;
    }
  }
  if (resolvedLocaleText === undefined && override.text !== undefined) {
    resolvedLocaleText = override.text;
  }
  if (resolvedLocaleText !== undefined) {
    el.textContent = resolvedLocaleText;
    trace.dom(`renderer:${tracePrefix}locale-text-override`, {
      nodeId: node.id, text: resolvedLocaleText.slice(0, 30),
      fromBucket: resolvedLocaleText !== override.text, vpWidth,
    });
  }
  if (override.props) {
    for (const [prop, value] of Object.entries(override.props)) el.setAttribute(prop, String(value));
    trace.dom(`renderer:${tracePrefix}locale-prop-override`, { nodeId: node.id, props: Object.keys(override.props) });
  }
  if (override.styles) {
    for (const [key, value] of Object.entries(override.styles)) {
      try { (el.style as any)[key] = value; } catch { /* skip invalid */ }
    }
    // Remember what we styled (kebab) for the residue clear above.
    el.setAttribute('data-locale-styled', Object.keys(override.styles).map(k => toKebab(k)).join(','));
    trace.dom(`renderer:${tracePrefix}locale-style-override`, { nodeId: node.id, styles: Object.keys(override.styles) });
  }
}
