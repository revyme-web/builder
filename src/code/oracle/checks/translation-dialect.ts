// oracle/checks/translation-dialect.ts — next-intl localization format rules.
//
// The editor's whole localization system (canvas resolution, TranslationPanel,
// Localization overlay, AI Translate) keys off ONE exact shape:
//   · text:  <p data-id="X">{t('X')}</p>            — key === data-id
//   · attrs: placeholder={t('X__attr_placeholder')} — key === id__attr_<name>
//   · scope: import { useTranslations } from 'next-intl'
//            + const t = useTranslations('<page-slug>') in the component body
//   · copy lives in messages/<locale>.json under the page-slug namespace
// A t() call without the hook CRASHES the live site; a mismatched key renders
// (next-intl resolves any key) but ORPHANS the string — the panels write under
// data-id keys, so the user can never edit that text again from the UI.

import * as t from '@babel/types';
import { traverse, jsxTagName, jsxAttrs, stringAttr } from './shared';
import type { OracleViolation } from './shared';

/** Same slug derivation as active-file-store's filePathToSlug for app/ pages —
 *  duplicated MINIMALLY here so the oracle stays dependency-light. */
export function pageSlugForPath(path: string): string | null {
  if (!path.startsWith('app/')) return null;
  const stripped = path.replace(/^app\//, '').replace(/\([^)]+\)\//, '');
  if (stripped === 'page.tsx' || stripped === 'page.client.tsx') return 'home';
  return stripped.replace(/\/page\.client\.tsx$/, '').replace(/\/page\.tsx$/, '');
}

/** A translation call: `<id>('<key>')` — one string-literal argument. */
function translationKeyOf(expr: t.Node | null | undefined): { hook: string; key: string } | null {
  if (!expr || expr.type !== 'CallExpression') return null;
  if (expr.callee.type !== 'Identifier') return null;
  if (expr.arguments.length !== 1 || expr.arguments[0].type !== 'StringLiteral') return null;
  return { hook: expr.callee.name, key: expr.arguments[0].value };
}

export function checkTranslationDialect(
  code: string,
  ast: t.File,
  path: string | undefined,
  v: OracleViolation[],
): void {
  // ── Collect scope facts ──────────────────────────────────────────────────
  let hasImport = false;
  for (const node of ast.program.body) {
    if (node.type !== 'ImportDeclaration' || node.source.value !== 'next-intl') continue;
    for (const spec of node.specifiers) {
      if (spec.type === 'ImportSpecifier' && spec.imported.type === 'Identifier' && spec.imported.name === 'useTranslations') {
        hasImport = true;
      }
    }
  }
  const hookVars = new Set<string>();
  const hookNamespaces: { ns: string; line?: number }[] = [];
  traverse(ast, {
    VariableDeclarator(p) {
      const init = p.node.init;
      if (!init || init.type !== 'CallExpression') return;
      if (init.callee.type !== 'Identifier' || init.callee.name !== 'useTranslations') return;
      if (p.node.id.type === 'Identifier') hookVars.add(p.node.id.name);
      const arg = init.arguments[0];
      hookNamespaces.push({
        ns: arg?.type === 'StringLiteral' ? arg.value : '',
        line: p.node.loc?.start.line,
      });
    },
  });

  // ── Walk elements for t() calls (text children + localizable attrs) ─────
  let sawCall = false;
  traverse(ast, {
    JSXElement(p) {
      const opening = p.node.openingElement;
      const attrs = jsxAttrs(opening);
      const id = stringAttr(attrs, 'data-id');
      const tag = jsxTagName(opening.name);

      // Text child call
      for (const child of p.node.children) {
        if (child.type !== 'JSXExpressionContainer') continue;
        const call = translationKeyOf(child.expression);
        if (!call || call.hook === 'useResponsiveText') continue;
        sawCall = true;
        const line = child.loc?.start.line;
        if (hookVars.size > 0 && !hookVars.has(call.hook)) {
          v.push({
            code: 'TRANSLATION_HOOK_MISSING', tier: 1, line, elementId: id,
            message: `<${tag}> at line ${line} calls {${call.hook}('${call.key}')} but no \`const ${call.hook} = useTranslations(...)\` exists — the live site crashes with "${call.hook} is not defined". Declare exactly \`const t = useTranslations('<page-slug>')\` at the top of the component and call {t('<data-id>')}.`,
          });
        }
        if (id && call.key !== id && !call.key.startsWith(`${id}__`)) {
          v.push({
            code: 'TRANSLATION_KEY_MISMATCH', tier: 2, line, elementId: id,
            message: `<${tag} data-id="${id}"> at line ${line} uses translation key '${call.key}' — the key MUST equal the element's data-id ('${id}'). The editor's translation panels and messages/<locale>.json store copy under the data-id, so a mismatched key renders but can never be edited from the UI again. Write {t('${id}')} and put the default text in messages under the '${id}' key.`,
          });
        }
      }

      // Localizable attr calls (placeholder / alt / aria-label / title / value)
      for (const a of attrs) {
        const attrName = a.name.name as string;
        if (a.value?.type !== 'JSXExpressionContainer') continue;
        const call = translationKeyOf(a.value.expression);
        if (!call) continue;
        if (!['placeholder', 'alt', 'aria-label', 'title', 'value'].includes(attrName)) continue;
        sawCall = true;
        const line = a.loc?.start.line;
        if (hookVars.size > 0 && !hookVars.has(call.hook)) {
          v.push({
            code: 'TRANSLATION_HOOK_MISSING', tier: 1, line, elementId: id,
            message: `<${tag}> at line ${line} sets ${attrName}={${call.hook}('${call.key}')} but no \`const ${call.hook} = useTranslations(...)\` exists — live crash. Declare \`const t = useTranslations('<page-slug>')\` and reference it.`,
          });
        }
        const expected = id ? `${id}__attr_${attrName}` : null;
        if (expected && call.key !== expected) {
          v.push({
            code: 'TRANSLATION_KEY_MISMATCH', tier: 2, line, elementId: id,
            message: `<${tag} data-id="${id}"> at line ${line} localizes ${attrName} with key '${call.key}' — attr translation keys MUST be '<data-id>__attr_<attrName>' (here: '${expected}'). Any other key orphans the string from the editor's translation panels.`,
          });
        }
      }
    },
  });

  // ── Hook present but unused / import missing / namespace mismatch ────────
  if (sawCall && !hasImport) {
    v.push({
      code: 'TRANSLATION_HOOK_MISSING', tier: 1, line: 1,
      message: `The file calls t('…') but never imports useTranslations — add \`import { useTranslations } from 'next-intl';\` and \`const t = useTranslations('<page-slug>');\` in the component body, or the live build fails.`,
    });
  }
  if (sawCall && hookVars.size === 0) {
    v.push({
      code: 'TRANSLATION_HOOK_MISSING', tier: 1, line: 1,
      message: `The file calls t('…') in JSX but never declares \`const t = useTranslations('<page-slug>')\` inside the component — the live site crashes with "t is not defined".`,
    });
  }
  const expectedNs = path ? pageSlugForPath(path) : null;
  if (expectedNs) {
    for (const h of hookNamespaces) {
      if (h.ns && h.ns !== expectedNs) {
        v.push({
          code: 'TRANSLATION_NAMESPACE_MISMATCH', tier: 2, line: h.line,
          message: `useTranslations('${h.ns}') at line ${h.line} — this page's translation namespace MUST be '${expectedNs}' (derived from the file path; messages/<locale>.json stores this page's copy under that namespace). Any other namespace makes every t() call resolve to nothing. Write useTranslations('${expectedNs}').`,
        });
      }
    }
  }
}
