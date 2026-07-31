// i18n-gen.ts — JSX transformation for next-intl integration.
//
// When the user commits a text edit on a non-default locale, the editor
// rewrites the page so the translation works at runtime in the live Next.js
// site (not just in the canvas's imperative override path):
//
//   1. The targeted JSX element's text children are replaced with
//      `{t('<nodeId>')}` (the data-id is the canonical key).
//   2. `import { useTranslations } from 'next-intl';` is added if missing.
//   3. `const t = useTranslations('<namespace>');` is inserted at the top of
//      the default-exported function body if missing.
//
// Subsequent edits in any locale just update `messages/{locale}.json`; the
// JSX stays unchanged because the t() call is already there.

import * as t from '@babel/types';
import { parseJSX, findFirstElementByDataId } from '../parsing/ast-utils';
import { generate } from './generator-utils';
import { trace } from '@/shared/debug-trace';

interface TransformResult {
  code: string;
  /** Whether the JSX element's text was actually swapped for `{t(...)}`.
   *  False when the element already had a `{t(...)}` call (idempotent). */
  changed: boolean;
  /** The previous text content (after stripping HTML tags). Empty string
   *  when the JSX held a `{t(...)}` call already (no original to capture). */
  originalText: string;
}

/**
 * Idempotent transform: replace the JSX element's text children with
 * `{t('<key>')}` and ensure `useTranslations` import + hook call exist.
 *
 * `key` is typically the node's `data-id`. `namespace` is the page slug
 * (so messages JSON is namespaced per page: `{ home: { title: '…' } }`).
 *
 * The returned `originalText` is what the JSX held before transformation —
 * caller writes it to `messages/{defaultLocale}.json` so the default-locale
 * fallback works on the live site without extra plumbing.
 */

/** Ensure `import { useTranslations } from 'next-intl'` + a
 *  `const t = useTranslations('<namespace>')` hook exist in the default-
 *  exported component (handles the `export default withResponsiveProps(X)`
 *  shape). Returns the hook variable name in scope (an existing hook's name
 *  is reused). Shared by the text + attr transforms. */
function ensureTranslationsScaffold(ast: t.File, namespace: string): string {
  let hookVarName = 't';
  let hasUseTranslationsImport = false;
  for (const node of ast.program.body) {
    if (node.type !== 'ImportDeclaration') continue;
    if (node.source.value !== 'next-intl') continue;
    for (const spec of node.specifiers) {
      if (spec.type === 'ImportSpecifier' && spec.imported.type === 'Identifier' && spec.imported.name === 'useTranslations') {
        hasUseTranslationsImport = true;
      }
    }
  }
  if (!hasUseTranslationsImport) {
    const importDecl = t.importDeclaration(
      [t.importSpecifier(t.identifier('useTranslations'), t.identifier('useTranslations'))],
      t.stringLiteral('next-intl')
    );
    let lastImportIdx = -1;
    for (let i = 0; i < ast.program.body.length; i++) {
      if (ast.program.body[i].type === 'ImportDeclaration') lastImportIdx = i;
    }
    if (lastImportIdx >= 0) ast.program.body.splice(lastImportIdx + 1, 0, importDecl);
    else ast.program.body.unshift(importDecl);
  }

  for (const node of ast.program.body) {
    let fnBody: t.BlockStatement | null = null;
    if (node.type === 'ExportDefaultDeclaration') {
      const decl = node.declaration;
      if (decl.type === 'FunctionDeclaration' && decl.body.type === 'BlockStatement') {
        fnBody = decl.body;
      } else if (decl.type === 'ArrowFunctionExpression' && decl.body.type === 'BlockStatement') {
        fnBody = decl.body;
      } else if (decl.type === 'CallExpression') {
        if (decl.arguments[0]?.type === 'Identifier') {
          const fnName = decl.arguments[0].name;
          for (const candidate of ast.program.body) {
            if (candidate.type === 'FunctionDeclaration' && candidate.id?.name === fnName && candidate.body.type === 'BlockStatement') {
              fnBody = candidate.body;
              break;
            }
          }
        }
      }
    }
    if (!fnBody) continue;

    let hasHookAssignment = false;
    for (const stmt of fnBody.body) {
      if (stmt.type !== 'VariableDeclaration') continue;
      for (const declarator of stmt.declarations) {
        if (declarator.init?.type !== 'CallExpression') continue;
        const callee = declarator.init.callee;
        if (callee.type === 'Identifier' && callee.name === 'useTranslations') {
          hasHookAssignment = true;
          if (declarator.id.type === 'Identifier') hookVarName = declarator.id.name;
        }
      }
    }
    if (hasHookAssignment) break;

    const hookCall = t.variableDeclaration('const', [
      t.variableDeclarator(
        t.identifier('t'),
        t.callExpression(t.identifier('useTranslations'), [t.stringLiteral(namespace)])
      ),
    ]);
    fnBody.body.unshift(hookCall);
    break;
  }
  return hookVarName;
}

export function transformTextToTranslation(
  code: string,
  nodeId: string,
  key: string,
  namespace: string,
): TransformResult {
  trace.fn('i18n-gen.transformTextToTranslation', { nodeId, key, namespace });

  const ast = parseJSX(code);
  if (!ast) return { code, changed: false, originalText: '' };

  let changed = false;
  let originalText = '';
  // Scaffold FIRST so the injected call uses the RESOLVED hook name — an
  // existing `const tr = useTranslations(...)` used to get a `t('key')`
  // call pointing at a variable that didn't exist. Idempotent, and when
  // nothing ends up changed the ORIGINAL code string is returned, so a
  // speculative import/hook injection is discarded.
  const hookVarName = ensureTranslationsScaffold(ast, namespace);

  // ─── Replace the targeted element's text with `{t('<key>')}` ──────────
  findFirstElementByDataId(ast, nodeId, (path) => {
    // If the children already contain a `t('<key>')` JSX expression, skip —
    // subsequent edits in any locale only update messages JSON, not JSX.
    const alreadyTranslated = path.node.children.some((child: any) => {
      if (child.type !== 'JSXExpressionContainer') return false;
      const expr = child.expression;
      if (expr.type !== 'CallExpression') return false;
      if (expr.callee.type !== 'Identifier') return false;
      // Match any `<id>(...)` call — covers `t(...)`, `tr(...)`, etc.
      // The user could rename their hook variable; we just need to know
      // SOMETHING is doing the translation already so we don't double-wrap.
      return true;
    });
    if (alreadyTranslated) {
      path.stop();
      return;
    }

    // Capture the original text (concatenate JSXText children, strip whitespace).
    const textParts: string[] = [];
    for (const child of path.node.children) {
      if (child.type === 'JSXText') textParts.push(child.value);
    }
    originalText = textParts.join('').replace(/\s+/g, ' ').trim();

    // Replace text children with `{t('<key>')}`. Preserve non-text JSX
    // children (e.g. <span> inside a <p>) so mixed content keeps its
    // structure — though in practice the canvas only auto-translates
    // pure-text leaves; mixed content is left alone above by the caller.
    const newChildren: any[] = [];
    let inserted = false;
    for (const child of path.node.children) {
      if (child.type === 'JSXText' && child.value.trim()) {
        if (!inserted) {
          newChildren.push(
            t.jsxExpressionContainer(
              t.callExpression(t.identifier(hookVarName), [t.stringLiteral(key)])
            )
          );
          inserted = true;
        }
      } else {
        newChildren.push(child);
      }
    }
    if (!inserted) {
      newChildren.push(
        t.jsxExpressionContainer(
          t.callExpression(t.identifier(hookVarName), [t.stringLiteral(key)])
        )
      );
    }
    path.node.children = newChildren;
    changed = true;
    path.stop();
  });

  if (!changed) return { code, changed: false, originalText: '' };

  try {
    return {
      code: generate(ast, { retainLines: false, concise: false }, code).code,
      changed: true,
      originalText,
    };
  } catch (err) {
    trace.error('i18n-gen:generate-failed', { nodeId, error: err instanceof Error ? err.message : String(err) });
    return { code, changed: false, originalText: '' };
  }
}

/**
 * RICH-TEXT RUN transform — rewrite ONE text run of a mixed-content node to a
 * translation call, leaving every styled span and sibling run untouched:
 *
 *   <p data-id="x">I'm <span style={{…}}>Jenny,</span></p>
 *      —run 1→  <p data-id="x">I'm <span style={{…}}>{t('x__r1')}</span></p>
 *
 * Runs are addressed in the SAME document order `extractTextRuns` uses
 * (non-whitespace JSXText segments + existing t() containers, recursing into
 * child elements). A run already carrying `key` reports changed:false.
 * `originalText` = the replaced run's trimmed text (default-message seed).
 */
export function transformRunToTranslation(
  code: string,
  nodeId: string,
  runIndex: number,
  key: string,
  namespace: string,
): TransformResult {
  trace.fn('i18n-gen.transformRunToTranslation', { nodeId, runIndex, key, namespace });
  const ast = parseJSX(code);
  if (!ast) return { code, changed: false, originalText: '' };

  let changed = false;
  let originalText = '';
  const hookVarName = ensureTranslationsScaffold(ast, namespace);

  findFirstElementByDataId(ast, nodeId, (path) => {
    // Walk runs in extractTextRuns' document order, tracking each run's
    // parent children-array + index so the replacement splices in place.
    let seen = 0;
    let done = false;
    const walk = (el: t.JSXElement): void => {
      if (done) return;
      for (let i = 0; i < el.children.length; i++) {
        if (done) return;
        const child = el.children[i];
        if (child.type === 'JSXText') {
          if (!child.value.trim()) continue;
          if (seen === runIndex) {
            const raw = child.value;
            originalText = raw.trim();
            const lead = raw.slice(0, raw.length - raw.trimStart().length);
            const trail = raw.slice(raw.trimEnd().length);
            const replacement: (t.JSXText | t.JSXExpressionContainer)[] = [];
            if (lead) replacement.push(t.jsxText(lead));
            replacement.push(t.jsxExpressionContainer(
              t.callExpression(t.identifier(hookVarName), [t.stringLiteral(key)])));
            if (trail) replacement.push(t.jsxText(trail));
            el.children.splice(i, 1, ...replacement);
            changed = true;
            done = true;
            return;
          }
          seen++;
        } else if (child.type === 'JSXExpressionContainer') {
          const expr: any = child.expression;
          const isTCall = expr?.type === 'CallExpression' && expr.callee?.type === 'Identifier'
            && expr.arguments?.length === 1 && expr.arguments[0]?.type === 'StringLiteral';
          if (isTCall) {
            // Already-transformed run — nothing to do if it's the target.
            if (seen === runIndex) { done = true; return; }
            seen++;
          }
        } else if (child.type === 'JSXElement') {
          walk(child);
        }
      }
    };
    walk(path.node);
    path.stop();
  });

  if (!changed) return { code, changed: false, originalText: '' };
  try {
    return {
      code: generate(ast, { retainLines: false, concise: false }, code).code,
      changed: true,
      originalText,
    };
  } catch (err) {
    trace.error('i18n-gen:run-generate-failed', { nodeId, runIndex, error: err instanceof Error ? err.message : String(err) });
    return { code, changed: false, originalText: '' };
  }
}

/** Attrs the localization system treats as translatable text-type props.
 *  Covers an input's placeholder, image alt, aria-label and title. */
export const LOCALIZABLE_ATTRS = ['placeholder', 'alt', 'aria-label', 'title', 'value'] as const;

/** Message key for a node attr translation — numeric-free suffix so it can
 *  never collide with the `key__<vpWidth>` replica buckets. */
export function attrMessageKey(nodeId: string, attr: string): string {
  return `${nodeId}__attr_${attr}`;
}

/**
 * Rewrite `<input placeholder="jane@x.com" …>` to
 * `<input placeholder={t('<nodeId>__attr_placeholder')} …>` (any hook name
 * already in scope is reused). Idempotent: an attr whose value is already a
 * translation call reports changed:false. `originalValue` carries the
 * pre-transform string for seeding the default-locale message.
 */
export function transformAttrToTranslation(
  code: string,
  nodeId: string,
  attr: string,
  namespace: string,
): { code: string; changed: boolean; originalValue: string } {
  trace.fn('i18n-gen.transformAttrToTranslation', { nodeId, attr, namespace });
  const ast = parseJSX(code);
  if (!ast) return { code, changed: false, originalValue: '' };

  const key = attrMessageKey(nodeId, attr);
  const hookVarName = ensureTranslationsScaffold(ast, namespace);
  let changed = false;
  let originalValue = '';

  findFirstElementByDataId(ast, nodeId, (path) => {
    const opening = path.node.openingElement;
    const callValue = t.jsxExpressionContainer(
      t.callExpression(t.identifier(hookVarName), [t.stringLiteral(key)])
    );
    let found = false;
    for (const a of opening.attributes) {
      if (a.type !== 'JSXAttribute' || a.name.type !== 'JSXIdentifier' || a.name.name !== attr) continue;
      found = true;
      if (a.value?.type === 'StringLiteral') {
        originalValue = a.value.value;
        a.value = callValue;
        changed = true;
      } else if (a.value?.type === 'JSXExpressionContainer') {
        const expr: any = a.value.expression;
        if (expr?.type === 'StringLiteral') {
          originalValue = expr.value;
          a.value = callValue;
          changed = true;
        }
        // CallExpression → already translated; other expressions → leave.
      }
      break;
    }
    if (!found) {
      opening.attributes.push(t.jsxAttribute(t.jsxIdentifier(attr), callValue));
      changed = true;
    }
    path.stop();
  });

  if (!changed) return { code, changed: false, originalValue: '' };
  try {
    return { code: generate(ast, { retainLines: false, concise: false }, code).code, changed: true, originalValue };
  } catch (err) {
    trace.error('i18n-gen:attr-generate-failed', { nodeId, attr, error: err instanceof Error ? err.message : String(err) });
    return { code, changed: false, originalValue: '' };
  }
}

/**
 * Detect whether a node's JSX has already been migrated to a `{t('...')}`
 * call. Used by the editor to decide where a text edit should land:
 *   - migrated → write to messages/{locale}.json (no JSX touch)
 *   - plain text → JSX update (default locale) OR migrate (non-default)
 */
export function nodeHasTranslationCall(code: string, nodeId: string): boolean {
  const ast = parseJSX(code);
  if (!ast) return false;
  let found = false;
  findFirstElementByDataId(ast, nodeId, (path) => {
    found = path.node.children.some((child: any) => {
      if (child.type !== 'JSXExpressionContainer') return false;
      const expr = child.expression;
      if (expr.type !== 'CallExpression') return false;
      // BUILDER-INJECTED text calls are NOT translation calls. The old "any
      // call expression counts" heuristic broke the day useResponsiveText
      // landed as a text child: a primary edit on a per-viewport text was
      // misrouted to messages/<defaultLocale>.json (JSX untouched) and the
      // orphaned message then SHADOWED every later source edit — the
      // "committed text reverts" bug (2026-07-03).
      if (expr.callee?.type === 'Identifier' && expr.callee.name === 'useResponsiveText') return false;
      return true;
    });
    path.stop();
  });
  return found;
}

/**
 * Read a value from the namespaced messages JSON: `{ <ns>: { <key>: '...' } }`.
 * Returns null if the file is missing or the key path doesn't exist.
 */
export function getMessageValue(
  messagesJson: string,
  namespace: string,
  key: string,
): string | null {
  try {
    const parsed = JSON.parse(messagesJson);
    const ns = parsed?.[namespace];
    if (!ns || typeof ns !== 'object') return null;
    const v = ns[key];
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

/**
 * Set a namespaced key in messages JSON, returning the updated JSON string.
 * Creates the namespace bucket if missing. Pretty-prints with 2-space indent
 * to keep file diffs reviewable.
 */
export function setMessageValue(
  messagesJson: string,
  namespace: string,
  key: string,
  value: string,
): string {
  let parsed: any = {};
  try {
    parsed = JSON.parse(messagesJson || '{}');
  } catch {
    parsed = {};
  }
  if (!parsed || typeof parsed !== 'object') parsed = {};
  if (!parsed[namespace] || typeof parsed[namespace] !== 'object') parsed[namespace] = {};
  parsed[namespace][key] = value;
  return JSON.stringify(parsed, null, 2);
}
