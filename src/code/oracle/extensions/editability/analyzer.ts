// oracle/extensions/editability/analyzer.ts — Phase 3 Editability Analyzer.
//
// Pure classifier. Takes a TSX string (+ optional opts {kind, path,
// coreViolations}) and returns an EditabilityReport describing how the
// produced page will round-trip into the editor.
//
// The analyzer NEVER mutates code, NEVER calls the media normalizer, and
// NEVER throws — it is a read-only lens over the source. The oracle's
// hook in check-file.ts is untouched (runEditabilityRules still emits
// tier-2 violations the same way). This module just adds a higher-level
// verdict for callers that want to teach a model "what to write next".

import { parse } from '@babel/parser';
import _traverseImport from '@babel/traverse';
import * as t from '@babel/types';

import {
  MOTION_PROP_NAMES,
  parseJSXToNodes,
} from '@/code/parsing/parser';
import { getPageVariables } from '@/code/features/page-variables';
import type { CanvasNode } from '@/code/parsing/parser';
import { needsDataId, type OracleViolation } from '../../checks/shared';

const traverse = (
  typeof _traverseImport === 'function' ? _traverseImport : (_traverseImport as any).default
) as typeof _traverseImport;

const TRANSPARENT_TAGS_LOCAL = new Set([
  'AnimatePresence',
  'LayoutGroup',
  'MotionConfig',
  'Fragment',
  'React.Fragment',
  'PageTransitions',
  'RevymeSplitText',
]);

// Tags that are not nodes the editor ever manages. <style> is just a CSS
// carrier; <script> is an inline script carrier; <meta>/<link> are head-only
// and never rendered into the canvas.
const NON_NODE_TAGS = new Set(['style', 'script', 'meta', 'link', 'title', 'base', 'html', 'head', 'body']);

const INSTANCE_EXEMPT_TAGS = new Set([
  'Link',
  'MotionLink',
  'MotionConfig',
  'LayoutGroup',
  'AnimatePresence',
]);

const SETTER_TRIGGER_ATTRS = new Set(['onClick', 'onMouseEnter', 'onMouseLeave']);

// Canonical setters that exist OUTSIDE the page-variables dialect — they are
// the editor's own state (variant toggling). Flagging them as recoverable
// would drown the actual shadow-setter signal in noise.
const CANONICAL_NON_VARIABLE_SETTERS = new Set(['setVariant']);

const ALLOWED_IMPORT_SOURCES = new Set([
  'react',
  'react-dom',
  'framer-motion',
  // P7 (I8'): the oracle MANDATES these (EXPORT_SHAPE requires the
  // withResponsiveProps wrapper) — flagging them CUSTOM made NATIVE
  // unreachable for every canonical master.
  '@revyme/runtime',
  'next/',
  '@/shared/',
  '@/code/runtime',
  '@/runtime',
  '@/cms/',
  '@/components/',
]);

export type EditabilityClass = 'NATIVE' | 'RECOVERABLE' | 'CUSTOM' | 'UNSUPPORTED';

export interface EditabilityFinding {
  capability: string;
  class: EditabilityClass;
  evidence: string;
}

export interface EditabilityReport {
  verdict: 'NATIVE' | 'RECOVERABLE' | 'MIXED' | 'CUSTOM' | 'UNSUPPORTED';
  counts: { native: number; recoverable: number; custom: number; unsupported: number };
  findings: EditabilityFinding[];
}

function parseSource(code: string): t.File {
  return parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] });
}

function tagName(name: t.JSXOpeningElement['name']): { tag: string; base: string } {
  if (t.isJSXIdentifier(name)) {
    const tag = name.name;
    return { tag, base: tag };
  }
  if (t.isJSXMemberExpression(name)) {
    const parts: string[] = [];
    let cur: t.JSXMemberExpression['object'] | t.JSXIdentifier = name;
    while (t.isJSXMemberExpression(cur)) {
      parts.unshift((cur.property as t.JSXIdentifier).name);
      cur = cur.object;
    }
    if (t.isJSXIdentifier(cur)) parts.unshift(cur.name);
    const tag = parts.join('.');
    return { tag, base: tag.startsWith('motion.') ? tag.slice('motion.'.length) : tag };
  }
  return { tag: '', base: '' };
}

function push(
  findings: EditabilityFinding[],
  capability: string,
  klass: EditabilityClass,
  evidence: string,
): void {
  findings.push({ capability, class: klass, evidence });
}

export function analyzeEditability(
  code: string,
  opts: { kind?: string; path?: string; coreViolations?: OracleViolation[] } = {},
): EditabilityReport {
  const findings: EditabilityFinding[] = [];

  if (opts.coreViolations && opts.coreViolations.some((v) => v.tier === 3)) {
    for (const v of opts.coreViolations.filter((x) => x.tier === 3)) {
      push(findings, 'core-violations', 'UNSUPPORTED', v.code + (v.line ? ' @line ' + v.line : ''));
    }
    return aggregate(findings);
  }

  let ast: t.File;
  try {
    ast = parseSource(code);
  } catch {
    push(findings, 'parse', 'UNSUPPORTED', 'source did not parse');
    return aggregate(findings);
  }

  const declaredVars = new Set(getPageVariables(code).map((pv) => pv.name));
  const nodes = safeParseJSXToNodes(code);
  const hiddenOnPageVar = nodes ? collectHiddenOnPageVar(nodes) : new Set<string>();

  classifyStructure(ast, nodes, findings);
  classifyStyles(ast, findings);
  classifyInteractions(ast, declaredVars, findings);
  classifyVisibility(ast, nodes, hiddenOnPageVar, findings);
  classifyVariables(declaredVars, findings);
  classifyMotion(ast, findings);
  classifyResponsive(code, ast, findings);
  classifyCustomLogic(ast, findings);
  classifyUnsupportedSignatures(ast, findings);

  return aggregate(findings);
}

function safeParseJSXToNodes(code: string): Map<string, CanvasNode> | null {
  try {
    return parseJSXToNodes(code);
  } catch {
    return null;
  }
}

function collectHiddenOnPageVar(nodes: Map<string, CanvasNode>): Set<string> {
  const ids = new Set<string>();
  for (const node of nodes.values()) {
    const n = node as unknown as { hiddenOnPageVar?: unknown };
    if (n.hiddenOnPageVar) ids.add(node.id);
  }
  return ids;
}

// ─── 1. structure ────────────────────────────────────────────────────────────
function classifyStructure(
  ast: t.File,
  nodes: Map<string, CanvasNode> | null,
  findings: EditabilityFinding[],
): void {
  let totalElements = 0;
  let literalIds = 0;
  let dynamicOrMissing = 0;
  let firstOffender: string | null = null;

  traverse(ast, {
    JSXElement(path) {
      const opening = path.node.openingElement;
      const { tag, base } = tagName(opening.name);
      if (!tag) return;
      if (TRANSPARENT_TAGS_LOCAL.has(tag) || TRANSPARENT_TAGS_LOCAL.has(base)) return;
      if (NON_NODE_TAGS.has(base)) return;
      // The builder's own `const MotionLink = motion.create(forwardRef(… <Link/> / <div/>))`
      // wrapper is plumbing, not a node — the same exemption MISSING_DATA_ID
      // makes (checks/shared.ts). Judged as an element it turned every Button /
      // card master with a link into "UNSUPPORTED: <Link> missing data-id".
      if (path.findParent((p) => p.isVariableDeclarator() && t.isIdentifier(p.node.id) && p.node.id.name === 'MotionLink')) return;
      // A rich-text mark (`<span style>` inside a text element) is not a node
      // either — the same call MISSING_DATA_ID makes.
      if (!needsDataId(tag, path)) return;
      totalElements++;
      const attrs = opening.attributes.filter((a): a is t.JSXAttribute => t.isJSXAttribute(a));
      const dataIdAttr = attrs.find((a) => t.isJSXIdentifier(a.name) && a.name.name === 'data-id');
      if (!dataIdAttr) {
        dynamicOrMissing++;
        if (!firstOffender) firstOffender = '<' + tag + '> missing data-id';
        return;
      }
      const v = dataIdAttr.value;
      if (t.isStringLiteral(v)) {
        literalIds++;
      } else {
        dynamicOrMissing++;
        if (!firstOffender) firstOffender = '<' + tag + '> data-id is not a string literal';
      }
    },
  });

  if (totalElements === 0) return;

  if (dynamicOrMissing === 0) {
    push(findings, 'structure', 'NATIVE', literalIds + ' literal data-ids');
  } else {
    push(findings, 'structure', 'UNSUPPORTED', firstOffender ?? 'non-literal data-id');
  }

  // Soft signal: the parser saw a node map — keep it for downstream consumers.
  void nodes;
}

// ─── 2. styles ───────────────────────────────────────────────────────────────
function classifyStyles(ast: t.File, findings: EditabilityFinding[]): void {
  let camelObjectCount = 0;
  let nonCamel = 0;
  let firstOffender: string | null = null;

  traverse(ast, {
    JSXAttribute(path) {
      if (!t.isJSXIdentifier(path.node.name)) return;
      if (path.node.name.name !== 'style') return;
      const v = path.node.value;
      if (!v || !t.isJSXExpressionContainer(v)) return;
      const expr = v.expression;
      if (!t.isObjectExpression(expr)) return;
      for (const prop of expr.properties) {
        if (!t.isObjectProperty(prop)) continue;
        const key = prop.key;
        const name = t.isIdentifier(key)
          ? key.name
          : t.isStringLiteral(key)
            ? key.value
            : null;
        if (!name) {
          nonCamel++;
          if (!firstOffender) firstOffender = 'computed style key';
          continue;
        }
        // The native dialect is camelCase: { fontSize: '48px', backgroundColor: 'red' }
        // Anything else (kebab strings, mixed, computed) is Custom.
        if (/^[a-z][A-Za-z0-9]*$/.test(name) && /[A-Z]/.test(name)) {
          camelObjectCount++;
        } else if (/^[a-z][a-z0-9-]*$/.test(name)) {
          camelObjectCount++;
        } else {
          nonCamel++;
          if (!firstOffender) firstOffender = '"' + name + '" (not a recognized style key)';
        }
      }
    },
  });

  if (camelObjectCount > 0 && nonCamel === 0) {
    push(findings, 'styles', 'NATIVE', camelObjectCount + ' inline style props');
  } else if (nonCamel > 0) {
    push(findings, 'styles', 'CUSTOM', firstOffender ?? 'non-camelCase style key');
  }
}

// ─── 3. interactions ─────────────────────────────────────────────────────────
function classifyInteractions(
  ast: t.File,
  declared: Set<string>,
  findings: EditabilityFinding[],
): void {
  let native = 0;
  const undeclaredNames = new Set<string>();
  let firstUndeclared: string | null = null;
  let complexFirst: string | null = null;
  let hasComplex = false;

  traverse(ast, {
    JSXAttribute(path) {
      if (!t.isJSXIdentifier(path.node.name)) return;
      if (!SETTER_TRIGGER_ATTRS.has(path.node.name.name)) return;
      const val = path.node.value;
      if (!val || !t.isJSXExpressionContainer(val)) return;
      const expr = val.expression;
      if (!t.isArrowFunctionExpression(expr) && !t.isFunctionExpression(expr)) return;

      const calls = collectHandlerCalls(expr.body);
      if (calls.length === 0) return;

      let sawSet = false;
      for (const call of calls) {
        const setterName = parseSetterCallName(call);
        if (!setterName) {
          hasComplex = true;
          if (!complexFirst) complexFirst = 'setX with non-literal arg @line ' + (call.loc?.start.line ?? 0);
          continue;
        }
        sawSet = true;
        if (declared.has(setterName)) {
          native++;
        } else {
          undeclaredNames.add(setterName);
          if (!firstUndeclared) firstUndeclared = setterName;
        }
      }
      void sawSet;
    },
  });

  if (native > 0 && undeclaredNames.size === 0 && !hasComplex) {
    push(findings, 'interactions', 'NATIVE', native + ' setX(literal) on declared vars');
  }
  if (undeclaredNames.size > 0 && !hasComplex) {
    push(
      findings,
      'interactions',
      'RECOVERABLE',
      'declare ' + Array.from(undeclaredNames).map((n) => '"' + n + '"').join(', ') + ' in @pageVariables',
    );
  } else if (undeclaredNames.size > 0 && hasComplex) {
    push(
      findings,
      'interactions',
      'CUSTOM',
      'mixed: declare ' + firstUndeclared + ' in @pageVariables; complex expression present',
    );
  }
  if (hasComplex && undeclaredNames.size === 0) {
    push(findings, 'interactions', 'CUSTOM', complexFirst ?? 'computed/toggle expression');
  }
}

function collectHandlerCalls(body: t.Expression | t.BlockStatement): t.CallExpression[] {
  const out: t.CallExpression[] = [];
  if (t.isCallExpression(body)) out.push(body);
  if (t.isBlockStatement(body)) {
    for (const stmt of body.body) {
      if (!t.isExpressionStatement(stmt)) continue;
      if (t.isCallExpression(stmt.expression)) out.push(stmt.expression);
    }
  }
  return out;
}

function parseSetterCallName(call: t.CallExpression): string | null {
  if (!t.isIdentifier(call.callee)) return null;
  const name = call.callee.name;
  if (!name.startsWith('set') || name.length <= 3) return null;
  if (CANONICAL_NON_VARIABLE_SETTERS.has(name)) return null;
  if (call.arguments.length !== 1) return null;
  const arg = call.arguments[0];
  const isLiteral =
    t.isStringLiteral(arg) ||
    t.isNumericLiteral(arg) ||
    t.isBooleanLiteral(arg) ||
    (t.isUnaryExpression(arg) && arg.operator === '-' && t.isNumericLiteral(arg.argument));
  if (!isLiteral) return null;
  const rest = name.slice(3);
  return rest.charAt(0).toLowerCase() + rest.slice(1);
}

// ─── 4. visibility ───────────────────────────────────────────────────────────
function classifyVisibility(
  ast: t.File,
  nodes: Map<string, CanvasNode> | null,
  hiddenOnPageVar: Set<string>,
  findings: EditabilityFinding[],
): void {
  let variantsDialect = 0;
  let hiddenMarker = 0;
  let arbitraryCond = 0;
  let firstCond: string | null = null;

  traverse(ast, {
    JSXExpressionContainer(path) {
      const parent = path.parent;
      if (!parent || !t.isJSXElement(parent)) return;
      const expr = (path.node as t.JSXExpressionContainer).expression as t.Expression;
      if (!expr || t.isJSXEmptyExpression(expr)) return;
      if (!rendersJSX(expr)) return;
      const text = printExprShallow(expr);
      if (/variant\s*!==\s*['"]/.test(text) || /variant\s*===\s*['"]/.test(text)) {
        variantsDialect++;
      } else if (t.isLogicalExpression(expr) || t.isConditionalExpression(expr)) {
        arbitraryCond++;
        if (!firstCond) firstCond = 'arbitrary condition @line ' + (expr.loc?.start.line ?? 0);
      }
    },
  });

  if (nodes && hiddenOnPageVar.size > 0) hiddenMarker = hiddenOnPageVar.size;

  if (variantsDialect > 0 || hiddenMarker > 0) {
    push(
      findings,
      'visibility',
      'NATIVE',
      variantsDialect + ' variants-dialect + ' + hiddenMarker + ' hiddenOnPageVar markers',
    );
  } else if (arbitraryCond > 0) {
    push(findings, 'visibility', 'CUSTOM', firstCond ?? 'arbitrary boolean condition');
  }
}

function rendersJSX(expr: t.Expression): boolean {
  if (t.isJSXElement(expr) || t.isJSXFragment(expr)) return true;
  if (t.isLogicalExpression(expr)) return rendersJSX(expr.right) || rendersJSX(expr.left);
  if (t.isConditionalExpression(expr)) return rendersJSX(expr.consequent) || rendersJSX(expr.alternate);
  return false;
}

function printExprShallow(expr: t.Expression): string {
  if (t.isLogicalExpression(expr)) return printExprShallow(expr.left) + ' ' + expr.operator + ' ' + printExprShallow(expr.right);
  if (t.isConditionalExpression(expr)) return printExprShallow(expr.test) + ' ? ' + printExprShallow(expr.consequent) + ' : ' + printExprShallow(expr.alternate);
  if (t.isIdentifier(expr)) return expr.name;
  if (t.isStringLiteral(expr)) return JSON.stringify(expr.value);
  // `variant === 'x'` — the variants-dialect gate. Unprinted, every Layers-eye
  // visibility read as an "arbitrary condition" (2026-09-22 audit).
  if (t.isBinaryExpression(expr)) return printExprShallow(expr.left as t.Expression) + ' ' + expr.operator + ' ' + printExprShallow(expr.right);
  if (t.isMemberExpression(expr)) {
    return printExprShallow(expr.object as t.Expression) + '.' + printExprShallow(expr.property as t.Expression);
  }
  return '';
}

// ─── 5. variables ────────────────────────────────────────────────────────────
function classifyVariables(declared: Set<string>, findings: EditabilityFinding[]): void {
  if (declared.size > 0) {
    push(findings, 'variables', 'NATIVE', declared.size + ' declared page variables');
  }
}

// ─── 6. motion ───────────────────────────────────────────────────────────────
function classifyMotion(ast: t.File, findings: EditabilityFinding[]): void {
  let regularMotion = 0;
  let instanceMotion = 0;
  let customFirst: string | null = null;
  let variantFn = false;
  let customProp = false;
  const exempt = INSTANCE_EXEMPT_TAGS;

  traverse(ast, {
    JSXAttribute(path) {
      if (!t.isJSXIdentifier(path.node.name)) return;
      const attrName = path.node.name.name;
      const parent = path.parent;
      if (!parent || !t.isJSXOpeningElement(parent)) return;
      const v = path.node.value;
      const valExpr = v && t.isJSXExpressionContainer(v) ? v.expression : null;

      // motion prop on element
      if (MOTION_PROP_NAMES.includes(attrName)) {
        const { tag } = tagName(parent.name);
        const isInstance =
          t.isJSXIdentifier(parent.name) && /^[A-Z]/.test(parent.name.name) && !exempt.has(tag);
        if (isInstance) {
          instanceMotion++;
        } else {
          regularMotion++;
        }
      }

      if (attrName === 'custom' && valExpr) {
        customProp = true;
        if (!customFirst) customFirst = 'custom={…} on line ' + (v?.loc?.start.line ?? 0);
      }

      // variants-*/initial/animate/whileHover/whileTap/exit as object with function value
      if (
        (attrName === 'variants' ||
          attrName === 'initial' ||
          attrName === 'animate' ||
          attrName === 'whileHover' ||
          attrName === 'whileTap' ||
          attrName === 'exit') &&
        valExpr &&
        (t.isArrowFunctionExpression(valExpr) || t.isFunctionExpression(valExpr))
      ) {
        variantFn = true;
      }
    },
    ObjectProperty(path) {
      const key = path.node.key;
      const name = t.isIdentifier(key)
        ? key.name
        : t.isStringLiteral(key)
          ? key.value
          : null;
      if (name !== 'variants' && name !== 'initial' && name !== 'animate' && name !== 'whileHover' && name !== 'whileTap' && name !== 'exit') return;
      const value = path.node.value;
      if (t.isArrowFunctionExpression(value) || t.isFunctionExpression(value)) variantFn = true;
    },
  });

  if (regularMotion > 0 && instanceMotion === 0 && !variantFn && !customProp) {
    push(findings, 'motion', 'NATIVE', regularMotion + ' motion props on regular elements');
  } else if (instanceMotion > 0) {
    push(findings, 'motion', 'UNSUPPORTED', 'motion prop on PascalCase instance (see MOTION_PROPS_ON_INSTANCE)');
  } else if (variantFn || customProp) {
    push(findings, 'motion', 'CUSTOM', customFirst ?? 'variants-function or custom prop');
  }
}

// ─── 7. responsive ───────────────────────────────────────────────────────────
function classifyResponsive(code: string, ast: t.File, findings: EditabilityFinding[]): void {
  let nativeContainerCount = 0;
  let recoverableCount = 0;
  let firstRecoverable: string | null = null;
  let customCss = false;
  let firstCustom: string | null = null;

  // dialect-detect: container query blocks at the generator dialect
  traverse(ast, {
    TemplateLiteral(path) {
      const raw = path.node.quasis.map((q) => q.value.raw).join('${…}');
      if (!/@media|@container/.test(raw)) return;
      const media = raw.match(/@media[^{]*\{[^}]*\}/g) ?? [];
      for (const block of media) {
        if (/\(max-width:\s*\d+px\)/.test(block) && /\[data-id="[^"]+"\]/.test(block) && /!important/.test(block)) {
          nativeContainerCount++;
        } else if (/\[data-id="[^"]+"\]/.test(block)) {
          recoverableCount++;
          if (!firstRecoverable) firstRecoverable = 'hand-written @media targeting [data-id]';
        } else if (block.length > 0) {
          customCss = true;
          if (!firstCustom) firstCustom = 'hand-written @media without [data-id] selector';
        }
      }
    },
  });

  // broader sweep on the raw source (catches non-template-literal CSS)
  if (nativeContainerCount === 0 && recoverableCount === 0) {
    const mediaMatches = code.match(/@media\s*\([^)]*\)\s*\{[^}]*\}/g) ?? [];
    for (const block of mediaMatches) {
      if (/\[data-id="[^"]+"\]/.test(block)) {
        recoverableCount++;
        if (!firstRecoverable) firstRecoverable = 'hand-written @media targeting [data-id]';
      } else if (block.length > 0) {
        customCss = true;
        if (!firstCustom) firstCustom = 'hand-written @media without [data-id] selector';
      }
    }
  }

  if (nativeContainerCount > 0) {
    push(findings, 'responsive', 'NATIVE', nativeContainerCount + ' container-query blocks at generator dialect');
  } else if (recoverableCount > 0) {
    push(findings, 'responsive', 'RECOVERABLE', firstRecoverable + ' — normalizable via media-normalizer');
  } else if (customCss) {
    push(findings, 'responsive', 'CUSTOM', firstCustom ?? 'custom CSS without data-id selectors');
  }
}

// ─── 8. custom-logic ─────────────────────────────────────────────────────────
function classifyCustomLogic(ast: t.File, findings: EditabilityFinding[]): void {
  let effect = 0;
  let nonWhitelistImport = 0;
  let firstImport: string | null = null;
  let customHook = 0;
  let firstHook: string | null = null;
  let fnDecl = 0;
  const defaultFnNames = collectDefaultFunctionNames(ast);

  traverse(ast, {
    CallExpression(path) {
      const callee = path.node.callee;
      if (!t.isIdentifier(callee)) return;
      if (callee.name === 'useEffect') {
        effect++;
      } else if (
        /^use[A-Z]/.test(callee.name) &&
        callee.name !== 'useState' &&
        callee.name !== 'useRef' &&
        callee.name !== 'useMemo' &&
        callee.name !== 'useCallback' &&
        callee.name !== 'useContext' &&
        callee.name !== 'useReducer'
      ) {
        customHook++;
        if (!firstHook) firstHook = callee.name;
      }
    },
    ImportDeclaration(path) {
      const src = path.node.source.value;
      if (isAllowedImport(src)) return;
      nonWhitelistImport++;
      if (!firstImport) firstImport = src;
    },
    FunctionDeclaration(path) {
      if (defaultFnNames.has(path.node.id?.name ?? '')) return;
      fnDecl++;
    },
  });

  if (effect > 0 || customHook > 0 || fnDecl > 0 || nonWhitelistImport > 0) {
    const parts: string[] = [];
    if (effect > 0) parts.push(effect + ' useEffect');
    if (customHook > 0) parts.push(customHook + ' custom hook (' + firstHook + ')');
    if (fnDecl > 0) parts.push(fnDecl + ' function declaration');
    if (nonWhitelistImport > 0) parts.push('non-whitelist import (' + firstImport + ')');
    push(findings, 'custom-logic', 'CUSTOM', 'functional, stable, not no-code — ' + parts.join('; '));
  }
}

function collectDefaultFunctionNames(ast: t.File): Set<string> {
  const names = new Set<string>();
  traverse(ast, {
    ExportDefaultDeclaration(path) {
      const decl = path.node.declaration;
      if (t.isFunctionDeclaration(decl) && decl.id) names.add(decl.id.name);
      else if (t.isIdentifier(decl)) names.add(decl.name);
      // P7 (I8'): the canonical master shape — `export default
      // withResponsiveProps(Name)` — declares the component function, not
      // custom logic. Without this every canonical master miscounted its
      // own declaration as a foreign function.
      else if (
        t.isCallExpression(decl) &&
        t.isIdentifier(decl.callee, { name: 'withResponsiveProps' }) &&
        decl.arguments.length > 0 &&
        t.isIdentifier(decl.arguments[0])
      ) {
        names.add(decl.arguments[0].name);
      }
    },
  });
  return names;
}

function isAllowedImport(src: string): boolean {
  if (ALLOWED_IMPORT_SOURCES.has(src)) return true;
  for (const prefix of ALLOWED_IMPORT_SOURCES) {
    if (prefix.endsWith('/') && src.startsWith(prefix)) return true;
  }
  // relative imports are allowed (./Foo, ../Bar)
  if (src.startsWith('./') || src.startsWith('../')) return true;
  return false;
}

// ─── 9. unsupported-signatures ───────────────────────────────────────────────
function classifyUnsupportedSignatures(ast: t.File, findings: EditabilityFinding[]): void {
  let gsap = false;
  let binaryText = false;
  let binaryFirst: string | null = null;
  let dsi = false;
  let firstDsi: string | null = null;

  traverse(ast, {
    ImportDeclaration(path) {
      const src = path.node.source.value;
      if (src === 'gsap' || src.startsWith('gsap/')) {
        gsap = true;
      }
    },
    JSXExpressionContainer(path) {
      const parent = path.parent;
      // text position only — direct JSX child of an element
      if (!parent || !t.isJSXElement(parent)) return;
      const expr = (path.node as t.JSXExpressionContainer).expression as t.Expression;
      if (t.isBinaryExpression(expr)) {
        binaryText = true;
        if (!binaryFirst) binaryFirst = '{…+…} in text position @line ' + (expr.loc?.start.line ?? 0);
      }
    },
    JSXAttribute(path) {
      if (!t.isJSXIdentifier(path.node.name)) return;
      if (path.node.name.name !== 'dangerouslySetInnerHTML') return;
      dsi = true;
      if (!firstDsi) firstDsi = 'dangerouslySetInnerHTML @line ' + (path.node.loc?.start.line ?? 0);
    },
  });

  if (gsap) push(findings, 'unsupported-signatures', 'UNSUPPORTED', 'gsap import');
  if (binaryText) push(findings, 'unsupported-signatures', 'UNSUPPORTED', binaryFirst ?? '{a + b} in text position');
  if (dsi) push(findings, 'unsupported-signatures', 'UNSUPPORTED', firstDsi ?? 'dangerouslySetInnerHTML');
}

// ─── aggregation ─────────────────────────────────────────────────────────────
function aggregate(findings: EditabilityFinding[]): EditabilityReport {
  const counts = { native: 0, recoverable: 0, custom: 0, unsupported: 0 };
  for (const f of findings) {
    if (f.class === 'NATIVE') counts.native++;
    else if (f.class === 'RECOVERABLE') counts.recoverable++;
    else if (f.class === 'CUSTOM') counts.custom++;
    else counts.unsupported++;
  }

  let verdict: EditabilityReport['verdict'];
  if (counts.unsupported > 0) verdict = 'UNSUPPORTED';
  else if (counts.custom === 0 && counts.recoverable === 0) verdict = 'NATIVE';
  else if (counts.custom === 0) verdict = 'RECOVERABLE';
  else if (counts.native === 0) verdict = 'CUSTOM';
  else verdict = 'MIXED';

  return { verdict, counts, findings };
}