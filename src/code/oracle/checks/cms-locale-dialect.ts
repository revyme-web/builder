// oracle/checks/cms-locale-dialect.ts — CMS content localization dialect.
//
// A translated collection has ONE native shape. Rows carry their translations
// inline under `_i18n`, and the list resolves them at render:
//
//   cms/programme.json   [{ title: 'Opening', _i18n: { fr: { title: 'Ouverture' } } }]
//   app/page.client.tsx  {localizeRows(programme, __activeLocale).map((row, idx) => …)}
//
// `localizeRows` (@revyme/runtime) merges `_i18n[locale]` over the base fields, so
// the published site translates itself with no build step, and the PARSER unwraps
// that head — the list stays a first-class collection list with live bindings, a
// working CMS panel and a round-tripping Filter/Sort.
//
// The anti-pattern these rules exist to stop (a real customer site, 2026-08-10):
//
//   const programmeFallback = programme.filter((row) => row.language === 'en');
//   const programmeLocale   = programme.filter((row) => row.language === locale);
//   const programmeRows     = programmeLocale.length > 0 ? programmeLocale : programmeFallback;
//   {programmeRows.map((row, idx) => …)}
//
// It renders, so nothing crashes and no existing rule fired — but the parser
// cannot resolve `programmeRows` back to a collection, so the builder saw NO
// collection list and NO bindings on those sections. Measured on that file:
// `programme-row` and `practical-row` both parsed to collectionList `null`, and
// only 2 of 7 field bindings survived. The owner could no longer edit their own
// content, and every row was duplicated per locale in the CMS.
//
// Two rules, deliberately layered:
//   · LOCALE_FILTER (tier 2) names the specific mistake and teaches the fix.
//   · MAP_UNRESOLVED (tier 3) is the general net — ANY `.map()` head the parser
//     can't resolve, however creatively derived. It asks the real parser rather
//     than pattern-matching, so it cannot drift from what the builder accepts.

import * as t from '@babel/types';
import type { CanvasNode } from '@/code/parsing/parser';
import { traverse, jsxAttrs, stringAttr } from './shared';
import type { OracleViolation, FileKind } from './shared';

/** Row properties that mean "which language is this row" rather than content. */
const LOCALE_FIELD_RE = /^(language|locale|lang|lng|_locale|_lang)$/i;

/** Collection variables: `import programme from '@/cms/programme.json'`. */
function cmsImportNames(code: string): Set<string> {
  const names = new Set<string>();
  for (const m of code.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from\s+['"]@\/cms\/[^'"]+\.json['"]/g)) {
    names.add(m[1]);
  }
  return names;
}

/**
 * Every variable that derives from a CMS collection, transitively.
 *
 * `programmeRows` is three hops from `programme` (filter → filter → ternary), and
 * it is precisely those hops that hide a list from the parser — so the set is
 * closed to a fixpoint rather than checked one level deep.
 */
function cmsDerivedNames(code: string, ast: t.File, seed: Set<string>): Set<string> {
  const derived = new Set(seed);
  const decls: Array<{ name: string; src: string }> = [];
  traverse(ast, {
    VariableDeclarator(p) {
      const { id, init } = p.node;
      if (!t.isIdentifier(id) || !init || init.start == null || init.end == null) return;
      decls.push({ name: id.name, src: code.slice(init.start, init.end) });
    },
  });
  for (let pass = 0; pass < decls.length + 1; pass++) {
    let grew = false;
    for (const d of decls) {
      if (derived.has(d.name)) continue;
      for (const known of derived) {
        if (new RegExp(`\\b${known}\\b`).test(d.src)) { derived.add(d.name); grew = true; break; }
      }
    }
    if (!grew) break;
  }
  return derived;
}

/** Identifiers holding the active locale (`const locale = useLocale()`, params). */
function localeVarNames(ast: t.File): Set<string> {
  const names = new Set<string>();
  traverse(ast, {
    VariableDeclarator(p) {
      const { id, init } = p.node;
      if (!init) return;
      const fromHook = t.isCallExpression(init)
        && t.isIdentifier(init.callee)
        && (init.callee.name === 'useLocale' || init.callee.name === 'useParams');
      if (!fromHook) return;
      if (t.isIdentifier(id)) { names.add(id.name); return; }
      if (t.isObjectPattern(id)) {
        for (const prop of id.properties) {
          if (t.isObjectProperty(prop) && t.isIdentifier(prop.value)) names.add(prop.value.name);
        }
      }
    },
  });
  return names;
}

/** `x.map` → the object being mapped. */
function mapObjectOf(call: t.CallExpression): t.Node | null {
  return t.isMemberExpression(call.callee)
    && t.isIdentifier(call.callee.property)
    && call.callee.property.name === 'map'
    ? call.callee.object
    : null;
}

/** Does this expression's source mention any name in the set? */
function referencesAny(code: string, node: t.Node | null | undefined, names: Set<string>): boolean {
  if (!node || node.start == null || node.end == null) return false;
  const src = code.slice(node.start, node.end);
  for (const n of names) if (new RegExp(`\\b${n}\\b`).test(src)) return true;
  return false;
}

/** Does the callback return JSX (i.e. is this map a rendered repeater)? */
function returnsJsx(cb: t.Node | null | undefined): boolean {
  if (!t.isArrowFunctionExpression(cb) && !t.isFunctionExpression(cb)) return false;
  const body = cb.body;
  if (t.isJSXElement(body) || t.isJSXFragment(body)) return true;
  if (t.isParenthesizedExpression(body)) return t.isJSXElement(body.expression) || t.isJSXFragment(body.expression);
  if (t.isConditionalExpression(body)) {
    return t.isJSXElement(body.consequent) || t.isJSXElement(body.alternate)
      || t.isJSXFragment(body.consequent) || t.isJSXFragment(body.alternate);
  }
  if (!t.isBlockStatement(body)) return false;
  let found = false;
  traverse({ type: 'File', program: { type: 'Program', body: body.body, directives: [], sourceType: 'module' } } as t.File, {
    JSXElement() { found = true; },
    JSXFragment() { found = true; },
  });
  return found;
}

/**
 * LOCALE-FILTERED COLLECTION — selecting rows by a language column.
 *
 * Fires on a CMS `.filter()` whose predicate compares a row property against the
 * active locale, or against a locale literal on a `language`-ish field. Both
 * halves of the fallback idiom are caught: the `=== locale` line AND the
 * `=== 'en'` line, because a fix that removes only one leaves the list broken.
 */
export function checkCmsLocaleFilter(code: string, ast: t.File, v: OracleViolation[]): void {
  const cmsVars = cmsImportNames(code);
  if (cmsVars.size === 0) return;
  const derived = cmsDerivedNames(code, ast, cmsVars);
  const locales = localeVarNames(ast);
  const seen = new Set<number>();

  traverse(ast, {
    CallExpression(path) {
      const callee = path.node.callee;
      if (!t.isMemberExpression(callee) || !t.isIdentifier(callee.property)) return;
      if (callee.property.name !== 'filter' && callee.property.name !== 'find') return;
      if (!referencesAny(code, callee.object, derived)) return;
      const cb = path.node.arguments[0];
      if (!t.isArrowFunctionExpression(cb) && !t.isFunctionExpression(cb)) return;

      // Walk the predicate for `<row>.<prop> === <locale>` in either direction.
      const cbAst = { type: 'File', program: { type: 'Program', body: [t.expressionStatement(cb as t.Expression)], directives: [], sourceType: 'module' } } as t.File;
      traverse(cbAst, {
        BinaryExpression(bp) {
          const { operator, left, right } = bp.node;
          if (!['===', '==', '!==', '!='].includes(operator)) return;
          const sides: Array<[t.Node, t.Node]> = [[left, right], [right, left]];
          for (const [member, other] of sides) {
            if (!t.isMemberExpression(member) || !t.isIdentifier(member.property)) continue;
            const field = member.property.name;
            const byLocaleVar = t.isIdentifier(other) && locales.has(other.name);
            const byLocaleLiteral = t.isStringLiteral(other) && LOCALE_FIELD_RE.test(field);
            const byParamsLocale = t.isMemberExpression(other) && t.isIdentifier(other.property)
              && LOCALE_FIELD_RE.test(other.property.name);
            if (!byLocaleVar && !byLocaleLiteral && !byParamsLocale) continue;
            const line = bp.node.loc?.start.line ?? path.node.loc?.start.line;
            if (line != null && seen.has(line)) return;
            if (line != null) seen.add(line);
            v.push({
              code: 'CMS_LOCALE_FILTER', tier: 2, line,
              message: `[CMS localization] Line ${line} selects collection rows by language (\`${field} ${operator} ${byLocaleVar ? (other as t.Identifier).name : t.isStringLiteral(other) ? `'${other.value}'` : 'params.locale'}\`). A translated collection is NOT one row per language — that duplicates every row, and the derived array it produces is invisible to the builder's parser, so the list loses its CMS panel and ALL its field bindings (measured on a real page: 2 of 7 bindings survived). The native shape is ONE row per item carrying its translations inline, resolved at render: (1) in the CMS, each row keeps its base fields and gets \`_i18n\`, e.g. { "title": "Opening", "_i18n": { "fr": { "title": "Ouverture" } } } — never a \`${field}\` column and never duplicate rows; (2) in the page, wrap the collection at the head of the chain — \`{localizeRows(<collection>, __activeLocale).map((row, idx) => …)}\` — with \`import { localizeRows } from '@revyme/runtime';\` and \`const __activeLocale = useLocale();\`. localizeRows merges _i18n[locale] over the base fields, the parser unwraps that head, and Filter/Sort still chain after it. Delete the language filters and the \`…Locale.length > 0 ? … : …Fallback\` ternary entirely.`,
            });
            return;
          }
        },
      });
    },
  });
}

/**
 * HAND-ROLLED `_i18n` ACCESS — reading the translation bag directly.
 *
 * `_i18n` is storage, not content: the merge (missing key → base field, empty
 * string → base field) lives in `localizeRows` so the canvas, the preview and
 * the published site cannot disagree. A page that indexes it inline reimplements
 * that merge, and the field it renders is no longer a binding the panel can read.
 */
export function checkCmsI18nDirectAccess(code: string, ast: t.File, v: OracleViolation[]): void {
  if (cmsImportNames(code).size === 0) return;
  const seen = new Set<number>();
  traverse(ast, {
    MemberExpression(path) {
      const prop = path.node.property;
      const name = t.isIdentifier(prop) ? prop.name : t.isStringLiteral(prop) ? prop.value : null;
      if (name !== '_i18n') return;
      const line = path.node.loc?.start.line;
      if (line != null && seen.has(line)) return;
      if (line != null) seen.add(line);
      v.push({
        code: 'CMS_I18N_DIRECT_ACCESS', tier: 2, line,
        message: `[CMS localization] Line ${line} reads a row's \`_i18n\` bag directly. \`_i18n\` is STORAGE — the resolution rules (missing locale → base row, missing or empty field → base field) live in ONE place, \`localizeRows\` from '@revyme/runtime', so the canvas, the preview and the published site can't disagree. Reading it inline also breaks the field binding: {row.title} is a binding the CMS panel can read and rebind, {row._i18n?.[locale]?.title} is an opaque expression. Wrap the collection instead — \`{localizeRows(<collection>, __activeLocale).map((row, idx) => …)}\` — and go back to plain {row.title}.`,
      });
    },
  });
}

/**
 * UNRESOLVABLE COLLECTION `.map()` — the general net (tier 3).
 *
 * Every rendered `.map()` rooted in a CMS import must come back from the REAL
 * parser as a collection list. This asks `parseJSXToNodes`'s own output instead
 * of re-deriving the accepted shapes, so the rule can never drift from what the
 * builder actually reads — and it catches derivations no pattern would predict.
 *
 * `nodes` is the map tier 3 already built; the check adds no second parse.
 */
export function checkCmsMapResolves(
  code: string,
  ast: t.File,
  nodes: Map<string, CanvasNode>,
  v: OracleViolation[],
  kind: FileKind,
): void {
  if (kind !== 'page' && kind !== 'component') return;
  const cmsVars = cmsImportNames(code);
  if (cmsVars.size === 0) return;
  const derived = cmsDerivedNames(code, ast, cmsVars);
  const reported = new Set<string>();

  traverse(ast, {
    CallExpression(path) {
      const obj = mapObjectOf(path.node);
      if (!obj || !referencesAny(code, obj, derived)) return;
      if (!returnsJsx(path.node.arguments[0])) return;   // not a rendered repeater

      // The collection list lives on the JSX element CONTAINING the map.
      const host = path.findParent((p) => p.isJSXElement());
      const hostId = host?.isJSXElement()
        ? stringAttr(jsxAttrs(host.node.openingElement), 'data-id')
        : undefined;
      const line = path.node.loc?.start.line;
      const headSrc = obj.start != null && obj.end != null ? code.slice(obj.start, obj.end) : '<expr>';
      const key = `${hostId ?? ''}:${line ?? 0}`;
      if (reported.has(key)) return;

      if (hostId && nodes.get(hostId)?.collectionList?.source) return;   // resolved → fine
      reported.add(key);

      const rooted = [...cmsVars].find((c) => new RegExp(`\\b${c}\\b`).test(headSrc)) ?? '<collection>';
      v.push({
        code: 'CMS_MAP_UNRESOLVED', tier: 3, line, elementId: hostId ?? undefined,
        message: hostId
          ? `[CMS list] The collection .map() at line ${line} maps \`${headSrc}\`, which the builder's parser CANNOT resolve back to a collection — <${hostId}> came back with no collection list, so this section renders on the live site but is DEAD in the editor: no CMS panel, no repeated-row template, and every {row.field} inside it stops being an editable binding. The head of the chain must be the imported collection itself, optionally wrapped by a form the parser knows: \`${rooted}\`, \`localizeRows(${rooted}, __activeLocale)\` (translated), or \`__applyListConfig(${rooted}, listCfg)\` (per-viewport/variant config). Filters, sorting and limits CHAIN AFTER the head — \`{${rooted}.filter((row) => …).sort((a, b) => …).slice(0, 6).map((row, idx) => …)}\` — they must never be hoisted into a \`const\` above the JSX, because the parser reads the chain in place. Inline the derivation back into the .map() head.`
          : `[CMS list] The collection .map() at line ${line} maps \`${headSrc}\` but the element containing it has no data-id, so the builder cannot register a collection list for it. Give the containing element a data-id and map the imported collection directly: \`<div data-id="…">{${rooted}.map((row, idx) => …)}</div>\`.`,
      });
    },
  });
}
