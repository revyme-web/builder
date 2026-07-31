// template-props.ts — Per-page values for a TEMPLATE's variables.
//
// A template (route-group `LayoutClient.tsx`) is a design-component master: it
// declares variables as function params (+ @propMeta), exactly like a component.
// Each PAGE that lives under the template's route group can override those
// variables with its own values — e.g. one page targets `leadership-section`
// for a scroll effect, another targets `hero`. Those per-page values live in a
//   /** @templateProps { "scrollSection": "leadership-section" } */
// annotation block on the PAGE (page.client.tsx) — page-owned, mirroring how
// @canvas / @pageVariables are stored.
//
// A Next.js layout can't read child-page props (the page is the child) and the
// page can't push context UP, so at render the values are resolved by a PULL:
//   - canvas: store.ts layout-merge bakes the active page's @templateProps onto
//     the merged layout nodes (compile-time, like component instance props).
//   - deploy: a generated route→props map + usePathname() in LayoutClient.
// This file owns the storage layer only (parse/serialize the annotation).

import { trace } from '@/shared/debug-trace';

/** Flat map of template-variable name → string value (the page's overrides). */
export type TemplateProps = Record<string, string>;

const TEMPLATE_PROPS_REGEX = /\/\*\*\s*@templateProps\s*(\{[\s\S]*?\})\s*\*\/\s*\n?/;

/**
 * Parse the /** @templateProps { ... } *​/ block. Returns {} when absent or
 * malformed — callers treat that as "no per-page overrides set."
 */
export function parseTemplateProps(code: string): TemplateProps {
  const match = code.match(TEMPLATE_PROPS_REGEX);
  if (!match) return {};
  try {
    const parsed = JSON.parse(match[1]) as Record<string, unknown>;
    const out: TemplateProps = {};
    for (const [k, v] of Object.entries(parsed)) {
      // Values are stored as strings (the control layer coerces per type).
      if (v != null) out[k] = String(v);
    }
    return out;
  } catch (e) {
    trace.error('template-props:parse-failed', { error: String(e) });
    return {};
  }
}

export function serializeTemplateProps(props: TemplateProps): string {
  // Drop empty values — an unset override falls back to the template's param
  // default, so storing '' would be a no-op that just clutters the block.
  const clean: TemplateProps = {};
  for (const [k, v] of Object.entries(props)) {
    if (v !== '' && v != null) clean[k] = v;
  }
  const json = JSON.stringify(clean, null, 2);
  trace.fn('template-props:serialize', { count: Object.keys(clean).length });
  return `/** @templateProps ${json} */\n`;
}

/**
 * Insert or replace the @templateProps block. Insertion order mirrors
 * @pageVariables: after @canvas, then after 'use client', then top. When the
 * resulting map is empty the block is removed entirely (no stray annotation).
 */
export function updateTemplatePropsInCode(code: string, props: TemplateProps): string {
  const clean: TemplateProps = {};
  for (const [k, v] of Object.entries(props)) {
    if (v !== '' && v != null) clean[k] = v;
  }
  const hasAny = Object.keys(clean).length > 0;
  const match = code.match(TEMPLATE_PROPS_REGEX);

  if (!hasAny) {
    // Nothing to store — strip an existing block if present, else no-op.
    return match ? code.replace(TEMPLATE_PROPS_REGEX, '') : code;
  }

  const block = serializeTemplateProps(clean);
  if (match) {
    trace.action('template-props:update', 'replace-existing');
    return code.replace(TEMPLATE_PROPS_REGEX, block);
  }
  // After @canvas
  const canvasMatch = code.match(/\/\*\*\s*@canvas\s*\{[\s\S]*?\}\s*\*\/\s*\n?/);
  if (canvasMatch && canvasMatch.index !== undefined) {
    const insertIdx = canvasMatch.index + canvasMatch[0].length;
    trace.action('template-props:update', 'insert-after-canvas');
    return code.slice(0, insertIdx) + block + code.slice(insertIdx);
  }
  // After 'use client'
  const useClientMatch = code.match(/^['"]use client['"];?\s*\n/m);
  if (useClientMatch && useClientMatch.index !== undefined) {
    const insertIdx = useClientMatch.index + useClientMatch[0].length;
    trace.action('template-props:update', 'insert-after-use-client');
    return code.slice(0, insertIdx) + '\n' + block + code.slice(insertIdx);
  }
  trace.action('template-props:update', 'insert-at-top');
  return block + code;
}

/** Set one template-prop value on a page (empty string removes it). */
export function setTemplatePropInCode(code: string, name: string, value: string): string {
  const props = parseTemplateProps(code);
  if (value === '' || value == null) delete props[name];
  else props[name] = value;
  trace.action('template-props:set', { name, hasValue: value !== '' && value != null });
  return updateTemplatePropsInCode(code, props);
}

/** Strip the annotation (preview/publish builds). */
export function stripTemplateProps(code: string): string {
  if (TEMPLATE_PROPS_REGEX.test(code)) trace.action('template-props:strip', 'removed');
  return code.replace(TEMPLATE_PROPS_REGEX, '');
}
