// oracle/checks/style-object.ts — style object rules.
// All code moved VERBATIM from check-file.ts (Phase 7.1 god-file split).

import * as t from '@babel/types';
import type { OracleViolation } from './shared';
import { objHasKey } from './node-dimensions';

// ─── style object rules ───────────────────────────────────────────────────────

const TRANSITION_KEYS = /^transition(Property|Duration|Delay|TimingFunction)?$/;
// `willChange` is deliberately NOT flagged: it's a compositor promotion HINT
// (perf isolation for self-animating components), not an animation — the
// Animation panel has nothing to show for it and the runtime needs it.
const ANIMATION_KEYS = /^(animation(Name|Duration|TimingFunction|Delay|IterationCount|Direction|FillMode|PlayState)?)$/;
// The Size tool's min/max secondary controls expose ONLY a px/% unit toggle —
// unlike the primary width/height (which also do Fit/Fill). So a committed
// min/max constraint must be a plain px or % length; anything else (viewport
// units vh/vw, em/rem/ch, calc(), or the keywords auto/none/min-content) has no
// slot in the panel and reads as unset (live find 2026-07-04: minHeight:'100vh').
const MINMAX_SIZE_KEYS = new Set(['minWidth', 'maxWidth', 'minHeight', 'maxHeight']);

// Padding / Margin / Radius are PX-ONLY (2026-08-12): the SpacingControl's
// %/rem unit cycle was removed — spacing is a pixel concept in this builder,
// and multi-unit spacing bred shorthand-mix/codegen bugs. Any other unit
// shows in the panel as a number the control will rewrite to px on the next
// edit — "reads as a different value", same class as MINMAX_SIZE_UNIT.
const SPACING_PX_KEYS = new Set([
  'padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'margin', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
  'borderRadius', 'borderTopLeftRadius', 'borderTopRightRadius',
  'borderBottomLeftRadius', 'borderBottomRightRadius',
]);

function checkStyleObject(
  obj: t.ObjectExpression,
  dataId: string | undefined,
  v: OracleViolation[],
  ctx: { fixedAllowed: boolean; builderOwned?: boolean } = { fixedAllowed: true },
): void {
  // BG_COLOR_WITH_IMAGE — the builder's Fill control is single-color OR
  // multi-layer, never both. An element carrying BOTH backgroundColor and
  // backgroundImage is an un-editable state (the control can't represent both),
  // so the colour must live IN the fill as a layer, not as a separate prop.
  // Conditional by design: only fires when both keys are present on the element.
  if (objHasKey(obj, 'backgroundColor') && objHasKey(obj, 'backgroundImage')) {
    const bgc = obj.properties.find((p): p is t.ObjectProperty =>
      t.isObjectProperty(p) && ((t.isIdentifier(p.key) && p.key.name === 'backgroundColor')
        || (t.isStringLiteral(p.key) && p.key.value === 'backgroundColor')));
    const line = bgc?.loc?.start.line;
    v.push({
      code: 'BG_COLOR_WITH_IMAGE', tier: 2, line, elementId: dataId,
      message: `This element has both backgroundColor and backgroundImage (line ${line}). The Fill control is single-color OR multi-layer — never both. Fold the colour into the fill as a layer: remove backgroundColor and append 'linear-gradient(<color>, <color>)' as the last backgroundImage layer (with matching backgroundSize/Repeat/BlendMode entries).`,
    });
  }

  for (const prop of obj.properties) {
    if (!t.isObjectProperty(prop)) continue; // ...style spreads are fine
    const key = t.isIdentifier(prop.key) ? prop.key.name : t.isStringLiteral(prop.key) ? prop.key.value : null;
    if (!key) continue;
    const line = prop.loc?.start.line;

    // STATIC_TEMPLATE_STYLE — a style value written as a backtick template
    // literal with NO ${} interpolation is a plain string in disguise. The
    // LIVE renderer evaluates it fine, but the CANVAS parser treats backtick
    // values as DYNAMIC bindings and skips them entirely — the property is
    // invisible in the editor while working on the deployed site (live find
    // 2026-07-21: a rebuild emitted static backgroundImage urls in backticks
    // → every image blank on canvas, perfect in preview). Backticks are ONLY
    // for genuinely dynamic values (a CMS binding interpolating item fields).
    if (t.isTemplateLiteral(prop.value) && prop.value.expressions.length === 0) {
      const raw = prop.value.quasis.map((q) => q.value.raw).join('').slice(0, 60);
      v.push({
        code: 'STATIC_TEMPLATE_STYLE', tier: 2, line, elementId: dataId,
        message: `${key} (line ${line}) is a template literal with NO interpolation — it renders live but is INVISIBLE on the canvas (backtick style values are treated as dynamic bindings and skipped). Write it as a normal quoted string: ${key}: '${raw}'. Backticks are only for genuinely dynamic values (a CMS binding interpolating item fields).`,
      });
      continue;
    }

    // ── position pin units (shared/pin-utils.ts: pins are px-only;
    //    left/top % is legal ONLY as the centering pattern with translate) ──
    // 'transparent' is not a color this builder's controls can represent (the
    // ColorPicker has no transparent keyword — see-through = rgba alpha 0), and
    // a quote-stripped 'transparent' historically poisoned the motion composer.
    if (styleValueIncludes(prop.value, 'transparent')) {
      v.push({
        code: 'TRANSPARENT_COLOR', tier: 2, line, elementId: dataId,
        message: `'transparent' (line ${line}) is not supported by the color controls. Use rgba(0, 0, 0, 0) for a see-through fill, or omit the property entirely.`,
      });
      continue;
    }
    if (['left', 'top', 'right', 'bottom'].includes(key) && containsNumericLiteral(prop.value)) {
      v.push({
        code: 'PIN_VALUE_NOT_PX', tier: 2, line, elementId: dataId,
        message: `${key}: <number> (line ${line}) — offset pins must be px STRINGS ('0px', '24px'). A bare number renders, but the Position tool's pin detector only matches '<n>px', so the pin shows as unset and gets rewritten on first drag.`,
      });
      continue;
    }
    if ((key === 'right' || key === 'bottom') && styleValueEndsWithPercent(prop.value)) {
      v.push({
        code: 'PIN_PERCENT_RIGHT_BOTTOM', tier: 2, line, elementId: dataId,
        message: `${key} with a percentage (line ${line}) does not resolve — the Position tool's pins are px-only, the value is ignored by the canvas and overwritten on first drag. Use ${key}: '<n>px', or anchor from the other edge with left/top (left/top accept %).`,
      });
      continue;
    }
    if (key === 'inset' && !ctx.builderOwned) {
      v.push({
        code: 'INSET_SHORTHAND', tier: 2, line, elementId: dataId,
        message: `inset shorthand (line ${line}) is not supported — write individual left/top/right/bottom px values so the Position tool can edit each pin.`,
      });
      continue;
    }
    // BACKGROUND_SOLID_SHORTHAND — a SOLID colour must live on `backgroundColor`.
    // The Fill control reads/writes backgroundColor for the colour tab, so a
    // solid put on the `background` shorthand renders but shows as an EMPTY,
    // uneditable fill in the panel (same class as MINMAX_SIZE_UNIT — "reads as
    // unset"). Gradients / images legitimately use background/backgroundImage;
    // only a plain colour string is flagged.
    if (key === 'background' && t.isStringLiteral(prop.value)) {
      const val = prop.value.value.trim();
      if (val && !/gradient|url\(|image-set/i.test(val)) {
        v.push({
          code: 'BACKGROUND_SOLID_SHORTHAND', tier: 2, line, elementId: dataId,
          message: `A solid colour on the 'background' shorthand (line ${line}) shows as an empty, uneditable fill — the Fill control reads backgroundColor. Write backgroundColor: '${val}' for a solid colour; reserve background/backgroundImage for gradients and images.`,
        });
        continue;
      }
    }
    // lineHeight must be a UNITLESS ratio ('1.2') or 'normal' — NEVER px (or
    // any length unit). A px line-height is frozen: change the font size (or
    // a responsive tier changes it) and the px leading no longer fits — lines
    // overlap or gap out (hard user rule 2026-07-21). Unitless scales with
    // the font automatically. Figma's CSS export emits px and
    // '110% /* 79.2px */' comment debris — convert both: ratio = lineHeightPx
    // / fontSizePx, e.g. fontSize 40 + lineHeight '48px' → lineHeight: '1.2'.
    if (key === 'lineHeight' && t.isStringLiteral(prop.value)) {
      const lhVal = prop.value.value.trim();
      // A `var(--typo-*-line-height)` ref is valid — it's exactly what the
      // typography-preset apply-guide tells the model to write (same as the var
      // font-size/weight this rule never flags), resolving to a real value at
      // runtime.
      const lhOk = lhVal === 'normal' || lhVal.startsWith('var(') || /^\d+(\.\d+)?$/.test(lhVal);
      if (!lhOk) {
        v.push({
          code: 'LINE_HEIGHT_FORMAT', tier: 2, line, elementId: dataId,
          message: `lineHeight: '${lhVal}' (line ${line}) — line height must be a UNITLESS ratio ('1.2', '1.5') or 'normal'; NEVER px or any length unit. A px line-height freezes the leading: when the font size changes (responsive tier, user edit) the lines overlap or gap out. Convert: ratio = lineHeightPx / fontSizePx (fontSize 40 + '48px' → '1.2'); percentages divide by 100 (110% → '1.1').`,
        });
        continue;
      }
    }
    if (MINMAX_SIZE_KEYS.has(key)) {
      const bad = badMinMaxSizeUnit(prop.value);
      if (bad) {
        v.push({
          code: 'MINMAX_SIZE_UNIT', tier: 2, line, elementId: dataId,
          message: `${key}: '${bad}' (line ${line}) — the Size panel's min/max fields accept ONLY px or %. '${bad}' (viewport units like vh/vw, em/rem/ch, calc(), or keywords like auto/none/min-content) has no slot in the min/max control, so it shows as unset and is dropped on the next edit. Use a px value (e.g. '800px') or a percentage of the parent (e.g. '100%'). For a full-viewport section, pick a concrete px height — the panel can't express vh.`,
        });
      }
      continue;
    }
    if (SPACING_PX_KEYS.has(key)) {
      const bad = badSpacingUnit(prop.value, key.startsWith('margin'));
      if (bad) {
        v.push({
          code: 'SPACING_UNIT_NOT_PX', tier: 2, line, elementId: dataId,
          message: `${key}: '${bad}' (line ${line}) — the Padding/Margin/Radius controls are PX-ONLY. '${bad}' (%, rem/em, vh/vw, calc(), …) shows in the panel as a bare number and gets rewritten to px on the user's next edit — silently changing the value. Write px lengths (e.g. '16px', shorthand '8px 16px' is fine${key.startsWith('margin') ? ", and 'auto' is allowed for margin centering" : ''}). For a circle use a large px radius ('9999px'), not '50%'.`,
        });
      }
      continue;
    }
    if (key === 'position' && styleValueIncludes(prop.value, 'fixed') && !ctx.fixedAllowed) {
      v.push({
        code: 'FIXED_DEPTH', tier: 2, line, elementId: dataId,
        message: `position: 'fixed' (line ${line}) only resolves on DIRECT children of the page root in this builder. Move the element to the top level, or use position: 'sticky' on a top-level wrapper.`,
      });
      continue;
    }

    if (TRANSITION_KEYS.test(key)) {
      v.push({
        code: 'CSS_TRANSITION', tier: 2, line, elementId: dataId,
        message: `CSS "${key}" (line ${line}) — transitions are not CSS here; motion timing is automatic via MotionConfig and editable in the Animation panel. Delete the property; per-variant differences animate on their own.`,
      });
    } else if (ANIMATION_KEYS.test(key)) {
      v.push({
        code: 'CSS_KEYFRAMES_ANIMATION', tier: 2, line, elementId: dataId,
        message: `CSS "${key}" (line ${line}) is invisible to the Animation panel. Express the motion with framer-motion: appear/initial for enter animations, variants for states, useScroll/useTransform for scroll.`,
      });
    } else if (key === 'transform' && !isCanonicalTransformString(prop.value)) {
      // Two transform strings are EXEMPT because the builder writes them
      // itself: translate-only (the Position tool's centering pattern) and
      // rotate-only (the Rotation tool's per-node format, paired with
      // transformBox/transformOrigin — live prime-rule find 2026-06-10: a
      // user-rotated canvas-node svg carried transform: 'rotate(185.8deg)').
      v.push({
        code: 'TRANSFORM_STRING', tier: 2, line, elementId: dataId,
        message: `transform strings (line ${line}) collide with layout animation and cannot be edited. Use NUMBER motion props instead: rotate: 30, scale: 1.1, x: 10, y: -8, skewX: 5. (Exceptions — the builder's own formats: translate-only centering, e.g. transform: 'translate(-50%, -50%)' with left/top %; rotate-only, e.g. transform: 'rotate(12deg)' with transformBox/transformOrigin; and folded single-arg motion sequences, e.g. 'translateX(10px) translateY(-8px) rotate(30deg)' as baked by Detach.)`,
      });
    } else if (key === 'display' && styleValueIncludes(prop.value, 'none')) {
      v.push({
        code: 'DISPLAY_TOGGLE_VISIBILITY', tier: 2, line, elementId: dataId,
        message: `display:'none' (line ${line}) — never hide with display. Visibility is conditional rendering inside <AnimatePresence> ({variant !== 'x' && <element/>}), which animates and stays editable.`,
      });
    } else if (t.isConditionalExpression(prop.value)
        && (t.isIdentifier(prop.value.consequent) || t.isIdentifier(prop.value.alternate))) {
      // A variable (prop) buried in a style ternary is unreadable: the panel
      // binds variables only as the WHOLE value (parser tags bare-Identifier
      // style values as var:<prop> → the purple Fill pill); a ternary branch
      // identifier resolves in neither the canvas nor the controls (live find
      // 2026-06-10: activeColor in a per-variant backgroundColor ternary —
      // the default master lost its fill and the Fill row vanished).
      const ident = t.isIdentifier(prop.value.consequent) ? prop.value.consequent.name
        : (prop.value.alternate as t.Identifier).name;
      v.push({
        code: 'VARIABLE_TERNARY_BINDING', tier: 2, line, elementId: dataId,
        message: `${key} (line ${line}) puts the variable '${ident}' inside a ternary — the controls bind variables only as the WHOLE value, so this renders wrong on the canvas and shows no bound pill. Bind it as the full value (${key}: ${ident}). If the value must DIFFER per variant, give it a dedicated conditionally-rendered element (<AnimatePresence>{variant === 'x' && <motion.div … style={{ ${key}: ${ident} }} />}</AnimatePresence>) and vary VISIBILITY instead.`,
      });
    } else if (key === 'alignItems' && (styleValueIncludes(prop.value, 'baseline') || styleValueIncludes(prop.value, 'stretch'))) {
      // The Layout tool's Align control offers ONLY start/center/end — baseline
      // and stretch were removed from the dropdown (2026-06-10), so a file using
      // them shows an unset Align the user can't read or round-trip.
      v.push({
        code: 'FORBIDDEN_ALIGN_VALUE', tier: 2, line, elementId: dataId,
        message: `alignItems: 'baseline'/'stretch' (line ${line}) is not in the Layout tool's Align control — the panel shows it as unset. Use 'flex-start', 'center' or 'flex-end'. For stretch behaviour OMIT alignItems (children with no cross-axis size fill by default); for text rows baseline ≈ 'flex-start'.`,
      });
    }
  }
}

/** true if the value is a bare numeric literal directly or in any ternary branch. */
function containsNumericLiteral(val: t.ObjectProperty['value']): boolean {
  if (t.isNumericLiteral(val)) return true;
  if (t.isUnaryExpression(val) && t.isNumericLiteral(val.argument)) return true; // -5
  if (t.isConditionalExpression(val)) {
    return containsNumericLiteral(val.consequent as t.ObjectProperty['value'])
      || containsNumericLiteral(val.alternate as t.ObjectProperty['value']);
  }
  return false;
}

/** The two builder-written transform strings: the Position tool's centering
 *  translate and the Rotation tool's rotate (with transformBox/Origin). */
function isCanonicalTransformString(val: t.ObjectProperty['value'], insideTernary = false): boolean {
  if (t.isStringLiteral(val)) {
    const s = val.value.trim();
    // Empty = "no transform" — Detach writes transform: '' as a cleared value.
    // STATIC only: a ''/'none' TERNARY BRANCH is a hand-rolled state toggle
    // (hover ? 'translateY(…)' : 'none') and must keep bouncing toward
    // motion props / whileHover.
    if (!insideTernary && (s === '' || s === 'none')) return true;
    if (/^translate[XY]?\([^()]*\)$/.test(s)) return true;
    if (/^rotate\(-?[\d.]+(deg|rad|turn)?\)$/.test(s)) return true;
    // FOLDED MOTION TRANSFORM — the canvas fold's own output
    // (motionPropsToCSSTransform): a sequence of single-argument motion
    // functions IN THE FOLD'S ORDER (perspective → translate → scale →
    // rotate → skew), e.g. 'translateX(-65px) translateY(10px)
    // rotate(238.8deg)'. The DETACH feature bakes exactly this string onto
    // canvas-node copies (live prime-rule find 2026-06-12: a detached
    // variant snapshot bounced every subsequent submit of its file).
    // matrix()/calc()/multi-arg/wrong-order compounds still bounce — only
    // the builder's own grammar is exempt.
    const fns = s.match(/[a-zA-Z]+\([^()]*\)/g) ?? [];
    if (fns.length > 0 && fns.join(' ') === s.replace(/\s+/g, ' ')) {
      const rank = (f: string): number => {
        if (/^perspective\(/.test(f)) return 0;
        if (/^translate[XYZ]?\(/.test(f)) return 1;
        if (/^scale[XY]?\(/.test(f)) return 2;
        if (/^rotate[XYZ]?\(/.test(f)) return 3;
        if (/^skew[XY]\(/.test(f)) return 4;
        return -1;
      };
      let prev = 0;
      for (const f of fns) {
        const r = rank(f);
        if (r < 0 || r < prev) return false;
        if (!/^[a-zA-Z]+\(\s*-?[\d.]+(px|deg|rad|turn|%)?\s*\)$/.test(f)) return false;
        prev = r;
      }
      return true;
    }
    return false;
  }
  if (t.isConditionalExpression(val)) {
    return isCanonicalTransformString(val.consequent as t.ObjectProperty['value'], true)
      && isCanonicalTransformString(val.alternate as t.ObjectProperty['value'], true);
  }
  return false;
}

/** For a min/max width/height value, return the first offending string (a
 *  non-px/% length, a viewport/relative unit, calc() or a keyword) or null when
 *  every branch is a clean px / % / bare-0 length. Recurses ternary branches
 *  (responsive + per-variant values) and ignores '' (a cleared property). */
function badMinMaxSizeUnit(val: t.ObjectProperty['value']): string | null {
  if (t.isStringLiteral(val)) {
    const s = val.value.trim();
    if (s === '' || s === '0') return null;
    if (/^\d*\.?\d+px$/.test(s)) return null;
    if (/^\d*\.?\d+%$/.test(s)) return null;
    return s;
  }
  if (t.isConditionalExpression(val)) {
    return badMinMaxSizeUnit(val.consequent as t.ObjectProperty['value'])
      || badMinMaxSizeUnit(val.alternate as t.ObjectProperty['value']);
  }
  return null;
}

/** For a padding/margin/radius value, return the first offending token (any
 *  non-px length: %, rem/em, viewport units, calc(), keywords) or null when
 *  every whitespace-separated token in every branch is px / bare-0 / '' —
 *  plus 'auto', for margins only (the '0 auto' centering idiom). Recurses
 *  ternary branches (responsive + per-variant values); non-string values
 *  (variable bindings, expressions) are skipped like every value rule here. */
function badSpacingUnit(val: t.ObjectProperty['value'], isMargin: boolean): string | null {
  if (t.isStringLiteral(val)) {
    const s = val.value.trim();
    if (s === '') return null;
    for (const token of s.split(/\s+/)) {
      if (token === '0') continue;
      if (/^-?\d*\.?\d+px$/.test(token)) continue;
      if (isMargin && token === 'auto') continue;
      return token;
    }
    return null;
  }
  if (t.isConditionalExpression(val)) {
    return badSpacingUnit(val.consequent as t.ObjectProperty['value'], isMargin)
      || badSpacingUnit(val.alternate as t.ObjectProperty['value'], isMargin);
  }
  return null;
}

/** true if the value is a percentage string directly or in any ternary branch. */
function styleValueEndsWithPercent(val: t.ObjectProperty['value']): boolean {
  if (t.isStringLiteral(val)) return /^-?[\d.]+%$/.test(val.value.trim());
  if (t.isConditionalExpression(val)) {
    return styleValueEndsWithPercent(val.consequent as t.ObjectProperty['value'])
      || styleValueEndsWithPercent(val.alternate as t.ObjectProperty['value']);
  }
  return false;
}

/** true if the value is 'needle' directly or in any ternary branch. */
function styleValueIncludes(val: t.ObjectProperty['value'], needle: string): boolean {
  if (t.isStringLiteral(val)) return val.value === needle;
  if (t.isConditionalExpression(val)) {
    return styleValueIncludes(val.consequent as t.ObjectProperty['value'], needle)
      || styleValueIncludes(val.alternate as t.ObjectProperty['value'], needle);
  }
  return false;
}

export { checkStyleObject, styleValueIncludes };
