// ComponentPropsTool/instance-props.ts — JSX instance-tag prop read/write helpers
// lifted verbatim from ComponentPropsTool.tsx (Phase 7 god-file split, item 7.5).

import { findTagClose } from '@/code/generation/generator-utils';
import { parseScopedScalarExpr } from '@/code/generation/generator-motion';
import {
  formatConditionalPropExpression,
  setConditionalPropEntry,
  hasVariantOverrides,
  currentConditionalMap,
} from '@/code/components/instance-conditional-prop';
import { findTagAttrs, formatStringAttr, readTagAttr, writeTagAttr } from '@/code/components/jsx-tag-attrs';
import { trace } from '@/shared/debug-trace';

// ─── JSX Instance Helpers ────────────────────────────────────────────────────

/**
 * Find the Nth instance of <ComponentName in the code.
 * nodeId like "auto_2" → occurrence index 2 (0-based counter from parser).
 * Returns { tagStart, tagEnd } or null.
 */
function findInstanceTag(code: string, nodeId: string, componentName: string): { tagStart: number; tagEnd: number } | null {
  // The parser assigns auto_0, auto_1, etc. in order.
  // We need to find which occurrence this instance is.
  // First try: if the instance has a data-id in the code, use that
  // Find instance tag by data-id — must be on the actual component/element JSX tag,
  // NOT inside CSS selectors like `[data-id="..."]` or template strings.
  // Verify by checking that the character immediately before `data-id` is whitespace
  // (JSX attribute) not `[` (CSS selector) or `"` (string).
  const idPattern = `data-id="${nodeId}"`;
  let idSearchFrom = 0;
  while (idSearchFrom < code.length) {
    const idIdx = code.indexOf(idPattern, idSearchFrom);
    if (idIdx === -1) break;
    // Check char before data-id — must be whitespace (JSX attr separator)
    const charBefore = idIdx > 0 ? code[idIdx - 1] : '';
    if (charBefore === ' ' || charBefore === '\n' || charBefore === '\t') {
      // findTagClose (brace/quote-aware) instead of indexOf('>'): an instance can carry an inline arrow
      // handler like `event1={() => setOpen(true)}` whose `=>` contains a `>` — a naive indexOf would cut the
      // tag there, dropping every attr after it (e.g. a `color1={color1}` binding placed after event1 showed
      // as an unbound literal in the panel even though the hoist was wired in the code).
      // A prop VALUE before `data-id` can hold markup of its own (a formatted-text prop
      // `content={"<strong>Hi</strong>"}`), so a `<` only opens OUR tag when that tag closes after the id.
      let tagStart = idIdx;
      while (tagStart > 0) {
        tagStart--;
        if (code[tagStart] !== '<') continue;
        const tagEnd = findTagClose(code, tagStart);
        if (tagEnd > idIdx) return { tagStart, tagEnd: tagEnd + 1 };
      }
    }
    idSearchFrom = idIdx + idPattern.length;
  }

  // Find by component tag name + occurrence index
  // auto_0 is the first auto-id, but we need the occurrence among THIS component's instances
  const tagPattern = `<${componentName}`;
  let searchFrom = 0;
  const occurrences: number[] = [];

  while (searchFrom < code.length) {
    const idx = code.indexOf(tagPattern, searchFrom);
    if (idx === -1) break;
    // Make sure it's a tag boundary (next char is space, /, or >)
    const nextChar = code[idx + tagPattern.length];
    if (nextChar === ' ' || nextChar === '/' || nextChar === '>') {
      occurrences.push(idx);
    }
    searchFrom = idx + tagPattern.length;
  }

  if (occurrences.length === 0) return null;

  // Determine which occurrence: extract numeric suffix from nodeId (auto_N)
  // But auto_N counts ALL auto nodes, not just this component.
  // Simpler: if there's only one instance, use it. Otherwise use first for now.
  // TODO: handle multiple instances of same component properly
  const tagStart = occurrences[0];
  const tagEnd = findTagClose(code, tagStart); // brace/quote-aware (see the data-id path above)
  if (tagEnd === -1) return null;

  return { tagStart, tagEnd: tagEnd + 1 };
}

/** Parse props from a component instance in JSX: <Name propA="val" propB="val" /> */
export function parseInstanceProps(code: string, nodeId: string, componentName: string): Map<string, string> {
  const result = new Map<string, string>();
  const tag = findInstanceTag(code, nodeId, componentName);
  if (!tag) return result;

  const tagContent = code.slice(tag.tagStart, tag.tagEnd);

  // System / framer-motion-only attrs that should NEVER show as user
  // editable component-instance props. `transition` USED to be on this
  // list — but design components can legitimately declare `transition`
  // as a user-defined prop (e.g. a card whose master file destructures
  // `{ transition }` and forwards it to its own `<motion.div>`). With
  // `transition` skipped, the hoisted-variable detection downstream
  // never saw the rewritten identifier value, so `parentVarsByName`
  // missed the new variable and the row never flipped to a purple
  // pill — the user-reported "transition stays Default after hoist"
  // bug. The panel still only iterates `componentInfo.props` (the
  // actual function-signature props), so removing `transition` from
  // the skip list can't pollute the panel with framer-motion-internal
  // attrs that aren't real component props.
  // `ref` (Scroll Variant's layerInView wires a real ref onto the instance) and
  // `data-scroll-variant` (the effect's spec carrier) are machine-managed — never
  // user-editable props.
  const skipAttrs = new Set(['data-id', 'data-name', 'data-viewport', 'data-canvas-node', 'style', 'className', 'variants', 'animate', 'onTap', 'onHoverStart', 'onHoverEnd', 'onClick', 'ref', 'data-scroll-variant']);

  // Match string attrs: prop="val", prop='val', prop={"val"}
  // AND expression attrs: prop={123}, prop={true}, prop={someVar}
  // The expression branch tolerates ONE nested brace level so a template-literal
  // value (`coverImage={`url(${item.coverImage})`}` — the whole-value CMS image
  // binding) or an object value is captured WHOLE; the old `[^}]+` stopped at the
  // first inner `}` and returned a mangled half-expression.
  const propRegex = /(\w+)=(?:"([^"]*)"|'([^']*)'|\{['"]([^'"]*)['"]\}|\{((?:[^{}]|\{[^{}]*\})+)\})/g;
  let match;
  while ((match = propRegex.exec(tagContent)) !== null) {
    const name = match[1];
    if (skipAttrs.has(name)) continue;
    let value = match[2] ?? match[3] ?? match[4] ?? match[5]?.trim() ?? '';
    // An inline per-VIEWPORT ternary (`(__mqN ? var : base)`) → the prop's NOMINAL value is the BASE
    // (desktop/cascade) branch; the per-viewport branch surfaces separately via the replica pill. Only
    // peel `__mq` ternaries — variant (`X === 'v' ? …`) ternaries keep their existing whole-string form,
    // and pure-locale ternaries (no `__mq`) stay whole so the display resolver can pick the
    // active-locale branch.
    if (match[5] && /__mq/.test(match[5])) {
      const base = parseScopedScalarExpr(code, match[5].trim()).base;
      // The peeled base is raw JS source: a string literal keeps its QUOTES —
      // fed to a select it matches no option and renders the FIRST one (the
      // "Justify shows Start though the code says flex-end" find). Unquote
      // literals; a bare `undefined` base means "defer to the master default",
      // so the prop is treated as unset (the panel's ?? chain falls through).
      const lit = base.match(/^"([^"]*)"$|^'([^']*)'$/);
      if (lit) value = lit[1] ?? lit[2] ?? '';
      else if (base === 'undefined') continue;
      else value = base;
    } else if (match[5] && /^"(?:[^"\\]|\\.)*"$/.test(match[5].trim())) {
      // An escaped string literal (`prop={"<a href=\"/x\">y</a>"}` — setInstanceProp's form for a
      // value holding both quote kinds, e.g. formatted text): the prop's value is the DECODED string.
      try { value = JSON.parse(match[5].trim()); } catch { /* keep the raw source */ }
    }
    result.set(name, value);
  }

  return result;
}

/**
 * Locate `propName` on an instance tag through the JSX attribute scanner
 * (jsx-tag-attrs): a prop after a newline, a single-quoted or BARE (`featured`)
 * prop, and a `{…}` value holding nested objects or a template literal are all
 * found whole. A miss here used to make SET append the prop a second time — a
 * duplicate attribute whose later copy wins at runtime, so the write looked
 * ignored (agent set_component_prop, 2026-10-15). When a tag already carries
 * duplicates, the LAST one is reported: it is the one JSX applies.
 */
function findInstancePropSpan(tagContent: string, propName: string): { spaceStart: number; propStart: number; end: number } | null {
  const hits = findTagAttrs(tagContent, propName);
  const a = hits[hits.length - 1];
  return a ? { spaceStart: a.wsStart, propStart: a.start, end: a.end } : null;
}

/** Set or update a prop on a component instance: <Name /> → <Name prop="value" /> or <Name prop={value} /> */
export function setInstanceProp(code: string, nodeId: string, componentName: string, propName: string, value: string, useExpression = false): string {
  const tag = findInstanceTag(code, nodeId, componentName);
  if (!tag) return code;

  const tagContent = code.slice(tag.tagStart, tag.tagEnd);
  // Quote-safety for string-form props. JSX attribute values use `"..."` so a
  // value that contains a literal `"` (e.g. `url("...")`, a CSS shorthand
  // with a double-quoted family name) ends the attribute early and breaks
  // parsing. Switch to single-quoted JSX wrap when the value has `"`. If it
  // also has `'`, fall back to expression form with JSON.stringify so both
  // are escaped via `\"`.
  const formatted = useExpression ? `${propName}={${value}}` : formatStringAttr(propName, value);

  // Replace the existing prop in place — every spelling (scanner-located, see
  // findInstancePropSpan) — and drop any duplicate copies; else insert it
  // after the ACTUAL tag name, read from the tag itself — NEVER derived from
  // `componentName`: the registry name can be the component's internal
  // function name while the JSX uses the import name, and a longer registry
  // name landed the insert INSIDE `data-id="…"`, splitting it into bare
  // `data-` + `id="…"` (the auto_N silent-no-op corruption, 2026-07-30).
  const next = writeTagAttr(tagContent, propName, formatted);
  if (next === null) {
    trace.error('instance-props:set-unreadable-tag', { nodeId, componentName, propName });
    return code;
  }
  return code.slice(0, tag.tagStart) + next + code.slice(tag.tagEnd);
}

/** Remove a prop from a component instance: <Name prop="value" /> → <Name /> */
export function removeInstanceProp(code: string, nodeId: string, componentName: string, propName: string): string {
  const tag = findInstanceTag(code, nodeId, componentName);
  if (!tag) return code;

  const tagContent = code.slice(tag.tagStart, tag.tagEnd);
  // Scanner spans (shared with setInstanceProp) — the leading whitespace and
  // the whole value go, so a template-literal `linkHref` doesn't leave a stray
  // `` `} ``; every duplicate copy goes too.
  const next = writeTagAttr(tagContent, propName, null);
  if (next === null || next === tagContent) return code;
  return code.slice(0, tag.tagStart) + next + code.slice(tag.tagEnd);
}

/**
 * Set a per-parent-variant prop value on a component instance using a JSX
 * ternary (`initialVariant === 'X' ? 'A' : ...`). Used when the editor is
 * inside a component file and the user is on a non-default variant — the
 * prop change must apply to that parent variant only.
 *
 * Reads any existing ternary on the prop, updates the entry for
 * `parentVariantName`, and re-formats. Collapses to a plain string when no
 * per-parent overrides remain. Removes the prop entirely if the resulting
 * value is empty/'default'.
 */
export function setConditionalInstanceProp(
  code: string,
  nodeId: string,
  componentName: string,
  propName: string,
  parentVariantName: string,
  value: string,
  /** Seed for the DEFAULT branch when the prop is absent from the tag —
   *  generic props (fillColor…) must fall back to the CONTROL default, not
   *  the `initialVariant`-specific `'default'` literal the formatter uses. */
  defaultSeed?: string,
): string {
  const tag = findInstanceTag(code, nodeId, componentName);
  if (!tag) return code;

  const tagContent = code.slice(tag.tagStart, tag.tagEnd);

  // Read current value: either `propName="literal"` or `propName={expr}` —
  // through the attribute scanner, so `data-name` never answers for `name`
  // and a `{…}` value is read whole. Used as the seed for the conditional map
  // so prior overrides survive.
  const currentMap = currentConditionalMap(readTagAttr(tagContent, propName));
  const seeded = !currentMap && parentVariantName !== 'default' && defaultSeed != null && defaultSeed !== ''
    ? { default: defaultSeed }
    : currentMap;

  // Apply the update for this parent variant
  const nextMap = setConditionalPropEntry(seeded, parentVariantName, value);

  // Decide write form:
  //   - All entries collapse to default and default is empty/'default' → remove prop
  //   - No per-variant overrides → plain string `propName="value"`
  //   - Otherwise → ternary expression `propName={expr}`
  const onlyDefault = !hasVariantOverrides(nextMap);
  const defaultVal = nextMap['default'] ?? '';

  if (onlyDefault && (defaultVal === '' || defaultVal === 'default')) {
    return removeInstanceProp(code, nodeId, componentName, propName);
  }

  // Identifier choice: when the parent file has connections wired (a
  // `useState(initialVariant)` scaffold), `variant` is the LIVE state
  // that re-renders on toggle. The PROP `initialVariant` is frozen at
  // mount and never changes — so a ternary keyed on `initialVariant`
  // freezes the child instance's prop value at the initial parent
  // variant and never animates when the parent toggles.
  // Mirror of the heuristic at `generator-styles.ts:1096`.
  const parentVarName = code.includes('useState(initialVariant)') ? 'variant' : 'initialVariant';
  const formattedAttr = onlyDefault
    ? formatStringAttr(propName, defaultVal)
    : `${propName}={${formatConditionalPropExpression(nextMap, parentVarName)}}`;

  // Replace the existing prop in place (duplicates dropped) or insert it after
  // the tag name — the scanner span, never a `\{[^}]+\}` guess.
  const next = writeTagAttr(tagContent, propName, formattedAttr);
  if (next === null) {
    trace.error('instance-props:conditional-unreadable-tag', { nodeId, componentName, propName });
    return code;
  }
  return code.slice(0, tag.tagStart) + next + code.slice(tag.tagEnd);
}

/**
 * Read the RAW value of an instance prop: for `prop={EXPR}` returns the EXPR
 * source (braces stripped); for `prop="str"` returns the string content.
 * Null when the tag or prop is absent. Used by the cursor popup to seed the
 * per-instance `<prop>Opts` behaviour overrides.
 */
export function getInstancePropExpr(code: string, nodeId: string, componentName: string, propName: string): string | null {
  const tag = findInstanceTag(code, nodeId, componentName);
  if (!tag) return null;
  const tagContent = code.slice(tag.tagStart, tag.tagEnd);
  const span = findInstancePropSpan(tagContent, propName);
  if (!span) return null;
  const raw = tagContent.slice(span.propStart + propName.length + 1, span.end);
  if (raw.startsWith('{')) return raw.slice(1, -1).trim();
  if (raw.startsWith('"') || raw.startsWith("'")) return raw.slice(1, -1);
  return null;
}
