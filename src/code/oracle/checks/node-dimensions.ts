// oracle/checks/node-dimensions.ts — node dimension rules (explicit width/height).
// All code moved VERBATIM from check-file.ts (Phase 7.1 god-file split).

import { parse } from '@babel/parser';
import * as t from '@babel/types';
import { traverse, jsxTagName, jsxAttrs, stringAttr } from './shared';

// ── NODE DIMENSIONS — every normal node carries an EXPLICIT width + height ──
// A "normal node" is a NATIVE element (div / p / h* / span / a / img / svg / motion.*) OR a
// styled link primitive (Link / MotionLink — they render an anchor and carry real layout
// styles) that has a data-id. DESIGN-COMPONENT instances (other PascalCase tags) are exempt —
// their size comes from the master + the ...style spread, so injecting here would wrongly
// override the component's own dimensions; so are the page root (the artboard: width 100% /
// auto height) and parked canvas-nodes. Returns the node when it's in scope for the rule.
function isDimensionedNode(opening: t.JSXOpeningElement): { id: string; obj: t.ObjectExpression | null } | null {
  const tag = jsxTagName(opening.name);
  const base = tag.startsWith('motion.') ? tag.slice('motion.'.length) : tag;
  // native lowercase tag, or the link primitives Link / MotionLink — NOT other components
  if (!/^[a-z]/.test(base) && base !== 'Link' && base !== 'MotionLink') return null;
  const attrs = jsxAttrs(opening);
  const id = stringAttr(attrs, 'data-id');
  if (!id || id === 'root') return null;                              // root = the page artboard
  if (stringAttr(attrs, 'data-canvas-node') === 'true') return null;  // parked / slot scratch
  const styleA = attrs.find((x) => x.name.name === 'style');
  const obj = styleA?.value?.type === 'JSXExpressionContainer' && t.isObjectExpression(styleA.value.expression)
    ? styleA.value.expression : null;
  return { id, obj };
}

function objHasKey(obj: t.ObjectExpression, key: string): boolean {
  return obj.properties.some((pr) => t.isObjectProperty(pr)
    && (t.isIdentifier(pr.key) ? pr.key.name : t.isStringLiteral(pr.key) ? pr.key.value : '') === key);
}

/** Is this element INSIDE an `<svg>` — i.e. a nested shape svg or an svg
 *  geometry child (path / g / rect / circle / …)?
 *
 *  Vector interiors are sized by the viewBox + x/y/width/height ATTRIBUTES,
 *  never by CSS box props: Chromium doesn't even paint CSS width/height on a
 *  nested svg, which is exactly what the sibling rule NESTED_SVG_BOX_IN_STYLE
 *  rejects. Injecting `width/height: 'auto'` here therefore wrote source the
 *  builder's OWN oracle bounces — a Figma import came back from a commit with
 *  1717 nested svgs carrying the injected pair, and the next submit failed
 *  (live find 2026-07-30). The OUTER svg wrapper is a real CSS box and still
 *  gets dimensions; only its interior is exempt. */
function isInsideSvg(path: { findParent: (fn: (p: any) => boolean) => unknown }): boolean {
  return !!path.findParent((p: any) =>
    t.isJSXElement(p.node) && jsxTagName(p.node.openingElement.name).replace(/^motion\./, '') === 'svg');
}

/** Inject explicit `width/height: 'auto'` into every normal node that omits them, so the
 *  committed source is never sizeless. Same node criteria as checkNodeDimensions. Pure
 *  string-injection right after the style object's opening `{` — preserves all existing
 *  formatting/values, no babel reprint. Idempotent. The gate runs this BEFORE checkFile so
 *  editor AND AI output always carry dimensions (prime-rule safe). */
export function ensureNodeDimensions(code: string): string {
  let ast: t.File;
  try { ast = parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] }); }
  catch { return code; }
  const inserts: Array<{ pos: number; text: string }> = [];
  traverse(ast, {
    JSXElement(path) {
      const node = isDimensionedNode(path.node.openingElement);
      if (!node || !node.obj || node.obj.start == null) return; // no style obj → can't inject (checker flags it)
      if (isInsideSvg(path)) return;                            // vector interior — sized by attrs, not CSS
      const add: string[] = [];
      if (!objHasKey(node.obj, 'width')) add.push("width: 'auto'");
      if (!objHasKey(node.obj, 'height')) add.push("height: 'auto'");
      if (add.length) inserts.push({ pos: node.obj.start + 1, text: ` ${add.join(', ')},` });
    },
  });
  if (!inserts.length) return code;
  inserts.sort((a, b) => b.pos - a.pos); // apply end → start so offsets stay valid
  let out = code;
  for (const ins of inserts) out = out.slice(0, ins.pos) + ins.text + out.slice(ins.pos);
  return out;
}

export { objHasKey };
