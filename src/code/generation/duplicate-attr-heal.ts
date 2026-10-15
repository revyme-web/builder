// duplicate-attr-heal.ts — drop the dead copies of a duplicated JSX attribute.
//
// `<Hero layout="a" layout={b} />` renders with `b`: JSX builds one props
// object, the later key wins. The earlier copy is dead code — but it is the one
// the regex-based writers used to find and update, so every later edit of that
// prop "did nothing" on screen (esbuild warns "Duplicate 'layout' attribute" at
// publish). The agent's old set_component_prop appended such copies whenever
// the existing value was an expression (2026-10-15).
//
// Dropping every copy but the LAST never changes what renders, so this runs on
// load (project-fs) for pages and components. LEAF module on purpose — project-fs
// imports it (see the project-fs import-cycle rule): the scanner + babel only.

import { findDuplicateAttrSpans } from '@/code/components/jsx-tag-attrs';
import { parseJSX } from '@/code/parsing/ast-utils';
import { trace } from '@/shared/debug-trace';

/** `code` with every duplicate JSX attribute reduced to its last copy. Returns
 *  the input unchanged when there is none, or when the result would not parse. */
export function healDuplicateJsxAttributes(code: string): string {
  const spans = findDuplicateAttrSpans(code);
  if (spans.length === 0) return code;
  let out = code;
  // Right to left, so earlier spans stay valid.
  for (const s of [...spans].sort((a, b) => b.wsStart - a.wsStart)) {
    out = out.slice(0, s.wsStart) + out.slice(s.end);
  }
  try {
    parseJSX(out);
  } catch {
    trace.error('duplicate-attr-heal:unparseable', { removed: spans.length });
    return code;
  }
  trace.action('duplicate-attr-heal:healed', { removed: spans.length, names: [...new Set(spans.map((s) => s.name))] });
  return out;
}
