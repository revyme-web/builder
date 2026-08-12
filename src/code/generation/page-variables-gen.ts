// page-variables-gen.ts — Code generation for page-variable bindings + useState sync.
//
// Responsibilities:
//   1. bindStyleToPageVariableInCode  — swap inline style literal → JSX identifier
//   2. unbindStyleFromPageVariableInCode — swap JSX identifier → inline literal
//   3. syncPageVariableHooks         — emit `const [x, setX] = useState(default)`
//      for every declared page variable that's REFERENCED in the function body
//
// Why a separate sync pass instead of emitting the hook at bind time?
//   The user might bind/unbind several properties in one batch. Emitting a
//   useState per bind would shotgun stale declarations into the file. The sync
//   pass takes the source-of-truth (@pageVariables block + body references)
//   and reconciles the hook list once per flush.
//
// Component variables (`function Card({ x = 1 })`) live in the function
// signature — different mechanism, different file. Page variables share the
// JSX-identifier shape but their declaration site is the function body.

import * as t from '@babel/types';
import generate from '@babel/generator';
import { parseJSX, findFirstElementByDataId, findAttribute, traverse } from '../parsing/ast-utils';
import {
  parsePageVariables,
  isConditionalDisplayProperty,
  conditionalBranchesFor,
  type PageVariable,
  type PageVariableType,
} from '../features/page-variables';
import { trace } from '@/shared/debug-trace';

/**
 * Build the JSX value expression for a binding. Most variables go in as a
 * bare Identifier (`{ opacity: fadeVar }`). Boolean variables bound to
 * visibility-style properties go in as a ternary
 * (`{ display: hideVar ? 'none' : '' }`) — `display: true` isn't valid CSS,
 * so we expand the boolean to the right CSS strings at compile time.
 *
 * Returns null when the bind doesn't apply (caller should fall back to
 * the bare-identifier path).
 */
function buildBindingExpression(
  varName: string,
  varType: PageVariableType | undefined,
  styleProperty: string,
): t.Expression {
  if (varType === 'boolean' && isConditionalDisplayProperty(styleProperty)) {
    const branches = conditionalBranchesFor(styleProperty);
    if (branches) {
      return t.conditionalExpression(
        t.identifier(varName),
        t.stringLiteral(branches.consequent),
        t.stringLiteral(branches.alternate),
      );
    }
  }
  return t.identifier(varName);
}

/**
 * Detect whether a JSX value already represents a binding to `varName` —
 * either as a bare Identifier or as the boolean-→-visibility ternary shape
 * we emit. Lets us be idempotent on re-binds.
 */
function valueAlreadyBoundTo(value: t.Expression, varName: string, styleProperty: string): boolean {
  if (t.isIdentifier(value) && value.name === varName) return true;
  if (
    isConditionalDisplayProperty(styleProperty) &&
    t.isConditionalExpression(value) &&
    t.isIdentifier(value.test) &&
    value.test.name === varName
  ) return true;
  return false;
}

// ─── Step 1: Inline literal → JSX identifier ────────────────────────────────

/**
 * Replace `style={{ opacity: 0.5 }}` with `style={{ opacity: opacityVar }}`,
 * where `opacityVar` is the page variable name.
 *
 * If the property is missing from the style object, it's added as an
 * Identifier reference (matches createVariableInCode's "missing property"
 * path).
 */
export function bindStyleToPageVariableInCode(
  code: string,
  nodeId: string,
  styleProperty: string,
  varName: string,
): string {
  const ast = parseJSX(code);
  if (!ast) return code;

  // Look up the variable's type from the @pageVariables annotation. Type
  // info drives the JSX shape: boolean + display/visibility expands to a
  // ternary, everything else stays a bare identifier.
  const config = parsePageVariables(code);
  const varType = config?.variables.find(v => v.name === varName)?.type as PageVariableType | undefined;
  const buildValue = () => buildBindingExpression(varName, varType, styleProperty);

  let mutated = false;
  findFirstElementByDataId(ast, nodeId, (path) => {
    const opening = path.node.openingElement;
    const styleAttr = findAttribute(opening, 'style') as t.JSXAttribute | null;

    // No style attribute yet — add `style={{ <prop>: <bindingExpr> }}`
    if (!styleAttr) {
      const expr = t.objectExpression([
        t.objectProperty(t.identifier(styleProperty), buildValue()),
      ]);
      opening.attributes.push(
        t.jsxAttribute(t.jsxIdentifier('style'), t.jsxExpressionContainer(expr)),
      );
      mutated = true;
      return;
    }

    if (styleAttr.value?.type !== 'JSXExpressionContainer') return;
    const expr = styleAttr.value.expression;
    if (!t.isObjectExpression(expr)) return;

    let propertyExists = false;
    for (const prop of expr.properties) {
      if (!t.isObjectProperty(prop)) continue;
      const key = t.isIdentifier(prop.key) ? prop.key.name
        : t.isStringLiteral(prop.key) ? prop.key.value : null;
      if (key !== styleProperty) continue;

      // Replaceable value shapes: literal/template/our-own-binding-shape.
      // We refuse to overwrite arbitrary user expressions — if the slot
      // holds a function call or some random JSX, leave it alone.
      const isLiteral = t.isStringLiteral(prop.value) || t.isNumericLiteral(prop.value);
      const isStaticTemplate = t.isTemplateLiteral(prop.value)
        && prop.value.expressions.length === 0
        && prop.value.quasis.length === 1;
      const isAlreadyBound = valueAlreadyBoundTo(prop.value as t.Expression, varName, styleProperty);
      if (!isLiteral && !isStaticTemplate && !isAlreadyBound) return;

      propertyExists = true;
      if (!isAlreadyBound) {
        prop.value = buildValue();
        mutated = true;
      }
      break;
    }

    if (!propertyExists) {
      expr.properties.push(
        t.objectProperty(t.identifier(styleProperty), buildValue()),
      );
      mutated = true;
    }
  });

  if (!mutated) return code;

  try {
    const out = generate(ast, { retainLines: true }, code);
    trace.action('page-vars-gen:bind', { nodeId, styleProperty, varName });
    return out.code;
  } catch (err) {
    trace.error('page-vars-gen:bind-generate-failed', { nodeId, styleProperty, varName, error: err instanceof Error ? err.message : String(err) });
    return code;
  }
}

// ─── Step 2: JSX identifier → inline literal ────────────────────────────────

/**
 * Reverse of `bindStyleToPageVariableInCode`. Replaces `opacity: opacityVar`
 * with `opacity: '<value>'` (the literal the user wants on unbind — typically
 * the variable's current default, surfaced by the caller).
 */
export function unbindStyleFromPageVariableInCode(
  code: string,
  nodeId: string,
  styleProperty: string,
  literalValue: string,
): string {
  const ast = parseJSX(code);
  if (!ast) return code;

  let mutated = false;
  findFirstElementByDataId(ast, nodeId, (path) => {
    const opening = path.node.openingElement;
    const styleAttr = findAttribute(opening, 'style') as t.JSXAttribute | null;
    if (!styleAttr || styleAttr.value?.type !== 'JSXExpressionContainer') return;
    const expr = styleAttr.value.expression;
    if (!t.isObjectExpression(expr)) return;

    for (const prop of expr.properties) {
      if (!t.isObjectProperty(prop)) continue;
      const key = t.isIdentifier(prop.key) ? prop.key.name
        : t.isStringLiteral(prop.key) ? prop.key.value : null;
      if (key !== styleProperty) continue;

      // Two binding shapes can be sitting in this slot:
      //   - bare Identifier              ← number/text/color/image bindings
      //   - ConditionalExpression(test=Identifier, …)  ← boolean→display ternary
      // Anything else means the user authored their own expression — bail.
      const isIdentBinding = t.isIdentifier(prop.value);
      const isTernaryBinding =
        t.isConditionalExpression(prop.value) && t.isIdentifier(prop.value.test);
      if (!isIdentBinding && !isTernaryBinding) return;

      // Empty literal means "remove the property entirely" — matches the
      // codebase-wide "empty string = remove property" convention.
      if (literalValue === '') {
        expr.properties = expr.properties.filter(p => p !== prop);
      } else {
        prop.value = t.stringLiteral(literalValue);
      }
      mutated = true;
      break;
    }
  });

  if (!mutated) return code;

  try {
    const out = generate(ast, { retainLines: true }, code);
    trace.action('page-vars-gen:unbind', { nodeId, styleProperty, literalValue });
    return out.code;
  } catch (err) {
    trace.error('page-vars-gen:unbind-generate-failed', { nodeId, styleProperty, error: err instanceof Error ? err.message : String(err) });
    return code;
  }
}

// ─── Step 3: useState sync ──────────────────────────────────────────────────

/**
 * Walk the function body, find the page-component function, and reconcile its
 * `const [x, setX] = useState(...)` declarations against the page-variables
 * annotation block.
 *
 * Rule:
 *   - For every declared variable that's REFERENCED somewhere in the function
 *     body, ensure a matching useState declaration exists at the top.
 *   - For every existing useState declaration whose name matches a declared
 *     variable but is NO LONGER referenced (anywhere outside its own
 *     declaration), remove it. This keeps the file clean when the last
 *     binding to a variable is removed but the variable itself still exists.
 *   - Stale declarations that don't match any declared page variable are
 *     left alone — they may be hand-written useState by the user.
 *
 * This pass runs after every page-variable mutation (bind/unbind/add/remove).
 * It deliberately does NOT touch the imports — `syncImports` in
 * mutation-queue.ts already adds `useState` when it detects `\buseState\b`
 * in the body.
 */
export function syncPageVariableHooks(code: string): string {
  const config = parsePageVariables(code);
  const declared = config?.variables ?? [];
  // Even with zero declared variables, we still want to remove orphan
  // useState declarations whose names match the (now empty) declared list.
  // Just bail if there's nothing to do — neither declared nor existing.

  const ast = parseJSX(code);
  if (!ast) return code;

  // Step A: find the default-export function (the page component).
  let pageFn: t.FunctionDeclaration | t.FunctionExpression | t.ArrowFunctionExpression | null = null;
  let pageFnPath: any = null;
  traverse(ast, {
    ExportDefaultDeclaration(path) {
      const decl = path.node.declaration;
      if (t.isFunctionDeclaration(decl)) {
        pageFn = decl;
        pageFnPath = path.get('declaration');
      } else if (t.isIdentifier(decl)) {
        // `export default Foo` — find the named function declaration.
        const programPath: any = path.findParent(p => p.isProgram());
        const programBody = programPath?.node?.body ?? [];
        for (const stmt of programBody) {
          if (t.isFunctionDeclaration(stmt) && stmt.id?.name === decl.name) {
            pageFn = stmt;
            // Don't have a path for stmt directly here — fall back to walking
            // the program body when we need to mutate (rare case).
            break;
          }
        }
      } else if (t.isCallExpression(decl)) {
        // `export default withResponsiveProps(Foo)` — walk back to the function.
        const arg = decl.arguments[0];
        if (t.isIdentifier(arg)) {
          const programPath: any = path.findParent(p => p.isProgram());
          const programBody = programPath?.node?.body ?? [];
          for (const stmt of programBody) {
            if (t.isFunctionDeclaration(stmt) && stmt.id?.name === arg.name) {
              pageFn = stmt;
              break;
            }
          }
        }
      }
      path.stop();
    },
    FunctionDeclaration(path) {
      // Fallback: first top-level function declaration if no default export
      // path captured one. Page files written by the canvas always have an
      // `export default function`-shaped pair, but tests sometimes don't.
      if (!pageFn) {
        pageFn = path.node;
        pageFnPath = path;
      }
    },
  });

  if (!pageFn) return code;
  // Get a stable handle on the function's body — we need to reach it via the
  // AST regardless of which export shape we detected.
  const fnNode = pageFn as t.FunctionDeclaration | t.FunctionExpression | t.ArrowFunctionExpression;
  if (!t.isBlockStatement(fnNode.body)) return code;
  const body = fnNode.body;

  // Step B: collect references to declared page-variable names anywhere INSIDE
  // the function body. We scan the generated source of the body once because
  // `\bname\b` regex over generated text is faster than a full traverse and
  // good enough — the names we look for are unique camelCase identifiers and
  // false positives in strings/comments are rare and harmless.
  const bodyCode = generate(body, { retainLines: true }).code;
  const referenced = new Set<string>();
  for (const v of declared) {
    // Reference test: identifier appears somewhere OTHER than the useState
    // declaration line. We approximate this by checking that the name appears
    // at least twice — once is the declaration, anything more is real usage.
    const re = new RegExp(`\\b${v.name}\\b`, 'g');
    const matches = bodyCode.match(re);
    if (matches && matches.length > 1) referenced.add(v.name);
    // Edge case: never declared yet but already referenced (e.g. JSX written
    // before useState was emitted — first bind in our flow). Match count of 1
    // means it appears only as a JSX identifier without a declaration; still
    // counts as referenced.
    else if (matches && matches.length === 1 && !hasUseStateForName(body, v.name)) referenced.add(v.name);
  }

  const declaredNames = new Set(declared.map(v => v.name));

  // Step C: remove existing useState declarations for declared names that are
  // no longer referenced.
  let mutated = false;
  body.body = body.body.filter(stmt => {
    if (!t.isVariableDeclaration(stmt)) return true;
    if (stmt.declarations.length !== 1) return true;
    const d = stmt.declarations[0];
    if (!t.isArrayPattern(d.id) || d.id.elements.length !== 2) return true;
    const first = d.id.elements[0];
    if (!t.isIdentifier(first)) return true;
    const name = first.name;
    if (!declaredNames.has(name)) return true; // not ours
    if (referenced.has(name)) return true; // keep
    // Drop — declared but unreferenced.
    mutated = true;
    return false;
  });

  // Variables that are already FUNCTION PARAMS must NEVER get a useState — a TEMPLATE
  // (LayoutClient) and a component read their variables as destructured props (`{ headerVariant
  // = "" }`), not useState. Emitting `const [headerVariant…] = useState(…)` for a param is a
  // duplicate declaration ("Identifier 'headerVariant' has already been declared"). Real pages
  // have no such params, so this is a no-op there.
  const paramNames = new Set<string>();
  const firstParam = (pageFn as t.Function).params?.[0];
  if (firstParam && t.isObjectPattern(firstParam)) {
    for (const p of firstParam.properties) {
      if (t.isObjectProperty(p) && t.isIdentifier(p.key)) paramNames.add(p.key.name);
      else if (t.isRestElement(p) && t.isIdentifier(p.argument)) paramNames.add(p.argument.name);
    }
  }

  // Step D: insert missing useState declarations at the TOP of the body, in
  // the same order they appear in the @pageVariables block.
  const existingDecls = collectUseStateNames(body);
  const insertions: t.Statement[] = [];
  for (const v of declared) {
    if (!referenced.has(v.name)) continue;
    if (existingDecls.has(v.name)) continue;
    if (paramNames.has(v.name)) continue; // already a function param (template/component) — skip
    insertions.push(buildUseStateStatement(v));
    mutated = true;
  }

  if (insertions.length > 0) {
    body.body.unshift(...insertions);
  }

  if (!mutated) return code;

  try {
    const out = generate(ast, { retainLines: true }, code);
    trace.action('page-vars-gen:sync-hooks', { declared: declared.length, referenced: referenced.size, inserted: insertions.length });
    return out.code;
  } catch (err) {
    trace.error('page-vars-gen:sync-hooks-failed', { error: err instanceof Error ? err.message : String(err) });
    return code;
  }
}

// ─── Canvas dormantize (module-scope safety) ─────────────────────────────────

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A page variable's default rendered as a JS literal — used to neutralize a
 *  reference that can't resolve at module scope (the canvasNodes fragment). */
function defaultLiteralFor(v: PageVariable): string {
  switch (v.type as PageVariableType) {
    case 'number': { const n = parseFloat(v.default); return Number.isFinite(n) ? String(n) : '0'; }
    case 'boolean': return v.default === 'true' ? 'true' : 'false';
    default: return JSON.stringify(v.default ?? ''); // text/color/image → quoted string
  }
}

/**
 * SELF-HEAL: a subtree dragged/pasted onto the CANVAS lands in the module-scope
 * `const canvasNodes = (<>…</>)` fragment, which CANNOT see page-function vars
 * (`useState`). A search field (`value={searchX}`) or a dynamic CMS filter
 * (`.filter(item => (searchX === '' || …))`) carried in there references `searchX`
 * at module scope → "searchX is not defined" at module eval → the whole page
 * crashes and validation blocks every later mutation.
 *
 * Fix: within the fragment, replace each page-variable reference with its DEFAULT
 * literal (text → `""`, number → the number, …) so the JSX/predicate is inert but
 * valid. The replace is string/property/key aware so it never touches a `var:`
 * STRING attribute (`data-search-field="searchX"`), a property access
 * (`item.searchX`), or a CSS object KEY (`opacity:`). Idempotent (after one pass
 * no live references remain). Mirrors `dormantizeFormBindingsInCanvas`.
 */
export function dormantizePageVarBindingsInCanvas(code: string): string {
  if (code.indexOf('const canvasNodes') === -1) return code;

  // Fragment bounds — emitted as `const canvasNodes = <>…</>;` OR `= (<>…</>);`.
  const start = code.indexOf('const canvasNodes');
  const open = code.indexOf('<>', start);
  if (open === -1) return code;
  const close = code.lastIndexOf('</>');
  if (close <= open) return code;

  let frag = code.slice(open + 2, close);
  const before = frag;

  // Names to neutralize → their replacement literal. canvasNodes is MODULE scope,
  // so EVERY page-function-scoped reference is invalid here:
  //   • this page's declared page variables → their typed default literal
  //   • any `data-search-field="X"` var (a Search Field) — INCLUDING one this page
  //     doesn't declare (pasted from ANOTHER page) → "" (treated as MISSING, not a
  //     crash; the data-search-field STRING marker survives so the input can be
  //     re-attached). Without this, a cross-page paste references an undeclared
  //     `searchX` → "searchX is not defined" → page crash + every mutation blocked.
  const names = new Map<string, string>();
  for (const v of (parsePageVariables(code)?.variables ?? [])) {
    if (v) names.set(v.name, defaultLiteralFor(v));
  }
  for (const m of frag.matchAll(/data-search-field="([^"]+)"/g)) {
    if (!names.has(m[1])) names.set(m[1], '""');
  }
  if (!names.size) return code;

  for (const [name, def] of names) {
    if (!new RegExp(`\\b${escapeRe(name)}\\b`).test(frag)) continue;
    // Match a bare reference: NOT preceded by a quote (string) / word char / `.`
    // (property access); NOT followed by a quote / word char / `:` (object key).
    const re = new RegExp(`(?<!["'\\w$.])${escapeRe(name)}(?!["'\\w$]|\\s*:)`, 'g');
    frag = frag.replace(re, def);
  }
  if (frag === before) return code;
  // EMPTY-STRING BAKE CLEANUP — the '' = remove-property convention must hold
  // here too. A TEXT variable with an empty default baked `key: ""` into an
  // object literal (e.g. a bound `padding: padding` → `padding: ""`), and a
  // PERSISTED empty style value is a renderer-divergence bomb: client-side
  // React assigns style keys in object order, and assigning '' to a SHORTHAND
  // (padding/margin/background/…) removes all its longhands via CSSOM — so
  // the editor PREVIEW (client-render) lost the padding while SSR (published
  // site, which skips empty values when serializing) and the canvas (clear-
  // then-set order) kept it (the Wisp footer, 2026-08-12). Strip the pair:
  //   { padding: "", flex: … } → { flex: … }     (leading comma form too)
  frag = frag
    .replace(/([{,]\s*)([a-zA-Z_$][\w$]*)\s*:\s*""\s*,/g, '$1')
    .replace(/,\s*([a-zA-Z_$][\w$]*)\s*:\s*""(\s*[},])/g, '$2')
    .replace(/([{]\s*)([a-zA-Z_$][\w$]*)\s*:\s*""(\s*})/g, '$1$3');
  trace.action('page-vars-gen:dormantize-canvas', { names: names.size });
  return code.slice(0, open + 2) + frag + code.slice(close);
}

/**
 * SELF-HEAL: a Search Field pasted INTO A VIEWPORT (page tree, not canvasNodes) of
 * a page that doesn't declare its variable → `value={searchX}` + the dynamic
 * `.filter(item => (searchX === '' || …))` reference an UNDECLARED `searchX` →
 * "searchX is not defined" → page crash + every mutation blocked.
 *
 * Unlike `dormantizePageVarBindingsInCanvas` (canvasNodes only, neutralizes ALL
 * page-var refs because module scope can't see page-fn vars), this scans the WHOLE
 * file and neutralizes ONLY the references whose var is genuinely MISSING (not in
 * `@pageVariables` AND not a `useState` in the page fn). A declared/working search
 * field is left untouched. The `data-search-field="X"` STRING marker survives, so
 * the Input tool's chip renders "Missing" for re-attach (see PageVariableChip).
 */
export function neutralizeMissingSearchFieldsInCode(code: string): string {
  if (code.indexOf('data-search-field') === -1) return code;

  // Identifiers this page genuinely declares: @pageVariables + page-fn useState.
  const declared = new Set<string>();
  for (const v of (parsePageVariables(code)?.variables ?? [])) { if (v) declared.add(v.name); }
  for (const m of code.matchAll(/const\s*\[\s*([A-Za-z_$][\w$]*)\s*,\s*set[A-Za-z0-9_$]*\s*\]\s*=\s*(?:React\.)?useState\b/g)) {
    declared.add(m[1]);
  }

  const missing = new Set<string>();
  for (const m of code.matchAll(/data-search-field="([^"]+)"/g)) {
    if (!declared.has(m[1])) missing.add(m[1]);
  }
  if (!missing.size) return code;

  let out = code;
  for (const name of missing) {
    // Bare reference only — never a string (`"searchX"` / the marker), a property
    // access (`item.searchX`), a CSS key (`searchX:`), or the setter (`setSearchX`).
    out = out.replace(new RegExp(`(?<!["'\\w$.])${escapeRe(name)}(?!["'\\w$]|\\s*:)`, 'g'), '""');
  }
  trace.action('page-vars-gen:neutralize-missing-search', { count: missing.size });
  return out;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function collectUseStateNames(body: t.BlockStatement): Set<string> {
  const names = new Set<string>();
  for (const stmt of body.body) {
    if (!t.isVariableDeclaration(stmt)) continue;
    if (stmt.declarations.length !== 1) continue;
    const d = stmt.declarations[0];
    if (!t.isArrayPattern(d.id) || d.id.elements.length !== 2) continue;
    const first = d.id.elements[0];
    if (!t.isIdentifier(first)) continue;
    if (!t.isCallExpression(d.init)) continue;
    const callee = d.init.callee;
    if (!t.isIdentifier(callee) || callee.name !== 'useState') continue;
    names.add(first.name);
  }
  return names;
}

function hasUseStateForName(body: t.BlockStatement, name: string): boolean {
  return collectUseStateNames(body).has(name);
}

function buildUseStateStatement(v: PageVariable): t.VariableDeclaration {
  const setterName = `set${v.name.charAt(0).toUpperCase()}${v.name.slice(1)}`;
  return t.variableDeclaration('const', [
    t.variableDeclarator(
      t.arrayPattern([t.identifier(v.name), t.identifier(setterName)]),
      t.callExpression(t.identifier('useState'), [defaultExpressionForVariable(v)]),
    ),
  ]);
}

/**
 * Rename a page variable's RUNTIME hook to match an annotation rename. The
 * `@pageVariables` block is rewritten separately (annotation-only) by
 * `updatePageVariableInCode`; this moves the `const [name, setName] = useState(…)`
 * value + setter bindings AND every reference (bound `style` identifiers,
 * `setName(…)` interaction calls, `{name}` children) via babel's scope-aware
 * rename, so the system invariant — annotation name === hook === setter — is
 * preserved. Without it, a rename leaves the OLD hook behind (`const [color,
 * setColor]` after renaming the annotation to `test`), and the Interactions
 * tool can no longer find the variable's setter (it looks for `set<NewName>`),
 * so the "Set Variable" "+" silently disappears. No-op when the old hook pair
 * isn't present (already renamed / pre-existing mismatch). Pure string→string.
 */
export function renamePageVariableHookInCode(code: string, oldName: string, newName: string): string {
  if (!oldName || !newName || oldName === newName) return code;
  const ast = parseJSX(code);
  if (!ast) return code;
  const setterOf = (n: string) => `set${n.charAt(0).toUpperCase()}${n.slice(1)}`;
  const oldSetter = setterOf(oldName);
  const newSetter = setterOf(newName);
  let renamed = false;
  traverse(ast, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Function(path: any) {
      if (renamed) return;
      // The page variable's value + setter are a `const [name, setName] =
      // useState(…)` pair declared in the page function scope. Require BOTH
      // bindings so we only ever rename a genuine useState pair, never an
      // unrelated identifier that happens to share the name.
      const valueBinding = path.scope.getBinding(oldName);
      const setterBinding = path.scope.getBinding(oldSetter);
      if (valueBinding && setterBinding) {
        path.scope.rename(oldName, newName);
        path.scope.rename(oldSetter, newSetter);
        renamed = true;
        path.stop();
      }
    },
  });
  if (!renamed) return code;
  try {
    const out = generate(ast, { retainLines: true }, code).code;
    trace.action('page-vars-gen:rename-hook', { oldName, newName });
    return out;
  } catch (err) {
    trace.error('page-vars-gen:rename-hook-failed', { oldName, newName, error: err instanceof Error ? err.message : String(err) });
    return code;
  }
}

/**
 * Coerce the variable's stored string default into the right JS literal type:
 *   number  → NumericLiteral (1, 0.5)
 *   boolean → BooleanLiteral (true / false)
 *   color   → StringLiteral ("#ff0000")
 *   text    → StringLiteral
 *
 * Falls back to a string literal when a number variable has a non-numeric
 * default — keeps the file syntactically valid even with weird input.
 */
function defaultExpressionForVariable(v: PageVariable): t.Expression {
  switch (v.type as PageVariableType) {
    case 'number': {
      const n = parseFloat(v.default);
      return Number.isFinite(n) ? t.numericLiteral(n) : t.stringLiteral(v.default);
    }
    case 'boolean':
      return t.booleanLiteral(v.default === 'true');
    case 'color':
    case 'text':
    case 'image':
    default:
      // image stores the full CSS string (`url(...)`) so this slot reads
      // straight into a `backgroundImage:` style attribute.
      return t.stringLiteral(v.default);
  }
}
