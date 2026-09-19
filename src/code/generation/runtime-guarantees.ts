// runtime-guarantees.ts — the builder-side twin of the drop path's
// layout-normalize (src/canvas/drag/layout-normalize.ts) + the oracle's
// self-healable rules (src/code/oracle/checks/layout-rules.ts,
// style-object.ts, check-file.ts NODE_MISSING_POSITION).
//
// The drop path guarantees that ANY plugin-supplied tree becomes
// oracle-compliant BEFORE it becomes real nodes. But the WRITE path has no
// such guarantee: a committed source can carry NODE_MISSING_POSITION,
// FLEX_CHILD_MISSING_ORDER, FLEX_CHILD_SHRINKS or TRANSPARENT_COLOR — the
// oracle bounces it on the NEXT AI submit, and the editor's own controls
// misread it. This module closes that gap with the SAME rules the drop path
// enforces, applied as a pure string pass over any committed file:
//
//   • NODE_MISSING_POSITION — every styled node without an explicit
//     `position` gets `position: 'relative'` (author-set positions kept).
//   • FLEX_CHILD_MISSING_ORDER — every in-flow child of a static flex/grid
//     container (2+ flow children) gets the SAME sequential quoted `order`
//     the drop path assigns (String(flowIdx) in source order).
//   • FLEX_CHILD_SHRINKS — every in-flow child of a static flex (not grid)
//     container whose shrink resolves to 1 gets EXACTLY the flex string
//     forceNonShrink (layout-normalize) produces ('0 0 auto' Hug, grow 0
//     basis Fill). Conforming flex/flexShrink (shrink 0, 'none', '1 0 0px',
//     indeterminate ternaries) is skipped.
//   • TRANSPARENT_COLOR — the literal 'transparent' on any style value →
//     TRANSPARENT_FILL (normalizeTransparent semantics from css-utils).
//
// Pure, deterministic, idempotent (2× = 1×): babel parse (jsx+typescript),
// STRING INJECTION ONLY (never a reprint/format), parse failure → the input
// is returned unchanged. The same single normalizer feeds every write-path
// seam: the mutation queue's processQueue + flushNow drains, modifyProjectFile
// and the freeform commit — so builder edits and AI commits land in exactly
// the dialect the oracle accepts.
import { parse } from '@babel/parser';
import * as t from '@babel/types';
import { traverse, jsxTagName, jsxAttrs, stringAttr, TRANSPARENT_TAGS } from '@/code/oracle/checks/shared';
import { TRANSPARENT_FILL } from '@/shared/css-utils';
import { isSvgTag } from '@/shared/constants';
import { trace } from '@/shared/debug-trace';

/** Containers whose in-flow children must carry a sequential `order`
 *  (FLEX_CHILD_MISSING_ORDER — same static-display scope as the oracle). */
const ORDER_CONTAINER_DISPLAYS = new Set(['flex', 'inline-flex', 'grid', 'inline-grid']);
/** Containers whose in-flow children must never shrink (FLEX_CHILD_SHRINKS —
 *  flex only; grid items are exempt, matching layout-normalize + the oracle). */
const SHRINK_CONTAINER_DISPLAYS = new Set(['flex', 'inline-flex']);

/** Per-style-object edit plan, keyed by the AST object node (babel node
 *  identity is stable across one traversal). */
interface ObjPlan {
  needPosition: boolean;
  needOrder: boolean;
  orderValue: string;
  needFlex: boolean;
  flexValue: string;
  /** Existing `flex` literal to replace (shrink-1 explicit flex). */
  flexSpan: { start: number; end: number } | null;
  /** `'transparent'` string literals to swap for TRANSPARENT_FILL. */
  transparentSpans: Array<{ start: number; end: number }>;
}

interface Edit { start: number; end: number; text: string }

/** The object expression of a STATIC `style={{…}}` attribute, or null when
 *  the attribute is missing, spread into, or a non-object expression. */
function staticStyleObj(el: t.JSXElement): t.ObjectExpression | null {
  for (const a of jsxAttrs(el.openingElement)) {
    if (a.name.name !== 'style') continue;
    if (a.value?.type === 'JSXExpressionContainer' && t.isObjectExpression(a.value.expression)) {
      return a.value.expression;
    }
    return null; // style={styles} / style={cond ? … : …} / style="…" — not a static object
  }
  return null;
}

/** Property value reader — mirrors the oracle's propVal in layout-rules.ts:
 *  { str } string literal, { num } numeric literal, '__expr__' for any
 *  other expression, null when the key is absent. */
function propVal(obj: t.ObjectExpression, key: string): { str?: string; num?: number; start?: number; end?: number } | '__expr__' | null {
  for (const pr of obj.properties) {
    if (!t.isObjectProperty(pr)) continue;
    const k = t.isIdentifier(pr.key) ? pr.key.name : t.isStringLiteral(pr.key) ? pr.key.value : '';
    if (k !== key) continue;
    if (t.isStringLiteral(pr.value)) return { str: pr.value.value, start: pr.value.start ?? undefined, end: pr.value.end ?? undefined };
    if (t.isNumericLiteral(pr.value)) return { num: pr.value.value, start: pr.value.start ?? undefined, end: pr.value.end ?? undefined };
    return '__expr__';
  }
  return null;
}

/** Static STRING value of a property (oracle's strProp): the literal string,
 *  '__expr__' when the property is an expression, null when absent. */
function staticStr(obj: t.ObjectExpression, key: string): string | null {
  const pv = propVal(obj, key);
  if (pv === '__expr__') return '__expr__';
  return pv && pv.str != null ? pv.str : null;
}

/** Key presence regardless of value shape (position already declared, order
 *  already declared — both make their rules skip). */
function objHasKey(obj: t.ObjectExpression, key: string): boolean {
  return obj.properties.some((pr) => t.isObjectProperty(pr)
    && (t.isIdentifier(pr.key) ? pr.key.name : t.isStringLiteral(pr.key) ? pr.key.value : '') === key);
}

/** Static position value of a child, or null when the child has no style
 *  object / no position property. A ternary/variable position is NOT
 *  'absolute'/'fixed', so such a child counts as in-flow — same as the
 *  oracle (styleStr returns '__expr__'). */
function childPosition(obj: t.ObjectExpression | null): string | null {
  if (!obj) return null;
  const pos = staticStr(obj, 'position');
  return pos === '__expr__' ? null : pos;
}

/** Does this child's flex resolve to shrink 1 — i.e. would the oracle's
 *  FLEX_CHILD_SHRINKS fire? Mirrors staticShrink in layout-rules.ts:
 *  flexShrink checked FIRST (an explicit non-0 shrink is a violation even
 *  with a conforming flex shorthand), then the flex shorthand, then the CSS
 *  default (absent → 1). Indeterminate (expression) → false (skip). */
function resolvesShrinkOne(obj: t.ObjectExpression | null): boolean {
  if (!obj) return true; // no flex/flexShrink at all ⇒ CSS default shrink 1 (oracle fires)
  const fs = propVal(obj, 'flexShrink');
  if (fs === '__expr__') return false;
  if (fs) {
    if (fs.num != null) return fs.num !== 0;
    if (fs.str != null) { const n = parseFloat(fs.str); return Number.isFinite(n) ? n !== 0 : false; }
  }
  const fpv = propVal(obj, 'flex');
  if (fpv === '__expr__') return false;
  if (fpv && fpv.str != null) {
    const val = fpv.str.trim();
    if (val === 'none') return false;
    if (val === 'auto' || val === 'initial') return true;
    const parts = val.split(/\s+/);
    if (parts.length >= 3) { const n = parseFloat(parts[1]); return Number.isFinite(n) ? n !== 0 : false; }
    if (parts.length === 2) {
      const second = parts[1];
      if (/^-?\d/.test(second)) { const n = parseFloat(second); return n !== 0; }
      return true; // grow basis ⇒ shrink defaults to 1
    }
    return true; // single value ⇒ shrink defaults to 1
  }
  if (fpv && fpv.num != null) return true; // `flex: 1` ⇒ grow 1, shrink 1
  return true; // flex + flexShrink both absent ⇒ CSS default shrink 1 (oracle fires)
}

/** The EXACT flex string layout-normalize's forceNonShrink produces for a
 *  shrinking child: '0 0 auto' when no flex is set (Hug), the existing
 *  grow/basis with the shrink slot forced to 0 (Fill). Byte-for-byte parity
 *  with layout-normalize.ts:43-55 — do not "fix" its keyword handling. */
function forcedFlexString(flex: { str?: string; num?: number } | null): string {
  if (!flex) return '0 0 auto';
  const f = flex.str != null ? flex.str : String(flex.num);
  const p = f.trim().split(/\s+/);
  if (p.length >= 3) { p[1] = '0'; return p.slice(0, 3).join(' '); }
  if (p.length === 2) {
    if (/^-?\d/.test(p[1])) { p[1] = '0'; return p.join(' '); }
    return `${p[0]} 0 ${p[1]}`;
  }
  return `${p[0]} 0 0px`;
}

/** Every 'transparent' STRING literal in a style value (directly or inside a
 *  ternary — the oracle's styleValueIncludes recurses branches too). */
function collectTransparentSpans(val: t.Expression, out: Array<{ start: number; end: number }>): void {
  if (t.isStringLiteral(val)) {
    if (val.value.trim() === 'transparent' && val.start != null && val.end != null) {
      out.push({ start: val.start, end: val.end });
    }
    return;
  }
  if (t.isConditionalExpression(val)) {
    collectTransparentSpans(val.consequent, out);
    collectTransparentSpans(val.alternate, out);
  }
}

/** Rule 1 scope — every element that must carry an explicit position
 *  (NODE_MISSING_POSITION exclusions, mirrored from check-file.ts:746-756:
 *  no data-id, the page root, parked canvas nodes, spread-carrying style
 *  objects (placement may arrive through them), svg internals, and
 *  TRANSPARENT_TAGS wrappers are exempt). A missing style object is handled
 *  by the caller (v1 never CREATES objects for position alone). */
function inPositionScope(
  dataId: string | undefined,
  baseTag: string,
  attrs: ReturnType<typeof jsxAttrs>,
  insideSvg: boolean,
  obj: t.ObjectExpression | null,
): boolean {
  if (!dataId || dataId === 'root') return false;
  if (stringAttr(attrs, 'data-canvas-node') === 'true') return false;
  if (TRANSPARENT_TAGS.has(baseTag)) return false;
  if (isSvgTag(baseTag)) return false;
  if (insideSvg) return false;
  if (obj && obj.properties.some((p) => t.isSpreadElement(p))) return false; // ...style passthrough
  return true;
}

/** GARDE PERF — parse the drain's file only when it actually changed
 *  STRUCTURE. Style/text/animation-only drains (updateStyles,
 *  updateContainerStyle, updateVariantStyle, updateCssHover,
 *  updatePseudoStyle, updateMotionProp, updateLoop, updateInstanceFx,
 *  updateTextAnim, updateScrollAnim, setConditionalStyle, updateHtmlAttrs,
 *  updateText, …) are gesture-hot (60 ticks/sec); running a babel parse on
 *  every tick is exactly the frame drop the queue already avoids. Only the
 *  structural mutations that can make a file NON-compliant (or that commit
 *  brand-new source) trigger the pass. */
const RUNTIME_GUARANTEES_STRUCTURAL_TYPES = new Set([
  'addNode', 'addCanvasNode', 'move', 'reorder', 'updateChildrenHTML', 'changeTag', 'writeFile',
]);

export function needsRuntimeGuarantees(mutationTypes: readonly string[]): boolean {
  return mutationTypes.length > 0 && mutationTypes.some((t) => RUNTIME_GUARANTEES_STRUCTURAL_TYPES.has(t));
}

/** Normalize a committed source into the oracle's dialect — the single
 *  normalizer behind every write-path seam (mutation queue, modifyProjectFile,
 *  freeform commit). Pure + idempotent; parse failure returns the input
 *  unchanged; every edit is a STRING SPLICE at an AST offset — the file's own
 *  formatting survives. */
export function applyRuntimeGuarantees(code: string): string {
  let ast: t.File;
  try {
    ast = parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] });
  } catch {
    return code;
  }

  const plans = new Map<t.ObjectExpression, ObjPlan>();
  const planOf = (obj: t.ObjectExpression): ObjPlan => {
    let p = plans.get(obj);
    if (!p) {
      p = { needPosition: false, needOrder: false, orderValue: '0', needFlex: false, flexValue: '0 0 auto', flexSpan: null, transparentSpans: [] };
      plans.set(obj, p);
    }
    return p;
  };
  // Created style attributes for style-less flex/grid children (rule 2/3):
  // ` style={{ position: 'relative', order: '0', flex: '0 0 auto' }}` spliced
  // right before the opening element's closing `>` / `/>`.
  const createdStyleAttrs: Edit[] = [];

  traverse(ast, {
    JSXElement(path) {
      const el = path.node;
      const opening = el.openingElement;
      const tag = jsxTagName(opening.name);
      const base = tag.startsWith('motion.') ? tag.slice('motion.'.length) : tag;
      const attrs = jsxAttrs(opening);
      const dataId = stringAttr(attrs, 'data-id');
      const obj = staticStyleObj(el);
      const insideSvg = !!path.findParent((p: any) =>
        t.isJSXElement(p.node) && jsxTagName(p.node.openingElement.name).replace(/^motion\./, '') === 'svg');

      // ── Rule 4 — TRANSPARENT_COLOR (every style object, no exclusions) ──
      if (obj) {
        for (const pr of obj.properties) {
          if (!t.isObjectProperty(pr) || !t.isExpression(pr.value)) continue;
          collectTransparentSpans(pr.value, planOf(obj).transparentSpans);
        }
      }

      // ── Rule 1 — NODE_MISSING_POSITION (static style object only) ──
      if (obj && inPositionScope(dataId, base, attrs, insideSvg, obj) && !objHasKey(obj, 'position')) {
        planOf(obj).needPosition = true;
      }

      // ── Rules 2 + 3 — the container pass over DIRECT element children ──
      const display = obj ? staticStr(obj, 'display') : null;
      const isOrderContainer = display != null && display !== '__expr__' && ORDER_CONTAINER_DISPLAYS.has(display);
      const isShrinkContainer = display != null && display !== '__expr__' && SHRINK_CONTAINER_DISPLAYS.has(display);
      if (isOrderContainer || isShrinkContainer) {
        // Children are inside svg when the parent is (any ancestor chain) or
        // when the parent itself is the svg wrapper.
        const childInSvg = insideSvg || base === 'svg';
        const flow: Array<{ child: t.JSXElement; cObj: t.ObjectExpression | null; cDataId: string; hasStyleAttr: boolean }> = [];
        for (const child of el.children) {
          if (!t.isJSXElement(child)) continue; // text / expressions / fragments are not flex children
          const cAttrs = jsxAttrs(child.openingElement);
          const cDataId = stringAttr(cAttrs, 'data-id');
          if (!cDataId) continue;
          const cObj = staticStyleObj(child);
          const pos = childPosition(cObj);
          if (pos === 'absolute' || pos === 'fixed') continue; // out of flow
          flow.push({ child, cObj, cDataId, hasStyleAttr: cAttrs.some((a) => a.name.name === 'style') });
        }
        if (flow.length >= 2) { // the oracle's FLEX_CHILD_MISSING_ORDER / FLEX_CHILD_SHRINKS threshold
          flow.forEach((c, i) => {
            const childObj = c.cObj;
            if (childObj) {
              // order — same sequential index the drop path assigns (flowIdx
              // counts every in-flow child, existing order included).
              if (isOrderContainer && !objHasKey(childObj, 'order')) {
                const p = planOf(childObj);
                p.needOrder = true;
                p.orderValue = String(i);
              }
              if (isShrinkContainer && resolvesShrinkOne(childObj)) {
                const p = planOf(childObj);
                const flex = propVal(childObj, 'flex');
                if (flex && flex !== '__expr__' && (flex.str != null || flex.num != null) && flex.start != null && flex.end != null) {
                  p.needFlex = true;
                  p.flexValue = forcedFlexString(flex);
                  p.flexSpan = { start: flex.start, end: flex.end }; // shrink-1 explicit flex → rewrite its literal
                } else {
                  p.needFlex = true;
                  p.flexValue = forcedFlexString(null);
                }
              }
            } else if (!c.hasStyleAttr) {
              // Style-less in-flow child — the drop path would have created
              // the object for it. Create one now (NEVER on top of a
              // non-static style attr — a second style attribute would not
              // parse). Everything a second pass would add goes in at once so
              // the pass stays idempotent.
              const childOpening = c.child.openingElement;
              const childEnd = childOpening.end;
              if (childEnd == null) return;
              // Self-closing children end with '/>' — insert before the '/'
              // (end-2); otherwise the '>' of the opening tag (end-1), so the
              // splice always lands between tag and closing.
              const insertAt = childOpening.selfClosing ? childEnd - 2 : childEnd - 1;
              const parts: string[] = [];
              if (inPositionScope(c.cDataId, baseOf(c.child), jsxAttrs(childOpening), childInSvg, null)) {
                parts.push("position: 'relative'");
              }
              if (isOrderContainer) parts.push(`order: '${i}'`);
              if (isShrinkContainer) parts.push("flex: '0 0 auto'");
              if (parts.length) {
                createdStyleAttrs.push({ start: insertAt, end: insertAt, text: ` style={{ ${parts.join(', ')} }}` });
              }
            }
          });
        }
      }
    },
  });

  if (plans.size === 0 && createdStyleAttrs.length === 0) return code;

  const edits: Edit[] = createdStyleAttrs;
  for (const [obj, p] of plans) {
    if (obj.start == null) continue;
    const pieces: string[] = [];
    if (p.needPosition) pieces.push("position: 'relative'");
    if (p.needOrder) pieces.push(`order: '${p.orderValue}'`);
    if (p.needFlex && !p.flexSpan) pieces.push(`flex: '${p.flexValue}'`);
    // Property order matches the drop path's canonical emit (position, order,
    // flex). A trailing comma is only legal/pretty when the object already
    // has properties — an empty `style={{ }}` gets a comma-free insert.
    if (pieces.length) {
      // Trailing comma only when the object already has properties (a comma
      // alone after a newline would be fine, but '{{ … }}' with a lone comma
      // reads broken); an empty object gets a trailing space instead so the
      // closing braces stay spaced ('{ position: 'relative' }').
      const tail = obj.properties.length > 0 ? ',' : ' ';
      edits.push({ start: obj.start + 1, end: obj.start + 1, text: ` ${pieces.join(', ')}${tail}` });
    }
    if (p.flexSpan) edits.push({ start: p.flexSpan.start, end: p.flexSpan.end, text: `'${p.flexValue}'` });
    for (const span of p.transparentSpans) edits.push({ start: span.start, end: span.end, text: `'${TRANSPARENT_FILL}'` });
  }

  edits.sort((a, b) => b.start - a.start); // apply end → start so offsets stay valid
  let out = code;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  if (out !== code) {
    trace.action('runtime-guarantees:applied', {
      edits: edits.length,
      bytes: out.length - code.length,
    });
  }
  return out;
}

function baseOf(el: t.JSXElement): string {
  const tag = jsxTagName(el.openingElement.name);
  return tag.startsWith('motion.') ? tag.slice('motion.'.length) : tag;
}
