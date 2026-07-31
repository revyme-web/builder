// locale-gen.ts — Write :lang() CSS rules to the <style> block.
//
// Pattern: :lang(fr) [data-id="hero-title"] { font-size: 28px !important; }
//
// Reuses the same <style> block as @container responsive overrides.
// The :lang() rules are top-level in <style> (outside @container blocks).
// Each property uses !important (same as @container rules).
//
// Empty string values = remove that property from the rule.
// If all properties are empty, remove the entire rule.

import { toKebab, coerceCssNumberToPx } from '@/shared/css-utils';
import { trace } from '@/shared/debug-trace';
import { getSortedBreakpointWidths } from '@/code/stores/viewport-store';

// ─── Style Block Regex ──────────────────────────────────────────────────────
// Same regex used by updateContainerQueryStyle in generator.ts
const styleBlockRegex = /(<style>\s*\{[`'])([\s\S]*?)([`']\}\s*<\/style>)/s;

// ─── Locale Rule Parsing ────────────────────────────────────────────────────

/**
 * Parse all :lang() rules from CSS text.
 * Returns Map<locale, Map<nodeId, Map<property, value>>>
 */
export function parseLocaleRules(
  css: string,
): Map<string, Map<string, Map<string, string>>> {
  const rules = new Map<string, Map<string, Map<string, string>>>();

  // Match: :lang(fr) [data-id="hero-title"] { font-size: 28px !important; }
  const langRegex = /:lang\(([^)]+)\)\s+\[data-id="([^"]+)"\]\s*\{([^}]*)\}/g;
  let match;

  while ((match = langRegex.exec(css)) !== null) {
    const locale = match[1];
    const nodeId = match[2];
    const declarations = match[3];

    if (!rules.has(locale)) rules.set(locale, new Map());
    const localeMap = rules.get(locale)!;
    if (!localeMap.has(nodeId)) localeMap.set(nodeId, new Map());
    const nodeProps = localeMap.get(nodeId)!;

    for (const decl of declarations.split(';').filter(d => d.trim())) {
      const colonIdx = decl.indexOf(':');
      if (colonIdx === -1) continue;
      const prop = decl.slice(0, colonIdx).trim();
      const val = decl.slice(colonIdx + 1).trim().replace(/\s*!important\s*$/, '').trim();
      nodeProps.set(prop, val);
    }
  }

  return rules;
}

/**
 * Serialize :lang() rules back to CSS text (indented for <style> block).
 */
function serializeLocaleRules(
  rules: Map<string, Map<string, Map<string, string>>>,
): string {
  let css = '';
  // Sort locales for deterministic output
  const sortedLocales = [...rules.keys()].sort();

  for (const locale of sortedLocales) {
    const localeMap = rules.get(locale)!;
    for (const [nodeId, props] of localeMap) {
      if (props.size === 0) continue;
      const decls = [...props.entries()]
        .map(([k, v]) => `${k}: ${v} !important;`)
        .join(' ');
      css += `    :lang(${locale}) [data-id="${nodeId}"] { ${decls} }\n`;
    }
  }

  return css;
}

// ─── Variant-scoped rules (design components) ───────────────────────────────
// Per-VARIANT locale values use the tile/root `data-variant` attribute as the
// scoping carrier (variants share one width, so @media bands can't split
// them): `:lang(fr) [data-variant="variant-1"] [data-id="X"] { … !important }`.
// The canvas stamps data-variant on every variant tile root (Renderer ~1066)
// and the generated component root carries it live (ensureRootDataVariantAttr)
// — so the SAME CSS scopes both. Specificity beats the global :lang rule, so
// a variant override wins the cascade naturally (no ordering tricks needed).

const VARIANT_LANG_RE = /:lang\(([^)]+)\)\s+\[data-variant="([^"]+)"\]\s+\[data-id="([^"]+)"\]\s*\{([^}]*)\}/g;

/** Map<variantName, Map<locale, Map<nodeId, Map<prop, val>>>> */
export type VariantLocaleRules = Map<string, Map<string, Map<string, Map<string, string>>>>;

function parseVariantScopedLocaleRules(css: string): VariantLocaleRules {
  const out: VariantLocaleRules = new Map();
  let m: RegExpExecArray | null;
  VARIANT_LANG_RE.lastIndex = 0;
  while ((m = VARIANT_LANG_RE.exec(css)) !== null) {
    const [, locale, variant, nodeId, decls] = m;
    if (!out.has(variant)) out.set(variant, new Map());
    const localeMap = out.get(variant)!;
    if (!localeMap.has(locale)) localeMap.set(locale, new Map());
    const nodeMap = localeMap.get(locale)!;
    if (!nodeMap.has(nodeId)) nodeMap.set(nodeId, new Map());
    const props = nodeMap.get(nodeId)!;
    for (const decl of decls.split(';').filter(d => d.trim())) {
      const idx = decl.indexOf(':');
      if (idx === -1) continue;
      props.set(decl.slice(0, idx).trim(), decl.slice(idx + 1).trim().replace(/\s*!important\s*$/, '').trim());
    }
  }
  return out;
}

function serializeVariantLocaleRules(rules: VariantLocaleRules): string {
  let css = '';
  for (const variant of [...rules.keys()].sort()) {
    const localeMap = rules.get(variant)!;
    for (const locale of [...localeMap.keys()].sort()) {
      for (const [nodeId, props] of localeMap.get(locale)!) {
        if (props.size === 0) continue;
        const decls = [...props.entries()].map(([k, v]) => `${k}: ${v} !important;`).join(' ');
        css += `    :lang(${locale}) [data-variant="${variant}"] [data-id="${nodeId}"] { ${decls} }\n`;
      }
    }
  }
  return css;
}

/**
 * Extract non-:lang() CSS content from the style block.
 * Returns the CSS text with :lang() rules stripped, preserving @container blocks and other rules.
 */
function extractNonLocaleCSS(css: string): string {
  // Remove :lang() lines (they are top-level, single-line rules)
  return css.replace(/^\s*:lang\([^)]+\)\s+\[data-id="[^"]+"\]\s*\{[^}]*\}\s*$/gm, '').replace(/\n{3,}/g, '\n');
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Write :lang() CSS rules to the <style> block.
 * Pattern: :lang(fr) [data-id="hero-title"] { font-size: 28px !important; }
 * Reuses the same <style> block as @container responsive overrides.
 *
 * @param code - Current JSX code
 * @param nodeId - Target node data-id
 * @param locale - Locale code (e.g. 'fr', 'ar', 'de')
 * @param styles - Style changes (camelCase keys). Empty string = remove property.
 * @returns Updated JSX code
 */

/** Width-scoped :lang() parse — the localization system is per-artboard:
 *  top-level rules are the BASE, rules nested in a @media/@container band are
 *  that replica's OVERRIDE (a different value, or a removal: the base value
 *  re-pinned plus a `--locale-off-<prop>: 1` marker). parseLocaleRules is
 *  position-agnostic and flattens both — use THIS for anything replica-aware. */
export function parseLocaleRulesScoped(css: string): {
  global: Map<string, Map<string, Map<string, string>>>;
  banded: Map<number, Map<string, Map<string, Map<string, string>>>>;
  /** Design-component per-variant scope (data-variant carrier). */
  variants: VariantLocaleRules;
} {
  const banded = new Map<number, Map<string, Map<string, Map<string, string>>>>();
  let stripped = css;
  // Extract @media/@container blocks (brace-balanced walk per block head).
  const headRe = /@(?:media|container)\s*\(max-width:\s*(\d+)px\)[^{]*\{/g;
  let m: RegExpExecArray | null;
  const spans: Array<{ start: number; end: number; width: number }> = [];
  while ((m = headRe.exec(css)) !== null) {
    let depth = 1;
    let i = headRe.lastIndex;
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') depth--;
      i++;
    }
    spans.push({ start: m.index, end: i, width: parseInt(m[1], 10) });
  }
  for (const span of spans) {
    const inner = css.slice(span.start, span.end);
    const rules = parseLocaleRules(inner);
    if (rules.size > 0) {
      const existing = banded.get(span.width);
      if (!existing) banded.set(span.width, rules);
      else {
        for (const [loc, nodes] of rules) {
          const eNodes = existing.get(loc) ?? new Map();
          for (const [nid, props] of nodes) {
            const eProps = eNodes.get(nid) ?? new Map();
            for (const [k, v] of props) eProps.set(k, v);
            eNodes.set(nid, eProps);
          }
          existing.set(loc, eNodes);
        }
      }
    }
  }
  // Global = css with the banded spans blanked out.
  for (const span of [...spans].reverse()) {
    stripped = stripped.slice(0, span.start) + ' '.repeat(span.end - span.start) + stripped.slice(span.end);
  }
  // Variant-scoped rules live at top level only; parseLocaleRules' regex
  // requires [data-id] DIRECTLY after :lang(), so they never double-count
  // as global.
  return { global: parseLocaleRules(stripped), banded, variants: parseVariantScopedLocaleRules(stripped) };
}

/** Marker custom property flagging "localization removed on this replica". */
export function localeOffMarker(kebabProp: string): string {
  return `--locale-off-${kebabProp}`;
}

/** Normalize an incoming locale style value: bare numbers get px (a unitless
 *  `gap: 45` is INVALID CSS the browser silently drops — the localized gap
 *  did nothing). Custom properties (the --locale-off markers) and genuinely
 *  unitless props (opacity, order, …) pass through untouched. */
function normalizeLocaleValue(key: string, value: string): string {
  if (key.startsWith('--')) return value;
  return coerceCssNumberToPx(key, value);
}

/** Apply one write batch onto a parsed prop map (shared by the global and
 *  banded writers). Two invariants beyond set/delete:
 *  · values are px-normalized (see normalizeLocaleValue);
 *  · a REAL value write DELETES the prop's stale `--locale-off-` removal
 *    marker — remove-then-relocalize used to leave both in the rule, so the
 *    CSS painted the new value while the pill logic read "removed here" and
 *    hid (the "background is purple in French but Fill shows no locale"
 *    find, 2026-07-22). The bake itself (base value + marker written in ONE
 *    batch) is exempt — its marker is part of the same write. */
function applyLocaleStyleWrites(props: Map<string, string>, styles: Record<string, string>): void {
  const batchMarkers = new Set(Object.keys(styles).filter((k) => k.startsWith('--locale-off-')));
  for (const [key, value] of Object.entries(styles)) {
    const kebab = toKebab(key);
    if (value === '') {
      props.delete(kebab);
    } else {
      props.set(kebab, normalizeLocaleValue(key, value));
      if (!kebab.startsWith('--') && !batchMarkers.has(localeOffMarker(kebab))) {
        props.delete(localeOffMarker(kebab));
      }
    }
  }
}


/** Remove TOP-LEVEL :lang rules only — banded ones (inside @media/@container)
 *  are per-replica overrides and must survive a global locale write verbatim.
 *  (The old position-agnostic strip emptied the bands and flattened their
 *  values into the global rule — replica locale values were destroyed by any
 *  base locale edit.) */
function stripTopLevelLangRules(css: string): string {
  const langRuleRe = /:lang\([^)]+\)[^{]*\{[^}]*\}\s*/g;
  const headRe = /@(?:media|container)\s*\([^)]*max-width:\s*\d+px[^)]*\)[^{]*\{/g;
  let out = '';
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = headRe.exec(css)) !== null) {
    // Strip :lang in the segment BEFORE this band; copy the band verbatim.
    out += css.slice(cursor, m.index).replace(langRuleRe, '');
    let depth = 1;
    let i = headRe.lastIndex;
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') depth--;
      i++;
    }
    out += css.slice(m.index, i);
    cursor = i;
    headRe.lastIndex = i;
  }
  out += css.slice(cursor).replace(langRuleRe, '');
  return out;
}

/** Ensure the component ROOT carries a live `data-variant` attribute — the
 *  deploy-side carrier for variant-scoped :lang rules (the canvas stamps
 *  tiles itself). Static components expose the instance's `initialVariant`;
 *  components with connections (a `useState(initialVariant)` state) expose
 *  the LIVE `variant` so locale CSS follows runtime variant switches
 *  (generateConnectionCode upgrades the attr when it injects the state). */
export function ensureRootDataVariantAttr(code: string): string {
  const expr = code.includes('useState(initialVariant)') ? '{variant}' : '{initialVariant}';
  const existing = code.match(/data-variant=\{(variant|initialVariant)\}/);
  if (existing) {
    const want = expr.slice(1, -1);
    if (existing[1] === want) return code;
    return code.replace(/data-variant=\{(?:variant|initialVariant)\}/, `data-variant=${expr}`);
  }
  // Root = the first data-id element in the return (the one that spreads
  // {...rest}/style). Insert right after its data-id attribute.
  const returnIdx = code.search(/return\s*</);
  if (returnIdx === -1) return code;
  const rootAttr = /(<[\w.]+[^>]*?data-id="[^"]+")/.exec(code.slice(returnIdx));
  if (!rootAttr) return code;
  const at = returnIdx + rootAttr.index + rootAttr[1].length;
  trace.action('localeGen.ensureRootDataVariantAttr', { expr });
  return code.slice(0, at) + ` data-variant=${expr}` + code.slice(at);
}

export function updateLocaleStyleInCode(
  code: string,
  nodeId: string,
  locale: string,
  styles: Record<string, string>,
  maxWidth?: number,
  variantName?: string,
): string {
  trace.fn('localeGen.updateLocaleStyleInCode', { nodeId, locale, styles, maxWidth, variantName });

  // Responsive + locale combo: write :lang() rule INSIDE the @container block
  // e.g. @container (max-width: 768px) { :lang(fr) [data-id="X"] { font-size: 28px !important; } }
  if (maxWidth !== undefined) {
    return updateLocaleStyleInsideContainer(code, nodeId, locale, styles, maxWidth);
  }

  // Variant-scoped writes need the deploy-side data-variant carrier on the
  // root; idempotent, so run before the style-block edit.
  if (variantName && variantName !== 'default') {
    code = ensureRootDataVariantAttr(code);
  }

  const blockMatch = styleBlockRegex.exec(code);

  // Parse existing GLOBAL :lang() rules only — banded rules are per-replica
  // state owned by updateLocaleStyleInsideContainer and must not be flattened
  // into (or overwritten by) the global model. VARIANT-scoped rules (design
  // components' per-variant locale values) are parsed alongside and carried
  // through every write — the bucket this write lands in depends on
  // `variantName`.
  const existingCSS = blockMatch ? blockMatch[2] : '';
  const scoped = parseLocaleRulesScoped(existingCSS);
  const rules = scoped.global;
  const variantRules = scoped.variants;

  // Pick the target bucket: a non-default variant write goes into that
  // variant's scope (data-variant carrier); everything else edits the base.
  let nodeProps: Map<string, string>;
  let cleanup: () => void;
  if (variantName && variantName !== 'default') {
    if (!variantRules.has(variantName)) variantRules.set(variantName, new Map());
    const vLocales = variantRules.get(variantName)!;
    if (!vLocales.has(locale)) vLocales.set(locale, new Map());
    const vNodes = vLocales.get(locale)!;
    if (!vNodes.has(nodeId)) vNodes.set(nodeId, new Map());
    nodeProps = vNodes.get(nodeId)!;
    cleanup = () => {
      if (nodeProps.size === 0) vNodes.delete(nodeId);
      if (vNodes.size === 0) vLocales.delete(locale);
      if (vLocales.size === 0) variantRules.delete(variantName);
    };
  } else {
    if (!rules.has(locale)) rules.set(locale, new Map());
    const localeMap = rules.get(locale)!;
    if (!localeMap.has(nodeId)) localeMap.set(nodeId, new Map());
    nodeProps = localeMap.get(nodeId)!;
    cleanup = () => {
      if (nodeProps.size === 0) localeMap.delete(nodeId);
      if (localeMap.size === 0) rules.delete(locale);
    };
  }

  applyLocaleStyleWrites(nodeProps, styles);
  cleanup();

  // Non-locale CSS: strip only TOP-LEVEL :lang rules; bands (including their
  // :lang content) pass through verbatim and land AFTER the global block.
  const nonLocaleCSS = stripTopLevelLangRules(existingCSS);

  // Serialize new locale rules — GLOBAL first, then variant-scoped (the
  // variant selector out-specifies the global one, so a variant override
  // wins regardless; the order is for readability).
  const localeCSSBlock = serializeLocaleRules(rules) + serializeVariantLocaleRules(variantRules);

  // Combine — GLOBAL :lang rules FIRST, everything else (incl. bands) after:
  // banded :lang rules share specificity with global ones, so the cascade
  // (later wins) must place bands last or a replica's locale value loses to
  // the global rule at that width.
  let newCss = '\n';
  if (localeCSSBlock) {
    newCss += localeCSSBlock;
  }
  const trimmedNonLocale = nonLocaleCSS.trim();
  if (trimmedNonLocale) {
    newCss += '    ' + trimmedNonLocale.split('\n').join('\n') + '\n';
  }
  newCss += '  ';

  if (blockMatch) {
    const [fullMatch, prefix, , suffix] = blockMatch;
    return code.slice(0, blockMatch.index!) + prefix + newCss + suffix + code.slice(blockMatch.index! + fullMatch.length);
  } else {
    // No style block exists — create one
    const rootCloseMatch = code.match(/\}\}>\s*\n/);
    if (!rootCloseMatch) {
      trace.error('localeGen', 'Cannot find root element close tag to insert <style> block');
      return code;
    }
    const insertIdx = rootCloseMatch.index! + rootCloseMatch[0].length;
    const styleBlock = `  <style>{\`${newCss}\`}</style>\n`;
    return code.slice(0, insertIdx) + styleBlock + code.slice(insertIdx);
  }
}

/**
 * Remove all :lang() rules for a specific locale from the <style> block.
 *
 * @param code - Current JSX code
 * @param locale - Locale code to remove (e.g. 'fr')
 * @returns Updated JSX code
 */
export function removeLocaleRulesFromCode(code: string, locale: string): string {
  trace.fn('localeGen.removeLocaleRulesFromCode', { locale });

  const blockMatch = styleBlockRegex.exec(code);
  if (!blockMatch) {
    trace.action('removeLocaleRules:no-style-block');
    return code;
  }

  const existingCSS = blockMatch[2];
  const rules = parseLocaleRules(existingCSS);

  if (!rules.has(locale)) {
    trace.action('removeLocaleRules:locale-not-found', { locale });
    return code;
  }

  // Remove the locale
  rules.delete(locale);

  // Get non-locale CSS
  const nonLocaleCSS = extractNonLocaleCSS(existingCSS);

  // Serialize remaining locale rules
  const localeCSSBlock = serializeLocaleRules(rules);

  // Combine — GLOBAL :lang rules FIRST, bands after: banded :lang rules have
  // the SAME specificity as the global ones, so the cascade (later wins) must
  // put bands last or a tablet's per-replica locale value loses to the global
  // rule at tablet width (the "French shows purple instead of blue" report).
  let newCss = '\n';
  if (localeCSSBlock) {
    newCss += localeCSSBlock;
  }
  const trimmedNonLocale = nonLocaleCSS.trim();
  if (trimmedNonLocale) {
    newCss += '    ' + trimmedNonLocale.split('\n').join('\n') + '\n';
  }
  newCss += '  ';

  // If style block is now empty (only whitespace), remove it entirely
  if (!trimmedNonLocale && !localeCSSBlock) {
    const [fullMatch] = blockMatch;
    // Remove the entire <style> block and any surrounding whitespace/newlines
    const beforeBlock = code.slice(0, blockMatch.index!);
    const afterBlock = code.slice(blockMatch.index! + fullMatch.length);
    // Clean up trailing newline from the removed block
    return beforeBlock + afterBlock.replace(/^\n/, '');
  }

  const [fullMatch, prefix, , suffix] = blockMatch;
  return code.slice(0, blockMatch.index!) + prefix + newCss + suffix + code.slice(blockMatch.index! + fullMatch.length);
}

// ─── Responsive + Locale Combo ──────────────────────────────────────────────

/**
 * Write a :lang() rule INSIDE an @container block.
 * Pattern: @container (max-width: 768px) { :lang(fr) [data-id="X"] { font-size: 28px !important; } }
 */
function updateLocaleStyleInsideContainer(
  code: string,
  nodeId: string,
  locale: string,
  styles: Record<string, string>,
  maxWidth: number,
): string {
  trace.fn('localeGen.updateLocaleStyleInsideContainer', { nodeId, locale, maxWidth });

  const blockMatch = styleBlockRegex.exec(code);
  if (!blockMatch) {
    // No style block at all — nothing to remove; creation falls back to a
    // fresh top-level write only when there ARE values to set.
    const hasValues = Object.values(styles).some(v => v !== '');
    return hasValues ? updateLocaleStyleInCode(code, nodeId, locale, styles) : code;
  }

  const existingCSS = blockMatch[2];

  // Locate the band whose head mentions THIS max-width. Heads may be RANGED
  // (`(max-width: 768px) and (min-width: 375px)`) — match loosely on the
  // max-width term, then brace-balance to find the block's true end (the old
  // `\)\s*\{` regex missed ranged heads and silently rerouted replica
  // writes to the TOP-LEVEL rule — the "× on tablet does nothing" report).
  const headRe = new RegExp(
    `@(?:media|container)\\s*\\([^)]*max-width:\\s*${maxWidth}px[^)]*\\)[^{]*\\{`,
  );
  const headMatch = headRe.exec(existingCSS);

  const buildRule = (props: Map<string, string>): string => {
    const body = [...props.entries()].map(([k, v]) => `${k}: ${v} !important`).join('; ');
    return `:lang(${locale}) [data-id="${nodeId}"] { ${body}; }`;
  };

  if (!headMatch) {
    const entries = Object.entries(styles).filter(([, v]) => v !== '');
    if (entries.length === 0) return code; // removal with no band = nothing to do
    // CREATE the band at the end of the style CSS — RANGED like every other
    // band (min-width = next-smaller breakpoint, inclusive): a bare
    // max-width band would cascade the tablet's locale value into MOBILE
    // and, sitting later in the file, win over the mobile band entirely
    // (the "Set updates every viewport" report).
    const widths = getSortedBreakpointWidths();
    const smaller = widths.filter((w) => w < maxWidth);
    const minW = smaller.length > 0 ? Math.max(...smaller) : undefined;
    const query = minW
      ? `@media (max-width: ${maxWidth}px) and (min-width: ${minW + 0.02}px)`
      : `@media (max-width: ${maxWidth}px)`;
    const props = new Map(entries.map(([k, v]) => [toKebab(k), normalizeLocaleValue(k, v)]));
    const band = `\n    ${query} {\n      ${buildRule(props)}\n    }\n`;
    // DESCENDING insertion: at a shared boundary (mobile tile at exactly
    // 375 matches the tablet band's inclusive min-width too) the LATER band
    // wins the cascade — so this band must sit BEFORE any smaller band,
    // mirroring the regular serializer's descending emission.
    const allHeads = new RegExp('@(?:media|container)\\s*\\([^)]*max-width:\\s*(\\d+)px[^)]*\\)[^{]*\\{', 'g');
    let insertAt = -1;
    let hm: RegExpExecArray | null;
    while ((hm = allHeads.exec(existingCSS)) !== null) {
      if (parseInt(hm[1], 10) < maxWidth) { insertAt = hm.index; break; }
    }
    const newCSS = insertAt >= 0
      ? existingCSS.slice(0, insertAt).replace(/\s*$/, '') + band + '    ' + existingCSS.slice(insertAt)
      : existingCSS.replace(/\s*$/, '') + band + '  ';
    const [fullMatch, prefix, , suffix] = blockMatch;
    return code.slice(0, blockMatch.index!) + prefix + newCSS + suffix + code.slice(blockMatch.index! + fullMatch.length);
  }

  // Brace-balance from the head to the band's end.
  let depth = 1;
  let i = headMatch.index + headMatch[0].length;
  while (i < existingCSS.length && depth > 0) {
    if (existingCSS[i] === '{') depth++;
    else if (existingCSS[i] === '}') depth--;
    i++;
  }
  const bandInner = existingCSS.slice(headMatch.index + headMatch[0].length, i - 1);

  // Merge into the existing :lang rule for this locale+node (empty = delete).
  const ruleRe = new RegExp(`:lang\\(${locale}\\)\\s*\\[data-id="${nodeId}"\\]\\s*\\{([^}]*)\\}\\s*`);
  const ruleMatch = ruleRe.exec(bandInner);
  const props = new Map<string, string>();
  if (ruleMatch) {
    for (const decl of ruleMatch[1].split(';')) {
      const idx = decl.indexOf(':');
      if (idx === -1) continue;
      const k = decl.slice(0, idx).trim();
      const v = decl.slice(idx + 1).trim().replace(/\s*!important\s*$/, '').trim();
      if (k) props.set(k, v);
    }
  }
  applyLocaleStyleWrites(props, styles);

  let newInner: string;
  if (props.size === 0) {
    newInner = ruleMatch ? bandInner.replace(ruleRe, '') : bandInner;
  } else if (ruleMatch) {
    newInner = bandInner.replace(ruleRe, buildRule(props) + '\n    ');
  } else {
    newInner = bandInner.replace(/\s*$/, '') + `\n      ${buildRule(props)}\n    `;
  }

  const newCSS = existingCSS.slice(0, headMatch.index + headMatch[0].length) + newInner + existingCSS.slice(i - 1);
  const [fullMatch, prefix, , suffix] = blockMatch;
  return code.slice(0, blockMatch.index!) + prefix + newCSS + suffix + code.slice(blockMatch.index! + fullMatch.length);
}
