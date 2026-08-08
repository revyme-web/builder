// oracle/checks/motion-tag.ts — motion props only do something on a motion tag.
//
// framer-motion props (`layout`, `variants`, `animate`, `initial`, `whileHover`,
// the tap/hover handlers, …) are React props of a `motion.*` component. Put them
// on a plain `<nav>` / `<section>` / `<div>` and React forwards them to the DOM
// as unknown attributes: no warning, no parse error, and — because the canvas
// renders statically, without motion — the artboard looks IDENTICAL. Only the
// live site and preview lose the animation.
//
// That silence is why this needs the oracle. A user retagged a component root
// to `nav` for semantics and its open/close stopped FLIP-animating; the file
// looked completely normal and the canvas agreed (report 2026-08-08). The
// codegen path that renames tags now preserves the `motion.` prefix, but an
// AI- or MCP-authored file bypasses codegen entirely and writes the tag
// directly — this is the only thing standing between that and a dead animation.
//
// Tier 2: the file parses and renders, so it isn't a blocker, but the element
// does not do what its own source says it does.

import * as t from '@babel/types';
import { traverse, jsxTagName, jsxAttrs } from './shared';
import type { OracleViolation } from './shared';

/** Props that ONLY mean something on a framer-motion component. `style` /
 *  `className` are deliberately absent — those work anywhere. */
const MOTION_ONLY_PROPS = new Set([
  'layout', 'layoutId', 'layoutScroll', 'layoutDependency', 'layoutRoot',
  'variants', 'animate', 'initial', 'exit', 'transition',
  'whileHover', 'whileTap', 'whileFocus', 'whileDrag', 'whileInView', 'viewport',
  'onTap', 'onTapStart', 'onTapCancel',
  'onHoverStart', 'onHoverEnd',
  'onViewportEnter', 'onViewportLeave',
  'drag', 'dragConstraints', 'dragElastic', 'dragMomentum',
]);

/** Tags that DO accept motion props: the `motion.*` proxy, and the
 *  `motion.create(...)` wrappers this codebase declares at module scope
 *  (`MotionLink`). An Uppercase component tag is exempt too — it's someone
 *  else's component and may well forward the props to a motion root. */
function acceptsMotionProps(tag: string): boolean {
  if (tag.startsWith('motion.')) return true;
  if (tag === 'MotionLink') return true;
  // Uppercase → a component, not a DOM element. Out of scope.
  return /^[A-Z]/.test(tag);
}

/**
 * Flag any DOM element carrying framer-motion props on a non-motion tag.
 *
 * The fix is always the same shape — prefix the tag — so the message says it
 * outright rather than describing the problem abstractly.
 */
export function checkMotionPropsNeedMotionTag(ast: t.File, v: OracleViolation[]): void {
  traverse(ast, {
    JSXOpeningElement(path: { node: t.JSXOpeningElement }) {
      const tag = jsxTagName(path.node.name);
      if (acceptsMotionProps(tag)) return;

      const attrs = jsxAttrs(path.node);
      const motionProps = attrs
        .map((a) => (t.isJSXIdentifier(a.name) ? a.name.name : ''))
        .filter((n) => MOTION_ONLY_PROPS.has(n));
      if (motionProps.length === 0) return;

      const idAttr = attrs.find((a) => t.isJSXIdentifier(a.name) && a.name.name === 'data-id');
      const elementId = idAttr && t.isStringLiteral(idAttr.value) ? idAttr.value.value : undefined;

      v.push({
        code: 'MOTION_PROPS_ON_PLAIN_TAG',
        tier: 2,
        elementId,
        line: path.node.loc?.start.line,
        message:
          `<${tag}> carries framer-motion ${motionProps.length === 1 ? 'prop' : 'props'} `
          + `(${motionProps.join(', ')}) but is not a motion component, so `
          + `${motionProps.length === 1 ? 'it is' : 'they are'} forwarded to the DOM and do nothing. `
          + `The canvas renders statically and looks correct either way — only the live site loses the animation. `
          + `Write <motion.${tag}> … </motion.${tag}> instead `
          + `(for a Next.js <Link>, use the MotionLink wrapper: const MotionLink = motion.create(Link)).`,
      });
    },
  });
}
