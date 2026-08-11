// oracle/checks/surface-dialect.ts — the EDITABLE SURFACE fence.
//
// Four rules with one principle: a thing may only ship if some panel can edit
// it afterwards. A style key with no control, a tag no tool manages, a loop
// with no carrier attribute, an export no generator emits — all render
// perfectly and are dead the moment they land (verified passing the gate with
// zero violations, 2026-08-11: the touchAction/scroll-snap cluster, custom
// properties, <ul>/<table>/<iframe>/checkbox, marquee-without-data-loop,
// typography inherited from a wrapper div, an api-helper export in a page).
//
// The style allowlist is DERIVED from the controls the editor actually mounts
// (editor-controls sweep, 2026-08-11) plus every key the generators emit —
// hand-curating subsets is how earlier rules flagged the builder's own
// canonical fixtures (`onTapCancel`, `useMotionValueEvent`). When a control or
// generator gains a property, add it here; the builder-conformance suite
// fails loudly if this set falls behind.

import * as t from '@babel/types';
import { MOTION_TRANSFORM_PROPS } from '@/shared/motion-transform';
import { TEXT_TAGS, isSvgTag } from '@/shared/constants';
import { traverse, jsxTagName, jsxAttrs, stringAttr, hasAttr } from './shared';
import { isCodeComponentSource } from './shared';
import type { OracleViolation, FileKind } from './shared';

// ─── A6: which style keys have an editing surface ───────────────────────────

/** Motion transform channels — canonical ONLY on motion.* elements. */
const MOTION_CHANNELS = new Set<string>(['x', 'y', 'z', ...MOTION_TRANSFORM_PROPS]);

/** Keys some panel reads/writes, or a generator emits. Kept deliberately
 *  GENEROUS — the rule exists for the confirmed dead-end cluster, not to
 *  bounce harmless CSS. */
const CONTROLLED_STYLE_PROPS = new Set<string>([
  // Size / position / layout (SizeTool, PositionTool, LayoutTool)
  'width', 'height', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight',
  'flex', 'flexGrow', 'flexShrink', 'flexBasis', 'alignSelf', 'aspectRatio',
  'position', 'left', 'top', 'right', 'bottom', 'inset',
  'display', 'flexDirection', 'flexWrap', 'alignItems', 'justifyContent', 'alignContent',
  'gap', 'rowGap', 'columnGap', 'order',
  'gridTemplateColumns', 'gridTemplateRows', 'gridTemplate', 'gridAutoFlow', 'gridAutoRows',
  'gridAutoColumns', 'gridColumn', 'gridRow', 'gridArea', 'justifySelf', 'justifyItems', 'placeSelf',
  'columnCount', 'columnWidth', 'columnRule', 'columnRuleStyle', 'columnRuleWidth', 'columnRuleColor',
  'padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'margin', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
  // Styles panel atoms
  'backgroundColor', 'background', 'backgroundImage', 'backgroundSize', 'backgroundPosition',
  'backgroundRepeat', 'backgroundAttachment', 'backgroundBlendMode', 'backgroundClip',
  'WebkitBackgroundClip',
  'borderRadius', 'borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius',
  'overflow', 'overflowX', 'overflowY', 'opacity',
  'border', 'borderTop', 'borderRight', 'borderBottom', 'borderLeft',
  'borderStyle', 'borderWidth', 'borderColor',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'borderTopStyle', 'borderRightStyle', 'borderBottomStyle', 'borderLeftStyle',
  'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor',
  'borderImage', 'borderImageSource', 'borderImageSlice', 'borderImageWidth', 'borderImageRepeat',
  'boxShadow', 'filter', 'backdropFilter', 'WebkitBackdropFilter',
  'maskImage', 'WebkitMaskImage', 'maskComposite', 'WebkitMaskComposite',
  'maskSize', 'maskPosition', 'maskRepeat', 'clipPath',
  'transform', 'transformStyle', 'transformOrigin', 'zIndex',
  'pointerEvents', 'userSelect', 'cursor', 'visibility',
  // Typography (TextStyleTool — WHERE they may sit is TEXT_STYLE_ON_FRAME's business)
  'color', 'fontFamily', 'fontSize', 'fontStyle', 'fontWeight', 'letterSpacing', 'lineHeight',
  'textAlign', 'textTransform', 'whiteSpace', 'textOverflow', 'writingMode', 'wordBreak',
  'overflowWrap',   // TextCreator + form-submit/cms-pagination generators emit it
  'textDecoration', 'textDecorationLine', 'textDecorationStyle', 'textDecorationColor',
  'textDecorationThickness', 'textUnderlineOffset', 'textShadow',
  'WebkitTextStroke', 'WebkitTextStrokeWidth', 'WebkitTextStrokeColor', 'WebkitTextFillColor',
  // Media tools
  'objectFit', 'objectPosition',
  // Scroll section
  'scrollMarginTop',
  // Generator-emitted (verified in generation/ + real project output +
  // the Insert catalogue: `resize` ships on its textarea)
  'isolation', 'contain', 'willChange', 'outline', 'resize',
  'stroke', 'strokeWidth', 'strokeDasharray', 'strokeDashoffset', 'strokeLinecap',
  'strokeLinejoin', 'strokeOpacity', 'strokeMiterlimit', 'fill', 'fillOpacity',
]);

/** The confirmed dead-end cluster gets a tailored redirect. */
const KNOWN_DEAD_ENDS: Record<string, string> = {
  touchAction: 'no control exists; if you added it for tap-delay, the builder does not need it',
  scrollSnapType: 'scroll-snap carousels are not a native pattern — build a variants-driven slider or use a Carousel code component',
  scrollSnapAlign: 'scroll-snap carousels are not a native pattern — build a variants-driven slider or use a Carousel code component',
  scrollSnapStop: 'scroll-snap carousels are not a native pattern',
  overscrollBehavior: 'no control exists; overlays already manage body scroll natively',
  mixBlendMode: 'no element-level Blend control exists yet — use the per-fill-layer blend in the Fill panel (backgroundBlendMode), or leave blending out',
  float: 'floats are not a layout the builder expresses — use flex or grid',
  clear: 'floats are not a layout the builder expresses — use flex or grid',
  listStyle: 'lists are not native elements — build stacked frames (see the element rule)',
  listStyleType: 'lists are not native elements — build stacked frames',
  translate: "the independent CSS translate property has no reader — motion uses x/y channels on a motion.* element, plain elements use the composed `transform` string",
};

export function checkStyleSurface(
  code: string,
  ast: t.File,
  v: OracleViolation[],
  kind: FileKind,
): void {
  if (kind !== 'page' && kind !== 'component' && kind !== 'template') return;
  if (isCodeComponentSource(code)) return;
  const seen = new Set<string>();

  traverse(ast, {
    JSXAttribute(path) {
      if (path.node.name.name !== 'style') return;
      if (!t.isJSXExpressionContainer(path.node.value)) return;
      const obj = path.node.value.expression;
      if (!t.isObjectExpression(obj)) return;
      const opening = path.parentPath?.node;
      if (!t.isJSXOpeningElement(opening)) return;
      const tag = jsxTagName(opening.name);
      const isMotionTag = tag.startsWith('motion.') || tag === 'MotionLink'
        || (tag[0] && tag[0] === tag[0].toUpperCase());
      const id = stringAttr(jsxAttrs(opening), 'data-id');

      for (const prop of obj.properties) {
        if (!t.isObjectProperty(prop) || prop.computed) continue;
        const key = t.isIdentifier(prop.key) ? prop.key.name
          : t.isStringLiteral(prop.key) ? prop.key.value : null;
        if (!key) continue;

        // Custom properties: render perfectly, invisible to every panel, no
        // removal path (verified). Blocked outright.
        if (key.startsWith('--')) {
          const dk = `${id}:--`;
          if (seen.has(dk)) continue;
          seen.add(dk);
          v.push({
            code: 'STYLE_PROP_NO_CONTROL', tier: 2, elementId: id ?? undefined,
            line: prop.loc?.start.line,
            message: `[style surface] data-id="${id ?? '?'}" sets the CSS custom property \`${key}\`. Custom properties render but NO panel can see or remove them — a permanent invisible style. Write the concrete values directly on the elements that use them; shared colors belong in the design-token system (globals.css presets), not ad-hoc --vars.`,
          });
          continue;
        }

        if (CONTROLLED_STYLE_PROPS.has(key)) {
          // Key is controlled, but ONE value has no slot: the Overflow select
          // offers visible/hidden/scroll/clip — `auto` renders the control
          // BLANK and the first touch rewrites it. Redirect to `scroll`.
          if (/^overflow[XY]?$/.test(key) && t.isStringLiteral(prop.value) && prop.value.value === 'auto') {
            const dk = `${id}:${key}:auto`;
            if (seen.has(dk)) continue;
            seen.add(dk);
            v.push({
              code: 'STYLE_PROP_NO_CONTROL', tier: 2, elementId: id ?? undefined,
              line: prop.loc?.start.line,
              message: `[style surface] data-id="${id ?? '?'}" sets \`${key}: 'auto'\` — the Overflow control offers visible / hidden / scroll / clip, so 'auto' shows as a BLANK select and the first interaction silently rewrites it. Use \`'scroll'\`.`,
            });
          }
          continue;
        }

        if (MOTION_CHANNELS.has(key)) {
          // Canonical on motion elements (the Transform popup owns them);
          // off-dialect on plain tags, where the builder composes `transform`.
          if (isMotionTag) continue;
          const dk = `${id}:${key}`;
          if (seen.has(dk)) continue;
          seen.add(dk);
          v.push({
            code: 'STYLE_PROP_NO_CONTROL', tier: 2, elementId: id ?? undefined,
            line: prop.loc?.start.line,
            message: `[style surface] data-id="${id ?? '?'}" sets \`${key}\` on a plain <${tag}>. Bare transform channels are the MOTION dialect — legal only on motion.* elements, where the Transform panel reads them. On a plain tag use the composed \`transform: '…'\` string, or make the element motion.${tag}.`,
          });
          continue;
        }

        const dk = `${id}:${key}`;
        if (seen.has(dk)) continue;
        seen.add(dk);
        const redirect = KNOWN_DEAD_ENDS[key]
          ?? 'no panel reads or writes it, so it can never be seen, edited or removed in the editor';
        v.push({
          code: 'STYLE_PROP_NO_CONTROL', tier: 2, elementId: id ?? undefined,
          line: prop.loc?.start.line,
          message: `[style surface] data-id="${id ?? '?'}" sets \`${key}\` — ${redirect}. Every style you write must be one the editor's controls can edit; drop the property or express the intent with a supported one.`,
        });
      }
    },
  });
}

// ─── A9: typography lives ON the text node, never a parent ──────────────────

const TEXT_STYLE_PROPS = new Set<string>([
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing',
  'textTransform', 'textAlign', 'textDecoration', 'textDecorationLine', 'textDecorationStyle',
  'textDecorationColor', 'textDecorationThickness', 'textUnderlineOffset', 'textShadow',
  'whiteSpace', 'textOverflow', 'wordBreak', 'textIndent', 'color',
  'WebkitTextStroke', 'WebkitTextStrokeWidth', 'WebkitTextStrokeColor', 'WebkitTextFillColor',
]);

export function checkTextStyleOnFrame(
  code: string,
  ast: t.File,
  v: OracleViolation[],
  kind: FileKind,
): void {
  if (kind !== 'page' && kind !== 'component' && kind !== 'template') return;
  if (isCodeComponentSource(code)) return;
  const seen = new Set<string>();

  traverse(ast, {
    JSXAttribute(path) {
      if (path.node.name.name !== 'style') return;
      if (!t.isJSXExpressionContainer(path.node.value)) return;
      const obj = path.node.value.expression;
      if (!t.isObjectExpression(obj)) return;
      const opening = path.parentPath?.node;
      if (!t.isJSXOpeningElement(opening)) return;
      const tag = jsxTagName(opening.name);
      const base = tag.startsWith('motion.') ? tag.slice(7) : tag;
      // Text tags carry typography by design; SVG paints with stroke/fill, and
      // an INSTANCE'S internal styling is INSTANCE_INTERNAL_STYLE's business.
      if (TEXT_TAGS.has(base)) return;
      if (isSvgTag(base) || base === 'path') return;
      if (base[0] && base[0] !== base[0].toLowerCase()) return;
      // An element with DIRECT text of its own IS the text carrier — the
      // parser puts textContent on it (the button-as-div pattern from the
      // Insert catalogue). Only pure WRAPPERS styling text by inheritance are
      // the defect.
      const host = path.parentPath?.parentPath?.node;
      if (t.isJSXElement(host)) {
        const hasOwnText = host.children.some((c) =>
          (t.isJSXText(c) && c.value.trim() !== '')
          || (t.isJSXExpressionContainer(c) && !t.isJSXEmptyExpression(c.expression)
            && !t.isJSXElement(c.expression) && !t.isJSXFragment(c.expression)));
        if (hasOwnText) return;
      }

      const offenders: string[] = [];
      for (const prop of obj.properties) {
        if (!t.isObjectProperty(prop) || prop.computed) continue;
        const key = t.isIdentifier(prop.key) ? prop.key.name
          : t.isStringLiteral(prop.key) ? prop.key.value : null;
        if (key && TEXT_STYLE_PROPS.has(key)) offenders.push(key);
      }
      if (offenders.length === 0) return;
      const id = stringAttr(jsxAttrs(opening), 'data-id');
      const dk = `${id}:${offenders[0]}`;
      if (seen.has(dk)) return;
      seen.add(dk);
      v.push({
        code: 'TEXT_STYLE_ON_FRAME', tier: 2, elementId: id ?? undefined,
        line: path.node.loc?.start.line,
        message: `[text styles] data-id="${id ?? '?'}" is a <${base}> frame carrying text styling (${offenders.join(', ')}). In this builder text styles live ON the text element itself — NEVER on a parent. Inherited typography renders, but the text node's panel then shows values that don't match what's painted, and every Text-tool edit fights the invisible wrapper. Move ${offenders.length > 1 ? 'these properties' : 'the property'} onto each text element (<p>, <h1>…, <span>) inside.`,
      });
    },
  });
}

// ─── A7: elements no tool can manage ────────────────────────────────────────

const UNSUPPORTED_TAGS: Record<string, string> = {
  ul: 'lists are stacked FRAMES here: a flex column of row frames (icon + text), giving full control of spacing and markers',
  ol: 'lists are stacked FRAMES here: a flex column of row frames with a number text per row',
  li: 'list items are row FRAMES inside a flex column',
  dl: 'definition lists are stacked frames', dt: 'use a text element inside a frame', dd: 'use a text element inside a frame',
  menu: 'use a flex column of frames',
  table: 'tables are a GRID here: a frame with display grid and per-cell frames — fully editable, responsive per viewport',
  thead: 'use grid rows', tbody: 'use grid rows', tr: 'a grid row is just the next N cells', td: 'use a frame as the cell', th: 'use a text frame as the header cell',
  details: 'an accordion is a design COMPONENT with closed/open VARIANTS driven by a click connection (see the FAQ pattern)',
  summary: 'the accordion header is a frame inside the closed/open variants component',
  dialog: 'a modal is the OVERLAY dialect: data-overlay type "fixed", opened by a trigger, last child of root',
  iframe: 'embeds are CODE COMPONENTS (YouTubeEmbed, CalendlyEmbed, …) — a raw iframe has no editable surface (src/allow/sandbox are unreachable)',
};

const SUPPORTED_INPUT_TYPES = new Set([
  'text', 'textarea', 'email', 'number', 'tel', 'url', 'date', 'time', 'select',
  'submit', 'button', 'reset', 'search',
]);

export function checkElementSurface(
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
      const attrs = jsxAttrs(path.node);
      const id = stringAttr(attrs, 'data-id');

      const redirect = UNSUPPORTED_TAGS[base];
      if (redirect) {
        const dk = `tag:${base}:${id ?? path.node.loc?.start.line}`;
        if (seen.has(dk)) return;
        seen.add(dk);
        v.push({
          code: 'ELEMENT_UNSUPPORTED_TAG', tier: 2, elementId: id ?? undefined,
          line: path.node.loc?.start.line,
          message: `[elements] <${base}>${id ? ` (data-id="${id}")` : ''} is not an element the editor can manage — it renders, but the tag switcher, its attributes and its native behaviour are unreachable from every panel (and converting away later is one-way). Build it natively instead: ${redirect}.`,
        });
        return;
      }

      if (base === 'input') {
        const type = stringAttr(attrs, 'type') ?? 'text';
        if (!SUPPORTED_INPUT_TYPES.has(type)) {
          const dk = `input:${id ?? path.node.loc?.start.line}`;
          if (seen.has(dk)) return;
          seen.add(dk);
          v.push({
            code: 'ELEMENT_UNSUPPORTED_TAG', tier: 2, elementId: id ?? undefined,
            line: path.node.loc?.start.line,
            message: `[elements] <input type="${type}">${id ? ` (data-id="${id}")` : ''} — the Input tool supports text, textarea, email, number, tel, url, date, time and select; "${type}" has no editable surface (its Type dropdown shows blank and converting is one-way). For consent/boolean UI build a frame-based toggle as a variants component; for a "${type}" field, pick the closest supported type or use a code component.`,
          });
        }
      }
    },
  });
}

// ─── A5: a loop needs its carrier ───────────────────────────────────────────

export function checkLoopCarrier(
  code: string,
  ast: t.File,
  v: OracleViolation[],
  kind: FileKind,
): void {
  if (kind !== 'page' && kind !== 'component' && kind !== 'template') return;
  if (isCodeComponentSource(code)) return;

  traverse(ast, {
    JSXOpeningElement(path) {
      const attrs = jsxAttrs(path.node);
      const animate = attrs.find((a) => a.name.name === 'animate');
      const transition = attrs.find((a) => a.name.name === 'transition');
      if (!animate || !transition) return;
      if (!t.isJSXExpressionContainer(animate.value) || !t.isObjectExpression(animate.value.expression)) return;
      if (!t.isJSXExpressionContainer(transition.value) || !t.isObjectExpression(transition.value.expression)) return;
      const hasRepeat = transition.value.expression.properties.some(
        (p) => t.isObjectProperty(p) && t.isIdentifier(p.key) && p.key.name === 'repeat',
      );
      if (!hasRepeat) return;
      if (hasAttr(attrs, 'data-loop')) return;
      // A parked canvas node's dormant loop form is hookless AND carrier-less
      // by design (module-scope JSX cannot re-parse the carrier live).
      if (hasAttr(attrs, 'data-canvas-node')) return;
      let p: typeof path.parentPath | null = path.parentPath;
      for (let d = 0; d < 40 && p; d++, p = p.parentPath ?? null) {
        if (p.isVariableDeclarator() && t.isIdentifier(p.node.id)
          && (p.node.id.name === 'canvasNodes' || p.node.id.name.startsWith('cn_'))) return;
      }
      const id = stringAttr(attrs, 'data-id');
      v.push({
        code: 'LOOP_MISSING_CARRIER', tier: 2, elementId: id ?? undefined,
        line: path.node.loc?.start.line,
        message: `[loop] ${id ? `data-id="${id}"` : `<${jsxTagName(path.node.name)}>`} animates with \`transition.repeat\` but has NO \`data-loop\` attribute. The animation plays, but the Animation panel reads loops from data-loop — without it nothing shows, so the loop can never be edited or removed. Emit the carrier: \`data-loop='{"props":{…},"transition":{"repeat":"Infinity",…}}'\` alongside the motion props.`,
      });
    },
  });
}

// ─── B3: builder data-* attributes must be string literals ──────────────────
//
// Every reader of these attributes — the overlay regex parser, the cms-nav
// dialect, the loop/glide/scroll-fx JSON re-parsers, and every oracle rule via
// `stringAttr` — sees STRING LITERALS only. `data-overlay={cfg}` renders
// identically and is invisible to all of them: the feature half-works live and
// no panel can see it (the whole oracle was blind to expression attrs,
// 2026-08-11). Component INSTANCES are exempt — their props are the
// component's business, and `data-responsive={JSON.stringify(…)}` is a legal
// generator form there.

const BUILDER_DATA_ATTRS = new Set([
  'data-id', 'data-name', 'data-overlay', 'data-overlay-trigger', 'data-cms-nav',
  'data-loop', 'data-glide', 'data-scroll-fx', 'data-scroll-variant', 'data-text-anim',
  'data-form', 'data-form-state', 'data-pagination', 'data-pinned', 'data-canvas-node',
  'data-smooth-scroll', 'data-keep-params', 'data-responsive', 'data-cms-field', 'data-cms-bind-target',
]);

export function checkExpressionDataAttrs(
  code: string,
  ast: t.File,
  v: OracleViolation[],
  kind: FileKind,
): void {
  if (kind !== 'page' && kind !== 'component' && kind !== 'template') return;
  if (isCodeComponentSource(code)) return;
  traverse(ast, {
    JSXAttribute(path) {
      const name = typeof path.node.name.name === 'string' ? path.node.name.name : '';
      if (!BUILDER_DATA_ATTRS.has(name)) return;
      const val = path.node.value;
      if (val == null) return;                                   // valueless boolean form
      if (t.isStringLiteral(val)) return;
      if (t.isJSXExpressionContainer(val) && t.isStringLiteral(val.expression)) return;
      const opening = path.parentPath?.node;
      if (!t.isJSXOpeningElement(opening)) return;
      const tag = jsxTagName(opening.name);
      const base = tag.startsWith('motion.') ? tag.slice(7) : tag;
      if (base[0] && base[0] !== base[0].toLowerCase()) return;  // instance — its component's business
      const id = stringAttr(jsxAttrs(opening), 'data-id');
      v.push({
        code: 'UNSUPPORTED_EXPRESSION_ATTR', tier: 2, elementId: id ?? undefined,
        line: path.node.loc?.start.line,
        message: `[attrs] <${tag}>${id ? ` (data-id="${id}")` : ''} — \`${name}={…}\` is an EXPRESSION value. Every builder reader of ${name} (the overlay/loop/scroll/cms parsers, every panel) reads STRING LITERALS only; an expression renders but is invisible to all of them, so the feature half-works on the live site and cannot be edited. Write the value as a plain quoted string (JSON attributes single-quoted: ${name}='{"…"}').`,
      });
    },
  });
}

// ─── A10: a page exports exactly its component ──────────────────────────────

export function checkPageExports(
  code: string,
  ast: t.File,
  v: OracleViolation[],
  kind: FileKind,
): void {
  if (kind !== 'page' && kind !== 'template') return;
  for (const stmt of ast.program.body) {
    if (!t.isExportNamedDeclaration(stmt)) continue;
    const line = stmt.loc?.start.line;
    let what = 'a named export';
    if (t.isFunctionDeclaration(stmt.declaration) && stmt.declaration.id) what = `\`export function ${stmt.declaration.id.name}\``;
    else if (t.isVariableDeclaration(stmt.declaration)) {
      const d = stmt.declaration.declarations[0];
      if (d && t.isIdentifier(d.id)) what = `\`export const ${d.id.name}\``;
    }
    v.push({
      code: 'PAGE_EXTRA_EXPORT', tier: 2, line,
      message: `[exports] Line ${line} — ${what}. A page file exports exactly ONE thing: its default component. Extra exports are dead weight the builder never calls, and the usual reason they appear — API/server logic that was refused as a route file — is not supported at all: form submissions go through the NATIVE form system (the generated /api/form relay), dynamic data from an external API belongs in a CODE COMPONENT doing a client-side fetch, and hosted server logic does not exist in this builder. Remove the export.`,
    });
  }
}
