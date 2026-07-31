// cms-gen.ts — CMS collection code generation.
// Pure functions: code string in → code string out.
// Handles collection list creation, field binding/unbinding, and filter/sort/limit config.

import { trace } from '@/shared/debug-trace';
import { findTagClose, findMatchingCloseTagIndex, findStyleObjectEnd, insertAfterLastImportLine } from './generator-utils';
import type { FilterGroup, SortConfig } from '@/shared/types';

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Find the JSX opening tag for an element by data-id.
 * Returns the index of `<` for the opening tag, or -1 if not found.
 * Skips CSS selectors like [data-id="..."] in <style> blocks.
 */
export function findJSXElementByDataId(code: string, nodeId: string): number {
  const idStr = `data-id="${nodeId}"`;
  let searchFrom = 0;
  while (searchFrom < code.length) {
    const found = code.indexOf(idStr, searchFrom);
    if (found === -1) return -1;
    // Check if this is inside a JSX tag (look back for <tagName, not [)
    const before = code.lastIndexOf('<', found);
    const bracket = code.lastIndexOf('[', found);
    if (before > bracket) {
      return before; // Preceded by < not [ → JSX element
    }
    searchFrom = found + idStr.length;
  }
  return -1;
}

/**
 * Find the matching closing tag for an element starting at `openTagStart`.
 * Returns the end index (after `</tag>`), or -1 if not found.
 */
export function findClosingTag(code: string, openTagStart: number): { contentStart: number; closeTagStart: number; closeTagEnd: number } | null {
  // Extract tag name
  const tagMatch = code.slice(openTagStart + 1).match(/^(\w[\w.-]*)/);
  if (!tagMatch) return null;
  const tagName = tagMatch[1];

  // Find end of opening tag
  const openTagEnd = findTagClose(code, openTagStart + 1);
  if (openTagEnd === -1) return null;

  // Self-closing?
  if (code[openTagEnd - 1] === '/') return null;

  const contentStart = openTagEnd + 1;

  // Find matching closing tag (handle nesting + self-closing same-tag
  // children) — shared depth matcher from generator-utils.
  const closeTagStart = findMatchingCloseTagIndex(code, tagName, contentStart);
  if (closeTagStart === -1) return null;
  return {
    contentStart,
    closeTagStart,
    closeTagEnd: closeTagStart + `</${tagName}>`.length,
  };
}

/**
 * Ensure an import line exists at the top of the code.
 * Adds `import <slug> from '@/cms/<slug>.json'` if not already present.
 */
function ensureCmsImport(code: string, slug: string): string {
  const importPath = `@/cms/${slug}.json`;
  if (code.includes(importPath)) return code;
  const importLine = `import ${slug} from '${importPath}';`;
  // Insert after last existing import; no imports at all → at the very top.
  return insertAfterLastImportLine(code, importLine) ?? (importLine + '\n' + code);
}

// ─── Filter/Sort/Limit Code Generation ──────────────────────────────────────

// A date-only string from the date picker: "2026-06-15". When a filter value
// looks like this, the field is compared by its CALENDAR DAY only — `_createdAt`
// /`_updatedAt` hold a full ISO timestamp ("2026-06-15T20:32:00.000Z"), so a
// plain `item._createdAt === "2026-06-15"` would NEVER match. `String(x).slice(0,10)`
// normalizes both a full timestamp and a date-only user field to "YYYY-MM-DD",
// which also lexically compares chronologically for gt/lt/between.
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDateVal = (v: any): boolean => typeof v === 'string' && DATE_ONLY_RE.test(v);

export function buildFilterExpression(fg: FilterGroup): string {
  const conditions = fg.filters.map(f => {
    // Dynamic value (Phase 4) — the predicate reads a page variable (search input /
    // date picker) at runtime, with an empty-guard so a blank input matches all.
    if (f.valueSource === 'searchField' && f.valueVar) {
      return `(${f.valueVar} === '' || String(item.${f.field}).toLowerCase().includes(${f.valueVar}.toLowerCase()))`;
    }
    if (f.valueSource === 'dateField' && f.valueVar) {
      return `(!${f.valueVar} || item.${f.field} >= ${f.valueVar})`;
    }
    // Date-aware LHS for comparison operators (see DATE_ONLY_RE note above).
    const dateCmp = isDateVal(f.value) || (Array.isArray(f.value) && (isDateVal(f.value[0]) || isDateVal(f.value[1])));
    const lhs = dateCmp ? `String(item.${f.field}).slice(0, 10)` : `item.${f.field}`;
    switch (f.operator) {
      case 'equals': return `${lhs} === ${JSON.stringify(f.value)}`;
      case 'not_equals': return `${lhs} !== ${JSON.stringify(f.value)}`;
      // contains / not_contains are CASE-INSENSITIVE (design-tool parity) — "the"
      // matches "The Truth…" as well as "…the spreadsheet".
      case 'contains': return `String(item.${f.field}).toLowerCase().includes(String(${JSON.stringify(f.value)}).toLowerCase())`;
      case 'not_contains': return `!String(item.${f.field}).toLowerCase().includes(String(${JSON.stringify(f.value)}).toLowerCase())`;
      case 'gt': return `${lhs} > ${JSON.stringify(f.value)}`;
      case 'gte': return `${lhs} >= ${JSON.stringify(f.value)}`;
      case 'lt': return `${lhs} < ${JSON.stringify(f.value)}`;
      case 'lte': return `${lhs} <= ${JSON.stringify(f.value)}`;
      case 'in': return `${JSON.stringify(f.value)}.includes(item.${f.field})`;
      case 'not_in': return `!${JSON.stringify(f.value)}.includes(item.${f.field})`;
      case 'exists': return `item.${f.field} != null`;
      case 'between': {
        const [lo, hi] = Array.isArray(f.value) ? f.value : [f.value, f.value];
        return `(${lhs} >= ${JSON.stringify(lo)} && ${lhs} <= ${JSON.stringify(hi)})`;
      }
    }
  });

  const joiner = fg.combinator === 'or' ? ' || ' : ' && ';
  return conditions.join(joiner);
}

/** One sort key → a parenthesized 3-branch comparator that returns 0 on a tie so
 *  the next `||`-joined key can break it. asc: `>` ⇒ +1; desc: `>` ⇒ -1. */
export function buildSortKeyExpr(field: string, direction: 'asc' | 'desc'): string {
  const [gt, lt] = direction === 'desc' ? ['-1', '1'] : ['1', '-1'];
  return `(a.${field} > b.${field} ? ${gt} : a.${field} < b.${field} ? ${lt} : 0)`;
}

function buildChainCode(
  slug: string,
  filterGroup?: FilterGroup,
  sort?: SortConfig | SortConfig[] | null,
  limit?: number,
  /** When set, the chain ends `.slice(0, <paginationVar>)` (pagination's visibleCount
   *  state) INSTEAD of a numeric limit — so editing filter/sort doesn't wipe pagination. */
  paginationVar?: string | null,
  /** Start offset — skip the first N items. `.slice(offset, offset+limit)` (both),
   *  `.slice(offset)` (offset only). Ignored when pagination is on. */
  offset?: number,
): string {
  let chain = slug;

  if (filterGroup && filterGroup.filters.length > 0) {
    chain += `.filter(item => ${buildFilterExpression(filterGroup)})`;
  }

  const sortKeys = Array.isArray(sort) ? sort : sort ? [sort] : [];
  if (sortKeys.length > 0) {
    const cmp = sortKeys.map(k => buildSortKeyExpr(k.field, k.direction)).join(' || ');
    chain += `.sort((a, b) => ${cmp})`;
  }

  const off = offset && offset > 0 ? offset : 0;
  const hasLimit = limit !== undefined && limit > 0;
  if (paginationVar) {
    chain += `.slice(0, ${paginationVar})`;          // pagination wins over numeric limit
  } else if (off > 0 && hasLimit) {
    chain += `.slice(${off}, ${off + limit!})`;       // end index = offset + count
  } else if (off > 0) {
    chain += `.slice(${off})`;
  } else if (hasLimit) {
    chain += `.slice(0, ${limit})`;
  }

  return chain;
}

/** Deterministic pagination state-var name for a list id — MUST match
 *  cms-pagination-gen.paginationStateVar (kept here to avoid a circular import). */
function paginationVarForId(id: string): string {
  const s = id.replace(/[^a-zA-Z0-9]/g, '');
  return 'vis' + s.charAt(0).toUpperCase() + s.slice(1);
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Create a collection list in code:
 * 1. Add import: import <slug> from '@/cms/<slug>.json'
 * 2. Replace parent's children with {slug.map(item => (<template>))}
 */
export function createCollectionListInCode(
  code: string,
  parentId: string,
  collectionSlug: string,
  templateJSX: string,
): string {
  trace.fn('cms-gen:createCollectionList', { parentId, collectionSlug });

  // Step 1: Ensure import exists
  let result = ensureCmsImport(code, collectionSlug);

  // Step 2: Find parent element
  const parentStart = findJSXElementByDataId(result, parentId);
  if (parentStart === -1) {
    trace.error('cms-gen:createCollectionList', { message: 'Parent element not found', ...{ parentId } });
    return code;
  }

  const closing = findClosingTag(result, parentStart);
  if (!closing) {
    trace.error('cms-gen:createCollectionList', { message: 'Cannot find closing tag for parent', ...{ parentId } });
    return code;
  }

  // Step 3: Replace children with .map() expression
  const mapExpr = `\n      {${collectionSlug}.map(item => (\n        ${templateJSX}\n      ))}\n    `;

  result = result.slice(0, closing.contentStart) + mapExpr + result.slice(closing.closeTagStart);

  trace.action('cms-gen:createCollectionList:done', { parentId, collectionSlug });
  return result;
}

/**
 * Bind a field to an element's property. Dispatches to the right rewriter:
 *   'text'                       → child text content {item.fieldName}
 *   'src' | 'href' | 'alt'       → JSX attribute={item.fieldName}
 *   anything else (CSS prop)     → style={{ ...existing, prop: item.fieldName }}
 *
 * The CSS branch is what makes the standard "+" picker work for Fill,
 * Color, Radius, Opacity, etc. — the binding lives inside the existing
 * `style={{ ... }}` object rather than as a separate attribute.
 */
export function bindFieldInCode(
  code: string,
  nodeId: string,
  property: string,
  fieldId: string,
  itemVar: string,
  fieldType?: string,
): string {
  trace.fn('cms-gen:bindField', { nodeId, property, fieldId, itemVar, fieldType });

  if (!property || !property.trim()) {
    trace.error('cms-gen:bindField', { message: 'Empty property', nodeId, fieldId });
    return code;
  }

  if (property === 'text' || property === 'textContent') {
    return bindTextFieldInCode(code, nodeId, fieldId, itemVar);
  }
  if (property === 'src' || property === 'href' || property === 'alt') {
    return bindAttributeFieldInCode(code, nodeId, property, fieldId, itemVar);
  }

  // Fill (`backgroundColor`) accepts both color and image fields. An image
  // field doesn't fit a `background-color: url(...)` slot — CSS would
  // ignore it — so when an image was picked, rewrite the binding to use
  // `backgroundImage: \`url(${item.field})\`` and clear any stale
  // `backgroundColor` entry. Same dispatch applies if other "Fill"-style
  // properties grow image support later.
  if (property === 'backgroundColor' && (fieldType === 'image' || fieldType === 'file')) {
    const cleared = unbindStyleFieldInCode(code, nodeId, 'backgroundColor');
    return bindBackgroundImageFieldInCode(cleared, nodeId, fieldId, itemVar);
  }

  return bindStyleFieldInCode(code, nodeId, property, fieldId, itemVar);
}

/** Bind an image field as `backgroundImage: \`url(${item.field})\``. Adds
 *  cover-sized + centered defaults so the image actually shows; the user
 *  can override via the regular Image / Mask controls afterwards. */
function bindBackgroundImageFieldInCode(
  code: string,
  nodeId: string,
  fieldId: string,
  itemVar: string,
): string {
  const urlValue = `\`url(\${${itemVar}.${fieldId}})\``;
  let result = setStyleEntryInCode(code, nodeId, 'backgroundImage', urlValue);
  if (!/backgroundSize\s*:/.test(result)) {
    result = setStyleEntryInCode(result, nodeId, 'backgroundSize', `'cover'`);
  }
  if (!/backgroundPosition\s*:/.test(result)) {
    result = setStyleEntryInCode(result, nodeId, 'backgroundPosition', `'center'`);
  }
  return result;
}

/**
 * Bind a CSS property to a CMS field. Inserts (or replaces) a key inside
 * the element's `style={{ ... }}` object so it reads
 * `style={{ backgroundColor: item.brand }}`.
 *
 * Idempotent: calling twice on the same property+field is a no-op. If the
 * style attribute doesn't exist yet on the element, it's created.
 */
function bindStyleFieldInCode(
  code: string,
  nodeId: string,
  styleProp: string,
  fieldId: string,
  itemVar: string,
): string {
  return setStyleEntryInCode(code, nodeId, styleProp, `${itemVar}.${fieldId}`);
}

/**
 * Lower-level helper: insert / replace a `propName: value` entry inside an
 * element's `style={{ ... }}` object. `value` is any valid JSX expression
 * source — `item.brand`, `'cover'`, `` `url(${item.cover})` `` — caller
 * is responsible for quoting strings. This is what `bindStyleField`,
 * `bindBackgroundImageField`, and the auto-default writers all share.
 */
function setStyleEntryInCode(
  code: string,
  nodeId: string,
  styleProp: string,
  value: string,
): string {
  const elStart = findJSXElementByDataId(code, nodeId);
  if (elStart === -1) {
    trace.error('cms-gen:setStyleEntry', { message: 'Element not found', nodeId });
    return code;
  }

  const openTagEnd = findTagClose(code, elStart + 1);
  if (openTagEnd === -1) {
    trace.error('cms-gen:setStyleEntry', { message: 'Cannot find tag close', nodeId });
    return code;
  }

  const tagSlice = code.slice(elStart, openTagEnd + 1);

  const styleOpenMatch = tagSlice.match(/style=\{\{/);
  if (!styleOpenMatch || styleOpenMatch.index === undefined) {
    const insertIdx = tagSlice.length - 1;
    const closingChar = tagSlice[insertIdx];
    const styleAttr = ` style={{ ${styleProp}: ${value} }}`;
    let newTagSlice: string;
    if (closingChar === '>' && tagSlice[insertIdx - 1] === '/') {
      newTagSlice = tagSlice.slice(0, insertIdx - 1) + styleAttr + ' />';
    } else {
      newTagSlice = tagSlice.slice(0, insertIdx) + styleAttr + '>';
    }
    return code.slice(0, elStart) + newTagSlice + code.slice(elStart + tagSlice.length);
  }

  const styleObjStart = elStart + styleOpenMatch.index + 'style={{'.length;
  // Index of the inner closing `}`; unbalanced → last char (historic fallout).
  const objEndCandidate = findStyleObjectEnd(code, styleObjStart);
  const objEnd = objEndCandidate === -1 ? code.length - 1 : objEndCandidate;

  const objBody = code.slice(styleObjStart, objEnd);
  const keyRegex = new RegExp(`(^|[\\s{,])${styleProp}\\s*:\\s*(?:'[^']*'|"[^"]*"|\`[^\`]*\`|\\{[^}]*\\}|[^,}]+)`);
  const newEntry = `${styleProp}: ${value}`;

  let newBody: string;
  if (keyRegex.test(objBody)) {
    newBody = objBody.replace(keyRegex, (_match, lead) => `${lead}${newEntry}`);
  } else {
    // Append to the object — be careful about trailing comma.
    const trimmed = objBody.trimEnd();
    const needsComma = trimmed.length > 0 && !trimmed.endsWith(',') && !trimmed.endsWith('{');
    newBody = (needsComma ? `${objBody}, ` : objBody.endsWith(' ') ? objBody : `${objBody} `) + newEntry;
  }

  trace.action('cms-gen:setStyleEntry:done', { nodeId, styleProp, value });
  return code.slice(0, styleObjStart) + newBody + code.slice(objEnd);
}

/**
 * Bind a text field: replace element's text content with {itemVar.fieldId}
 */
function bindTextFieldInCode(code: string, nodeId: string, fieldId: string, itemVar: string): string {
  const elStart = findJSXElementByDataId(code, nodeId);
  if (elStart === -1) {
    trace.error('cms-gen:bindTextField', { message: 'Element not found', ...{ nodeId } });
    return code;
  }

  const closing = findClosingTag(code, elStart);
  if (!closing) {
    trace.error('cms-gen:bindTextField', { message: 'Cannot find closing tag', ...{ nodeId } });
    return code;
  }

  // Replace content between opening and closing tags
  const binding = `{${itemVar}.${fieldId}}`;
  const result = code.slice(0, closing.contentStart) + binding + code.slice(closing.closeTagStart);

  trace.action('cms-gen:bindTextField:done', { nodeId, fieldId });
  return result;
}

/**
 * Bind an attribute field: replace src="..." with src={itemVar.fieldId}, etc.
 */
function bindAttributeFieldInCode(
  code: string,
  nodeId: string,
  attrName: string,
  fieldId: string,
  itemVar: string,
): string {
  const elStart = findJSXElementByDataId(code, nodeId);
  if (elStart === -1) {
    trace.error('cms-gen:bindAttributeField', { message: 'Element not found', ...{ nodeId } });
    return code;
  }

  const openTagEnd = findTagClose(code, elStart + 1);
  if (openTagEnd === -1) {
    trace.error('cms-gen:bindAttributeField', { message: 'Cannot find tag close', ...{ nodeId } });
    return code;
  }

  const tagSlice = code.slice(elStart, openTagEnd + 1);

  // Match existing attribute: attrName="value" or attrName={value}
  const strAttrRegex = new RegExp(`${attrName}="[^"]*"`);
  const exprAttrRegex = new RegExp(`${attrName}=\\{[^}]*\\}`);
  const binding = `${attrName}={${itemVar}.${fieldId}}`;

  let newTagSlice: string;
  if (strAttrRegex.test(tagSlice)) {
    newTagSlice = tagSlice.replace(strAttrRegex, binding);
  } else if (exprAttrRegex.test(tagSlice)) {
    newTagSlice = tagSlice.replace(exprAttrRegex, binding);
  } else {
    // Attribute doesn't exist — add it before the closing >
    const insertIdx = tagSlice.length - 1;
    const closingChar = tagSlice[insertIdx];
    // Handle self-closing: insert before />
    if (closingChar === '>' && tagSlice[insertIdx - 1] === '/') {
      newTagSlice = tagSlice.slice(0, insertIdx - 1) + ` ${binding} />`;
    } else {
      newTagSlice = tagSlice.slice(0, insertIdx) + ` ${binding}>`;
    }
  }

  const result = code.slice(0, elStart) + newTagSlice + code.slice(elStart + tagSlice.length);

  trace.action('cms-gen:bindAttributeField:done', { nodeId, attrName, fieldId });
  return result;
}

/**
 * Unbind a field: replace {item.fieldName} with static text.
 * For text properties: replace expression in content.
 * For attributes: replace expression-bound attribute with static value.
 */
export function unbindFieldInCode(
  code: string,
  nodeId: string,
  property: string,
  staticValue: string,
): string {
  trace.fn('cms-gen:unbindField', { nodeId, property, staticValue });

  if (!property || !property.trim()) {
    trace.error('cms-gen:unbindField', { message: 'Empty property', nodeId });
    return code;
  }
  if (property === 'text' || property === 'textContent') {
    return unbindTextFieldInCode(code, nodeId, staticValue);
  }
  if (property === 'src' || property === 'href' || property === 'alt') {
    return unbindAttributeFieldInCode(code, nodeId, property, staticValue);
  }
  // Fill image binding lives under `backgroundImage` (with sane
  // backgroundSize / backgroundPosition defaults the bind path injected).
  // When the user clicks × on the Fill pill, clean up all three so the
  // element returns to a normal "no fill" state — leaving backgroundSize
  // behind would survive future binds and look weird.
  if (property === 'backgroundColor') {
    let result = unbindStyleFieldInCode(code, nodeId, 'backgroundColor');
    result = unbindStyleFieldInCode(result, nodeId, 'backgroundImage');
    result = unbindStyleFieldInCode(result, nodeId, 'backgroundSize');
    result = unbindStyleFieldInCode(result, nodeId, 'backgroundPosition');
    return result;
  }
  return unbindStyleFieldInCode(code, nodeId, property);
}

/** Remove a CSS style key from `style={{ ... }}`. Used when the user
 *  picks "Unbind Field" on a property that was bound to a CMS field via
 *  the style-object rewriter. */
function unbindStyleFieldInCode(code: string, nodeId: string, styleProp: string): string {
  const elStart = findJSXElementByDataId(code, nodeId);
  if (elStart === -1) return code;
  const openTagEnd = findTagClose(code, elStart + 1);
  if (openTagEnd === -1) return code;

  const tagSlice = code.slice(elStart, openTagEnd + 1);
  const styleOpenMatch = tagSlice.match(/style=\{\{/);
  if (!styleOpenMatch || styleOpenMatch.index === undefined) return code;

  const styleObjStart = elStart + styleOpenMatch.index + 'style={{'.length;
  // Index of the inner closing `}`; unbalanced → last char (historic fallout).
  const objEndCandidate = findStyleObjectEnd(code, styleObjStart);
  const objEnd = objEndCandidate === -1 ? code.length - 1 : objEndCandidate;
  const objBody = code.slice(styleObjStart, objEnd);

  // Match the entry plus the comma + whitespace separator on either side.
  // Value alternatives, in order: backtick template literal (handles
  // `url(${item.cover})` with embedded `${...}` expressions whose `}`
  // would otherwise kill the bare-value fallback), single-quoted,
  // double-quoted, brace-expression, bare. Without the template-literal
  // branch the bare fallback `[^,}]+` stops at the first `}` inside the
  // interpolation and leaves a stray `})\`` behind, breaking the JSX.
  const removeRegex = new RegExp(
    '(?:,\\s*)?' +
    styleProp + '\\s*:\\s*' +
    '(?:`(?:[^\\\\`]|\\\\.|\\$\\{[^}]*\\})*`' +
    '|\'[^\']*\'' +
    '|"[^"]*"' +
    '|\\{[^}]*\\}' +
    '|[^,}]+)' +
    '(?:\\s*,)?',
  );
  const newBody = objBody.replace(removeRegex, (match) => {
    // If we consumed BOTH leading and trailing commas, leave one in.
    if (match.startsWith(',') && match.endsWith(',')) return ',';
    return '';
  });

  trace.action('cms-gen:unbindStyleField:done', { nodeId, styleProp });
  return code.slice(0, styleObjStart) + newBody + code.slice(objEnd);
}

function unbindTextFieldInCode(code: string, nodeId: string, staticValue: string): string {
  const elStart = findJSXElementByDataId(code, nodeId);
  if (elStart === -1) {
    trace.error('cms-gen:unbindTextField', { message: 'Element not found', ...{ nodeId } });
    return code;
  }

  const closing = findClosingTag(code, elStart);
  if (!closing) {
    trace.error('cms-gen:unbindTextField', { message: 'Cannot find closing tag', ...{ nodeId } });
    return code;
  }

  // Replace content (which should be {item.something}) with static text
  const result = code.slice(0, closing.contentStart) + staticValue + code.slice(closing.closeTagStart);

  trace.action('cms-gen:unbindTextField:done', { nodeId });
  return result;
}

function unbindAttributeFieldInCode(code: string, nodeId: string, attrName: string, staticValue: string): string {
  const elStart = findJSXElementByDataId(code, nodeId);
  if (elStart === -1) {
    trace.error('cms-gen:unbindAttributeField', { message: 'Element not found', ...{ nodeId } });
    return code;
  }

  const openTagEnd = findTagClose(code, elStart + 1);
  if (openTagEnd === -1) {
    trace.error('cms-gen:unbindAttributeField', { message: 'Cannot find tag close', ...{ nodeId } });
    return code;
  }

  const tagSlice = code.slice(elStart, openTagEnd + 1);

  // Match expression attribute: attrName={something}
  const exprAttrRegex = new RegExp(`${attrName}=\\{[^}]*\\}`);
  const staticAttr = `${attrName}="${staticValue}"`;

  if (exprAttrRegex.test(tagSlice)) {
    const newTagSlice = tagSlice.replace(exprAttrRegex, staticAttr);
    const result = code.slice(0, elStart) + newTagSlice + code.slice(elStart + tagSlice.length);
    trace.action('cms-gen:unbindAttributeField:done', { nodeId, attrName });
    return result;
  }

  // No expression binding found — return unchanged
  trace.error('cms-gen:unbindAttributeField', { message: 'No expression binding found', ...{ nodeId, attrName } });
  return code;
}

/**
 * Update collection list filter/sort/limit in code.
 * Finds the .map() call on the collection variable and inserts/updates
 * .filter()/.sort()/.slice() before .map().
 */
export function updateCollectionListConfigInCode(
  code: string,
  parentId: string,
  filterGroup?: FilterGroup,
  sort?: SortConfig | SortConfig[] | null,
  limit?: number,
  offset?: number,
): string {
  trace.fn('cms-gen:updateCollectionConfig', { parentId, hasFilter: !!filterGroup, hasSort: !!sort, limit, offset });

  // Find the parent element to locate the .map() expression
  const elStart = findJSXElementByDataId(code, parentId);
  if (elStart === -1) {
    trace.error('cms-gen:updateCollectionConfig', { message: 'Parent element not found', ...{ parentId } });
    return code;
  }

  const closing = findClosingTag(code, elStart);
  if (!closing) {
    trace.error('cms-gen:updateCollectionConfig', { message: 'Cannot find closing tag', ...{ parentId } });
    return code;
  }

  // Extract the content between opening and closing tags
  const content = code.slice(closing.contentStart, closing.closeTagStart);

  // Find the .map( call and walk backward to find the slug identifier.
  // Strategy: find `.map(<callback-args> =>` then scan backward past any
  // chained calls (.filter(...), .sort(...), .slice(...)) to the
  // identifier start.
  //
  // Two callback-arg shapes survive in the wild — single-arg `item =>`
  // (the legacy createCollectionListInCode output) and two-arg
  // `(item, idx) =>` (the current bindToCmsCollectionInCode output). The
  // earlier regex only matched the first; ALL filter/sort/limit edits on
  // the new shape silently fell through. Capture either shape, preserve
  // it verbatim on the rewrite.
  const mapCallRegex = new RegExp(COLLECTION_MAP_CALL_RE.source, 'g');
  const mapMatch = mapCallRegex.exec(content);

  if (!mapMatch) {
    trace.error('cms-gen:updateCollectionConfig', { message: 'No .map() expression found in parent', ...{ parentId } });
    return code;
  }

  const callbackParam = mapMatch[1]; // 'item' OR '(item, idx)'
  const mapDotIdx = mapMatch.index; // index of the `.` before `map(`

  // Walk backward from .map( past chained .filter()/.sort()/.slice() to the slug.
  const head = findCollectionChainHead(content, mapDotIdx);
  if (!head) {
    trace.error('cms-gen:updateCollectionConfig', { message: 'Cannot identify collection slug', ...{ parentId } });
    return code;
  }
  const { slugStart, slug } = head;

  // If this list is paginated (data-pagination marker on the opening tag), the chain
  // must keep `.slice(0, <visibleCount>)` — NOT a numeric limit — so editing filter/sort
  // here doesn't wipe pagination's slice.
  const openingTag = code.slice(elStart, closing.contentStart);
  const paginationVar = /data-pagination="/.test(openingTag) ? paginationVarForId(parentId) : null;

  // Build the new chain
  const newChain = buildChainCode(slug, filterGroup, sort, limit, paginationVar, offset);
  const newChainWithMap = `${newChain}.map(${callbackParam} =>`;

  // Replace from slug start to end of `.map(itemVar =>`
  const oldChainEnd = mapMatch.index + mapMatch[0].length;
  const absoluteStart = closing.contentStart + slugStart;
  const absoluteEnd = closing.contentStart + oldChainEnd;

  const result = code.slice(0, absoluteStart) + newChainWithMap + code.slice(absoluteEnd);

  trace.action('cms-gen:updateCollectionConfig:done', { parentId, slug });
  return result;
}

/** Skip whitespace backward and return the index of the first non-whitespace char. */
function skipWhitespaceBackward(str: string, from: number): number {
  while (from >= 0 && /\s/.test(str[from])) from--;
  return from;
}

/** Find the matching opening paren for a closing paren at `closeIdx`. */
function findMatchingParenBackward(str: string, closeIdx: number): number {
  let depth = 0;
  let inString: string | null = null;
  // Simple backward scan — for short chain segments this is sufficient
  for (let i = closeIdx; i >= 0; i--) {
    const ch = str[i];
    // Basic string tracking (simplified for this use case)
    if (inString) {
      if (ch === inString && (i === 0 || str[i - 1] !== '\\')) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch;
      continue;
    }
    if (ch === ')') depth++;
    if (ch === '(') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** Permissive `.map(<callback>` matcher — captures BOTH the single-arg `item =>`
 *  and two-arg `(item, idx) =>` callback shapes that survive in the wild. */
export const COLLECTION_MAP_CALL_RE = /\.map\(\s*(\(\s*\w+(?:\s*,\s*\w+)?\s*\)|\w+)\s*=>/g;

/** Given a collection-list `content` string and the index of the `.` in `.map(`,
 *  walk BACKWARD past any chained `.filter(...)/.sort(...)/.slice(...)` calls to the
 *  chain-head identifier (the collection slug var). Returns its `[slugStart, slugEnd)`
 *  span (relative to `content`) + the slug text, or null if it can't be identified.
 *  Shared by `updateCollectionListConfigInCode` (rewrite the chain) and
 *  `changeCollectionSourceInCode` (rewrite ONLY the head) so the two never diverge —
 *  the old narrow regex in changeCollectionSource silently failed once any chain
 *  method sat between the slug and `.map(`. */
export function findCollectionChainHead(
  content: string,
  mapDotIdx: number,
): { slugStart: number; slugEnd: number; slug: string } | null {
  let chainStart = mapDotIdx;
  // Skip past `.methodName(...)` segments (filter/sort/slice) tracking balanced parens.
  while (chainStart > 0) {
    const prevNonSpace = skipWhitespaceBackward(content, chainStart - 1);
    if (prevNonSpace < 0 || content[prevNonSpace] !== ')') break;
    const openParen = findMatchingParenBackward(content, prevNonSpace);
    if (openParen < 0) break;
    const beforeParen = skipWhitespaceBackward(content, openParen - 1);
    if (beforeParen < 0) break;
    let methodStart = beforeParen;
    while (methodStart > 0 && /\w/.test(content[methodStart - 1])) methodStart--;
    if (methodStart <= 0 || content[methodStart - 1] !== '.') break;
    chainStart = methodStart - 1; // position of the dot
  }
  const slugEnd = chainStart;
  let slugStart = slugEnd;
  while (slugStart > 0 && /\w/.test(content[slugStart - 1])) slugStart--;
  const slug = content.slice(slugStart, slugEnd);
  if (!slug || !/^\w+$/.test(slug)) return null;
  return { slugStart, slugEnd, slug };
}

/** Extract the iterator var (first param) from a `.map()` callback-param capture,
 *  e.g. `'item'` from `'item'` or from `'(item, idx)'`. */
export function itemVarFromCallbackParam(param: string): string {
  const m = param.match(/^\(?\s*(\w+)/);
  return m ? m[1] : 'item';
}

/** Return the collection slug SPAN for a list's `.map()` chain, handling BOTH shapes:
 *  the inline chain (`slug.filter().sort().slice()`) AND the responsive-upgraded
 *  `__applyListConfig(slug, cfgVar)` head — findCollectionChainHead returns null on
 *  the latter (its head is the `__applyListConfig` call, not a bare identifier), so
 *  callers that must REWRITE the slug (source change) or READ it (pagination) need
 *  this. Returns `[slugStart, slugEnd)` relative to `content` + the slug text. */
export function extractCollectionSlugSpan(
  content: string,
  mapDotIdx: number,
): { slugStart: number; slugEnd: number; slug: string } | null {
  const applyIdx = content.lastIndexOf('__applyListConfig(', mapDotIdx);
  if (applyIdx >= 0) {
    let s = applyIdx + '__applyListConfig('.length;
    while (s < content.length && /\s/.test(content[s])) s++;
    let e = s;
    while (e < content.length && /\w/.test(content[e])) e++;
    const slug = content.slice(s, e);
    if (slug && /^\w+$/.test(slug)) return { slugStart: s, slugEnd: e, slug };
  }
  return findCollectionChainHead(content, mapDotIdx);
}

/** Slug-only convenience over {@link extractCollectionSlugSpan}. */
export function extractCollectionSlug(content: string, mapDotIdx: number): string | null {
  const span = extractCollectionSlugSpan(content, mapDotIdx);
  return span ? span.slug : null;
}
