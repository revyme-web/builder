// oracle/checks/layout-rules.ts — layout/structure rules (flex order + shrink,
// padding needs layout, grid template, slot children, unresolvable ternary,
// canvas fill feedback, image background frame).
// All code moved VERBATIM from check-file.ts (Phase 7.1 god-file split).

import * as t from '@babel/types';
import { traverse, jsxTagName, jsxAttrs, stringAttr, hasAttr, isCodeComponentSource } from './shared';
import type { OracleViolation } from './shared';

/** FLEX/GRID CHILD ORDER — a direct, in-flow child of a flex/grid container
 *  must carry an explicit `order` (number literal, string number, or a
 *  variant/initialVariant ternary resolving to numbers). The editor's
 *  drag-to-reorder writes/animates `order`; a child without one defaults to
 *  CSS `order: 0` and jumps to the front of the order:0 group, so reordering
 *  breaks. Required when the container has 2+ in-flow children. Absolutely-
 *  positioned children are out of flow — exempt. */

// ── PADDING NEEDS LAYOUT — the editor's Padding control lives INSIDE the
//    Layout tool, which only renders for a flex/grid element. A frame with
//    padding but no display:flex/grid therefore has padding the user CANNOT
//    edit in the builder (the whole Layout section is hidden). Every padded
//    frame must declare a layout. NEW nodes only (never rewrites pre-existing
//    builder content), div/motion.div frames only, and skips ...style-spread
//    passthrough/instance nodes + canvas-workspace nodes. ────────────────────
/**
 * SLOT_COMPONENT_INLINE_CHILDREN — a code component (imported from
 * '@/components/…', e.g. Marquee / Carousel / CompanyMarquee) renders its slot
 * items ON THE EDITOR CANVAS only as CONNECTED CANVAS NODES: the Renderer's
 * `slotCanvasNodes` pass picks children where `isCanvasNode && parentId`, i.e.
 * elements carrying `data-canvas-node="true"` (or a `{cn_x}` reference to such a
 * const). An INLINE element child that has a `data-id` but NOT
 * `data-canvas-node="true"` deploys to the live site yet stays INVISIBLE on the
 * canvas — the exact "where are my icons?" trap. Hoist each to a module-scope
 * const with `data-canvas-node="true"` and reference it `{cn_<id>}` inside the
 * slot (see the home page's CompanyMarquee + `cn_co_*` consts).
 */
function checkSlotComponentInlineChildren(ast: t.File, v: OracleViolation[]): void {
  const componentNames = new Set<string>();
  for (const node of ast.program.body) {
    if (t.isImportDeclaration(node) && node.source.value.startsWith('@/components/')) {
      for (const spec of node.specifiers) componentNames.add(spec.local.name);
    }
  }
  if (componentNames.size === 0) return;

  traverse(ast, {
    JSXElement(path) {
      const name = path.node.openingElement.name;
      if (!t.isJSXIdentifier(name) || !componentNames.has(name.name)) return;
      for (const child of path.node.children) {
        if (!t.isJSXElement(child)) continue;            // {cn_x} refs / text are fine
        const cAttrs = jsxAttrs(child.openingElement);
        const cid = stringAttr(cAttrs, 'data-id');
        if (cid && stringAttr(cAttrs, 'data-canvas-node') !== 'true') {
          const cn = 'cn_' + cid.replace(/[^a-zA-Z0-9]/g, '_');
          v.push({
            code: 'SLOT_COMPONENT_INLINE_CHILDREN',
            tier: 2,
            line: child.loc?.start.line,
            message: `<${name.name}> has an INLINE slot child "${cid}". The editor canvas renders a code-component's slot items ONLY as CONNECTED CANVAS NODES, so inline children deploy to the live site but stay INVISIBLE on the canvas. Hoist EACH item to a module-scope const with data-canvas-node="true" (name "${cn}", position:'absolute' off-canvas left/top) and reference it inside <${name.name}> as {${cn}}. Mirror the home page's CompanyMarquee + cn_co_* consts.`,
          });
          break; // one finding per component instance
        }
      }
    },
  });
}

/**
 * UNRESOLVABLE_TERNARY — a PAGE renders an inline `x ? a : b` ternary as TEXT content
 * or a STYLE value. It deploys, but the builder CANNOT resolve / edit / toggle it on a
 * page (no variant scope), so the value silently can't be switched in the editor — the
 * "the prices are missing / it's not resolved" trap. State-driven values on a page MUST
 * be PAGE VARIABLES: bind the value as a bare identifier (`{varName}` in text, `prop:
 * varName` in style) backed by a @pageVariables entry + useState, and switch it with a
 * Set-Variable interaction (`onClick={() => setVarName(value)}`). Value ternaries only —
 * element ternaries (`cond ? <A/> : <B/>`) are conditional render, a separate concern.
 * PAGE only — design COMPONENTS legitimately use variant ternaries (`variant === 'v' ? …`).
 */
function checkUnresolvableTernary(ast: t.File, v: OracleViolation[]): void {
  const isValueTernary = (ce: t.ConditionalExpression): boolean =>
    !t.isJSXElement(ce.consequent) && !t.isJSXFragment(ce.consequent)
    && !t.isJSXElement(ce.alternate) && !t.isJSXFragment(ce.alternate);
  const flag = (line: number | undefined, where: string) => {
    v.push({
      code: 'UNRESOLVABLE_TERNARY', tier: 2, line,
      message: `An inline \`x ? a : b\` ternary in ${where} (line ${line}) renders on the live site but the builder CANNOT resolve or toggle it on a page — the value silently can't be switched in the editor (the "value is missing / not resolved" trap). Use a PAGE VARIABLE: bind the value as a bare identifier ({varName} in text, \`prop: varName\` in a style) backed by a @pageVariables entry + a useState hook, and switch it with a Set-Variable interaction (onClick={() => setVarName(value)}; one onClick may set several). Variant ternaries (variant === 'v' ? …) are for design COMPONENTS, not pages.`,
    });
  };
  traverse(ast, {
    JSXElement(path) {
      for (const child of path.node.children) {
        if (t.isJSXExpressionContainer(child) && t.isConditionalExpression(child.expression) && isValueTernary(child.expression)) {
          flag(child.loc?.start.line, 'text content');
        }
      }
    },
    JSXAttribute(path) {
      if (path.node.name.name !== 'style') return;
      const val = path.node.value;
      if (val?.type !== 'JSXExpressionContainer' || !t.isObjectExpression(val.expression)) return;
      for (const prop of val.expression.properties) {
        if (t.isObjectProperty(prop) && t.isConditionalExpression(prop.value) && isValueTernary(prop.value)) {
          flag(prop.loc?.start.line, 'a style value');
        }
      }
    },
  });
}

/**
 * GRID_NEEDS_TEMPLATE — a display:'grid'/'inline-grid' container MUST declare grid
 * TRACKS (gridTemplateColumns, or gridTemplate / a column auto-flow). Without them
 * the grid collapses to a SINGLE column (a bento never forms) AND the Layout tool's
 * grid-track controls — which key off gridTemplateColumns — don't render, so the
 * grid is uneditable in the builder. Mirror the Layout tool's grid presets:
 * { display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gridAutoRows:'minmax(200px, auto)', gap:'16px' }.
 * New-node-only (won't flag pre-existing builder content).
 */
function checkGridNeedsTemplate(ast: t.File, v: OracleViolation[], existingDataIds?: Set<string>): void {
  const styleObjectOf = (el: t.JSXElement): t.ObjectExpression | null => {
    const a = jsxAttrs(el.openingElement).find((x) => x.name.name === 'style');
    if (a?.value?.type === 'JSXExpressionContainer' && t.isObjectExpression(a.value.expression)) return a.value.expression;
    return null;
  };
  const styleStr = (obj: t.ObjectExpression, key: string): string | null => {
    for (const pr of obj.properties) {
      if (!t.isObjectProperty(pr)) continue;
      const k = t.isIdentifier(pr.key) ? pr.key.name : t.isStringLiteral(pr.key) ? pr.key.value : '';
      if (k === key) return t.isStringLiteral(pr.value) ? pr.value.value : '__expr__';
    }
    return null;
  };
  traverse(ast, {
    JSXElement(path) {
      const attrs = jsxAttrs(path.node.openingElement);
      const dataId = stringAttr(attrs, 'data-id');
      if (!dataId) return;
      if (!existingDataIds || existingDataIds.has(dataId)) return;   // new nodes only
      const so = styleObjectOf(path.node);
      if (!so || so.properties.some((p) => t.isSpreadElement(p))) return;
      const display = styleStr(so, 'display');
      if (display !== 'grid' && display !== 'inline-grid') return;
      const hasTracks = styleStr(so, 'gridTemplateColumns') != null
        || styleStr(so, 'gridTemplate') != null
        || styleStr(so, 'gridTemplateRows') != null
        || ((styleStr(so, 'gridAutoFlow') ?? '').includes('column') && styleStr(so, 'gridAutoColumns') != null);
      if (hasTracks) return;
      const line = path.node.openingElement.loc?.start.line;
      v.push({
        code: 'GRID_NEEDS_TEMPLATE', tier: 2, line, elementId: dataId,
        message: `<${dataId}> (line ${line}) is display:'grid' but declares NO grid tracks — it collapses to a SINGLE column (the bento/grid never forms) and the Layout tool's grid-track controls don't resolve. Add gridTemplateColumns (+ a gap, usually gridAutoRows), e.g. { display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gridAutoRows:'minmax(200px, auto)', gap:'16px' }. Each child still takes an explicit quoted order; a bento card spans with gridColumn:'span 2' / gridRow:'span 2'.`,
      });
    },
  });
}

/**
 * GRID_CHILD_SPAN_UNRESOLVABLE — a grid child's `gridColumn`/`gridRow` must be
 * written in one of the two forms the Layout tool's Span dropdown round-trips
 * losslessly (`formatSpanValue`/`parseSpanValue` in editor/tools/LayoutTool.tsx):
 *
 *     absent        → Span 1
 *     'span N'      → Span N        (N = 2..12)
 *     '1 / -1'      → Span All
 *
 * Every other CSS-legal value — `'7 / span 6'`, `'2 / 4'`, `'span 2 / span 3'`,
 * named lines — RENDERS CORRECTLY on canvas and in production but decodes to
 * `'1'`, so the dropdown reads "Span 1" while the element visibly spans six
 * tracks. The value is not lost until someone touches the dropdown, at which
 * point the hand-written placement is silently overwritten.
 *
 * Line-based placement is also redundant in practice: in a 12-track grid,
 * children of `'1 / span 6'` and `'7 / span 6'` auto-place to exactly the cells
 * plain `'span 6'` gives them. Live case: the four Selected Work cards,
 * 2026-08-01 — correct on canvas, "Span 1" in the panel.
 */
function checkGridChildSpan(ast: t.File, v: OracleViolation[], existingDataIds?: Set<string>): void {
  // The forms parseSpanValue decodes without loss. `N / M` starting at line 1
  // also decodes (→ Span M-1), but it is not what the control ever WRITES, so
  // it is steered to the canonical `span N` rather than blessed.
  const RESOLVES = /^(span\s+([2-9]|1[0-2])|1\s*\/\s*-1)$/;

  traverse(ast, {
    JSXElement(path) {
      const attrs = jsxAttrs(path.node.openingElement);
      const dataId = stringAttr(attrs, 'data-id');
      if (!dataId) return;
      if (!existingDataIds || existingDataIds.has(dataId)) return;   // new nodes only
      const a = attrs.find((x) => x.name.name === 'style');
      if (a?.value?.type !== 'JSXExpressionContainer' || !t.isObjectExpression(a.value.expression)) return;

      for (const pr of a.value.expression.properties) {
        if (!t.isObjectProperty(pr)) continue;
        const k = t.isIdentifier(pr.key) ? pr.key.name : t.isStringLiteral(pr.key) ? pr.key.value : '';
        if (k !== 'gridColumn' && k !== 'gridRow') continue;
        // Only literals — an expression is someone else's problem (and the
        // panel shows no dropdown for it anyway).
        if (!t.isStringLiteral(pr.value)) continue;
        const raw = pr.value.value.trim();
        if (!raw || RESOLVES.test(raw)) continue;

        // Suggest the equivalent the control writes, when it is derivable.
        const span = raw.match(/^-?\d+\s*\/\s*span\s+(\d+)$/)
          ?? raw.match(/^span\s+(\d+)$/);
        const fix = span
          ? (span[1] === '1' ? `drop ${k} entirely (Span 1 is the default)` : `${k}: 'span ${span[1]}'`)
          : `${k}: 'span N'`;
        const line = path.node.openingElement.loc?.start.line;
        v.push({
          code: 'GRID_CHILD_SPAN_UNRESOLVABLE', tier: 2, line, elementId: dataId,
          message: `<${dataId}> (line ${line}) sets ${k}: '${raw}' — a line-based placement the Layout tool's Span dropdown cannot decode, so the panel reads "Span 1" while the element actually spans a different number of tracks, and the first edit to that dropdown silently overwrites the placement. Use ${fix}. Auto-placement puts a 'span N' child in the same cells as the explicit line form; only 'span N' (N=2..12) and '1 / -1' (Span All) round-trip.`,
        });
      }
    },
  });
}

/**
 * CANVAS_FILL_FEEDBACK — a code-component <canvas> that fills its box
 * (width/height '100%') MUST be position:'absolute'. An IN-FLOW fill canvas has
 * no definite parent height when the instance uses a fill/grow height, so its
 * display height falls back to its OWN bitmap height; the component's
 * ResizeObserver then sets bitmap = clientHeight × devicePixelRatio, which grows
 * the box, which re-fires the observer — the host element EXPANDS WITHOUT BOUND
 * ("the page grows forever"). Absolute-positioning takes the canvas out of flow
 * so it can't feed its own height back. Code components only.
 */
function checkCanvasFillFeedback(code: string, ast: t.File, v: OracleViolation[]): void {
  if (!isCodeComponentSource(code)) return; // code components only
  const styleObjectOf = (el: t.JSXElement): t.ObjectExpression | null => {
    const a = jsxAttrs(el.openingElement).find((x) => x.name.name === 'style');
    if (a?.value?.type === 'JSXExpressionContainer' && t.isObjectExpression(a.value.expression)) return a.value.expression;
    return null;
  };
  const styleStr = (obj: t.ObjectExpression, key: string): string | null => {
    for (const pr of obj.properties) {
      if (!t.isObjectProperty(pr)) continue;
      const k = t.isIdentifier(pr.key) ? pr.key.name : t.isStringLiteral(pr.key) ? pr.key.value : '';
      if (k === key) return t.isStringLiteral(pr.value) ? pr.value.value : '__expr__';
    }
    return null;
  };
  traverse(ast, {
    JSXElement(path) {
      if (jsxTagName(path.node.openingElement.name) !== 'canvas') return;
      const so = styleObjectOf(path.node);
      if (!so) return;
      const fills = styleStr(so, 'height') === '100%' || styleStr(so, 'width') === '100%';
      const pos = styleStr(so, 'position');
      if (fills && pos !== 'absolute' && pos !== 'fixed') {
        v.push({
          code: 'CANVAS_FILL_FEEDBACK',
          tier: 2,
          line: path.node.openingElement.loc?.start.line,
          message: `<canvas> (line ${path.node.openingElement.loc?.start.line}) fills its box (width/height '100%') but is in-flow — give it position:'absolute' with top/left '0px' inside the position:'relative' root. An in-flow fill canvas feeds its bitmap height back through the ResizeObserver (bitmap = clientHeight × devicePixelRatio each cycle), so when the instance uses a fill/grow height the host element GROWS WITHOUT BOUND. e.g. style={{ position:'absolute', top:'0px', left:'0px', width:'100%', height:'100%' }}.`,
        });
      }
    },
  });
}

function checkPaddingNeedsLayout(ast: t.File, v: OracleViolation[], existingDataIds?: Set<string>): void {
  const PAD_KEYS = ['padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'];
  const LAYOUT = ['flex', 'inline-flex', 'grid', 'inline-grid'];
  const baseTag = (tag: string): string => tag.startsWith('motion.') ? tag.slice('motion.'.length) : tag;
  const styleObjectOf = (el: t.JSXElement): t.ObjectExpression | null => {
    const a = jsxAttrs(el.openingElement).find((x) => x.name.name === 'style');
    if (a?.value?.type === 'JSXExpressionContainer' && t.isObjectExpression(a.value.expression)) return a.value.expression;
    return null;
  };
  const styleStr = (obj: t.ObjectExpression, key: string): string | null => {
    for (const pr of obj.properties) {
      if (!t.isObjectProperty(pr)) continue;
      const k = t.isIdentifier(pr.key) ? pr.key.name : t.isStringLiteral(pr.key) ? pr.key.value : '';
      if (k !== key) continue;
      if (t.isStringLiteral(pr.value)) return pr.value.value;
      return '__expr__';
    }
    return null;
  };
  traverse(ast, {
    JSXElement(path) {
      if (baseTag(jsxTagName(path.node.openingElement.name)) !== 'div') return;
      const attrs = jsxAttrs(path.node.openingElement);
      const dataId = stringAttr(attrs, 'data-id');
      if (!dataId) return;
      // NEW nodes only — silent when the gate didn't pass the previous-version set.
      if (!existingDataIds || existingDataIds.has(dataId)) return;
      if (hasAttr(attrs, 'data-canvas-node')) return;
      const so = styleObjectOf(path.node);
      if (!so) return;
      // Instance/passthrough wrapper — layout comes from elsewhere.
      if (so.properties.some((p) => t.isSpreadElement(p))) return;
      // A real (non-zero) padding present?
      let hasPad = false;
      for (const k of PAD_KEYS) {
        const val = styleStr(so, k);
        if (val === '__expr__' || (val != null && /[1-9]/.test(val))) { hasPad = true; break; }
      }
      if (!hasPad) return;
      const display = styleStr(so, 'display');
      if (display === '__expr__') return;                      // dynamic — can't confirm
      if (display != null && LAYOUT.includes(display)) return; // already a layout
      const line = path.node.openingElement.loc?.start.line;
      v.push({
        code: 'PADDING_NEEDS_LAYOUT', tier: 2, line, elementId: dataId,
        message: `<${dataId}> (line ${line}) sets padding but declares no flex/grid layout — the editor's Padding control lives INSIDE the Layout tool, which only appears for a flex/grid element, so this padding CANNOT be edited in the builder. Every padded frame must carry a layout: add display: 'flex' together with flexDirection / alignItems / justifyContent, e.g. { …, padding: '…', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }. (Use 'grid' instead of 'flex' if you genuinely need a grid.)`,
      });
    },
  });
}

function checkFlexChildOrder(ast: t.File, v: OracleViolation[]): void {
  const baseTag = (tag: string): string => tag.startsWith('motion.') ? tag.slice('motion.'.length) : tag;
  const styleObjectOf = (el: t.JSXElement): t.ObjectExpression | null => {
    const a = jsxAttrs(el.openingElement).find((x) => x.name.name === 'style');
    if (a?.value?.type === 'JSXExpressionContainer' && t.isObjectExpression(a.value.expression)) return a.value.expression;
    return null;
  };
  const styleHas = (obj: t.ObjectExpression, key: string): boolean => obj.properties.some((pr) =>
    t.isObjectProperty(pr) && ((t.isIdentifier(pr.key) && pr.key.name === key) || (t.isStringLiteral(pr.key) && pr.key.value === key)));
  const styleStr = (obj: t.ObjectExpression, key: string): string | null => {
    for (const pr of obj.properties) {
      if (!t.isObjectProperty(pr)) continue;
      const k = t.isIdentifier(pr.key) ? pr.key.name : t.isStringLiteral(pr.key) ? pr.key.value : '';
      if (k !== key) continue;
      if (t.isStringLiteral(pr.value)) return pr.value.value;
      return '__expr__';
    }
    return null;
  };

  traverse(ast, {
    JSXElement(path) {
      const parentStyle = styleObjectOf(path.node);
      if (!parentStyle) return;
      const display = styleStr(parentStyle, 'display');
      // Static flex/grid only — a ternary/variable display can't be statically
      // confirmed as a flex context, so don't false-positive on it.
      if (display == null || !['flex', 'inline-flex', 'grid', 'inline-grid'].includes(display)) return;

      // Direct element children that participate in flow (skip absolute/fixed,
      // skip non-elements, skip elements with no data-id — transparent runs).
      const flowChildren: Array<{ id: string; el: t.JSXElement; hasOrder: boolean; line?: number }> = [];
      for (const child of path.node.children) {
        if (!t.isJSXElement(child)) continue;
        const cAttrs = jsxAttrs(child.openingElement);
        const cId = stringAttr(cAttrs, 'data-id');
        if (!cId) continue;
        const cStyle = styleObjectOf(child);
        const pos = cStyle ? styleStr(cStyle, 'position') : null;
        if (pos === 'absolute' || pos === 'fixed') continue; // out of flow
        flowChildren.push({
          id: cId, el: child,
          hasOrder: cStyle ? styleHas(cStyle, 'order') : false,
          line: child.openingElement.loc?.start.line,
        });
      }
      if (flowChildren.length < 2) return; // nothing to reorder

      const missing = flowChildren.filter((c) => !c.hasOrder);
      if (missing.length === 0) return;

      const parentId = stringAttr(jsxAttrs(path.node.openingElement), 'data-id') ?? baseTag(jsxTagName(path.node.openingElement.name));
      const line = path.node.openingElement.loc?.start.line;
      // Sequential assignment in SOURCE order (== DOM order at creation).
      const plan = flowChildren.map((c, i) => `${c.id} → order: '${i}'`).join(', ');
      v.push({
        code: 'FLEX_CHILD_MISSING_ORDER', tier: 2, line, elementId: parentId,
        message: `Flex/grid container <${parentId}> (line ${line}) has ${flowChildren.length} flow children but ${missing.length} lack an \`order\` — the drag-to-reorder engine manipulates CSS \`order\`, and a child without one snaps to the front of the order:0 group, breaking reorder. Give EVERY in-flow child an explicit sequential order, as a QUOTED STRING (the reorder engine serialises order: String(n) and matches the quoted form): ${plan}. (Per-variant reorder is the exception — a numeric ternary: order: variant === 'v1' ? 1 : 0.)`,
      });
    },
  });
}

/** ORDER MUST BE A STRING — the drag-to-reorder engine serialises CSS `order`
 *  as a QUOTED STRING (`order: String(n)` — CanvasDragStrategy / reparent-utils)
 *  and its source-update step matches the quoted form. A bare numeric
 *  `order: 2` renders fine but the reorder tool can't resolve/update it, so
 *  dragging silently no-ops. Flag a NUMERIC-LITERAL `order` inside any inline
 *  `style={{}}`. EXEMPT: a string value (`order: '2'` — correct) and a
 *  ternary/expression (`order: variant === 'v1' ? 1 : 0` — the per-variant
 *  reorder shape the variant tool writes). Component variant OBJECTS
 *  (`const xVariants = { v1: { order: 1 } }`) aren't inline style attrs so
 *  they're untouched (framer-motion needs numeric order there). */
function checkOrderIsString(ast: t.File, v: OracleViolation[]): void {
  traverse(ast, {
    JSXAttribute(path) {
      const nm = path.node.name;
      if (!t.isJSXIdentifier(nm) || nm.name !== 'style') return;
      const val = path.node.value;
      if (!val || !t.isJSXExpressionContainer(val) || !t.isObjectExpression(val.expression)) return;
      for (const prop of val.expression.properties) {
        if (!t.isObjectProperty(prop)) continue;
        const k = t.isIdentifier(prop.key) ? prop.key.name : t.isStringLiteral(prop.key) ? prop.key.value : '';
        if (k !== 'order') continue;
        const pv = prop.value;
        const neg = t.isUnaryExpression(pv) && pv.operator === '-' && t.isNumericLiteral(pv.argument);
        if (!t.isNumericLiteral(pv) && !neg) continue; // string / ternary / expression → fine
        const numText = t.isNumericLiteral(pv) ? String(pv.value) : `-${(pv.argument as t.NumericLiteral).value}`;
        const opening = path.parent;
        const id = t.isJSXOpeningElement(opening) ? stringAttr(jsxAttrs(opening), 'data-id') : undefined;
        const line = (prop.loc ?? path.node.loc)?.start.line;
        v.push({
          code: 'ORDER_MUST_BE_STRING', tier: 2, line, elementId: id,
          message: `inline \`order: ${numText}\` (line ${line}) is a bare number — the drag-to-reorder engine reads/writes CSS order as a QUOTED STRING (it serialises \`order: String(n)\`), so a numeric literal renders but the reorder tool can't resolve or update it and dragging silently no-ops. Quote it: \`order: '${numText}'\`. (Per-variant reorder is the ONE exception — a numeric ternary \`order: variant === 'v1' ? 1 : 0\`, written by the variant tool, not a bare literal.)`,
        });
      }
    },
  });
}

/** FLEX CHILD SHRINK — a flow child of a display:flex container must resolve
 *  to flex-shrink: 0 (design-tool parity: children are Fixed/Hug/Fill, never
 *  shrinking). The CSS default is shrink: 1, which collapses a child to ~0
 *  computed size in a constrained flex column — the "node disappears on drop"
 *  class of bug. Fires on flex containers with 2+ in-flow children (same
 *  scope as the order rule) when a child is missing flex/flexShrink (CSS
 *  default 1) OR explicitly shrinks. grid items are NOT checked — flex-shrink
 *  does not apply to them. Indeterminate (ternary/variable) flex ⇒ skip. */
function checkFlexChildShrink(ast: t.File, v: OracleViolation[]): void {
  const baseTag = (tag: string): string => tag.startsWith('motion.') ? tag.slice('motion.'.length) : tag;
  const styleObjectOf = (el: t.JSXElement): t.ObjectExpression | null => {
    const a = jsxAttrs(el.openingElement).find((x) => x.name.name === 'style');
    if (a?.value?.type === 'JSXExpressionContainer' && t.isObjectExpression(a.value.expression)) return a.value.expression;
    return null;
  };
  // prop value: { str } literal string, { num } numeric, '__expr__' (ternary/
  // identifier/etc.), or null when absent.
  const propVal = (obj: t.ObjectExpression, key: string): { str?: string; num?: number } | '__expr__' | null => {
    for (const pr of obj.properties) {
      if (!t.isObjectProperty(pr)) continue;
      const k = t.isIdentifier(pr.key) ? pr.key.name : t.isStringLiteral(pr.key) ? pr.key.value : '';
      if (k !== key) continue;
      if (t.isStringLiteral(pr.value)) return { str: pr.value.value };
      if (t.isNumericLiteral(pr.value)) return { num: pr.value.value };
      return '__expr__';
    }
    return null;
  };
  const strProp = (obj: t.ObjectExpression, key: string): string | null => {
    const pv = propVal(obj, key);
    return pv && pv !== '__expr__' && pv.str != null ? pv.str : (pv === '__expr__' ? '__expr__' : null);
  };
  // 0 = shrink 0 (ok), 1 = shrinks (fire), null = indeterminate (skip).
  const staticShrink = (obj: t.ObjectExpression): 0 | 1 | null => {
    const fs = propVal(obj, 'flexShrink');
    if (fs === '__expr__') return null;
    if (fs) {
      if (fs.num != null) return fs.num === 0 ? 0 : 1;
      if (fs.str != null) { const n = parseFloat(fs.str); return Number.isFinite(n) ? (n === 0 ? 0 : 1) : null; }
    }
    const fpv = propVal(obj, 'flex');
    if (fpv === '__expr__') return null;
    if (fpv && fpv.str != null) {
      const val = fpv.str.trim();
      if (val === 'none') return 0;
      if (val === 'auto' || val === 'initial') return 1;
      const parts = val.split(/\s+/);
      if (parts.length >= 3) { const n = parseFloat(parts[1]); return Number.isFinite(n) ? (n === 0 ? 0 : 1) : null; }
      if (parts.length === 2) {
        const second = parts[1];
        if (/^-?\d/.test(second)) { const n = parseFloat(second); return n === 0 ? 0 : 1; } // grow shrink
        return 1; // grow basis ⇒ shrink defaults to 1
      }
      return 1; // single value ⇒ shrink defaults to 1
    }
    if (fpv && fpv.num != null) return 1; // `flex: 1` ⇒ grow 1, shrink 1
    // neither flex nor flexShrink present ⇒ CSS default shrink: 1
    if (fs == null && fpv == null) return 1;
    return null;
  };

  traverse(ast, {
    JSXElement(path) {
      const pObj = styleObjectOf(path.node);
      if (!pObj) return;
      const display = strProp(pObj, 'display');
      if (display !== 'flex' && display !== 'inline-flex') return; // flex only
      const flow: Array<{ id: string; obj: t.ObjectExpression | null; line?: number }> = [];
      for (const child of path.node.children) {
        if (!t.isJSXElement(child)) continue;
        const cAttrs = jsxAttrs(child.openingElement);
        const cId = stringAttr(cAttrs, 'data-id');
        if (!cId) continue;
        const cObj = styleObjectOf(child);
        const pos = cObj ? strProp(cObj, 'position') : null;
        if (pos === 'absolute' || pos === 'fixed') continue;
        flow.push({ id: cId, obj: cObj, line: child.openingElement.loc?.start.line });
      }
      if (flow.length < 2) return;
      const bad = flow.filter((c) => c.obj == null ? true : staticShrink(c.obj) === 1);
      if (bad.length === 0) return;
      const parentId = stringAttr(jsxAttrs(path.node.openingElement), 'data-id') ?? baseTag(jsxTagName(path.node.openingElement.name));
      const line = path.node.openingElement.loc?.start.line;
      v.push({
        code: 'FLEX_CHILD_SHRINKS', tier: 2, line, elementId: parentId,
        message: `Flex container <${parentId}> (line ${line}) has ${bad.length} child(ren) that can SHRINK (flex-shrink: 1 — explicit, or the CSS default when no flex is set): ${bad.map((c) => c.id).join(', ')}. In a constrained flex column a shrinking child collapses to ~0 computed size (the "disappears on drop" bug). Give each flow child flex: '0 0 auto' (Fixed/Hug). A child that should expand uses flex: '1 0 0px' (Fill) — still shrink 0. Match the reference: flex children never shrink.`,
      });
    },
  });
}


/**
 * NO_LAYOUT_PARENT_RELATIVE_CHILD — a container is either a LAYOUT frame
 * (display:flex/grid → children in flow, position:'relative') or a FREEFORM
 * frame (no layout → the canvas drag engine free-moves children, i.e. absolute
 * drags). A position:'relative' (or position-less) child inside a NO-LAYOUT
 * parent is the inconsistent in-between: CSS stacks it in flow, but the drag
 * engine treats the parent as freeform, so the first drag converts/behaves as
 * an ABSOLUTE move and the source no longer matches what the user sees.
 * Applies to every element child with a data-id — component instances
 * included. Fix: give the parent a layout (display:'flex' + flexDirection…) so
 * flow children are legitimate, OR author the child position:'absolute' +
 * data-pinned with explicit left/top. NEW child nodes only (never rewrites
 * pre-existing builder content). Skips: parents without a style object
 * (AnimatePresence & friends), spread/instance passthrough parents,
 * indeterminate (expression) display values, svg subtrees.
 */
function checkNoLayoutParentRelativeChild(ast: t.File, v: OracleViolation[], existingDataIds?: Set<string>): void {
  const FRAME_TAGS = new Set(['div', 'section', 'header', 'footer', 'main', 'nav', 'article', 'aside', 'form', 'figure']);
  const LAYOUT = ['flex', 'inline-flex', 'grid', 'inline-grid'];
  const baseTag = (tag: string): string => tag.startsWith('motion.') ? tag.slice('motion.'.length) : tag;
  const styleObjectOf = (el: t.JSXElement): t.ObjectExpression | null => {
    const a = jsxAttrs(el.openingElement).find((x) => x.name.name === 'style');
    if (a?.value?.type === 'JSXExpressionContainer' && t.isObjectExpression(a.value.expression)) return a.value.expression;
    return null;
  };
  const styleStr = (obj: t.ObjectExpression, key: string): string | null => {
    for (const pr of obj.properties) {
      if (!t.isObjectProperty(pr)) continue;
      const k = t.isIdentifier(pr.key) ? pr.key.name : t.isStringLiteral(pr.key) ? pr.key.value : '';
      if (k !== key) continue;
      if (t.isStringLiteral(pr.value)) return pr.value.value;
      return '__expr__';
    }
    return null;
  };
  traverse(ast, {
    JSXElement(path) {
      if (!FRAME_TAGS.has(baseTag(jsxTagName(path.node.openingElement.name)))) return;
      const pObj = styleObjectOf(path.node);
      if (!pObj) return;
      if (pObj.properties.some((p) => t.isSpreadElement(p))) return; // instance/passthrough parent
      const display = styleStr(pObj, 'display');
      if (display === '__expr__') return;                       // dynamic — can't confirm
      if (display != null && LAYOUT.includes(display)) return;  // layout frame — flow children are correct
      const parentId = stringAttr(jsxAttrs(path.node.openingElement), 'data-id') ?? baseTag(jsxTagName(path.node.openingElement.name));
      for (const child of path.node.children) {
        if (!t.isJSXElement(child)) continue;
        const cAttrs = jsxAttrs(child.openingElement);
        const cId = stringAttr(cAttrs, 'data-id');
        if (!cId) continue;
        // NEW nodes only — silent when the gate didn't pass the previous-version set.
        if (!existingDataIds || existingDataIds.has(cId)) continue;
        const cObj = styleObjectOf(child);
        const pos = cObj ? styleStr(cObj, 'position') : null;
        if (pos === '__expr__') continue;                       // indeterminate
        if (pos === 'absolute' || pos === 'fixed' || pos === 'sticky') continue; // freeform — correct here
        const line = child.openingElement.loc?.start.line;
        v.push({
          code: 'NO_LAYOUT_PARENT_RELATIVE_CHILD', tier: 2, line, elementId: cId,
          message: `<${cId}> (line ${line}) is an in-flow (position:'relative') child of <${parentId}>, which declares NO layout (no display:flex/grid). A container is either a LAYOUT frame (flex/grid → relative flow children) or a FREEFORM frame (no layout → absolutely-positioned children the canvas free-drags) — this in-between renders in flow but DRAGS as an absolute move, so the source stops matching the canvas. Either give <${parentId}> a layout (display: 'flex', flexDirection: 'column'/'row' + alignItems/justifyContent — then keep the child relative with flex: '0 0 auto' and a quoted order), or make <${cId}> position: 'absolute' + data-pinned="true" with explicit left/top px. Applies to component instances too.`,
        });
      }
    },
  });
}

/**
 * IMAGE_USE_BACKGROUND_FRAME — images are FRAME divs with backgroundImage, not
 * <img>. A <div data-canvas-node> wrapping an <img> mis-positions, and the
 * project's convention is a single resizable/croppable backgroundImage box.
 * Scope: a STATIC-src <img> (src="https://…") — a hardcoded content image.
 * EXEMPT: an expression src (src={item.image} / src={prop}) — a CMS or dynamic
 * binding (the CMS scaffolds emit src={item.field}); those keep <img> (or use
 * backgroundImage: `url(${item.field})`), so the prime rule holds.
 */
function checkImageBackgroundFrame(ast: t.File, v: OracleViolation[]): void {
  traverse(ast, {
    JSXElement(path) {
      const opening = path.node.openingElement;
      const tag = jsxTagName(opening.name);
      const base = tag.startsWith('motion.') ? tag.slice('motion.'.length) : tag;
      if (base !== 'img') return;
      const attrs = jsxAttrs(opening);
      const srcAttr = attrs.find((a) => a.name.name === 'src');
      if (!srcAttr || !t.isStringLiteral(srcAttr.value)) return; // dynamic/CMS src → exempt
      const src = srcAttr.value.value;
      const id = stringAttr(attrs, 'data-id');
      const line = opening.loc?.start.line;
      v.push({
        code: 'IMAGE_USE_BACKGROUND_FRAME', tier: 2, line, elementId: id,
        message: `<img${id ? ` data-id="${id}"` : ''}> at line ${line} is a static content image — images are Frame DIVs with backgroundImage here, never <img> (and never a <div> wrapping an <img>). Replace it with: <div data-id="${id ?? 'image'}" data-name="Image" style={{ width: '…', height: '…px', backgroundImage: 'url(${src})', backgroundSize: 'cover', backgroundPosition: 'center', backgroundRepeat: 'no-repeat' }} /> — give it an explicit height (a backgroundImage div has no intrinsic size). A CMS/dynamic <img src={item.x}> is exempt; for those use a div with backgroundImage: \`url(\${item.x})\`.`,
      });
    },
  });
}


/**
 * MEDIA_COLUMN_FLIP_MISSING_REBASE — a responsive @media rule that flips a
 * flex container to flex-direction: column MUST re-base every flow child
 * whose flex is the row-fill form ('1 0 0px'): in column direction that
 * basis-0 governs HEIGHT, and a child without text content (e.g. a freeform
 * card of absolute children) collapses to a 0-height strip (the "HOW WE
 * WORK card is a gray sliver on tablet" find). A height rule does NOT save
 * it — flex-basis outranks height in the flex algorithm. The same media
 * block must set `flex: 0 0 auto` on such children.
 */
function checkMediaColumnFlipRebase(ast: t.File, v: OracleViolation[]): void {
  // 1. collect the page's <style> template text
  let css = '';
  traverse(ast, {
    JSXElement(path) {
      if (jsxTagName(path.node.openingElement.name) !== 'style') return;
      for (const child of path.node.children) {
        if (t.isJSXExpressionContainer(child) && t.isTemplateLiteral(child.expression)) {
          css += child.expression.quasis.map((q) => q.value.raw).join('');
        }
      }
    },
  });
  if (!css.includes('@media')) return;

  // 2. index elements + their children by data-id
  const styleObjectOf = (el: t.JSXElement): t.ObjectExpression | null => {
    const a = jsxAttrs(el.openingElement).find((x) => x.name.name === 'style');
    if (a?.value?.type === 'JSXExpressionContainer' && t.isObjectExpression(a.value.expression)) return a.value.expression;
    return null;
  };
  const styleStr = (obj: t.ObjectExpression | null, key: string): string | null => {
    if (!obj) return null;
    for (const pr of obj.properties) {
      if (!t.isObjectProperty(pr)) continue;
      const k = t.isIdentifier(pr.key) ? pr.key.name : t.isStringLiteral(pr.key) ? pr.key.value : '';
      if (k !== key) continue;
      if (t.isStringLiteral(pr.value)) return pr.value.value;
      return '__expr__';
    }
    return null;
  };
  const elements = new Map<string, t.JSXElement>();
  traverse(ast, {
    JSXElement(path) {
      const id = stringAttr(jsxAttrs(path.node.openingElement), 'data-id');
      if (id) elements.set(id, path.node);
    },
  });

  // 3. walk each media block
  const mediaRe = /@media[^{]*\{/g;
  let m: RegExpExecArray | null;
  while ((m = mediaRe.exec(css))) {
    let depth = 1;
    let i = mediaRe.lastIndex;
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') depth--;
      i++;
    }
    const block = css.slice(mediaRe.lastIndex, i - 1);
    const header = m[0].slice(0, -1).trim();
    const rules = new Map<string, string>();
    const ruleRe = /\[data-id="([^"]+)"\][^{]*\{([^}]*)\}/g;
    let r: RegExpExecArray | null;
    while ((r = ruleRe.exec(block))) {
      rules.set(r[1], (rules.get(r[1]) ?? '') + r[2]);
    }
    for (const [pid, decls] of rules) {
      if (!/flex-direction\s*:\s*column/.test(decls)) continue;
      const parent = elements.get(pid);
      if (!parent) continue;
      for (const child of parent.children) {
        if (!t.isJSXElement(child)) continue;
        const cAttrs = jsxAttrs(child.openingElement);
        const cId = stringAttr(cAttrs, 'data-id');
        if (!cId) continue;
        const cObj = styleObjectOf(child);
        const pos = styleStr(cObj, 'position');
        if (pos === 'absolute' || pos === 'fixed' || pos === 'sticky') continue;
        const inlineFlex = styleStr(cObj, 'flex');
        if (!inlineFlex || inlineFlex === '__expr__') continue;
        if (!/^[1-9]\d*\s+\d+\s+0(px)?$/.test(inlineFlex.trim())) continue; // only the row-fill form collapses
        const childDecls = rules.get(cId) ?? '';
        const rebased = /flex\s*:\s*0\s+0\s+auto/.test(childDecls);
        if (rebased) continue;
        const line = child.openingElement.loc?.start.line;
        v.push({
          code: 'MEDIA_COLUMN_FLIP_MISSING_REBASE', tier: 2, line, elementId: cId,
          message: `<${cId}> has flex: '${inlineFlex}' (row-fill) while the ${header} block flips its parent <${pid}> to flex-direction: column. In column direction that basis-0 governs HEIGHT, so the child collapses to a 0-height strip unless it has enough text content — and a height override does NOT help (flex-basis outranks height). Add to the SAME media block: [data-id="${cId}"]{ flex: 0 0 auto !important; width: 100% !important; }.`,
        });
      }
    }
  }
}

export { checkSlotComponentInlineChildren, checkUnresolvableTernary, checkGridNeedsTemplate, checkGridChildSpan, checkCanvasFillFeedback, checkPaddingNeedsLayout, checkFlexChildOrder, checkOrderIsString, checkFlexChildShrink, checkImageBackgroundFrame, checkNoLayoutParentRelativeChild, checkMediaColumnFlipRebase };
