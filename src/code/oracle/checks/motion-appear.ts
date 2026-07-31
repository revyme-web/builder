// oracle/checks/motion-appear.ts — appear-animation stuck-hidden rule.
// All code moved VERBATIM from check-file.ts (Phase 7.1 god-file split).

import * as t from '@babel/types';
import { traverse, jsxTagName, jsxAttrs, stringAttr } from './shared';
import type { OracleViolation } from './shared';

/**
 * MOTION_APPEAR_STUCK_HIDDEN — initial={{ opacity: 0 }} with no animate /
 * whileInView that sets opacity back leaves the element INVISIBLE on the live
 * site (framer-motion holds the initial). The canvas paints resolved variant
 * styles and ignores enter animations, so it looks fine there → the classic
 * "renders on canvas, blank on the live site". A variant-list animate
 * (animate={['default', variant]}) does NOT restore opacity.
 */
function checkMotionAppearHidden(ast: t.File, v: OracleViolation[]): void {
  const opacityState = (val: t.JSXAttribute['value'] | undefined): 'zero' | 'restored' | 'none' => {
    if (!val || val.type !== 'JSXExpressionContainer' || !t.isObjectExpression(val.expression)) return 'none';
    for (const p of val.expression.properties) {
      if (!t.isObjectProperty(p)) continue;
      const k = t.isIdentifier(p.key) ? p.key.name : t.isStringLiteral(p.key) ? p.key.value : '';
      if (k !== 'opacity') continue;
      return (t.isNumericLiteral(p.value) && p.value.value === 0) ? 'zero' : 'restored';
    }
    return 'none';
  };
  traverse(ast, {
    JSXElement(path) {
      const opening = path.node.openingElement;
      const attrs = jsxAttrs(opening);
      if (opacityState(attrs.find((a) => a.name.name === 'initial')?.value) !== 'zero') return; // initial doesn't hide
      if (opacityState(attrs.find((a) => a.name.name === 'animate')?.value) === 'restored') return;
      if (opacityState(attrs.find((a) => a.name.name === 'whileInView')?.value) === 'restored') return;
      if (attrs.some((a) => a.name.name === 'variants')) return; // a variant may define opacity
      const tag = jsxTagName(opening.name);
      const id = stringAttr(attrs, 'data-id');
      const line = opening.loc?.start.line;
      const hasAnimate = attrs.some((a) => a.name.name === 'animate');
      v.push({
        code: 'MOTION_APPEAR_STUCK_HIDDEN', tier: 2, line, elementId: id,
        message: `<${tag}>${id ? ` (data-id="${id}")` : ''} at line ${line} has initial={{ opacity: 0 }} but nothing restores it — its animate ${hasAnimate ? 'does not set opacity back to a visible value' : 'is missing'}. It renders on the CANVAS (enter animations are ignored there) but is INVISIBLE on the live site. For an AnimatePresence/variant child the fix is to REMOVE the initial — it appears/disappears via the variant switch + layout, no fade needed. For a one-time scroll reveal use whileInView={{ opacity: 1 }} + viewport={{ once: true }} (shown as "Appear"). Do NOT "fix" it with a plain animate={{…}} object — the editor reads that as a Loop effect.`,
      });
    },
  });
}

/**
 * MOTION_TRANSFORM_TEMPLATE_DRIFT — a static `style.transform` on a motion
 * element that also ANIMATES a transform value (an Appear's `y`, a shorthand
 * `rotate`) is silently discarded at runtime: framer-motion rebuilds the whole
 * transform string from its own values. A pinned aura centred by
 * `translate(-50%, -50%)` shifts by half its own size the moment the appear
 * runs — correct on the canvas (which paints the resting style), broken on the
 * live page (user report 2026-07-27). The fix is the composing
 * `transformTemplate={(_, generated) => \`<transform> ${generated}\`}` the
 * builder pairs with the static string (single writer:
 * `ensureTransformTemplateInCode`). This rule fires when the pair is missing,
 * stale, or orphaned — each a shape where canvas and live silently disagree.
 */
const TRANSFORM_VALUE_KEYS = new Set([
  'x', 'y', 'z', 'rotate', 'rotateX', 'rotateY', 'rotateZ',
  'scale', 'scaleX', 'scaleY', 'scaleZ', 'skewX', 'skewY', 'transformPerspective',
]);

function checkMotionTransformDrift(ast: t.File, v: OracleViolation[]): void {
  /** Object-literal keys of a JSX attr value (empty for non-object shapes). */
  const objKeys = (val: t.JSXAttribute['value'] | undefined): string[] => {
    if (!val || val.type !== 'JSXExpressionContainer') return [];
    // Accept the bare object AND a conditional whose branch is an object
    // (the scoped/variant enter shape).
    const exprs: t.Node[] = [val.expression];
    if (t.isConditionalExpression(val.expression)) exprs.push(val.expression.consequent, val.expression.alternate);
    const keys: string[] = [];
    for (const e of exprs) {
      if (!t.isObjectExpression(e)) continue;
      for (const p of e.properties) {
        if (!t.isObjectProperty(p)) continue;
        keys.push(t.isIdentifier(p.key) ? p.key.name : t.isStringLiteral(p.key) ? p.key.value : '');
      }
    }
    return keys;
  };
  /** The canonical template's static prefix, `null` when absent or foreign.
   *  Canonical = the writer's exact shape, `(_, generated) => \`… ${generated}\`` —
   *  the same test `ensureTransformTemplateInCode` applies. Any other arrow
   *  (different params, a computed body) is a hand-written composer the writer
   *  refuses to touch, so the oracle must not demand it be regenerated either. */
  const templatePrefix = (attr: t.JSXAttribute | undefined): { prefix: string } | 'foreign' | null => {
    if (!attr) return null;
    const val = attr.value;
    if (!val || val.type !== 'JSXExpressionContainer' || !t.isArrowFunctionExpression(val.expression)) return 'foreign';
    const [p0, p1] = val.expression.params;
    if (!t.isIdentifier(p0) || p0.name !== '_' || !t.isIdentifier(p1) || p1.name !== 'generated') return 'foreign';
    const body = val.expression.body;
    if (!t.isTemplateLiteral(body)) return 'foreign';
    return { prefix: body.quasis[0]?.value.cooked?.trim() ?? '' };
  };
  traverse(ast, {
    JSXElement(path) {
      const opening = path.node.openingElement;
      const tag = jsxTagName(opening.name);
      if (!tag.startsWith('motion.') && tag !== 'MotionLink') return;
      const attrs = jsxAttrs(opening);

      // Static transform string in the style object.
      let staticT = '';
      const styleKeys: string[] = [];
      const styleAttr = attrs.find((a) => a.name.name === 'style')?.value;
      if (styleAttr && styleAttr.type === 'JSXExpressionContainer' && t.isObjectExpression(styleAttr.expression)) {
        for (const p of styleAttr.expression.properties) {
          if (!t.isObjectProperty(p)) continue;
          const k = t.isIdentifier(p.key) ? p.key.name : t.isStringLiteral(p.key) ? p.key.value : '';
          styleKeys.push(k);
          if (k === 'transform' && t.isStringLiteral(p.value)) staticT = p.value.value.trim();
        }
      }

      // Anything animating a transform value?
      const animates =
        (['initial', 'whileInView', 'animate'] as const).some((n) =>
          objKeys(attrs.find((a) => a.name.name === n)?.value).some((k) => TRANSFORM_VALUE_KEYS.has(k)))
        || styleKeys.some((k) => TRANSFORM_VALUE_KEYS.has(k));

      const tt = templatePrefix(attrs.find((a) => a.name.name === 'transformTemplate'));
      if (tt === 'foreign') return; // hand-written composer — not ours to judge
      const id = stringAttr(attrs, 'data-id');
      const line = opening.loc?.start.line;
      const at = `<${tag}>${id ? ` (data-id="${id}")` : ''} at line ${line}`;

      if (staticT && animates) {
        if (!tt) {
          v.push({
            code: 'MOTION_TRANSFORM_TEMPLATE_DRIFT', tier: 2, line, elementId: id,
            message: `${at} has a static style transform '${staticT}' AND animates a transform value (x/y/scale/rotate) — framer-motion rebuilds the transform from its own values and DROPS the static string at runtime, so the element shifts on the live page while the canvas looks right. Pair them with transformTemplate={(_, generated) => \`${staticT} \${generated}\`} (the builder derives this automatically), or move the static transform out of the animated element.`,
          });
        } else if (tt.prefix !== staticT) {
          v.push({
            code: 'MOTION_TRANSFORM_TEMPLATE_DRIFT', tier: 2, line, elementId: id,
            message: `${at} has transformTemplate prefix '${tt.prefix}' but style.transform is '${staticT}' — the template is DERIVED from style.transform and must match exactly, or the live page composes a stale transform the canvas never shows. Regenerate it: transformTemplate={(_, generated) => \`${staticT} \${generated}\`}.`,
          });
        }
      } else if (tt) {
        v.push({
          code: 'MOTION_TRANSFORM_TEMPLATE_DRIFT', tier: 2, line, elementId: id,
          message: `${at} carries a transformTemplate but ${staticT ? 'nothing animates a transform value' : 'has no static style.transform to compose'} — the composer is orphaned. Remove the transformTemplate attribute${staticT ? '' : ' (or restore the static transform it was derived from)'}.`,
        });
      }
    },
  });
}

export { checkMotionAppearHidden, checkMotionTransformDrift };
