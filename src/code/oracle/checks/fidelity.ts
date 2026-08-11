// oracle/checks/fidelity.ts — the parser-backed RESOLUTION FIDELITY gate.
//
// Every other rule detects a KNOWN-bad shape; this one asks the opposite
// question: did the builder's own parser actually resolve everything in the
// file? The parser never fails loudly from its own point of view — when it
// can't handle something it mints an `auto_N` id, writes a `token:` sentinel,
// drops a style key, or leaves a text node empty. Those artifacts are a
// complete confession of everything it couldn't read, across every feature
// area at once, produced by the one implementation that must stay correct
// anyway (it IS the builder). Reading the confession catches shapes nobody
// predicted: a novel AI invention that renders but degrades in the parser is
// rejected here without a rule ever having named it.
//
// Verified live before this existed (2026-08-11): `{42}` and
// `{items.length}` text (renders EMPTY), `color: THEME.primary` (paints
// nothing, panel shows `token:THEME.primary`), `{...base}` style spreads
// (panel lies about the element's real look), computed style keys — all
// passed the gate with zero violations.
//
// Runs in tier 3 off the SAME `parseJSXToNodes` result the tier already
// computes — zero additional parsing cost. Code components are exempt (black
// boxes; RESOLVE_EMPTY is their backstop).

import * as t from '@babel/types';
import type { CanvasNode } from '@/code/parsing/parser';
import { TEXT_TAGS } from '@/shared/constants';
import { traverse, jsxTagName, jsxAttrs, stringAttr } from './shared';
import { isCodeComponentSource } from './shared';
import type { OracleViolation, FileKind } from './shared';

/** Sentinel prefixes the parser writes when a style value did not resolve. */
const STYLE_SENTINELS = ['token:', 'var:', 'urlvar:'];

export function checkResolutionFidelity(
  code: string,
  ast: t.File,
  nodes: Map<string, CanvasNode>,
  v: OracleViolation[],
  kind: FileKind,
): void {
  if (kind !== 'page' && kind !== 'component' && kind !== 'template') return;
  if (isCodeComponentSource(code)) return; // code component — black box

  // HOOK-DERIVED identifiers are runtime values, not parse-time ones — a
  // `style={{ y: heroY }}` where `heroY = useTransform(…)` is the SCROLL
  // dialect's canonical binding (framer resolves it live; the parser's `var:`
  // sentinel is expected there). Which hooks may exist at all is
  // PAGE_HOOK_UNRESOLVED's business; their SHAPES are scroll-dialect's. So
  // fidelity trusts any name declared from a hook call (or a tagged
  // `useMotionTemplate\`…\``), including `const { scrollYProgress: p } = useScroll(…)`.
  const hookNames = new Set<string>();
  traverse(ast, {
    VariableDeclarator(path) {
      const init = path.node.init;
      const isHookCall = (n: t.Node | null | undefined): boolean =>
        (t.isCallExpression(n) && t.isIdentifier(n.callee) && /^use[A-Z]/.test(n.callee.name))
        || (t.isTaggedTemplateExpression(n) && t.isIdentifier(n.tag) && /^use[A-Z]/.test(n.tag.name));
      if (!isHookCall(init)) return;
      if (t.isIdentifier(path.node.id)) hookNames.add(path.node.id.name);
      else if (t.isObjectPattern(path.node.id)) {
        for (const p of path.node.id.properties) {
          if (t.isObjectProperty(p) && t.isIdentifier(p.value)) hookNames.add(p.value.name);
        }
      } else if (t.isArrayPattern(path.node.id)) {
        for (const el of path.node.id.elements) {
          if (t.isIdentifier(el)) hookNames.add(el.name);
        }
      }
    },
  });

  // ── 1. Elements the parser could not IDENTIFY ─────────────────────────────
  // No data-id → the parser mints `auto_N`. The node is selectable and renders,
  // but the id exists nowhere in the source, so every generator no-ops: edits
  // appear and then silently revert on the next parse. MISSING_DATA_ID (tier 2)
  // catches most of these earlier; this is the backstop for shapes its
  // exemption list gets wrong.
  const autoIds = [...nodes.values()].filter((n) => n.id.startsWith('auto_'));
  for (const n of autoIds.slice(0, 5)) {
    v.push({
      code: 'RESOLVE_UNIDENTIFIED_ELEMENT', tier: 3,
      message: `[fidelity] A <${n.type}>${n.name && n.name !== n.type ? ` ("${n.name}")` : ''} element resolved WITHOUT a source data-id (the parser minted a temporary "${n.id}"). It renders and is even selectable, but the id exists nowhere in the file, so every edit silently reverts on the next parse. Give every element a stable data-id string literal.`,
    });
  }

  // ── Per-element checks need the AST side. Walk elements with a data-id and
  //    compare against their resolved node. ──────────────────────────────────
  traverse(ast, {
    JSXElement(path) {
      const opening = path.node.openingElement;
      const attrs = jsxAttrs(opening);
      const id = stringAttr(attrs, 'data-id');
      if (!id) return;
      const node = nodes.get(id);
      if (!node) return; // skipped/transparent shapes are other rules' business
      const tag = jsxTagName(opening.name);
      const base = tag.startsWith('motion.') ? tag.slice(7) : tag;

      // ── 2. Style values the parser left as SENTINELS ──────────────────────
      for (const [key, val] of Object.entries(node.styles ?? {})) {
        if (typeof val !== 'string') continue;
        const sentinel = STYLE_SENTINELS.find((s) => val.startsWith(s));
        if (!sentinel) continue;
        if (sentinel === 'token:') {
          v.push({
            code: 'RESOLVE_STYLE_SENTINEL', tier: 3, elementId: id,
            message: `[fidelity] data-id="${id}" — \`${key}\` resolved to \`${val}\`: the parser cannot read a member-expression style value (a theme object, an imported constant). It paints NOTHING in the browser (invalid CSS) and the panel shows the sentinel text. Use a literal value, a component/page-variable identifier with a default, or — inside a collection — \`item.<field>\`.`,
          });
        } else {
          // var:/urlvar: that SURVIVED the resolve pass = an identifier with no
          // matching prop/page-variable default. Renders as invalid CSS —
          // UNLESS the identifier is hook-derived (a motion value), which is
          // the scroll/composed-fx dialect and resolves at runtime.
          const name = val.replace(/^(url)?var:/, '');
          if (hookNames.has(name)) continue;
          v.push({
            code: 'RESOLVE_STYLE_SENTINEL', tier: 3, elementId: id,
            message: `[fidelity] data-id="${id}" — \`${key}\` references the variable \`${val.replace(/^(url)?var:/, '')}\`, which has NO default the parser can resolve (not a destructured prop default, not in @pageVariables). The style paints as invalid CSS. Declare the variable with a default, or use a literal.`,
          });
        }
      }

      // ── 3. Style keys that went IN but not OUT ────────────────────────────
      // Spread and computed keys are flagged from the AST (precise); everything
      // else is a per-key presence diff with the parser's known relocation
      // targets allowed (bindings, responsive maps, conditional variables).
      const styleAttr = attrs.find((a) => a.name.name === 'style');
      const styleExpr = styleAttr && t.isJSXExpressionContainer(styleAttr.value)
        ? styleAttr.value.expression : null;
      if (styleExpr && t.isObjectExpression(styleExpr)) {
        const relocated = new Set<string>([
          ...(node.styleBindings ?? []).map((b: { styleProp: string }) => b.styleProp),
          ...Object.keys((node as { responsiveStyleValues?: Record<string, unknown> }).responsiveStyleValues ?? {}),
          ...Object.keys((node as { responsiveStyleVariables?: Record<string, unknown> }).responsiveStyleVariables ?? {}),
          ...Object.keys((node as { conditionalStyleVariables?: Record<string, unknown> }).conditionalStyleVariables ?? {}),
          ...Object.keys((node as { conditionalStyles?: Record<string, unknown> }).conditionalStyles ?? {}),
        ]);
        for (const prop of styleExpr.properties) {
          if (t.isSpreadElement(prop)) {
            // `...style` (and a destructured style-rest) on a component ROOT is
            // the MANDATORY dialect — ROOT_STYLE_SPREAD requires it; instances
            // and the canvas override through it. Only foreign spreads flag.
            if (t.isIdentifier(prop.argument)
              && /^(style|styleRest|restStyle)$/.test(prop.argument.name)) continue;
            v.push({
              code: 'RESOLVE_STYLE_DROPPED', tier: 3, elementId: id,
              message: `[fidelity] data-id="${id}" — the style object contains a \`...\` spread. The parser drops spreads silently: the element PAINTS with those styles while the panel shows an object without them, so the first edit flattens the element to the visible subset. Inline every property as a literal.`,
            });
            continue;
          }
          if (!t.isObjectProperty(prop)) continue;
          if (prop.computed) {
            v.push({
              code: 'RESOLVE_STYLE_DROPPED', tier: 3, elementId: id,
              message: `[fidelity] data-id="${id}" — the style object uses a COMPUTED key (\`[expr]: …\`). The parser misreads the key as the literal variable name, producing a fake CSS property. Write the property name directly.`,
            });
            continue;
          }
          const keyName = t.isIdentifier(prop.key) ? prop.key.name
            : t.isStringLiteral(prop.key) ? prop.key.value : null;
          if (!keyName) continue;
          if (keyName in (node.styles ?? {})) continue;
          if (relocated.has(keyName)) continue;
          v.push({
            code: 'RESOLVE_STYLE_DROPPED', tier: 3, elementId: id,
            message: `[fidelity] data-id="${id}" — \`${keyName}\` did not survive parsing: its value shape (a template literal with expressions, a function call, a ternary the dialect doesn't know) is unreadable, so the property exists in the source but not in the editor. Resolvable value forms: string/number literals, a prop or page-variable identifier with a default, the \`variant === '…' ? … : …\` ternary, \`__mqN ? … : …\`, and \`item.<field>\` inside a collection.`,
          });
        }
      }

      // ── 4. Text that resolves to NOTHING ──────────────────────────────────
      // A text tag whose child is an expression the parser can't read renders
      // an EMPTY element — `{42}`, `{items.length}`, `{definedVar}` with no
      // default. The oracle's old text allowlist was WIDER than the parser.
      if (TEXT_TAGS.has(base)) {
        const hasExprChild = path.node.children.some(
          (c) => t.isJSXExpressionContainer(c) && !t.isJSXEmptyExpression(c.expression),
        );
        const anyText = !!(node.textContent
          || (node as { textVariable?: string }).textVariable
          || (node as { binding?: unknown }).binding
          || (node as { translationKey?: string }).translationKey
          || (node as { conditionalText?: unknown }).conditionalText
          || (node as { textOverrides?: unknown }).textOverrides
          || (node as { hasMixedContent?: boolean }).hasMixedContent
          || (node as { responsiveTextValues?: unknown }).responsiveTextValues);
        if (hasExprChild && !anyText) {
          v.push({
            code: 'RESOLVE_TEXT_EMPTY', tier: 3, elementId: id,
            message: `[fidelity] data-id="${id}" — the <${base}> has an expression child the parser cannot read, so it resolves to EMPTY text: the element renders blank and the text tool has nothing to edit. Readable text forms: a plain literal, {"string"}, a prop/page-variable identifier WITH a default, {t('${id}')}, useResponsiveText(…), and {item.<field>} inside a collection. Numbers, member expressions and computed strings are not readable — write the literal you mean.`,
          });
        }
      }
    },
  });
}
