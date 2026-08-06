// oracle/checks/variant-dialect.ts — variant dialect checks (design components).
// All code moved VERBATIM from check-file.ts (Phase 7.1 god-file split).

import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { CONDITIONAL_LAYOUT_PROPS } from '@/shared/constants';
import { parseVariantConfig } from '@/code/variants/variant-config';
import { parseConnections } from '@/code/variants/connection-config';
import { traverse, jsxTagName, jsxAttrs, stringAttr, findSetVariantArg, endsWithVariantFallthrough, isRootCandidate } from './shared';
import type { OracleViolation } from './shared';
import { styleValueIncludes } from './style-object';

// ─── variant dialect (design components) ─────────────────────────────────────
//
// The variant system's two load-bearing laws:
//   1. LAYOUT props that differ per variant are inline style TERNARIES — putting
//      them in a motion variants object runs them on motion's rAF clock AFTER the
//      FLIP snapshot → the layout snaps and shoves siblings (the original
//      hamburger-header catastrophe).
//   2. A variants object needs an entry for EVERY variant — motion has no
//      missing-key fallback; a missing entry = no paint on that artboard and no
//      way to animate back (hamburger stuck as an X).
// Variant names come from the REAL parser (parseVariantConfig), so this check
// can never drift from what the canvas resolves.
/** Whether an `<AnimatePresence>{<expr> && <Child/>}` visibility condition is a
 *  shape the canvas can statically resolve per variant — MIRRORS parser.ts
 *  `parseVisibilityCondition`'s accepted shapes (variant ===/!== 'X', chained
 *  with || / &&, or a boolean literal). A boolean VARIABLE (`const isDesktop =
 *  …`) or any other expression returns null there → no `hiddenOnVariants` → the
 *  child renders on EVERY variant on the canvas. */
function isRecognizedVisibilityExpr(expr: t.Node): boolean {
  if (t.isBooleanLiteral(expr)) return true;
  if (t.isBinaryExpression(expr)
      && (expr.operator === '===' || expr.operator === '!==')
      && t.isIdentifier(expr.left)
      && (expr.left.name === 'variant' || expr.left.name === 'initialVariant')
      && t.isStringLiteral(expr.right)) return true;
  if (t.isLogicalExpression(expr) && (expr.operator === '&&' || expr.operator === '||')) {
    return isRecognizedVisibilityExpr(expr.left) && isRecognizedVisibilityExpr(expr.right);
  }
  return false;
}

/** Read a string-literal style value off a tag's style={{ … }} object. */
function readStyleLiteral(attrs: t.JSXAttribute[], key: string): string | null {
  const styleAttr = attrs.find((a) => a.name.name === 'style');
  if (!styleAttr || !t.isJSXExpressionContainer(styleAttr.value) || !t.isObjectExpression(styleAttr.value.expression)) return null;
  for (const p of styleAttr.value.expression.properties) {
    if (!t.isObjectProperty(p)) continue;
    const k = t.isIdentifier(p.key) ? p.key.name : t.isStringLiteral(p.key) ? p.key.value : null;
    if (k === key && t.isStringLiteral(p.value)) return p.value.value;
  }
  return null;
}

/** Does a gate condition compare the live `variant`/`initialVariant`? */
function mentionsVariant(e: t.Node): boolean {
  if (t.isBinaryExpression(e)) return t.isIdentifier(e.left) && (e.left.name === 'variant' || e.left.name === 'initialVariant');
  if (t.isLogicalExpression(e)) return mentionsVariant(e.left) || mentionsVariant(e.right);
  return false;
}

function checkVariantDialect(code: string, ast: t.File, v: OracleViolation[]): void {
  const variantCfg = parseVariantConfig(code);
  const variantNames = variantCfg.map((vc) => vc.name);
  // Set when a variant gate reveals IN-FLOW content (position relative /
  // unset) — the root must then be the column shell (see the post-traverse
  // VARIANT_REVEAL_ROOT_SHELL check).
  let sawInFlowVariantReveal = false;
  const hasConnections = /\bconst\s+connections\s*=\s*\[/.test(code) && /useState\s*\(\s*initialVariant\s*\)/.test(code);
  const connections = parseConnections(code);

  // PRIMARY_VARIANT_NAME — the canvas hardcodes 'default' as the primary id
  // (Renderer.ts: isPrimary→'default' mapping, map['default'] fallbacks,
  // conditionalText['default']). A primary named anything else half-resolves:
  // missing artboard labels, broken variant fallbacks, dead connection arrows.
  const primary = variantCfg.find((vc) => vc.isPrimary) ?? variantCfg[0];
  if (primary && primary.name !== 'default') {
    v.push({
      code: 'PRIMARY_VARIANT_NAME', tier: 2,
      message: `The PRIMARY variant must be named 'default' (its label can be anything: { name: 'default', label: '${primary.label ?? 'Collapsed'}', … }). The canvas hardcodes 'default' as the primary id — a primary named '${primary.name}' breaks variant resolution, artboard labels and connection arrows. Also keep the prop default: initialVariant = 'default'.`,
    });
  }

  // Collect `const xVariants = { … }` objects + which are referenced by variants={x};
  // detect the ROOT (the element whose style spreads ...style) and per-element shapes.
  const referenced = new Set<string>();
  /** variants-object name → the inline style keys of the element using it. */
  const inlineKeysFor = new Map<string, Set<string>>();
  let rootVariantsName: string | null = null;
  let sawStyleSpread = false;

  // Editor-generated fixed / instance-sized components destructure the `style`
  // prop and re-spread the REST on the root:
  //   const { width: __instW, height: __instH, ...__instStyle } = style ?? {};
  //   <motion.div … style={{ …, ...__instStyle }}>
  // (routes the instance width/height into the variants so the responsive width
  // ternary still wins). That rest identifier IS the forwarded style, so treat it
  // like a literal `...style` spread for ROOT detection — otherwise ROOT_STYLE_SPREAD
  // (and the other root-only checks) false-fire on a perfectly valid fixed header.
  const styleRestNames = new Set<string>();
  const refsStyleParam = (n: t.Node | null | undefined): boolean =>
    !!n && (t.isIdentifier(n, { name: 'style' })
      || (t.isLogicalExpression(n) && (refsStyleParam(n.left) || refsStyleParam(n.right))));
  traverse(ast, {
    VariableDeclarator(p) {
      if (!t.isObjectPattern(p.node.id) || !refsStyleParam(p.node.init)) return;
      for (const prop of p.node.id.properties) {
        if (t.isRestElement(prop) && t.isIdentifier(prop.argument)) styleRestNames.add(prop.argument.name);
      }
    },
  });
  const spreadsStyle = (so: t.ObjectExpression): boolean => so.properties.some(
    (p) => t.isSpreadElement(p) && t.isIdentifier(p.argument)
      && (p.argument.name === 'style' || styleRestNames.has(p.argument.name)),
  );

  // Boolean PROP toggles — destructured component params with a boolean default
  // (`dot1 = true`). These are PER-INSTANCE "Visible: X" toggles, NOT per-variant
  // state, so (a) an <AnimatePresence> gated on one is VALID (exempt from
  // VARIANT_VISIBILITY_CONDITION below) and (b) a BARE {toggle && <el/>} OUTSIDE
  // <AnimatePresence> is the mis-authored form the canvas can't animate
  // (VISIBILITY_NEEDS_ANIMATEPRESENCE). Guard on a style/initialVariant param so
  // helper fns (__applyInstanceSize, effect callbacks) don't leak names.
  const booleanPropNames = new Set<string>();
  traverse(ast, {
    Function(p) {
      const p0 = (p.node.params ?? [])[0];
      if (!t.isObjectPattern(p0)) return;
      const keyNames = p0.properties
        .filter((x): x is t.ObjectProperty => t.isObjectProperty(x) && t.isIdentifier(x.key))
        .map((x) => (x.key as t.Identifier).name);
      if (!keyNames.includes('style') && !keyNames.includes('initialVariant')) return;
      for (const prop of p0.properties) {
        if (t.isObjectProperty(prop) && t.isIdentifier(prop.key)
            && t.isAssignmentPattern(prop.value) && t.isBooleanLiteral(prop.value.right)) {
          booleanPropNames.add(prop.key.name);
        }
      }
    },
  });

  // @propMeta IMAGE-typed variable names — for IMAGE_VARIABLE_URL_WRAPPED below. An
  // image VARIABLE must bind as the WHOLE backgroundImage value so the panel shows
  // the "Pick image" control; the url-wrapped `url(${x})` form is CMS-field-only.
  const imagePropNames = new Set<string>();
  const pmMatch = code.match(/@propMeta\s+(\{[\s\S]*\})\s*\*\//);
  if (pmMatch) {
    try {
      const pm = JSON.parse(pmMatch[1]) as Record<string, { type?: string }>;
      for (const [k, meta] of Object.entries(pm)) if (meta?.type === 'image') imagePropNames.add(k);
    } catch { /* malformed @propMeta — skip (a separate check owns that) */ }
  }

  traverse(ast, {
    JSXElement(path: NodePath<t.JSXElement>) {
      const attrs = jsxAttrs(path.node.openingElement);
      const dataId = stringAttr(attrs, 'data-id');
      const line = path.node.openingElement.loc?.start.line;

      // DUPLICATE_JSX_ATTR — React keeps only the LAST duplicate; the parser
      // and generators assume one attr per name (live case: two `initial`
      // props, one silently dead).
      const seenAttrs = new Set<string>();
      for (const a of attrs) {
        const n = String(a.name.name);
        if (seenAttrs.has(n)) {
          v.push({
            code: 'DUPLICATE_JSX_ATTR', tier: 2, line, elementId: dataId,
            message: `<${dataId ?? 'element'}> declares "${n}" twice (line ${line}) — React silently keeps only the last one and the editor's parsers assume one per name. Merge them into a single ${n} attribute.`,
          });
        }
        seenAttrs.add(n);
      }

      // CONNECTION TRIGGER dialect — handlers that drive the variant machine
      // must be the gated parameterless form, and every one must be DECLARED
      // in the connections array (the canvas draws arrows from that data; a
      // rogue handler is invisible to the connections UI and double-fires).
      const onTapAttr = attrs.find((a) => a.name.name === 'onTap');
      if (onTapAttr && t.isJSXExpressionContainer(onTapAttr.value)
        && (t.isArrowFunctionExpression(onTapAttr.value.expression) || t.isFunctionExpression(onTapAttr.value.expression))) {
        const fn = onTapAttr.value.expression;
        const body = code.slice(fn.start ?? 0, fn.end ?? 0);
        if (body.includes('setVariant')) {
          if (fn.params.length > 0 || body.includes('stopPropagation')) {
            v.push({
              code: 'CONNECTION_HANDLER_SHAPE', tier: 2, line, elementId: dataId,
              message: `The variant trigger on <${dataId ?? 'element'}> (line ${line}) must be the gated parameterless form: onTap={() => { const _n = variant === 'a' ? 'b' : null; if (_n) setVariant(_n); }} — no event parameter, no stopPropagation. The no-match branch must NOT call setVariant (taps bubble; an ancestor's no-op set reverts a child's transition in the same React batch). The connections editor regenerates handlers in exactly this shape.`,
            });
          }
          // The gated chain must END with the `variant` fallthrough — an
          // unconditional else grants transitions no connection declares
          // (e.g. menu→menu jumps the arrows don't show), and the connections
          // editor regenerates handlers in the fallthrough form anyway.
          // CONVERGENCE: the message carries the EXACT handler computed from
          // this element's declared connections — copy-paste fixable (abstract
          // pattern messages failed to converge live, 2026-06-10).
          const isRootEl = isRootCandidate(attrs);
          const setVariantArg = findSetVariantArg(fn);
          if (setVariantArg && !endsWithVariantFallthrough(setVariantArg)) {
            const mine = connections.filter((c) => c.sourceNode === dataId || (!c.sourceNode && isRootEl));
            const exact = mine.length
              ? `onTap={() => { const _n = ${mine.map((c) => `variant === '${c.from}' ? '${c.to}'`).join(' : ')} : null; if (_n) setVariant(_n); }}`
              : `onTap={() => { const _n = variant === '<from>' ? '<to>' : null; if (_n) setVariant(_n); }}`;
            v.push({
              code: 'CONNECTION_HANDLER_FALLTHROUGH', tier: 2, line, elementId: dataId,
              message: `The setVariant chain on <${dataId ?? 'element'}> (line ${line}) must not transition for undeclared states — use the guarded form whose no-match branch is null and skips setVariant entirely (an unconditional else grants transitions no connection declares, and a bare setVariant(variant) no-op reverts bubbled child transitions). Replace the handler with EXACTLY this, derived from its declared connections: ${exact}`,
            });
          }
          const declared = connections.some((c) => c.sourceNode === dataId)
            || (isRootEl && connections.some((c) => !c.sourceNode));
          if (!declared) {
            v.push({
              code: 'ONTAP_WITHOUT_CONNECTION', tier: 2, line, elementId: dataId,
              message: `<${dataId ?? 'element'}> calls setVariant but no connection declares it (line ${line}). The connections array is the source of truth — the canvas draws the arrows from it. Either add { from, to, trigger: 'click', sourceNode: '${dataId}' } to connections, or remove this handler (one trigger per transition; don't duplicate the toggle on the root AND a button).`,
            });
          }
        }
      }

      const variantsAttr = attrs.find((a) => a.name.name === 'variants');
      const variantsName = variantsAttr && t.isJSXExpressionContainer(variantsAttr.value) && t.isIdentifier(variantsAttr.value.expression)
        ? variantsAttr.value.expression.name : null;
      if (variantsName) referenced.add(variantsName);

      const styleAttr = attrs.find((a) => a.name.name === 'style');
      const styleObj = styleAttr && t.isJSXExpressionContainer(styleAttr.value) && t.isObjectExpression(styleAttr.value.expression)
        ? styleAttr.value.expression : null;
      if (variantsName && styleObj) {
        const keys = new Set<string>();
        for (const p of styleObj.properties) {
          if (t.isObjectProperty(p) && t.isIdentifier(p.key)) keys.add(p.key.name);
          else if (t.isObjectProperty(p) && t.isStringLiteral(p.key)) keys.add(p.key.value);
        }
        inlineKeysFor.set(variantsName, keys);
      }
      const isRoot = !!styleObj && spreadsStyle(styleObj);
      if (isRoot) {
        sawStyleSpread = true;
        if (variantsName) rootVariantsName = variantsName;

        // COMPONENT_ROOT_POSITION — the canvas owns master placement; a fixed/
        // sticky/relative root re-anchors the artboard (the live "position:
        // fixed header" failure). 'absolute' (drawn components) or absent
        // (compiled components — canvas injects via ...style) are the dialect.
        const posProp = styleObj.properties.find((p): p is t.ObjectProperty => t.isObjectProperty(p) && t.isIdentifier(p.key, { name: 'position' }));
        if (posProp && !styleValueIncludes(posProp.value, 'absolute')) {
          v.push({
            code: 'COMPONENT_ROOT_POSITION', tier: 2, line: posProp.loc?.start.line, elementId: dataId,
            message: `The component ROOT must not be position fixed/sticky/relative — the canvas owns master placement (variantConfig x/y + the ...style spread). Use position: 'absolute' with explicit px width/height, or omit position entirely. For a "sticks to the top of the page" header, the PAGE places the instance — the component itself stays canvas-positioned.`,
          });
        }

        // COMPONENT_ROOT_OFFSET — the master's canvas position is owned by
        // variantConfig (x/y); inset props (left/top/right/bottom) must NEVER be
        // in the root's INLINE style. Because `...style` is spread last, an inset
        // on the root LEAKS through onto every PAGE instance — which renders
        // position:relative — shifting each instance by the master's canvas
        // coordinates (the live "every advisor card offset by -73px/-69px" bug;
        // an editor move/resize had written left/top onto the root inline style).
        const insetKey = (p: t.ObjectProperty): string | null => {
          const k = t.isIdentifier(p.key) ? p.key.name : t.isStringLiteral(p.key) ? p.key.value : null;
          return k && (k === 'left' || k === 'top' || k === 'right' || k === 'bottom') ? k : null;
        };
        // ZERO is exempt: the leak this rule guards is the master's canvas
        // COORDINATES riding onto instances, and `left: '0px'` shifts nothing on
        // a position:relative instance. The builder writes 0/0 on a root placed
        // at the artboard origin, so flagging it asks the user to fix a no-op.
        const isZeroInset = (p: t.ObjectProperty): boolean => {
          if (t.isStringLiteral(p.value)) return /^-?0(px|%|em|rem)?$/.test(p.value.value.trim());
          if (t.isNumericLiteral(p.value)) return p.value.value === 0;
          return false;
        };
        const insetProp = styleObj.properties.find((p): p is t.ObjectProperty =>
          t.isObjectProperty(p) && insetKey(p) !== null && !isZeroInset(p));
        if (insetProp) {
          const k = insetKey(insetProp);
          v.push({
            code: 'COMPONENT_ROOT_OFFSET', tier: 2, line: insetProp.loc?.start.line, elementId: dataId,
            message: `The component ROOT has "${k}" in its inline style — inset props (left/top/right/bottom) on a master root LEAK through the ...style spread onto every page instance (which is position:relative), shifting each instance by the master's canvas coordinates (the "all the cards are offset by the same amount" bug). The master's canvas position is owned by variantConfig (x/y) ONLY — remove left/top/right/bottom from the root style entirely (the root keeps position:absolute + width/height; the PAGE positions the instance).`,
          });
        }

        // COMPONENT_ROOT_PERCENT_SIZE — a master/artboard root has NO parent
        // box, so a percentage (or other parent-relative unit) width/height is
        // meaningless on the canvas; the root can ONLY be a fixed px value or
        // 'auto' (or a px/auto variant-size ternary). The PAGE INSTANCE stays
        // fluid by overriding size through the ...style spread, where % is valid.
        const badRootDim = (val: t.Expression | t.PatternLike | null | undefined): string | null => {
          if (!val) return null;
          // `min-content`/`max-content`/`fit-content` size from CONTENT, not from a
          // parent box — they resolve perfectly on a parentless artboard root, and
          // `min-content` is exactly what the Size tool's FIT control writes. Only
          // PARENT-relative units (%, vw/vh are viewport but still not the box) are
          // meaningless here.
          if (t.isStringLiteral(val)) {
            const ok = /^-?\d+(\.\d+)?px$/.test(val.value)
              || val.value === 'auto'
              || /^(min|max|fit)-content$/.test(val.value);
            return ok ? null : val.value;
          }
          if (t.isConditionalExpression(val)) return badRootDim(val.consequent) ?? badRootDim(val.alternate);
          return null; // numeric (= px) / identifier / computed — can't statically flag
        };
        for (const dim of ['width', 'height'] as const) {
          const dprop = styleObj.properties.find((p): p is t.ObjectProperty => t.isObjectProperty(p) && ((t.isIdentifier(p.key) && p.key.name === dim) || (t.isStringLiteral(p.key) && p.key.value === dim)));
          const bad = dprop ? badRootDim(dprop.value) : null;
          if (bad != null) {
            v.push({
              code: 'COMPONENT_ROOT_PERCENT_SIZE', tier: 2, line: dprop?.loc?.start.line, elementId: dataId,
              message: `The component ROOT's ${dim} is "${bad}" — a master/artboard root has NO parent box, so "%" (or any parent-relative unit) is invalid; the root can ONLY be a fixed px value or "auto". Set ${dim} to e.g. '1280px' or 'auto'. To make the PAGE instance fluid, override size on the INSTANCE via the ...style spread — e.g. <NavHeader style={{ ${dim}: '100%' }} /> on the page — never on the master root.`,
            });
          }
        }

        // COMPONENT_ROOT_ASPECT_RATIO — the root's size must be plain px /
        // 'auto' width+height ONLY. An `aspectRatio` on a top-level variant root
        // LOCKS the dimensions in the builder's Dimensions panel (W/H become a
        // linked pair) and the canvas variant-size resolver doesn't honour it →
        // the artboard mis-sizes. (Live find: a square Advisor card built with
        // aspectRatio:'1/1' showed a locked 440×440 that wouldn't resolve.)
        // aspect-ratio is fine on INNER elements — just never the root.
        const arProp = styleObj.properties.find((p): p is t.ObjectProperty => t.isObjectProperty(p) && ((t.isIdentifier(p.key) && p.key.name === 'aspectRatio') || (t.isStringLiteral(p.key) && p.key.value === 'aspectRatio')));
        if (arProp) {
          v.push({
            code: 'COMPONENT_ROOT_ASPECT_RATIO', tier: 2, line: arProp.loc?.start.line, elementId: dataId,
            message: `The component ROOT has an "aspectRatio" — a top-level variant root cannot carry a locked aspect ratio; the builder's Dimensions panel can't resolve it and the artboard mis-sizes (it shows a locked W/H pair). Remove aspectRatio and give the root an explicit px (or 'auto') width AND height instead, e.g. width: '600px', height: '600px'. For a square card that fills its column on the page, the PAGE INSTANCE overrides width via the ...style spread (style={{ width: '100%' }}) while the master root keeps a fixed px size. aspectRatio is fine on INNER elements — just not the root.`,
          });
        }
      }

      // PER-TAG ANIMATE — connection codegen injects animate={variant} on EVERY
      // element with variants= (propagation is unreliable here). A varianted
      // element without it is frozen: it never reacts to variant switches.
      if (variantsName && hasConnections) {
        const hasAnimate = attrs.some((a) => a.name.name === 'animate');
        if (!hasAnimate) {
          v.push({
            code: 'MISSING_ANIMATE_ON_VARIANTS', tier: 2, line, elementId: dataId,
            message: `<${dataId ?? 'element'}> has variants={${variantsName}} but no animate (line ${line}) — it will NEVER react to variant switches. Every element with variants needs animate={['default', variant]} and initial={['default', initialVariant]} on the same tag (the list form merges the default entry under the variant — sparse-entry inheritance).`,
          });
        }
      }

      // ANIMATEPRESENCE_KEY — conditionally-rendered elements need a key or
      // AnimatePresence cannot track mount/unmount.
      if (jsxTagName(path.node.openingElement.name) === 'AnimatePresence') {
        // ANIMATEPRESENCE_POPLAYOUT_MODE — without mode="popLayout" the exiting
        // element keeps occupying layout space for its whole exit animation, so
        // siblings jump only AFTER it finishes (the header open/close "big
        // jumps", live find 2026-07-30). Overlay children are exempt (they
        // float and displace nothing).
        const apHasGatedChild = path.node.children.some((c) =>
          t.isJSXExpressionContainer(c) && t.isLogicalExpression(c.expression)
          && t.isJSXElement(c.expression.right)
          && !jsxAttrs((c.expression.right as t.JSXElement).openingElement).some((a) => a.name.name === 'data-overlay'));
        if (apHasGatedChild && stringAttr(jsxAttrs(path.node.openingElement), 'mode') !== 'popLayout') {
          v.push({
            code: 'ANIMATEPRESENCE_POPLAYOUT_MODE', tier: 2, line: path.node.openingElement.loc?.start.line,
            message: `<AnimatePresence> (line ${path.node.openingElement.loc?.start.line}) gates in-flow content but has no mode="popLayout" — the exiting element holds its layout slot until the exit animation ends, so siblings snap instead of reflowing. Write <AnimatePresence mode="popLayout"> (its children need key + layout={true}).`,
          });
        }
        for (const child of path.node.children) {
          if (!t.isJSXExpressionContainer(child) || !t.isLogicalExpression(child.expression)) continue;
          const el = child.expression.right;
          if (!t.isJSXElement(el)) continue;
          const elAttrs = jsxAttrs(el.openingElement);
          if (!elAttrs.some((a) => a.name.name === 'key')) {
            v.push({
              code: 'ANIMATEPRESENCE_KEY', tier: 2, line: el.openingElement.loc?.start.line,
              elementId: stringAttr(elAttrs, 'data-id'),
              message: `The conditionally-rendered element inside <AnimatePresence> (line ${el.openingElement.loc?.start.line}) needs key="<its data-id>" — without it AnimatePresence cannot track the mount/unmount and the show/hide snaps.`,
            });
          }

          const isOverlayChild = elAttrs.some((a) => a.name.name === 'data-overlay');
          const isVariantGate = child.expression.operator === '&&' && mentionsVariant(child.expression.left);

          // ANIMATEPRESENCE_CHILD_LAYOUT — a gated child without `layout` can't
          // FLIP its siblings when it mounts/unmounts: the reveal pops and the
          // row/column snaps into place (the header distortion, 2026-07-30).
          if (!isOverlayChild && !elAttrs.some((a) => a.name.name === 'layout')) {
            v.push({
              code: 'ANIMATEPRESENCE_CHILD_LAYOUT', tier: 2, line: el.openingElement.loc?.start.line,
              elementId: stringAttr(elAttrs, 'data-id'),
              message: `The conditionally-rendered <${stringAttr(elAttrs, 'data-id') ?? 'element'}> inside <AnimatePresence> (line ${el.openingElement.loc?.start.line}) has no layout={true} — its siblings snap instead of animating when it mounts/unmounts. Add layout={true} next to its key.`,
            });
          }

          // Track in-flow variant reveals for the root column-shell check below.
          if (!isOverlayChild && isVariantGate) {
            const pos = readStyleLiteral(elAttrs, 'position');
            if (pos !== 'absolute' && pos !== 'fixed') sawInFlowVariantReveal = true;
          }

          // VARIANT_VISIBILITY_CONDITION — a per-variant show/hide wrapper must
          // gate on a condition the canvas can statically resolve. parser.ts's
          // parseVisibilityCondition only understands inline `variant ===/!== 'X'`
          // (chained with || / &&); anything else (a boolean VARIABLE like
          // `const isDesktop = variant === 'a' || …`, a `.includes()` call, etc.)
          // returns null → no `hiddenOnVariants` → the element renders on EVERY
          // variant (the live "nav links + hamburger show on all variants" bug).
          // Overlays legitimately gate on a useState boolean, so skip data-overlay
          // children; a boolean PROP TOGGLE (dot1) is a per-INSTANCE Visible toggle,
          // NOT per-variant, so it's legitimately AnimatePresence-gated too — skip it
          // (the mis-authored bare form is caught by VISIBILITY_NEEDS_ANIMATEPRESENCE).
          // Only fires on multi-variant components.
          if (variantNames.length > 1
              && child.expression.operator === '&&'
              && !elAttrs.some((a) => a.name.name === 'data-overlay')
              && !(t.isIdentifier(child.expression.left) && booleanPropNames.has(child.expression.left.name))
              && !isRecognizedVisibilityExpr(child.expression.left)) {
            const vLine = el.openingElement.loc?.start.line;
            v.push({
              code: 'VARIANT_VISIBILITY_CONDITION', tier: 2, line: vLine,
              elementId: stringAttr(elAttrs, 'data-id'),
              message: `The <AnimatePresence> show/hide condition for <${stringAttr(elAttrs, 'data-id') ?? 'element'}> (line ${vLine}) isn't a form the canvas can resolve per variant, so the element renders on EVERY variant. Gate it on an INLINE variant comparison — never a boolean variable or other expression: variant === 'x', variant === 'a' || variant === 'b', or variant !== 'a' && variant !== 'b'. e.g. {(variant === 'default' || variant === 'default-scrolled') && <…/>}.`,
            });
          }
        }
      }
    },
  });

  // VARIANT_REVEAL_ROOT_SHELL — when a variant reveals IN-FLOW stacked content
  // (menu panel, accordion body), the ROOT must be the column shell: height
  // 'auto' (a fixed px height clips the revealed content or forces it absolute
  // — the pop-in anti-pattern) and layout={true} (the root's layout spring is
  // what animates the height expansion and pushes page content down smoothly).
  if (sawInFlowVariantReveal) {
    let done = false;
    traverse(ast, {
      JSXElement(path: NodePath<t.JSXElement>) {
        if (done) return;
        const attrs = jsxAttrs(path.node.openingElement);
        if (!isRootCandidate(attrs)) return;
        done = true;
        const line = path.node.openingElement.loc?.start.line;
        const heightVal = readStyleLiteral(attrs, 'height');
        const problems: string[] = [];
        if (heightVal && /^\d+(?:\.\d+)?px$/.test(heightVal)) {
          problems.push(`its height is fixed (${heightVal}) — the revealed content gets clipped (overflow hidden) or must go absolute and pop over the page; use height: 'auto' so the root hugs its children`);
        }
        if (!attrs.some((a) => a.name.name === 'layout')) {
          problems.push(`it has no layout={true} — the layout spring on the root is what animates the height expansion instead of snapping`);
        }
        if (problems.length > 0) {
          v.push({
            code: 'VARIANT_REVEAL_ROOT_SHELL', tier: 2, line,
            elementId: stringAttr(attrs, 'data-id'),
            message: `A variant reveals in-flow stacked content, so the ROOT (line ${line}) must be the column shell, but ${problems.join('; and ')}. The smooth shape: root = flexDirection 'column', height 'auto', overflow 'hidden', layout={true}, with the fixed-height bar at order '0' and the revealed panel at order '1' (position 'relative', inside <AnimatePresence mode="popLayout"> with key, layout and enter/exit).`,
          });
        }
        path.stop();
      },
    });
  }

  // VISIBILITY_NEEDS_ANIMATEPRESENCE — a boolean "Visible" toggle prop gating a
  // designed element (`{dot1 && <motion.div data-id=…/>}`) MUST be conditionally
  // rendered INSIDE <AnimatePresence mode="popLayout"> (child with key + layout) so
  // the show/hide animates and its flex siblings reflow via the layout FLIP. A BARE
  // conditional render pops the element in/out and snaps the row. Only fires for a
  // destructured boolean PROP identifier → pagination (`x < y.length`), overlays
  // (useState booleans) and list `.map()`s are naturally exempt (not prop toggles).
  if (booleanPropNames.size > 0) {
    traverse(ast, {
      LogicalExpression(path: NodePath<t.LogicalExpression>) {
        if (path.node.operator !== '&&') return;
        if (!t.isIdentifier(path.node.left) || !booleanPropNames.has(path.node.left.name)) return;
        const el = path.node.right;
        if (!t.isJSXElement(el)) return;
        const elAttrs = jsxAttrs(el.openingElement);
        const did = stringAttr(elAttrs, 'data-id');
        if (!did) return;
        const inAP = path.findParent((pp) =>
          t.isJSXElement(pp.node) && jsxTagName(pp.node.openingElement.name) === 'AnimatePresence');
        if (inAP) return;
        const line = el.openingElement.loc?.start.line;
        v.push({
          code: 'VISIBILITY_NEEDS_ANIMATEPRESENCE', tier: 2, line, elementId: did,
          message: `<${did}> (line ${line}) is shown/hidden by the boolean toggle {${path.node.left.name} && …} but is NOT wrapped in <AnimatePresence>. A "Visible" toggle must be conditionally rendered INSIDE <AnimatePresence mode="popLayout"> — the child needs key="${did}" + layout={true} — so the show/hide animates and its siblings reflow: <AnimatePresence mode="popLayout">{${path.node.left.name} && <… data-id="${did}" key="${did}" layout={true} …/>}</AnimatePresence>. (A display:'none' toggle is also rejected — DISPLAY_TOGGLE_VISIBILITY.)`,
        });
      },
    });
  }

  // IMAGE_VARIABLE_URL_WRAPPED — an @propMeta "image" VARIABLE (a prop) must bind
  // as the WHOLE backgroundImage value: `backgroundImage: image1` (the picker
  // stores the full `url(...)`; default the prop to '' or "url('https://…')").
  // TWO authored wrappings reach here and both break, differently:
  //
  //   `url(${image1})`        TemplateLiteral — the parser reads a `urlvar:`
  //                           binding, not the whole-value `var:` an image
  //                           control needs, so the panel shows a plain TEXT
  //                           field instead of "Pick image".
  //   'url(' + image1 + ')'   BinaryExpression — WORSE. The canvas renders from
  //                           PARSED source, it does not execute the component,
  //                           so a computed style value resolves to nothing and
  //                           the element renders with no image at all. The
  //                           template-literal-only check used to miss this
  //                           (live case: WorkCard, 2026-08-01 — four cards
  //                           rendered blank and the panel showed no Image
  //                           control, with a clean oracle pass).
  //
  // The wrapped `url(${x})` form is CORRECT ONLY for a CMS FIELD —
  // `url(${item.image})`, a MemberExpression — so an image PROP is the
  // mis-authored case either way.
  if (imagePropNames.size > 0) {
    // → the image-prop name this value url-wraps, or null if it is not a wrap.
    const urlWrappedImageProp = (val: t.Node): string | null => {
      if (t.isTemplateLiteral(val)) {
        if (val.expressions.length !== 1) return null;
        const ex = val.expressions[0];
        if (!t.isIdentifier(ex) || !imagePropNames.has(ex.name)) return null;
        const raw = (val.quasis[0]?.value?.raw ?? '').trimStart().toLowerCase();
        return raw.startsWith('url(') ? ex.name : null;
      }
      if (t.isBinaryExpression(val)) {
        // Flatten the `+` chain: 'url(' + x + ')' nests to the LEFT, so the
        // leading quote is the deepest node rather than val.left.
        const parts: t.Node[] = [];
        const flatten = (n: t.Node): boolean => {
          if (t.isBinaryExpression(n)) {
            if (n.operator !== '+') return false;
            return flatten(n.left) && flatten(n.right);
          }
          parts.push(n);
          return true;
        };
        if (!flatten(val)) return null;
        const named = parts.filter(
          (p): p is t.Identifier => t.isIdentifier(p) && imagePropNames.has(p.name));
        if (named.length !== 1) return null;
        const lead = t.isStringLiteral(parts[0]) ? parts[0].value.trimStart().toLowerCase() : '';
        return lead.startsWith('url(') ? named[0].name : null;
      }
      return null;
    };

    traverse(ast, {
      ObjectProperty(path: NodePath<t.ObjectProperty>) {
        const key = t.isIdentifier(path.node.key) ? path.node.key.name
          : t.isStringLiteral(path.node.key) ? path.node.key.value : null;
        if (key !== 'backgroundImage') return;
        const name = urlWrappedImageProp(path.node.value);
        if (!name) return;
        const line = path.node.loc?.start.line;
        v.push({
          code: 'IMAGE_VARIABLE_URL_WRAPPED', tier: 2, line,
          message: `The image variable '${name}' (line ${line}) is url-wrapped. An @propMeta "image" variable must bind as the WHOLE value — backgroundImage: ${name} — and carry the wrapper in its DEFAULT instead: ${name} = "url('https://…')". Wrapped at the binding it breaks: \`url(\${${name}})\` shows a plain TEXT field rather than the "Pick image" control, and 'url(' + ${name} + ')' is a computed expression the canvas cannot resolve, so the element renders with NO image. The wrapped url(\${x}) form is ONLY for a CMS field — url(\${item.image}).`,
        });
      },
    });
  }

  if (!sawStyleSpread) {
    v.push({
      code: 'ROOT_STYLE_SPREAD', tier: 2,
      message: `No element spreads ...style — the component root's style object must end with ...style so instances and the canvas can override it: style={{ …, ...style }}.`,
    });
  }

  traverse(ast, {
    VariableDeclarator(path: NodePath<t.VariableDeclarator>) {
      if (!t.isIdentifier(path.node.id) || !referenced.has(path.node.id.name)) return;
      if (!t.isObjectExpression(path.node.init)) return;
      const objName = path.node.id.name;
      const line = path.node.loc?.start.line;
      const entryNames = new Set<string>();

      for (const entry of path.node.init.properties) {
        if (!t.isObjectProperty(entry)) continue;
        const entryName = t.isIdentifier(entry.key) ? entry.key.name : t.isStringLiteral(entry.key) ? entry.key.value : null;
        if (!entryName) continue;
        if (entryNames.has(entryName)) {
          v.push({
            code: 'DUP_DEFAULT_KEY', tier: 2, line,
            message: `${objName} declares the entry "${entryName}" twice (e.g. both default: and 'default':) — JavaScript keeps only one; the other's values are silently lost. Merge them into a single entry.`,
          });
        }
        entryNames.add(entryName);

        // law 1 — layout props don't belong in variants objects. left/top ARE
        // legal in CHILD variant objects (positions tween) but never the ROOT's
        // (the canvas owns master placement via variantConfig x/y).
        if (t.isObjectExpression(entry.value)) {
          for (const p of entry.value.properties) {
            if (!t.isObjectProperty(p) || !t.isIdentifier(p.key)) continue;
            if (CONDITIONAL_LAYOUT_PROPS.has(p.key.name)) {
              v.push({
                code: 'LAYOUT_PROP_IN_VARIANT_OBJECT', tier: 2, line: p.loc?.start.line,
                message: `${objName}.${entryName}.${p.key.name} (line ${p.loc?.start.line}) — layout props (${p.key.name}) must NOT live in a variants object: motion applies them after the FLIP snapshot, so the layout snaps and shoves siblings. Write it as an inline style ternary instead: style={{ ${p.key.name}: variant === '${entryName}' ? <value> : <base> }}.`,
              });
            }
            if (objName === rootVariantsName && ['left', 'top', 'position'].includes(p.key.name)) {
              v.push({
                code: 'ROOT_CANVAS_PROP_IN_VARIANTS', tier: 2, line: p.loc?.start.line,
                message: `${objName}.${entryName}.${p.key.name} — the ROOT's variant entries must never carry left/top/position: master placement per variant lives in variantConfig (x/y), and the canvas strips these. (Child variant objects MAY tween left/top.)`,
              });
            }
          }
        }
      }

      // law 0 — default-entry values live at the panel's address. The builder
      // writes default-state values to the INLINE style (where every control
      // reads) and merely MIRRORS them in the default entry for animate-back.
      // An AI that puts them ONLY in the default entry renders identical pixels
      // but the panel shows nothing (live find 2026-06-10: bloom-menu cards
      // "hidden" via default:{opacity:0,scale:0} — invisible to the controls).
      // Transforms in the default entry: NEUTRAL values (0 / scale 1) are the
      // canonical reset (CeRoKa: default { rotate: 0 }) and always fine. A
      // NON-neutral default transform is the same address bug as opacity —
      // Scale/Rotate controls read the inline style (UnifiedControlProvider →
      // nodeStyles), so a petal at default:{scale:0.2} renders tiny while the
      // panel shows 1 (live find 2026-06-10: FlowerPetalCard). Rest-state
      // scale/rotate must be mirrored inline; rest-state x/y are not allowed
      // at all (rest position = left/top, where the Position tool reads).
      // Mirrors generator-styles' MOTION_TRANSFORM_NEUTRAL — every prop the
      // builder seeds into the `default` entry as an animate-back value. Missing
      // `transformPerspective` here meant the builder's OWN seed (a neutral 0)
      // was reported as a value the panel can't see, on a component built
      // entirely in the editor (user report 2026-07-26).
      const MOTION_ONLY = new Set(['rotate', 'rotateX', 'rotateY', 'rotateZ', 'scale', 'scaleX', 'scaleY', 'skewX', 'skewY', 'x', 'y', 'z', 'transformPerspective']);
      const defaultEntry = path.node.init.properties.find((p): p is t.ObjectProperty =>
        t.isObjectProperty(p) && ((t.isIdentifier(p.key, { name: 'default' })) || (t.isStringLiteral(p.key) && p.key.value === 'default')));
      if (defaultEntry && t.isObjectExpression(defaultEntry.value)) {
        const inline = inlineKeysFor.get(objName) ?? new Set<string>();
        const missing: string[] = [];
        for (const p of defaultEntry.value.properties) {
          if (!t.isObjectProperty(p) || !t.isIdentifier(p.key)) continue;
          const k = p.key.name;
          if (MOTION_ONLY.has(k)) {
            const neutral = (k === 'scale' || k === 'scaleX' || k === 'scaleY') ? 1 : 0;
            const num = t.isNumericLiteral(p.value) ? p.value.value
              : (t.isUnaryExpression(p.value, { operator: '-' }) && t.isNumericLiteral(p.value.argument)) ? -p.value.argument.value
              : null;
            if (num === null || num === neutral) continue;
            if (k === 'x' || k === 'y' || k === 'z') {
              v.push({
                code: 'DEFAULT_TRANSFORM_NOT_IN_BASE', tier: 2, line: p.loc?.start.line,
                message: `${objName}.default sets ${k}: ${num} — a rest-state offset is NOT a transform. Position the element with left/top in the inline style (the Position tool reads those) and keep ${k}: 0 in the default entry; move it in the OTHER variants' entries instead.`,
              });
            } else if (!inline.has(k)) {
              v.push({
                code: 'DEFAULT_TRANSFORM_NOT_IN_BASE', tier: 2, line: p.loc?.start.line,
                message: `${objName}.default sets ${k}: ${num} but the inline style doesn't — the panel's ${k} control reads the INLINE style, so the element renders transformed while the control shows the default. Write it inline too (style={{ …, ${k}: ${num} }}); the default entry only mirrors it for animate-back.`,
              });
            }
            continue;
          }
          if (!inline.has(k)) missing.push(k);
        }
        if (missing.length > 0) {
          v.push({
            code: 'DEFAULT_VALUE_NOT_IN_BASE', tier: 2, line,
            message: `${objName}.default sets ${missing.join(', ')} but the element's inline style doesn't — the properties panel reads the INLINE style, so these default-state values are invisible to the controls. Write them in the inline style too (the default entry only mirrors them for animate-back). E.g. for a hidden-at-rest element: style={{ …, opacity: 0 }} AND default: { opacity: 0, scale: 0 }.`,
          });
        }
      }

      // law 2 — TRANSFORM props need a return path. Builder-written variant
      // objects legitimately omit entries (inline style carries the base, the
      // canvas resolves diffs) — but motion keeps an ANIMATED transform at its
      // last value when switching to a variant with no entry: a rotate/scale/x/y
      // set somewhere must have an entry in EVERY variant or the element sticks
      // (the hamburger-frozen-as-X bug). Paint omissions are fine.
      const TRANSFORM_KEYS = ['rotate', 'rotateX', 'rotateY', 'rotateZ', 'scale', 'scaleX', 'scaleY', 'skewX', 'skewY', 'x', 'y', 'z'];
      const usesTransforms = path.node.init.properties.some((entry) =>
        t.isObjectProperty(entry) && t.isObjectExpression(entry.value)
        && entry.value.properties.some((p) => t.isObjectProperty(p) && t.isIdentifier(p.key) && TRANSFORM_KEYS.includes(p.key.name)));
      if (usesTransforms) {
        const missing = variantNames.filter((n) => n !== 'default' && !entryNames.has(n));
        if (missing.length > 0 && variantNames.length > 1) {
          v.push({
            code: 'VARIANT_OBJECT_MISSING_ENTRY', tier: 2, line,
            message: `${objName} (line ${line}) animates a transform (rotate/scale/x/y) but has no entry for variant${missing.length > 1 ? 's' : ''} ${missing.map((m) => `'${m}'`).join(', ')} — motion keeps the LAST animated transform when switching to a variant with no entry, so the element sticks mid-state. Add an entry with the neutral values (rotate: 0, scale: 1, x: 0, y: 0) for every variant the transform should reset in.`,
          });
        }
      }
    },
  });
}

/**
 * VARIANT_TERNARY_TESTS_PRIMARY — the canvas maps a variant ternary's FINAL
 * `else` branch to the PRIMARY variant (parser walkVariant*: the trailing
 * alternate → the primary). So testing `variant === '<primary>'` in a ternary
 * VALUE puts the primary's value in a dead consequent — the else also claims
 * the primary and overwrites it, so the primary resolves to the ELSE value
 * (the "desktop variant shows the 390px mobile width" bug). Condition only on
 * NON-primary variant names and leave the primary's value as the trailing else.
 * Conditional RENDERS `{variant === 'x' && …}` are LogicalExpressions, NOT
 * ternaries — those are correct and never flagged here.
 */
function checkVariantTernaryPrimary(code: string, ast: t.File, v: OracleViolation[]): void {
  const m = code.match(/name:\s*'([^']+)'[^}]*isPrimary:\s*true/);
  const primary = m ? m[1] : 'default';
  const seen = new Set<number>();
  traverse(ast, {
    ConditionalExpression(path) {
      const test = path.node.test;
      if (!t.isBinaryExpression(test) || test.operator !== '===') return;
      if (!t.isIdentifier(test.left) || (test.left.name !== 'variant' && test.left.name !== 'initialVariant')) return;
      if (!t.isStringLiteral(test.right) || test.right.value !== primary) return;
      // ONLY a STYLE-object value ternary resolves per-variant on the canvas
      // (where the else→primary collision bites). Climb out of any enclosing
      // ternary chain, then require the value position to be an ObjectProperty
      // inside a `style={{…}}` attribute. This EXCLUDES the legitimate
      // setVariant toggle `variant === 'default' ? 'open' : 'default'` and prop
      // ternaries — only the resolved style values are the bug.
      let valueNode: t.Node = path.node;
      let pp: NodePath | null = path.parentPath;
      while (pp && t.isConditionalExpression(pp.node)) { valueNode = pp.node; pp = pp.parentPath; }
      if (!pp || !t.isObjectProperty(pp.node) || pp.node.value !== valueNode) return;
      const objExpr = pp.parentPath;
      if (!objExpr || !t.isObjectExpression(objExpr.node)) return;
      const container = objExpr.parentPath;
      if (!container || !t.isJSXExpressionContainer(container.node)) return;
      const attr = container.parentPath;
      if (!attr || !t.isJSXAttribute(attr.node) || !t.isJSXIdentifier(attr.node.name) || attr.node.name.name !== 'style') return;
      const line = path.node.loc?.start.line ?? 0;
      if (seen.has(line)) return;
      seen.add(line);
      v.push({
        code: 'VARIANT_TERNARY_TESTS_PRIMARY', tier: 2, line,
        message: `A variant ternary at line ${line} tests \`${test.left.name} === '${primary}'\` — the PRIMARY variant. The canvas maps a ternary's trailing ELSE branch to the primary, so this consequent is dead and the primary resolves to the ELSE value instead (the "desktop variant shows the mobile width" bug). Make the PRIMARY's value the final else and condition only on NON-primary variants — e.g. width: variant === 'mobile' ? '390px' : '1280px' (else '1280px' = the desktop/primary value, which is what the element is FOR). (Conditional renders {variant === '${primary}' && …} are fine — this only flags ? : value ternaries.)`,
      });
    },
  });
}

export { checkVariantDialect, checkVariantTernaryPrimary };
