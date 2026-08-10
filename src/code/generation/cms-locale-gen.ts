// cms-locale-gen.ts — make a collection list resolve its own locale.
//
// Rewrites the SOURCE, not the render:
//
//   {programme.map((item, idx) => …)}
//   {localizeRows(programme, __activeLocale).map((item, idx) => …)}
//
// `localizeRows` (@revyme/runtime) merges each row's `_i18n[locale]` over its
// base fields, so the published site translates itself with no build step and
// no extra file — the page already imports its collection JSON, and the
// translations ride on the rows. The canvas calls the same function, so the two
// cannot disagree.
//
// The parser unwraps this head (see `localizeRows` in parser.ts), so a localized
// list stays a first-class collection list: same bindings, same CMS panel, same
// filter/sort round trip.
//
// IDEMPOTENT, and deliberately one function for three callers — dropping a new
// list, healing existing files on load, and healing again when a second locale
// is added later. Three copies of this rule would be three things to keep in
// step.

import { ensureLocaleHook } from './scoped-expr';
import { findCollectionChainHead } from './cms-gen';
import { trace } from '@/shared/debug-trace';

const RUNTIME_IMPORT = '@revyme/runtime';

/** Ensure `localizeRows` is imported, merging into an existing runtime import. */
function ensureLocalizeRowsImport(code: string): string {
  if (/import\s*\{[^}]*\blocalizeRows\b[^}]*\}\s*from\s*'@revyme\/runtime'/.test(code)) return code;
  const existing = code.match(/import\s*\{([^}]*)\}\s*from\s*'@revyme\/runtime'/);
  if (existing && existing.index !== undefined) {
    return code.slice(0, existing.index)
      + existing[0].replace(`{${existing[1]}}`, `{ ${existing[1].trim()}, localizeRows }`)
      + code.slice(existing.index + existing[0].length);
  }
  const firstImport = code.match(/^import[^\n]*\n/m);
  const at = firstImport?.index !== undefined ? firstImport.index : 0;
  return code.slice(0, at) + `import { localizeRows } from '${RUNTIME_IMPORT}';\n` + code.slice(at);
}

/**
 * Every CMS import's LOCAL identifier in this file.
 *
 * The identifier is NOT the slug: a slug may contain characters that are
 * illegal in a JS identifier, so `cms/collection-1.json` is imported as
 * `collection1`. Matching `.map()` heads against slugs therefore missed every
 * hyphenated collection, and the on-load heal quietly did nothing for them
 * (user report 2026-08-10). Read the imports, exactly as the parser does.
 */
function cmsImportNames(code: string): Set<string> {
  const names = new Set<string>();
  const re = /import\s+(\w+)\s+from\s*['"]@\/cms\/[^'"]+\.json['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) names.add(m[1]);
  return names;
}

/**
 * Wrap every unlocalized CMS collection source in the file.
 *
 * Only `.map()` heads that resolve to a CMS import count — an inline `const`
 * array is not CMS content and has no `_i18n`. Returns the code UNCHANGED when
 * nothing applies, so callers can run it unconditionally without dirtying files
 * (which matters most for the on-load heal: an untouched project must not come
 * back modified).
 *
 * Rewrites from the END so each edit can't shift the indices of the ones still
 * to come.
 */
export function localizeCollectionListsInCode(code: string): string {
  const cmsNames = cmsImportNames(code);
  if (cmsNames.size === 0) return code;
  const mapDots: number[] = [];
  const re = /\.map\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) mapDots.push(m.index);

  let out = code;
  const wrapped: string[] = [];
  for (let i = mapDots.length - 1; i >= 0; i--) {
    const head = findCollectionChainHead(out, mapDots[i]);
    if (!head || head.localized || !cmsNames.has(head.slug)) continue;
    out = out.slice(0, head.slugStart)
      + `localizeRows(${head.slug}, __activeLocale)`
      + out.slice(head.slugEnd);
    wrapped.push(head.slug);
  }
  if (wrapped.length === 0) return code;

  out = ensureLocalizeRowsImport(out);
  out = ensureLocaleHook(out);
  trace.action('cms-locale-gen:localized', { slugs: wrapped });
  return out;
}
