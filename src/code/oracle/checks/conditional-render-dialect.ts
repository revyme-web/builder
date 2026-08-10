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
  if (/@controls\s*\{/.test(code)) return;                 // code component — black box
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
    JSXExpressionContainer(path) {
      const expr = path.node.expression;
      if (!t.isLogicalExpression(expr) || expr.operator !== '&&') return;
      const el = gatedElement(expr.right);
      if (!el) return;                                  // not a conditional RENDER

      // A code component's internals can appear inline in a page only via an
      // @controls block; those files are exempted above by kind.
      if (isBuilderGatedElement(el)) return;

      // Variant gating: EVERY test must be a variant comparison. A mixed chain
      // (`variant !== 'a' && isCompact`) is not something the Hide control can
      // read back, so it does not qualify.
      const tests = conditionTests(expr);
      if (tests.length > 0 && tests.every(isVariantTest)) return;

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
