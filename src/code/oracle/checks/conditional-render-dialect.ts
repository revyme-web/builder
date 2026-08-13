// oracle/checks/conditional-render-dialect.ts — what may gate a mounted element.
//
// A `{cond && <el/>}` conditional render decides whether an element EXISTS. The
// builder renders the canvas from the parsed node map, not by executing the
// page, so it cannot evaluate `cond` — an element behind an unrecognised
// condition is registered as an ordinary child and painted in EVERY viewport,
// while the live site mounts it only when the condition happens to be true.
// Editor and production then disagree, and no control can fix it: the Hide
// control writes `hiddenOnVariants` or a per-viewport `display`, neither of
// which touches a hand-written gate, so toggling visibility layers a second,
// conflicting mechanism on top.
//
// The builder emits exactly THREE conditional renders, and each is recognised by
// the GATED ELEMENT, not by the condition text:
//
//   overlay      <AnimatePresence>{<id>Open && (<motion.div data-overlay='…'/>)}
//                  — overlay-gen.ts
//   visibility   <AnimatePresence mode="popLayout">{variant !== 'a' && (<el/>)}
//                  — variant-visibility-gen.ts (the Hide control / layers eye)
//   pagination   {visX < coll.length && <LoadMore data-pagination-ui="true"/>}
//                  — cms-pagination-gen.ts
//
// What this rule exists to stop (a real customer page, 2026-08-10):
//
//   const [isCompact, setIsCompact] = useState(false);
//   useEffect(() => { … window.matchMedia('(max-width: 768px)') … }, []);
//   <AnimatePresence>{isCompact && (<motion.button data-id="nav-burger" …/>)}</AnimatePresence>
//
// A breakpoint-gated MOUNT. It renders, so nothing crashed and no rule fired,
// but the burger and its three bars parsed as plain children of the nav with
// `hiddenOnVariants: null` — shown on every canvas viewport, mounted on the live
// site only below 768px. The generator dialect already taught the native way
// ("Hide-on-viewport = display: none inside that viewport's rule", and the
// three-variant responsive nav recipe) and the AI had used @media for ~40 other
// elements in the same file — it hand-rolled the nav anyway. Prose in a prompt
// is not a gate; this is.

import * as t from '@babel/types';
import { traverse, jsxTagName, jsxAttrs, stringAttr, hasAttr } from './shared';
import { MOTION_ONLY_PROPS } from './motion-tag';
import { isCodeComponentSource } from './shared';
import type { OracleViolation, FileKind } from './shared';

/** Identifiers the builder's own variant gating uses. */
const VARIANT_IDENTS = new Set(['variant', 'initialVariant']);

/** Flatten `a && b && <jsx/>` into its test operands (the JSX tail excluded). */
function conditionTests(expr: t.LogicalExpression): t.Node[] {
  const tests: t.Node[] = [];
  let cur: t.Node = expr.left;
  for (let d = 0; d < 32; d++) {
    if (t.isLogicalExpression(cur) && cur.operator === '&&') {
      tests.unshift(cur.right);
      cur = cur.left;
      continue;
    }
    tests.unshift(cur);
    break;
  }
  return tests;
}

/** `<ident> === '…'` / `<ident> !== '…'` against a variant identifier. */
function isVariantTest(node: t.Node): boolean {
  if (!t.isBinaryExpression(node)) return false;
  if (!['===', '!==', '==', '!='].includes(node.operator)) return false;
  const named = (n: t.Node) => t.isIdentifier(n) && VARIANT_IDENTS.has(n.name);
  return (named(node.left) && t.isStringLiteral(node.right))
    || (named(node.right) && t.isStringLiteral(node.left));
}

/** One variant test, or the visibility generator's positive OR chain
 *  `variant === 'C' || variant === 'D'` — variant-visibility-gen.ts emits it
 *  when fewer variants SHOW the element than hide it (first shipped version
 *  flagged the builder's own OR gates on a committed nav, 2026-08-13). */
function isVariantTestOrChain(node: t.Node): boolean {
  if (t.isLogicalExpression(node) && node.operator === '||') {
    return isVariantTestOrChain(node.left) && isVariantTestOrChain(node.right);
  }
  return isVariantTest(node);
}

/**
 * Byte ranges of the builder's OWN injected helpers.
 *
 * `useMediaQuery` legitimately contains `window.matchMedia`, and
 * `useResponsiveText` legitimately reads `window.innerWidth` — they are
 * generator output, not hand-written responsive logic. Matched the same way
 * check-file's NO_COMMENTS exemption does (whole FunctionDeclaration, so it
 * survives babel dropping the marker comments).
 */
function injectedHelperRanges(code: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const re of [/function useMediaQuery\([\s\S]*?\n\}/, /function useResponsiveText\([\s\S]*?\n\}/]) {
    const m = code.match(re);
    if (m && m.index !== undefined) ranges.push([m.index, m.index + m[0].length]);
  }
  const fence = code.match(/\/\/ @useResponsiveText-begin[\s\S]*?\/\/ @useResponsiveText-end/);
  if (fence && fence.index !== undefined) ranges.push([fence.index, fence.index + fence[0].length]);
  return ranges;
}

/**
 * HAND-WRITTEN VIEWPORT LISTENER — the root of the whole class.
 *
 * `CONDITIONAL_RENDER_UNSUPPORTED` below catches a breakpoint boolean used to
 * gate a MOUNT, but the same boolean escapes through a JSX ternary, a style
 * value or a prop. Rather than chase every consumer, reject the SOURCE: a
 * `window.matchMedia` / `window.innerWidth` listener driving React state is not
 * how this builder does responsive, whatever it is later used for.
 *
 * The builder's mechanism is CSS — per-viewport overrides become `@media` rules
 * in the page's one `<style>` block (`@container` at canvas render). When a
 * value genuinely must be a JS boolean (a motion prop, a responsive attr), the
 * builder injects its OWN `useMediaQuery` helper and reads it through
 * `const __mqN = useMediaQuery('…')` — a shape `scoped-expr.ts` can parse back.
 * A bespoke hook is invisible to every panel.
 */
export function checkHandWrittenMediaQuery(
  code: string,
  ast: t.File,
  v: OracleViolation[],
  kind: FileKind,
): void {
  if (kind !== 'page' && kind !== 'component' && kind !== 'template') return;
  if (isCodeComponentSource(code)) return;                 // code component — black box
  const exempt = injectedHelperRanges(code);
  const inHelper = (idx: number) => exempt.some(([s, e]) => idx >= s && idx < e);

  const seen = new Set<number>();
  traverse(ast, {
    MemberExpression(path) {
      const prop = path.node.property;
      if (!t.isIdentifier(prop)) return;
      if (prop.name !== 'matchMedia' && prop.name !== 'innerWidth') return;
      if (!t.isIdentifier(path.node.object) || path.node.object.name !== 'window') return;
      const at = path.node.start ?? -1;
      if (at < 0 || inHelper(at)) return;
      const line = path.node.loc?.start.line;
      if (line != null && seen.has(line)) return;
      if (line != null) seen.add(line);
      v.push({
        code: 'RESPONSIVE_JS_HANDWRITTEN', tier: 2, line,
        message: `[responsive] Line ${line} reads window.${prop.name} to drive responsive behaviour by hand. That is not how this builder expresses responsive: per-viewport differences are CSS — the page's ONE <style> block carries \`@media (max-width: <viewportWidth>px) { [data-id="…"] { … } }\` rules keyed exactly at each replica viewport's width, and the canvas renders them as @container queries. HIDE ON A VIEWPORT is \`display: none\` inside that viewport's rule, with the element MOUNTED in every viewport — never a conditional mount, ternary or prop driven by a breakpoint boolean, because the canvas renders from the parsed source and cannot evaluate your boolean: the element shows in every viewport in the editor while the live site follows the media query. For a RESPONSIVE NAV, build a design component with 'default' / 'mobile' / 'mobile-open' variants — the page instance's data-responsive width map picks desktop⇄mobile (no connection), and a click connection drives mobile⇄mobile-open. When a value genuinely must be a JS boolean (a motion prop, a responsive input attr), the EDITOR injects its own \`function useMediaQuery(query)\` helper and reads it as \`const __mqN = useMediaQuery('(max-width: …px)')\` — a shape the parser round-trips. A bespoke useState + listener is invisible to every panel in the editor.`,
      });
    },
  });
}

/**
 * Event handlers the builder can WRITE and READ BACK.
 *
 * Derived from what the generators actually emit: the Interactions panel owns
 * `click` / `mouseEnter` / `mouseLeave` (page-interactions.ts), forms own
 * `onSubmit` / `onChange`, framer connections on a component master own the
 * tap/hover pair, and `onLoadMore` / `onTrigger` are instance props.
 */
const READABLE_HANDLERS = new Set([
  // Interactions panel (page-interactions.ts owns exactly these three).
  'onClick', 'onMouseEnter', 'onMouseLeave',
  // Forms.
  'onSubmit', 'onChange',
  // Instance props the builder wires (Load More, plugin trigger, icon pick).
  'onLoadMore', 'onTrigger', 'onPick',
  // Every framer gesture/viewport event, taken from the ONE list the codebase
  // already maintains (motion-tag.ts). Hand-curating this set is how the first
  // version of this rule flagged `onTapCancel` — which the composed-fx press
  // generator emits — on the builder's own canonical fixture.
  ...[...MOTION_ONLY_PROPS].filter((p) => /^on[A-Z]/.test(p)),
]);

/**
 * A HANDLER NO CONTROL CAN SEE.
 *
 * An interaction is only real if a panel can read it back — otherwise the page
 * behaves one way and the editor shows nothing, and the user cannot change or
 * remove it. On a real customer page (2026-08-10) a close button carried BOTH
 * `onClick` (the Close Overlay interaction, visible in the panel) and
 * `onPointerDown` doing the same thing (invisible to everything).
 *
 * Scoped to INTRINSIC elements — a lowercase tag or `motion.*`. A capitalised
 * tag is a component instance whose props are declared by that component (a
 * code component's `@controls` can expose any handler it likes), and those are
 * none of this rule's business.
 */
export function checkUnreadableHandlers(
  code: string,
  ast: t.File,
  v: OracleViolation[],
  kind: FileKind,
): void {
  if (kind !== 'page' && kind !== 'component' && kind !== 'template') return;
  if (isCodeComponentSource(code)) return;
  const seen = new Set<string>();

  traverse(ast, {
    JSXOpeningElement(path) {
      const tag = jsxTagName(path.node.name);
      const base = tag.startsWith('motion.') ? tag.slice(7) : tag;
      if (!base || base[0] !== base[0].toLowerCase()) return;   // component instance — skip
      const attrs = jsxAttrs(path.node);
      const id = stringAttr(attrs, 'data-id');
      for (const a of attrs) {
        const name = typeof a.name.name === 'string' ? a.name.name : '';
        if (!/^on[A-Z]/.test(name) || READABLE_HANDLERS.has(name)) continue;
        const key = `${id ?? ''}:${name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        v.push({
          code: 'INTERACTION_HANDLER_UNREADABLE', tier: 2,
          line: a.loc?.start.line, elementId: id ?? undefined,
          message: `[interaction] <${tag}>${id ? ` (data-id="${id}")` : ''} carries \`${name}\`, which no control in the editor can read back — the page behaves one way and every panel shows nothing, so the user cannot see, change or remove it. The builder authors exactly these handlers: onClick / onMouseEnter / onMouseLeave (the Interactions panel, incl. Set Variable and Close Overlay), onSubmit + onChange (forms), onTap / onTapStart / onHoverStart / onHoverEnd (framer connections between variants on a component master), and onLoadMore / onTrigger (instance props). Express the behaviour with one of those — a tap is \`onClick\`, and if you added ${name} for touch responsiveness note that \`touchAction: 'manipulation'\` is what actually removes the tap delay.`,
        });
      }
    },
  });
}

/**
 * THE FREE-JAVASCRIPT FENCE — hooks the builder did not inject.
 *
 * Pages and design components carry hooks ONLY as generator output: overlay
 * state + positioner effects, the variant `useState(initialVariant)` pair,
 * pagination `vis*` counters and their IntersectionObserver, form lifecycle
 * state, scroll refs/values (their SHAPE is scroll-dialect's business), the
 * injected `useMediaQuery`/`useResponsiveText` helpers, and composed-motion
 * `animate()` effects. Everything else — `setInterval` countdowns, hand-rolled
 * scroll/resize listeners, IntersectionObservers driving custom state,
 * localStorage, client `fetch()` — renders fine and is invisible to every
 * panel forever (verified passing the gate with zero violations, 2026-08-11).
 *
 * Detection is DANGER-first, then a positive allowlist of generator shapes,
 * then default-flag: an unknown effect is not benefit-of-the-doubt material,
 * because the whole class exists to hold behaviour no control can read.
 */
// Derived from `grep -rhoE "use[A-Z][A-Za-z]+\(" src/code/generation/*.ts` —
// every hook name a generator actually emits (minus useState/useEffect/
// useLayoutEffect, whose SHAPES are validated below). Hand-curating this set
// is how the first draft flagged `useMotionValueEvent` on the builder's own
// composed-fx conformance fixture; keep it in sync with the grep.
const ALLOWED_HOOK_CALLEES = new Set([
  // Scroll/motion dialect owns the shape of these (scroll-dialect.ts).
  'useScroll', 'useTransform', 'useSpring', 'useMotionValue', 'useMotionTemplate',
  'useMotionValueEvent', 'useInView', 'useRef',
  // Builder-injected / runtime helpers.
  'useMediaQuery', 'useResponsiveText', 'useResponsiveListConfig', 'useOverlayPos',
  // Localization + routing reads the generators emit.
  'useLocale', 'useTranslations', 'useParams', 'usePathname', 'useRouter',
]);

/** Effect bodies that ALWAYS mean hand-rolled behaviour, whatever else is in them. */
const EFFECT_DANGER = /setInterval\s*\(|addEventListener\s*\(\s*['"](scroll|resize|keydown|keyup|wheel|touchmove|mousemove)['"]|localStorage|sessionStorage|\bfetch\s*\(|new\s+WebSocket|requestAnimationFrame\s*\(/;

/** Effect bodies the generators emit (any one marker qualifies). */
const EFFECT_ALLOWED: RegExp[] = [
  /setVariant\s*\(\s*initialVariant\s*\)/,           // variant sync (connections)
  /setTimeout\s*\([\s\S]*setVariant\s*\(/,           // afterDelay chain
  /prevOverflow/,                                    // fixed-overlay body lock
  /getBoundingClientRect|\[data-id=/,                // overlay positioner
  /new\s+IntersectionObserver[\s\S]*set[A-Z_$]/,     // pagination sentinel
  /\banimate\s*\([\s\S]*\.stop\s*\(\s*\)/,           // composed appear/loop
  /document\.getElementById\s*\([\s\S]*\.current\s*=/, // scroll section ref resolve
];

export function checkPageHooks(
  code: string,
  ast: t.File,
  v: OracleViolation[],
  kind: FileKind,
): void {
  if (kind !== 'page' && kind !== 'component' && kind !== 'template') return;
  if (isCodeComponentSource(code)) return;                 // code component — black box
  const exempt = injectedHelperRanges(code);
  const inHelper = (idx: number) => exempt.some(([s, e]) => idx >= s && idx < e);
  const seen = new Set<number>();

  const flag = (line: number | undefined | null, what: string, teach: string) => {
    if (line != null && seen.has(line)) return;
    if (line != null) seen.add(line);
    v.push({
      code: 'PAGE_HOOK_UNRESOLVED', tier: 2, line: line ?? undefined,
      message: `[hooks] Line ${line} — ${what}. Pages and design components carry hooks ONLY as the builder's own generated shapes (overlay state + positioner, \`useState(initialVariant)\`, pagination \`vis*\` counters, form lifecycle, scroll refs/values, injected responsive helpers). A hand-written hook renders on the live site but is invisible to every panel in the editor — nobody can see, edit or remove the behaviour. ${teach}`,
    });
  };

  const TEACH =
    `Express the intent natively instead: an ANIMATION over time is the Animation panel (Appear / Loop / Scroll effects); RESPONSIVE behaviour is @media rules in the page's <style> block; SHOW/HIDE state is a design-component variant driven by a connection; DYNAMIC DATA from an API belongs in a CODE COMPONENT (a black box where free React is legitimate) — not in a page. If none of those fit, the behaviour is not supported on pages.`;

  // ── Scroll→Variant shapes (scroll-variant-gen.ts) ────────────────────────
  // The Animation panel's Scroll Variant emits `useState(<__mq-gated variant>)`
  // — a ternary chain over the injected media-query gates, optionally wrapped
  // `<fromVar> || (<gated>)` when a template variable binds the resting variant
  // — plus a reset `useEffect(() => { set<X>(<same expr>); }, [gates + vars])`.
  // First shipped rule flagged both on the builder's own committed output
  // (MAISON nav, 2026-08-13) — prime rule: canvas output must pass.
  const isMqGate = (n: t.Node): boolean => t.isIdentifier(n) && /^__mq\d+$/.test(n.name);
  const isMqGatedScalar = (n: t.Node): boolean => {
    if (t.isConditionalExpression(n)) {
      return isMqGate(n.test) && isMqGatedScalar(n.consequent) && isMqGatedScalar(n.alternate);
    }
    return t.isStringLiteral(n) || t.isIdentifier(n);        // leaves: variant name or bound variable
  };
  // The full resting expression a generated useState/reset-setter may carry.
  // A BARE identifier is NOT one (the generator never emits it alone) — that
  // stays flagged, or `useState(someVar)` hand-sync would slip the fence.
  const isGeneratedRestingExpr = (n: t.Node): boolean => {
    if (t.isConditionalExpression(n)) return isMqGatedScalar(n);
    if (t.isLogicalExpression(n) && n.operator === '||') {
      const leftOk = t.isStringLiteral(n.left) || t.isIdentifier(n.left)
        || (t.isConditionalExpression(n.left) && isMqGatedScalar(n.left));
      const rightOk = t.isStringLiteral(n.right)
        || (t.isConditionalExpression(n.right) && isMqGatedScalar(n.right));
      return leftOk && rightOk;
    }
    return false;
  };

  const acceptedInit = (arg: t.Node | undefined): boolean => arg === undefined
    || t.isStringLiteral(arg) || t.isNumericLiteral(arg) || t.isBooleanLiteral(arg)
    || (t.isUnaryExpression(arg) && t.isNumericLiteral(arg.argument))
    || (t.isIdentifier(arg) && arg.name === 'initialVariant')
    || isGeneratedRestingExpr(arg);

  // Setters declared by an ACCEPTED useState — the reset effect is only legal
  // when it calls one of these (pre-pass: the generator emits the useState
  // first, but hand code may not keep source order).
  const generatedSetters = new Set<string>();
  traverse(ast, {
    CallExpression(path) {
      const callee = path.node.callee;
      if (!t.isIdentifier(callee) || callee.name !== 'useState') return;
      const parent = path.parentPath?.node;
      if (!t.isVariableDeclarator(parent) || !t.isArrayPattern(parent.id)) return;
      const setter = parent.id.elements[1];
      if (!t.isIdentifier(setter)) return;
      if (acceptedInit(path.node.arguments[0])) generatedSetters.add(setter.name);
    },
  });

  traverse(ast, {
    CallExpression(path) {
      const callee = path.node.callee;
      if (!t.isIdentifier(callee) || !/^use[A-Z]/.test(callee.name)) return;
      const at = path.node.start ?? -1;
      if (at >= 0 && inHelper(at)) return;
      const line = path.node.loc?.start.line;

      if (ALLOWED_HOOK_CALLEES.has(callee.name)) return;

      if (callee.name === 'useState') {
        // Generated form: `const [x, setX] = useState(<literal | initialVariant>)`.
        const parent = path.parentPath?.node;
        const destructured = t.isVariableDeclarator(parent) && t.isArrayPattern(parent.id);
        const arg = path.node.arguments[0];
        const literalArg = acceptedInit(arg);
        if (destructured && literalArg) return;
        flag(line, `\`useState(${literalArg ? '…' : 'non-literal initializer'})\` outside the generated \`const [x, setX] = useState(<literal>)\` shape`, TEACH);
        return;
      }

      if (callee.name === 'useEffect' || callee.name === 'useLayoutEffect') {
        const body = code.slice(path.node.start ?? 0, path.node.end ?? 0);
        if (EFFECT_DANGER.test(body)) {
          flag(line, `a hand-written \`${callee.name}\` (timer / event listener / storage / fetch)`, TEACH);
          return;
        }
        if (EFFECT_ALLOWED.some((re) => re.test(body))) return;
        // Scroll→Variant reset effect: a single `set<X>(<generated resting expr>)`
        // whose setter comes from an accepted useState, deps all identifiers
        // (the __mq gates + any bound template variables). A bare-LITERAL reset
        // arg is generated only when the gates live elsewhere in the effect
        // block, so it must ride on pure `__mq*` deps.
        if (callee.name === 'useEffect') {
          const [fn, deps] = path.node.arguments;
          const stmts = t.isArrowFunctionExpression(fn) && t.isBlockStatement(fn.body) ? fn.body.body : null;
          const only = stmts?.length === 1 && t.isExpressionStatement(stmts[0]) ? stmts[0].expression : null;
          const depEls = t.isArrayExpression(deps) ? deps.elements : null;
          const allIdent = !!depEls && depEls.length > 0 && depEls.every((e) => t.isIdentifier(e));
          const allMq = allIdent && depEls!.every((e) => isMqGate(e as t.Node));
          if (only && t.isCallExpression(only) && t.isIdentifier(only.callee)
            && generatedSetters.has(only.callee.name) && only.arguments.length === 1) {
            const resetArg = only.arguments[0];
            const argOk = t.isStringLiteral(resetArg) ? allMq
              : t.isExpression(resetArg) && isGeneratedRestingExpr(resetArg) && allIdent;
            if (argOk) return;
          }
        }
        flag(line, `a \`${callee.name}\` that matches none of the builder's generated effect shapes`, TEACH);
        return;
      }

      // useCallback / useMemo / useReducer / useContext / any custom hook.
      flag(line, `\`${callee.name}()\` — a hook no generator emits`, TEACH);
    },
  });
}

/**
 * HANDLER BODIES — a readable NAME is not enough.
 *
 * `checkUnreadableHandlers` polices which handler PROPS may exist; this one
 * polices what may be INSIDE them. `onClick` is a readable name, but a body
 * doing `navigator.clipboard.writeText(...)` or `classList.toggle(...)` is
 * still invisible to every panel (verified passing with zero violations,
 * 2026-08-11). The generators emit handler bodies built EXCLUSIVELY from:
 * bare event-prop identifiers, calls to `set*` state setters, `setTimeout` /
 * `clearTimeout` wrapping those, and composed-motion `animate()` — nothing
 * else. `onSubmit` is exempt here: the FORM_* rules own its exact shape.
 */
export function checkHandlerBodies(
  code: string,
  ast: t.File,
  v: OracleViolation[],
  kind: FileKind,
): void {
  if (kind !== 'page' && kind !== 'component' && kind !== 'template') return;
  if (isCodeComponentSource(code)) return;
  const seen = new Set<string>();
  const ALLOWED_CALLEES = /^(set[A-Z_$]|setTimeout$|clearTimeout$|animate$)/;

  traverse(ast, {
    JSXAttribute(path) {
      const name = typeof path.node.name.name === 'string' ? path.node.name.name : '';
      if (!/^on[A-Z]/.test(name) || name === 'onSubmit') return;
      if (!READABLE_HANDLERS.has(name)) return;              // other rule's business
      const opening = path.parentPath?.node;
      if (!t.isJSXOpeningElement(opening)) return;
      const tag = jsxTagName(opening.name);
      const base = tag.startsWith('motion.') ? tag.slice(7) : tag;
      if (!base || base[0] !== base[0].toLowerCase()) return; // instance props — component's business

      const val = path.node.value;
      if (!t.isJSXExpressionContainer(val)) return;
      const expr = val.expression;
      if (t.isIdentifier(expr)) return;                      // bare event-prop fire
      if (!t.isArrowFunctionExpression(expr) && !t.isFunctionExpression(expr)) return;

      let offender: string | null = null;
      let offenderLine: number | undefined;
      path.get('value').traverse({
        CallExpression(inner) {
          if (offender) return;
          const c = inner.node.callee;
          const ok = (t.isIdentifier(c) && ALLOWED_CALLEES.test(c.name));
          if (!ok) {
            offender = code.slice(inner.node.start ?? 0, Math.min((inner.node.start ?? 0) + 60, inner.node.end ?? 0));
            offenderLine = inner.node.loc?.start.line;
          }
        },
        AssignmentExpression(inner) {
          if (offender) return;
          if (t.isMemberExpression(inner.node.left)) {
            offender = code.slice(inner.node.start ?? 0, Math.min((inner.node.start ?? 0) + 60, inner.node.end ?? 0));
            offenderLine = inner.node.loc?.start.line;
          }
        },
      });
      if (!offender) return;

      const attrs = jsxAttrs(opening);
      const id = stringAttr(attrs, 'data-id');
      const key = `${id ?? ''}:${name}`;
      if (seen.has(key)) return;
      seen.add(key);
      v.push({
        code: 'INTERACTION_HANDLER_BODY_UNREADABLE', tier: 2,
        line: offenderLine ?? path.node.loc?.start.line, elementId: id ?? undefined,
        message: `[interaction] <${tag}>${id ? ` (data-id="${id}")` : ''} — the \`${name}\` body contains \`${offender}…\`, which no panel can read back. Handler bodies the builder can resolve are built ONLY from: a bare event-prop identifier, calls to \`set*\` state setters (Set Variable, overlay open/close, pagination, search), \`setTimeout\`/\`clearTimeout\` wrapping those, and composed-motion \`animate()\`. Anything else (clipboard, classList, scrollIntoView, window.*, router pushes, analytics) behaves on the live site while the editor shows nothing. Express it natively: NAVIGATION is a Link/MotionLink href (incl. \`#section\` smooth-scroll); STATE is a variant connection or Set Variable; anything genuinely needing free JS belongs in a CODE COMPONENT.`,
      });
    },
  });
}

/** Unwrap `(<el/>)` / a JSX tail to the element being gated. */
function gatedElement(node: t.Node | null | undefined): t.JSXElement | null {
  if (!node) return null;
  if (t.isJSXElement(node)) return node;
  if (t.isParenthesizedExpression(node)) return gatedElement(node.expression);
  if (t.isJSXFragment(node)) {
    const first = node.children.find((c) => t.isJSXElement(c));
    return t.isJSXElement(first) ? first : null;
  }
  return null;
}

/**
 * Is this element one the builder legitimately gates? Recognised by the ELEMENT
 * (an attribute the generator stamps), never by the condition's variable name —
 * a name is trivially imitated, a marker means a generator wrote it.
 */
function isBuilderGatedElement(el: t.JSXElement): boolean {
  const attrs = jsxAttrs(el.openingElement);
  if (hasAttr(attrs, 'data-overlay')) return true;            // overlay-gen
  if (hasAttr(attrs, 'data-pagination-ui')) return true;      // cms-pagination-gen
  const id = stringAttr(attrs, 'data-id');
  if (id && id.startsWith('loadmore-')) return true;          // pagination, older files
  return false;
}

export function checkConditionalRenderDialect(
  ast: t.File,
  v: OracleViolation[],
  kind: FileKind,
): void {
  // A CODE COMPONENT is a black box — the builder never reads its internals, so
  // ordinary React conditionals inside it are none of this rule's business.
  if (kind !== 'page' && kind !== 'component' && kind !== 'template') return;

  const seen = new Set<number>();
  traverse(ast, {
    // The TERNARY spelling of the same defect. Bouncing `{cond && <X/>}` while
    // accepting `{cond ? <X/> : null}` doesn't close the gap — it TEACHES the
    // rewrite: the model's natural "fix" for a bounced && gate is the ternary
    // (verified live: the ternary form passed the gate with zero violations,
    // 2026-08-11). Both branches parse into permanent, always-visible nodes;
    // the live site mounts one. Text/attr ternaries (string branches) are a
    // different, supported dialect and are untouched here — this fires only
    // when a BRANCH IS JSX.
    ConditionalExpression(path) {
      // Only ternaries used AS JSX content — a ternary inside a style value or
      // attr belongs to other rules.
      if (!path.parentPath?.isJSXExpressionContainer()) return;
      const branches = [gatedElement(path.node.consequent), gatedElement(path.node.alternate)]
        .filter((b): b is t.JSXElement => b !== null);
      if (branches.length === 0) return;                // not a conditional RENDER
      if (branches.every(isBuilderGatedElement)) return;

      const first = branches[0];
      const attrs = jsxAttrs(first.openingElement);
      const id = stringAttr(attrs, 'data-id');
      const tag = jsxTagName(first.openingElement.name);
      const line = path.node.loc?.start.line;
      if (line != null && seen.has(line)) return;
      if (line != null) seen.add(line);

      v.push({
        code: 'CONDITIONAL_RENDER_UNSUPPORTED', tier: 2, line, elementId: id ?? undefined,
        message: `[conditional render] Line ${line} mounts <${tag}>${id ? ` (data-id="${id}")` : ''} behind a ternary (\`cond ? <jsx/> : …\`). This is the same unsupported shape as \`{cond && <jsx/>}\` in different spelling: the builder renders from the PARSED source and cannot evaluate the condition, so every JSX branch becomes a permanent always-visible node on the canvas while the live site mounts only one — editor and published page disagree and no control can repair it. Ternaries are supported for TEXT and ATTRIBUTE values (string branches), never for mounting elements. Express the intent a supported way: HIDE ON A VIEWPORT is \`display: none\` inside that viewport's @media rule (element stays mounted everywhere); state-driven show/hide is a design-component VARIANT (the Hide control per variant) driven by a connection; an OVERLAY is the data-overlay dialect. If both branches exist as designs, mount BOTH elements and control visibility per variant/viewport instead of swapping mounts.`,
      });
    },
    JSXExpressionContainer(path) {
      const expr = path.node.expression;
      if (!t.isLogicalExpression(expr) || expr.operator !== '&&') return;
      const el = gatedElement(expr.right);
      if (!el) return;                                  // not a conditional RENDER

      // A code component's internals can appear inline in a page only via an
      // @controls block; those files are exempted above by kind.
      if (isBuilderGatedElement(el)) return;

      // Variant gating: EVERY test must be a variant comparison (or a pure OR
      // chain of them — the generator's positive form). A mixed chain
      // (`variant !== 'a' && isCompact`) is not something the Hide control can
      // read back, so it does not qualify.
      const tests = conditionTests(expr);
      if (tests.length > 0 && tests.every(isVariantTestOrChain)) return;

      const attrs = jsxAttrs(el.openingElement);
      const id = stringAttr(attrs, 'data-id');
      const tag = jsxTagName(el.openingElement.name);
      const line = path.node.loc?.start.line;
      if (line != null && seen.has(line)) return;
      if (line != null) seen.add(line);

      v.push({
        code: 'CONDITIONAL_RENDER_UNSUPPORTED', tier: 2, line, elementId: id ?? undefined,
        message: `[conditional render] Line ${line} mounts <${tag}>${id ? ` (data-id="${id}")` : ''} behind a hand-written condition. The builder renders the canvas from the PARSED source — it never executes the page — so it cannot evaluate that condition: the element (and its whole subtree) is registered as an ordinary child and painted in EVERY viewport, while the live site mounts it only when the condition is true. The editor and the published page then disagree, and no control can repair it, because the Hide control writes hiddenOnVariants / a per-viewport display and neither touches your gate. Only THREE conditional renders are supported, each recognised by the gated element: an OVERLAY (the element carries data-overlay), per-VARIANT visibility (every test is \`variant\`/\`initialVariant\` === or !== a variant name, which is what the Hide control and the layers eye write), and the CMS Load More guard (data-pagination-ui). Express what you meant a supported way instead: HIDE ON A VIEWPORT is CSS, not a mount — put \`[data-id="${id ?? '…'}"] { display: none; }\` inside that viewport's @media rule in the page's <style> block, and keep the element mounted in all of them. A RESPONSIVE NAV is a design component with 'default' / 'mobile' / 'mobile-open' variants, where the page instance's data-responsive width map picks desktop⇄mobile (no connection) and a click connection drives mobile⇄mobile-open. Never gate a mount on a breakpoint boolean (a useState + window.matchMedia): that shape is unreachable from every panel in the editor.`,
      });
    },
  });
}
