// rich-text-runs.ts — the translatable text RUNS of a mixed-content (rich
// text) node's inner JSX.
//
// A mixed node's `textContent` is the RAW inner JSX (`I'm <span style={{…}}>
// Jenny,</span><br/>Product Designer`). The localization UI must never show
// that markup — instead each contiguous piece of visible text (a bare JSXText
// segment or a styled run's inner text) is a RUN, addressed by index in
// document order and translated under the message key `<nodeId>__r<index>`.
// A run that is already transformed appears in the JSX as `{t('<key>')}` and
// carries that key here, so re-listing after edits never re-keys it.
//
// Everything is offset-based string surgery on the ORIGINAL inner string —
// no re-generation, so the node's other markup is untouched byte-for-byte.

import * as t from '@babel/types';
import { parseJSX } from './ast-utils';
import { trace } from '@/shared/debug-trace';

const WRAP_OPEN = '<x>';

export interface TextRun {
  /** Trimmed visible text ('' for an already-transformed t() run). */
  text: string;
  /** Existing translation key when the run is already `{t('key')}`. */
  key: string | null;
  /** Offsets of the replaceable region INSIDE the inner-JSX string. For a
   *  text run this is the trimmed text span; for a t() run the whole
   *  `{t('…')}` container. */
  start: number;
  end: number;
}

/** `{t('key')}`-shaped expression → its key (any single-identifier hook). */
function tCallKey(expr: t.Node): string | null {
  if (!t.isCallExpression(expr)) return null;
  if (!t.isIdentifier(expr.callee)) return null;
  if (expr.arguments.length !== 1 || !t.isStringLiteral(expr.arguments[0])) return null;
  return (expr.arguments[0] as t.StringLiteral).value;
}

/** Extract the runs of an inner-JSX string, in document order. */
export function extractTextRuns(innerJsx: string): TextRun[] {
  const ast = parseJSX(WRAP_OPEN + innerJsx + '</x>');
  if (!ast) {
    trace.error('rich-text-runs:parse-failed', { snippet: innerJsx.slice(0, 60) });
    return [];
  }
  const stmt = ast.program.body[0];
  if (!stmt || stmt.type !== 'ExpressionStatement' || stmt.expression.type !== 'JSXElement') return [];
  const runs: TextRun[] = [];
  const shift = WRAP_OPEN.length;

  const walk = (el: t.JSXElement): void => {
    for (const child of el.children) {
      if (t.isJSXText(child)) {
        const raw = child.value;
        if (!raw.trim()) continue;
        const lead = raw.length - raw.trimStart().length;
        const trail = raw.length - raw.trimEnd().length;
        runs.push({
          text: raw.trim(),
          key: null,
          start: (child.start ?? 0) + lead - shift,
          end: (child.end ?? 0) - trail - shift,
        });
      } else if (t.isJSXExpressionContainer(child)) {
        const key = tCallKey(child.expression);
        if (key !== null) {
          runs.push({ text: '', key, start: (child.start ?? 0) - shift, end: (child.end ?? 0) - shift });
        }
      } else if (t.isJSXElement(child)) {
        walk(child);
      }
    }
  };
  walk(stmt.expression);
  return runs;
}

/** Escape text for insertion as a JSXText segment (also HTML-safe — the
 *  canvas renders mixed content via innerHTML). */
export function escapeJsxText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\{/g, '&#123;')
    .replace(/\}/g, '&#125;');
}

/** Replace a run's region with literal (escaped) text. */
export function replaceRunWithText(innerJsx: string, run: TextRun, newText: string): string {
  return innerJsx.slice(0, run.start) + escapeJsxText(newText) + innerJsx.slice(run.end);
}

/** Replace a run's region with a `{hook('key')}` translation call. */
export function replaceRunWithCall(innerJsx: string, run: TextRun, key: string, hookVar = 't'): string {
  return innerJsx.slice(0, run.start) + `{${hookVar}('${key}')}` + innerJsx.slice(run.end);
}

/** The message-key run suffix: `<nodeId>__r<index>`. */
export const RUN_KEY_RE = /^(.+)__r(\d+)$/;

/** Locate the inner-JSX span (children region) of the element with `nodeId`
 *  in a full source file. Returns null for self-closing / missing nodes. */
export function nodeInnerSpan(code: string, nodeId: string): { start: number; end: number } | null {
  const ast = parseJSX(code);
  if (!ast) return null;
  let span: { start: number; end: number } | null = null;
  const visit = (node: t.Node): void => {
    if (span) return;
    if (t.isJSXElement(node)) {
      const opening = node.openingElement;
      const has = opening.attributes.some((a) =>
        t.isJSXAttribute(a) && t.isJSXIdentifier(a.name) && a.name.name === 'data-id'
        && t.isStringLiteral(a.value) && a.value.value === nodeId);
      if (has && node.closingElement && opening.end != null && node.closingElement.start != null) {
        span = { start: opening.end, end: node.closingElement.start };
        return;
      }
    }
    for (const k of Object.keys(node)) {
      const v = (node as any)[k];
      if (Array.isArray(v)) { for (const item of v) { if (item && typeof item === 'object' && item.type) visit(item); if (span) return; } }
      else if (v && typeof v === 'object' && v.type) { visit(v); if (span) return; }
    }
  };
  visit(ast.program as unknown as t.Node);
  return span;
}
