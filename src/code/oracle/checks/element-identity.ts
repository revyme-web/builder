// oracle/checks/element-identity.ts — element identity rules (page variable
// types, event variables, component fluid width).
// All code moved VERBATIM from check-file.ts (Phase 7.1 god-file split).

import * as t from '@babel/types';
import { traverse, jsxAttrs, stringAttr } from './shared';
import type { OracleViolation } from './shared';

// ─── element identity rules ───────────────────────────────────────────────────

/** COMPONENT FLUID WIDTH — the canvas master is a FIXED-SIZE artboard, but a
 *  page INSTANCE resizes its root via the ...style spread. A non-root child
 *  whose width is pinned to the artboard width (a px literal matching the
 *  root, or a per-variant ternary MIRRORING the root's widths) does NOT
 *  follow when the instance root resizes — the component renders at the
 *  artboard width regardless of the instance, so it is not responsive. Such
 *  spanning children must use width: '100%' (fills the root on every variant
 *  tile AND stretches with the instance). High-signal: fires only when EVERY
 *  width the child can take is one of the root's artboard widths. */
/** PAGE_VARIABLE_INVALID_TYPE — the @pageVariables parser (`isPageVariableType`,
 *  page-variables.ts) accepts ONLY `number|text|boolean|color|image|componentCursor`.
 *  Any other `type` is silently dropped by `normalizeVariable` → the variable
 *  VANISHES from the page (no pill, no instance/template control). Rich variable
 *  types (transition, shadow, border, radius, and the option/select kind) are
 *  @propMeta types layered on top of a VALID @pageVariables base type — they are
 *  NEVER the @pageVariables `type` itself. We tolerate `option` (it round-trips
 *  through the @propMeta options + the component-info parser even though
 *  getPageVariables drops it) but bounce every other non-base type. */
const PAGE_VARIABLE_BASE_TYPES = new Set(['number', 'text', 'boolean', 'color', 'image', 'componentCursor', 'option']);
function checkPageVariableTypes(code: string, v: OracleViolation[]): void {
  const m = code.match(/@pageVariables\s*([\s\S]*?)\*\//);
  if (!m) return;
  let parsed: unknown;
  try { parsed = JSON.parse(m[1].trim()); } catch { return; /* malformed JSON is another check's problem */ }
  const vars = (parsed as { variables?: unknown })?.variables;
  if (!Array.isArray(vars)) return;
  for (const pv of vars) {
    if (!pv || typeof pv !== 'object') continue;
    const ty = (pv as { type?: unknown }).type;
    const nm = (pv as { name?: unknown }).name;
    if (typeof ty !== 'string' || PAGE_VARIABLE_BASE_TYPES.has(ty)) continue;
    const name = typeof nm === 'string' ? nm : '(unnamed)';
    const base = ty === 'componentCursor' ? 'componentCursor' : 'text';
    v.push({
      code: 'PAGE_VARIABLE_INVALID_TYPE', tier: 2,
      message: `@pageVariables variable "${name}" has type "${ty}" — the page-variable parser only accepts number, text, boolean, color, image, componentCursor, so it SILENTLY DROPS this variable and it vanishes from the page (no bound pill, no template/instance control). Rich types like transition / shadow / border / radius are @propMeta types, NOT @pageVariables types: set the @pageVariables type to the valid base "${base}" and declare the rich type in the @propMeta block instead — e.g. @pageVariables { … "type": "${base}" … } together with @propMeta {"${name}":{"type":"${ty}","label":"…"}}. (A component cursor uses "componentCursor"; a web/CSS cursor or any enum is "option" with an "options" list in @propMeta.)`,
    });
  }
}

/** EVENT VARIABLES — a standard component event is a callback PROP, not a
 *  data prop. Declared in @propMeta as `"type": "event"`, it must be a BARE
 *  destructured param (no default — it's a function the instance passes), and
 *  a child fires it with the bare identifier (onClick={eventName} /
 *  onMouseEnter / onMouseLeave, or onClick={() => setTimeout(eventName, ms)}).
 *  Two failure modes the editor never produces but a model might: giving the
 *  event prop a default value (then it's a string, not callable), or calling
 *  it at render (onClick={eventName()} fires on mount / crashes). */
function checkEventVariables(code: string, ast: t.File, v: OracleViolation[]): void {
  // Event prop names from @propMeta (type 'event').
  const pm = code.match(/@propMeta\s*([\s\S]*?)\*\//);
  const eventNames = new Set<string>();
  if (pm) {
    try {
      const obj = JSON.parse(pm[1].trim()) as Record<string, { type?: string }>;
      for (const [k, meta] of Object.entries(obj)) if (meta && meta.type === 'event') eventNames.add(k);
    } catch { /* malformed propMeta is another check's problem */ }
  }
  if (eventNames.size === 0) return;

  // 1) The component function must destructure each event prop BARE (no default).
  traverse(ast, {
    Function(path) {
      const p0 = path.node.params[0];
      if (!p0 || !t.isObjectPattern(p0)) return;
      for (const prop of p0.properties) {
        if (!t.isObjectProperty(prop) || !t.isIdentifier(prop.key)) continue;
        if (!eventNames.has(prop.key.name)) continue;
        // AssignmentPattern value ⇒ the param has a default (`event1 = '…'`).
        if (t.isAssignmentPattern(prop.value)) {
          v.push({
            code: 'EVENT_VAR_HAS_DEFAULT', tier: 2, line: prop.loc?.start.line,
            message: `Event prop "${prop.key.name}" has a default value — a component event is a CALLBACK the page instance passes, not a data prop. Declare it BARE before ...rest: function Name({ style, initialVariant = 'default', ${prop.key.name}, ...rest }). A default makes it a string, so firing it crashes.`,
          });
        }
      }
    },
  });

  // 2) A child must FIRE an event with the bare identifier, never call it at
  //    render. Flag `onX={eventName()}` (calls on mount) for any event prop.
  traverse(ast, {
    JSXAttribute(path) {
      const val = path.node.value;
      if (!val || !t.isJSXExpressionContainer(val)) return;
      const expr = val.expression;
      // onClick={eventName()} — a CallExpression on a bare event identifier.
      if (t.isCallExpression(expr) && t.isIdentifier(expr.callee) && eventNames.has(expr.callee.name)) {
        const attr = t.isJSXIdentifier(path.node.name) ? path.node.name.name : '';
        v.push({
          code: 'EVENT_FIRE_CALLED_AT_RENDER', tier: 2, line: path.node.loc?.start.line,
          message: `${attr}={${expr.callee.name}()} CALLS the event at render (fires on mount / crashes if undefined). Pass the callback BARE: ${attr}={${expr.callee.name}}. For a delay: onClick={() => setTimeout(${expr.callee.name}, 500)}.`,
        });
      }
    },
  });
}

function checkComponentFluidWidth(code: string, ast: t.File, v: OracleViolation[]): void {
  const styleObjectOf = (el: t.JSXElement): t.ObjectExpression | null => {
    const a = jsxAttrs(el.openingElement).find((x) => x.name.name === 'style');
    if (a?.value?.type === 'JSXExpressionContainer' && t.isObjectExpression(a.value.expression)) return a.value.expression;
    return null;
  };
  const hasSpread = (obj: t.ObjectExpression): boolean => obj.properties.some((pr) => t.isSpreadElement(pr));
  const widthNode = (obj: t.ObjectExpression): t.Node | null => {
    for (const pr of obj.properties) {
      if (!t.isObjectProperty(pr)) continue;
      const k = t.isIdentifier(pr.key) ? pr.key.name : t.isStringLiteral(pr.key) ? pr.key.value : '';
      if (k === 'width') return pr.value;
    }
    return null;
  };
  // px value-set a width expression can produce; null if ANY branch is not a
  // bare px literal (auto/%/max-content/calc/var ⇒ already fluid/intentional).
  const pxSet = (node: t.Node | null): number[] | null => {
    if (!node) return null;
    if (t.isStringLiteral(node)) {
      const m = /^(\d+(?:\.\d+)?)px$/.exec(node.value.trim());
      return m ? [parseFloat(m[1])] : null;
    }
    if (t.isNumericLiteral(node)) return [node.value];
    if (t.isConditionalExpression(node)) {
      const a = pxSet(node.consequent); const b = pxSet(node.alternate);
      if (a == null || b == null) return null;
      return [...a, ...b];
    }
    return null;
  };

  // Locate the root: first element (DFS) whose style object carries a spread.
  const found: { root: t.JSXElement | null; set: number[] | null } = { root: null, set: null };
  traverse(ast, {
    JSXElement(path) {
      if (found.root) return;
      const so = styleObjectOf(path.node);
      if (so && hasSpread(so)) { found.root = path.node; found.set = pxSet(widthNode(so)); }
    },
  });
  const rootEl = found.root;
  if (!rootEl || !found.set || found.set.length === 0) return;
  const rootWidths = new Set(found.set);

  traverse(ast, {
    JSXElement(path) {
      if (path.node === rootEl) return;
      const so = styleObjectOf(path.node);
      if (!so) return;
      const wn = widthNode(so);
      const cs = pxSet(wn);
      if (!cs || cs.length === 0) return;
      // Every width this child can take is an artboard width ⇒ pinned.
      if (!cs.every((w) => rootWidths.has(w))) return;
      const attrs = jsxAttrs(path.node.openingElement);
      const id = stringAttr(attrs, 'data-id') ?? '(element)';
      const line = path.node.openingElement.loc?.start.line;
      const widthText = wn && wn.start != null && wn.end != null ? code.slice(wn.start, wn.end) : `${cs.join('/')}px`;
      v.push({
        code: 'COMPONENT_CHILD_FIXED_WIDTH', tier: 2, line, elementId: id,
        message: `<${id}> (line ${line}) hardcodes width ${widthText}, matching the component's artboard/root width. The canvas master is fixed-size, but a PAGE INSTANCE resizes the root via ...style — a child pinned to the artboard width can't follow, so the component renders non-responsively (full artboard width even when the instance is 100%). Spanning children must be width: '100%' (it fills the root on every variant tile AND stretches with the instance). For a flex child that should grow instead, use flex: '1 1 auto'.`,
      });
    },
  });
}


export { checkPageVariableTypes, checkEventVariables, checkComponentFluidWidth };
