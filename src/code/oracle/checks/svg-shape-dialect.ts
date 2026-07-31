// oracle/checks/svg-shape-dialect.ts — SVG shape dialect checks.
// All code moved VERBATIM from check-file.ts (Phase 7.1 god-file split).

import * as t from '@babel/types';
import { traverse, jsxTagName, jsxAttrs, stringAttr } from './shared';
import type { OracleViolation } from './shared';

/** SVG SHAPE DIALECT — the builder's shape system resolves EXACTLY this
 *  structure (everything else renders but is dead to the controls/gestures):
 *
 *    <svg data-id="shape-X" viewBox="0 0 W H" preserveAspectRatio="none"
 *         style={{ position:'absolute', left/top/width/height px (== viewBox), overflow:'visible' }}>
 *      <path data-id="shape-X-g0" d="…" fill="#hex" stroke="#000000" stroke-width="0" />
 *    </svg>
 *
 *  Groups/icons: an outer svg wrapper whose CHILDREN are nested svg shapes
 *  positioned by x/y/width/height ATTRS (never CSS — Chromium doesn't paint
 *  CSS box props on a nested svg), each with its own 1:1 viewBox + ONE
 *  path child. Paint props live on the INNER path (the Fill/Stroke controls
 *  read & write there). Geometry is `d`-paths only — the shape editor,
 *  per-variant geometry and resize bakes all operate on `d`. */
function checkSvgShapeDialect(ast: t.File, v: OracleViolation[]): void {
  const GEOM_TAGS = new Set(['path', 'polygon', 'polyline', 'rect', 'circle', 'ellipse', 'line']);
  const PAINT_ATTRS = ['fill', 'stroke', 'stroke-width', 'strokeWidth', 'stroke-dasharray', 'strokeDasharray', 'stroke-linecap', 'strokeLinecap', 'stroke-linejoin', 'strokeLinejoin'];

  const baseTag = (tag: string): string => tag.startsWith('motion.') ? tag.slice('motion.'.length) : tag;
  const styleObjectOf = (attrs: t.JSXAttribute[]): t.ObjectExpression | null => {
    const a = attrs.find((x) => x.name.name === 'style');
    if (a?.value?.type === 'JSXExpressionContainer' && t.isObjectExpression(a.value.expression)) return a.value.expression;
    return null;
  };
  const styleKeyValue = (obj: t.ObjectExpression, key: string): string | null => {
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
      const tag = jsxTagName(path.node.openingElement.name);
      if (baseTag(tag) !== 'svg') return;
      const attrs = jsxAttrs(path.node.openingElement);
      const dataId = stringAttr(attrs, 'data-id');
      const line = path.node.openingElement.loc?.start.line;
      const parent = path.parentPath?.node;
      const isNested = t.isJSXElement(parent) && baseTag(jsxTagName((parent as t.JSXElement).openingElement.name)) === 'svg';

      const childEls = path.node.children.filter((c): c is t.JSXElement => t.isJSXElement(c));
      const geomChildren = childEls.filter((c) => GEOM_TAGS.has(baseTag(jsxTagName(c.openingElement.name))));
      const svgChildren = childEls.filter((c) => baseTag(jsxTagName(c.openingElement.name)) === 'svg');
      const isWrapper = geomChildren.length > 0 || svgChildren.length > 0;

      // GEOMETRY MUST BE d-PATHS — the shape editor, per-variant geometry
      // channel and resize bakes operate on `d`; polygon/rect/… render but
      // are invisible to all of them.
      for (const g of geomChildren) {
        const gTag = baseTag(jsxTagName(g.openingElement.name));
        const gAttrs = jsxAttrs(g.openingElement);
        const gLine = g.openingElement.loc?.start.line;
        if (gTag !== 'path') {
          let fix = `rewrite it as a <path d="…">`;
          const points = stringAttr(gAttrs, 'points');
          if ((gTag === 'polygon' || gTag === 'polyline') && points) {
            const pts = points.trim().split(/[\s,]+/).map(Number);
            const pairs: string[] = [];
            for (let i = 0; i + 1 < pts.length; i += 2) pairs.push(`${pts[i]},${pts[i + 1]}`);
            if (pairs.length > 0) {
              fix = `replace it with <path d="M${pairs[0]} ${pairs.slice(1).map((pp) => `L${pp}`).join(' ')}${gTag === 'polygon' ? ' z' : ''}" …same paint attrs…/>`;
            }
          }
          v.push({
            code: 'SHAPE_GEOMETRY_NOT_PATH', tier: 2, line: gLine, elementId: dataId,
            message: `<${gTag}> inside <svg${dataId ? ` data-id="${dataId}"` : ''}> (line ${gLine}) — the shape editor, per-variant geometry and resize all operate on \`d\` paths; a ${gTag} renders but can't be reshaped, per-variant-styled, or rotated. ${fix.charAt(0).toUpperCase() + fix.slice(1)}.`,
          });
        } else if (dataId && !stringAttr(gAttrs, 'data-id')) {
          // Stable geometry id — per-variant d overrides and the stroke/fill
          // controls key on it.
          v.push({
            code: 'SHAPE_GEOMETRY_ID_REQUIRED', tier: 2, line: gLine, elementId: dataId,
            message: `The <path> inside <svg data-id="${dataId}"> (line ${gLine}) has no data-id — per-variant geometry and the Fill/Stroke controls key on a stable inner id. Add data-id="${dataId}-g0" to the path.`,
          });
        }
        // ONE PATH = ONE CONTINUOUS SHAPE. A stroke-only path whose `d` has
        // multiple subpaths (2+ M/m move commands) is several SEPARATE strokes
        // crammed into one shape — the builder resolves one continuous path per
        // svg, so the extra strokes can't be selected/edited/rotated and the
        // user could never DRAW this. Each subpath must be its OWN <svg> shape
        // inside a GROUP. Stroke-only (fill none/absent) is the safe trigger: a
        // FILLED multi-subpath path is a legit holed shape (donut, letter O,
        // icon counter — the hole needs fill + fill-rule), so it's left alone.
        if (gTag === 'path') {
          const dAttr = stringAttr(gAttrs, 'd') ?? '';
          const fillAttr = stringAttr(gAttrs, 'fill');
          const strokeOnly = fillAttr == null || fillAttr === 'none' || fillAttr === 'transparent';
          const subpathCount = (dAttr.match(/[Mm]/g) ?? []).length;
          if (strokeOnly && subpathCount >= 2) {
            v.push({
              code: 'SHAPE_PATH_MULTIPLE_SUBPATHS', tier: 2, line: gLine, elementId: dataId,
              message: `The <path> inside <svg${dataId ? ` data-id="${dataId}"` : ''}> (line ${gLine}) is stroke-only but its \`d\` has ${subpathCount} separate subpaths (${subpathCount} \`M\`/\`m\` move commands) — that's ${subpathCount} disconnected strokes in ONE shape. The builder resolves ONE continuous path per <svg> shape, so only the first stroke is editable and the user could never recreate it. Split into a GROUP: one outer <svg> wrapper whose children are ${subpathCount} nested shape <svg>s, each with a single-subpath <path> (one \`M\`). (A FILLED path with hole subpaths — donut, letter O — stays one shape and is fine.)`,
            });
          }
        }
      }

      // NESTED svg children position/size via ATTRS — Chromium does not paint
      // CSS left/top/width/height on a nested <svg> (real-browser probe).
      if (isNested) {
        const styleObj = styleObjectOf(attrs);
        if (styleObj) {
          const offending = ['left', 'top', 'width', 'height'].filter((k) => styleKeyValue(styleObj, k) != null);
          if (offending.length > 0) {
            v.push({
              code: 'NESTED_SVG_BOX_IN_STYLE', tier: 2, line, elementId: dataId,
              message: `Nested <svg${dataId ? ` data-id="${dataId}"` : ''}> (line ${line}) has ${offending.join('/')} in style — CSS box props DO NOT PAINT on a nested svg (Chromium). Move them to x/y/width/height ATTRIBUTES (numbers in the parent's viewBox units): <svg x="…" y="…" width="…" height="…" viewBox="0 0 w h" …>.`,
            });
          }
        }
        if (isWrapper && !stringAttr(attrs, 'overflow')) {
          v.push({
            code: 'NESTED_SVG_OVERFLOW_REQUIRED', tier: 2, line, elementId: dataId,
            message: `Nested shape <svg${dataId ? ` data-id="${dataId}"` : ''}> (line ${line}) needs overflow="visible" — per-variant geometry paints OUTSIDE the viewBox and clips without it.`,
          });
        }
      }

      // Paint lives on the INNER path — the Fill/Stroke controls read & write
      // the geometry child; paint on the wrapper is invisible to the panel.
      if (isWrapper) {
        const wrapperPaint = PAINT_ATTRS.filter((pa) => stringAttr(attrs, pa) != null);
        if (wrapperPaint.length > 0) {
          v.push({
            code: 'WRAPPER_PAINT_PROPS', tier: 2, line, elementId: dataId,
            message: `<svg${dataId ? ` data-id="${dataId}"` : ''}> (line ${line}) carries ${wrapperPaint.join(', ')} — the Fill/Stroke controls read and write the INNER <path>, so paint on the wrapper doesn't resolve in the panel. Move ${wrapperPaint.join(', ')} onto the geometry <path> child.`,
          });
        }
      }

      // TOP-LEVEL wrapper: created 1:1 (style px == viewBox units). The
      // engine renormalizes on resize, but a file BORN non-1:1 makes drag
      // deltas land in scaled units ("moves slowly" / oversized selection).
      if (!isNested && isWrapper) {
        const styleObj = styleObjectOf(attrs);
        const vb = (stringAttr(attrs, 'viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
        if (styleObj && vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
          const wRaw = styleKeyValue(styleObj, 'width');
          const hRaw = styleKeyValue(styleObj, 'height');
          const wPx = wRaw && /^\d+(?:\.\d+)?px$/.test(wRaw) ? parseFloat(wRaw) : null;
          const hPx = hRaw && /^\d+(?:\.\d+)?px$/.test(hRaw) ? parseFloat(hRaw) : null;
          if ((wPx != null && Math.abs(wPx - vb[2]) > 0.5) || (hPx != null && Math.abs(hPx - vb[3]) > 0.5)) {
            v.push({
              code: 'SHAPE_WRAPPER_NOT_1TO1', tier: 2, line, elementId: dataId,
              message: `<svg${dataId ? ` data-id="${dataId}"` : ''}> (line ${line}) is ${wPx ?? vb[2]}×${hPx ?? vb[3]}px but its viewBox is ${vb[2]}×${vb[3]} — shapes are created 1:1 (1 viewBox unit = 1px) so gesture math runs in pixels. Set viewBox="0 0 ${wPx ?? vb[2]} ${hPx ?? vb[3]}" and express the geometry in that space.`,
            });
          }
        }
      }
    },
  });
}

export { checkSvgShapeDialect };
