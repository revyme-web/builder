// text-override-gen.ts — Per-viewport text content via a single inline hook
// call. Source JSX:
//
//   plain  → <p data-id="t1">Hello</p>
//   wrap   → <p data-id="t1">{useResponsiveText('Hello', { 768: 'Hi' })}</p>
//
// The hook resolves to the right string at runtime based on `window.innerWidth`
// — so each viewport's React subtree renders the correct variant in its own
// `<p>`. Live preview, SSR, and the editor's per-viewport flow all just work
// because every viewport is its own React tree.
//
// The hook function definition is auto-injected at the top of the file the
// FIRST time any text element gets a non-primary override; auto-removed once
// no element references it. Files without responsive text stay untouched.

import * as t from '@babel/types';
import { ensureMediaQueryHook } from './scoped-expr';
import { parseJSX, findFirstElementByDataId, traverse } from '../parsing/ast-utils';
import { trace } from '@/shared/debug-trace';
import { generate, ensureNamedImport } from './generator-utils';

/** The function name the inline hook is registered under. */
export const HOOK_NAME = 'useResponsiveText';

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Set (or update, or remove) a per-viewport text override on a text element.
 *
 * - `vpWidth === primaryWidth` (primary edit):
 *     - element wrapped in `useResponsiveText` → updates the FIRST ARG (primary)
 *     - element plain → updates JSXText children (no hook needed)
 * - `vpWidth !== primaryWidth` (non-primary edit):
 *     - element plain → wraps in hook with `{ vpWidth: text }` overrides
 *     - element wrapped → adds/replaces overrides[vpWidth]
 * - Empty `text` AND `vpWidth !== primaryWidth`: removes that override entry.
 *   If overrides becomes empty, unwraps the hook back to plain JSXText.
 *
 * Also ensures the inline hook function definition exists in the file once
 * any element wraps in it, and removes it when no element uses it anymore.
 */
export function setTextOverrideInCode(
  code: string,
  nodeId: string,
  vpWidth: number,
  primaryWidth: number,
  text: string,
  /**
   * Full list of every configured viewport's width on this page. Used as the
   * third argument to `useResponsiveText` so the runtime hook can bucket the
   * live `vpWidth` correctly (a tablet override at 768 should NOT fire on
   * a mobile viewport at 375). Pass the union of all viewport widths from
   * the `@canvas` block; the hook handles sorting and bucket selection.
   */
  allViewportWidths: number[] = [],
): string {
  trace.fn('text-override-gen.set', { nodeId, vpWidth, primaryWidth, len: text.length, vpCount: allViewportWidths.length });
  const ast = parseJSX(code);
  if (!ast) return code;

  const isPrimary = vpWidth === primaryWidth;

  let mutated = false;
  findFirstElementByDataId(ast, nodeId, (path) => {
    const wrapper = findHookCall(path.node.children);
    if (wrapper) {
      // Already wrapped — update in place.
      if (isPrimary) {
        // Update first arg (primary string).
        wrapper.arguments[0] = t.stringLiteral(text);
      } else {
        const obj = ensureOverridesObject(wrapper);
        if (text === '') {
          removeOverrideKey(obj, vpWidth);
        } else {
          setOverrideKey(obj, vpWidth, text);
        }
        // If overrides emptied AND primary still has a value, unwrap.
        if (obj.properties.length === 0) {
          const primaryArg = wrapper.arguments[0];
          if (t.isStringLiteral(primaryArg)) {
            path.node.children = [t.jsxText(primaryArg.value)];
          }
        }
      }
      mutated = true;
      path.stop();
      return;
    }

    // Not wrapped yet — only wrap when this is a NON-primary override.
    // Primary edits on a plain element should fall through to a normal
    // text update (delegated by the caller via `setTextOverrideInCode`'s
    // `isPrimary` check below).
    if (isPrimary) {
      // No wrapper, primary edit → plain text replace.
      path.node.children = [t.jsxText(text)];
      mutated = true;
      path.stop();
      return;
    }

    // Non-primary, plain element → wrap.
    const currentPlain = extractPlainText(path.node.children);
    const call = makeHookCall(currentPlain, [{ width: vpWidth, text }], allViewportWidths);
    path.node.children = [t.jsxExpressionContainer(call)];
    mutated = true;
    path.stop();
  });

  if (!mutated) return code;

  // Sync the `vpWidths` third argument across every existing hook call in
  // the file. Viewport widths can change (user resizes a viewport, adds a
  // new breakpoint) — without this every text-override call goes stale and
  // the runtime hook can't bucket correctly.
  let out = generate(ast, { retainLines: false, concise: false }, code).code;
  if (allViewportWidths.length > 0) {
    out = syncVpWidthsArg(out, allViewportWidths);
  }
  // Make sure the inline hook function definition lives in the file. If we
  // just unwrapped the last reference, prune it.
  out = ensureHookFunction(out);
  return out;
}

/**
 * Remove a viewport override entirely. Equivalent to passing `text=''` to
 * `setTextOverrideInCode`, given as a separate name so call sites read clearly.
 */
export function removeTextOverrideInCode(
  code: string,
  nodeId: string,
  vpWidth: number,
  primaryWidth: number,
  allViewportWidths: number[] = [],
): string {
  return setTextOverrideInCode(code, nodeId, vpWidth, primaryWidth, '', allViewportWidths);
}

/**
 * Inspect a node's element and return the override widths currently set on
 * its `useResponsiveText` call (excluding the primary). Returns empty when
 * the element is plain. Used by callers that want to know "does this node
 * have any responsive text variants?" without re-parsing themselves.
 */
export function getTextOverrideWidths(code: string, nodeId: string): number[] {
  const ast = parseJSX(code);
  if (!ast) return [];
  const out: number[] = [];
  findFirstElementByDataId(ast, nodeId, (path) => {
    const wrapper = findHookCall(path.node.children);
    if (!wrapper) {
      path.stop();
      return;
    }
    const obj = wrapper.arguments[1];
    if (!obj || !t.isObjectExpression(obj)) {
      path.stop();
      return;
    }
    for (const p of obj.properties) {
      if (!t.isObjectProperty(p)) continue;
      const k = p.key;
      if (t.isNumericLiteral(k)) out.push(k.value);
      else if (t.isStringLiteral(k)) {
        const n = parseFloat(k.value);
        if (!Number.isNaN(n)) out.push(n);
      }
    }
    path.stop();
  });
  return out;
}

// ─── AST helpers ───────────────────────────────────────────────────────────

/** Walk children to find a `{useResponsiveText(...)}` expression container. */
function findHookCall(children: t.JSXElement['children']): t.CallExpression | null {
  for (const c of children) {
    if (!t.isJSXExpressionContainer(c)) continue;
    const expr = c.expression;
    if (
      t.isCallExpression(expr) &&
      t.isIdentifier(expr.callee) &&
      expr.callee.name === HOOK_NAME
    ) {
      return expr;
    }
  }
  return null;
}

/** Get the existing overrides object literal, or create one as `arguments[1]`. */
function ensureOverridesObject(call: t.CallExpression): t.ObjectExpression {
  const a = call.arguments[1];
  if (a && t.isObjectExpression(a)) return a;
  const obj = t.objectExpression([]);
  call.arguments[1] = obj;
  return obj;
}

function setOverrideKey(obj: t.ObjectExpression, width: number, text: string): void {
  // Remove any existing entry for this width — covers both numeric- and
  // string-literal keys (some users may hand-edit the object).
  removeOverrideKey(obj, width);
  obj.properties.push(
    t.objectProperty(t.numericLiteral(width), t.stringLiteral(text), /* computed */ false, /* shorthand */ false),
  );
  // Keep numeric keys sorted descending so the file diff is stable.
  obj.properties.sort((a, b) => {
    const aw = readKeyWidth(a);
    const bw = readKeyWidth(b);
    if (aw === null || bw === null) return 0;
    return bw - aw;
  });
}

function removeOverrideKey(obj: t.ObjectExpression, width: number): void {
  obj.properties = obj.properties.filter((p) => readKeyWidth(p) !== width);
}

function readKeyWidth(p: t.ObjectExpression['properties'][number]): number | null {
  if (!t.isObjectProperty(p)) return null;
  if (t.isNumericLiteral(p.key)) return p.key.value;
  if (t.isStringLiteral(p.key)) {
    const n = parseFloat(p.key.value);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

function extractPlainText(children: t.JSXElement['children']): string {
  let out = '';
  for (const c of children) {
    if (t.isJSXText(c)) out += c.value;
    else if (
      t.isJSXExpressionContainer(c) &&
      t.isStringLiteral(c.expression)
    ) {
      out += c.expression.value;
    }
    // Other shapes (rich-text marks, etc.) are flattened to empty — V1
    // limitation. Authors who add an override on a rich-text element lose
    // their inline marks. Documented in the lesson.
  }
  return out.trim();
}

function makeHookCall(
  primary: string,
  overrides: Array<{ width: number; text: string }>,
  vpWidths: number[],
): t.CallExpression {
  const args: t.Expression[] = [t.stringLiteral(primary)];
  if (overrides.length > 0) {
    const obj = t.objectExpression(
      overrides.map((o) =>
        t.objectProperty(
          t.numericLiteral(o.width),
          t.stringLiteral(o.text),
          false,
          false,
        ),
      ),
    );
    args.push(obj);
  } else {
    // Always emit the overrides slot even when empty so the third arg's
    // position stays stable. Avoids `useResponsiveText('text', undefined,
    // [375, 768])` being mis-parsed as overrides=[375, 768].
    args.push(t.objectExpression([]));
  }
  args.push(t.arrayExpression(vpWidths.map((w) => t.numericLiteral(w))));
  return t.callExpression(t.identifier(HOOK_NAME), args);
}

/**
 * Walk every `useResponsiveText(...)` call in the file and replace its third
 * argument (the viewport-widths array) with the up-to-date list. Called after
 * every `setTextOverrideInCode` so a viewport resize / add / remove
 * propagates to every existing call site without the user having to re-edit
 * each text element.
 */
function syncVpWidthsArg(code: string, allViewportWidths: number[]): string {
  const ast = parseJSX(code);
  if (!ast) return code;
  const sortedAsc = [...allViewportWidths]
    .filter((w) => Number.isFinite(w) && w > 0)
    .sort((a, b) => a - b);
  let touched = false;
  traverse(ast, {
    CallExpression(p: any) {
      const callee = p.node.callee;
      if (!t.isIdentifier(callee) || callee.name !== HOOK_NAME) return;
      while (p.node.arguments.length < 2) {
        p.node.arguments.push(t.objectExpression([]));
      }
      const newArr = t.arrayExpression(sortedAsc.map((w) => t.numericLiteral(w)));
      p.node.arguments[2] = newArr;
      touched = true;
    },
  });
  if (!touched) return code;
  try {
    return generate(ast, { retainLines: false, concise: false }, code).code;
  } catch {
    return code;
  }
}

// ─── Inline hook function definition ───────────────────────────────────────
//
// The hook is inlined into the page file so the file is self-contained — no
// shared module to import. Lives between the imports and `export default`.

// The hook is a small component because it needs a DOM ref to walk up to
// the closest ancestor with `data-viewport-width` (set by Revyme's
// renderer on each viewport root). Without that, all canvas viewports share
// `window.innerWidth` and resolve to the primary text. The wrapper span uses
// `display: contents` so it's structurally invisible — it doesn't break flex
// children, line-wrapping, or any layout the parent text element relies on.
//
// In live preview (no `[data-viewport-width]` ancestor), the component falls
// back to `window.innerWidth` and listens for window resize. In the canvas
// it uses ResizeObserver on the viewport root so resizing the viewport's
// breakpoint width is reflected immediately.
const HOOK_DEFINITION = `
function ${HOOK_NAME}(primary, overrides, vpWidths) {
  const ref = useRef(null);
  const [w, setW] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth : Infinity
  );
  useLayoutEffect(() => {
    if (typeof window === 'undefined') return;
    let host = ref.current && ref.current.parentElement;
    while (host && host !== document.body && !host.hasAttribute('data-viewport-width')) {
      host = host.parentElement;
    }
    if (host && host.hasAttribute && host.hasAttribute('data-viewport-width')) {
      const read = () => setW(parseInt(host.getAttribute('data-viewport-width'), 10) || window.innerWidth);
      read();
      const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(read) : null;
      if (ro) ro.observe(host);
      const mo = new MutationObserver(read);
      mo.observe(host, { attributes: true, attributeFilter: ['data-viewport-width'] });
      return () => { if (ro) ro.disconnect(); mo.disconnect(); };
    }
    const onResize = () => setW(window.innerWidth);
    setW(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  // Bucket the current width into one of the configured viewports, then look
  // up that bucket's override. Smallest viewport width >= w wins. If no
  // viewport is wider than w, fall through to primary. Without the full
  // viewport list, we can't tell mobile (375) from tablet (768) when only
  // tablet has an override — both would resolve to tablet's text.
  const widths = (vpWidths || Object.keys(overrides || {}).map(Number))
    .filter(function (n) { return typeof n === 'number' && isFinite(n) && n > 0; })
    .slice().sort(function (a, b) { return a - b; });
  let bucket = null;
  for (let i = 0; i < widths.length; i++) {
    if (w <= widths[i]) { bucket = widths[i]; break; }
  }
  let value = primary;
  if (bucket !== null && overrides && overrides[bucket] !== undefined) {
    value = overrides[bucket];
  }
  // Override values may contain rich-text marks emitted by TipTap on commit
  // (\`<span style="font-size: 14px">word</span>\` etc.). Plain string children
  // get escaped by React, so use dangerouslySetInnerHTML when the value looks
  // like HTML. Plain text falls through to the children path so React's text
  // diffing stays cheap.
  const isHtml = typeof value === 'string' && /<[a-z][^>]*>/i.test(value);
  return isHtml
    ? React.createElement('span', {
        ref: ref,
        style: { display: 'contents' },
        dangerouslySetInnerHTML: { __html: value },
      })
    : React.createElement('span', { ref: ref, style: { display: 'contents' } }, value);
}
`.trim();

const HOOK_BEGIN_MARKER = `// @${HOOK_NAME}-begin`;
const HOOK_END_MARKER = `// @${HOOK_NAME}-end`;

/**
 * If the code contains any `useResponsiveText(...)` call, ensure the
 * function definition lives in the file (and `useState` / `useEffect` are
 * imported from React). If no calls exist, prune the definition.
 *
 * NOTE: cms-responsive-gen.ensureResponsiveListHooks mirrors this
 * marker-fenced-block pattern but deliberately diverges (two used-regexes,
 * imports left to syncImports, prune replaces with '\n' not '') — a shared
 * util was evaluated and rejected in phase-9 9.2g; keep them separate.
 */
/** Exported for make-component: the extracted JSX can CALL `useResponsiveText`
 *  while the hook's file-local definition stays behind on the page — the new
 *  component then crashes with a ReferenceError on the live site (found in a
 *  componentized section with per-viewport text overrides, 2026-07-28). Running
 *  the built component file through this inserts the definition (and React
 *  imports) exactly like the page-side text writer does. */
export function ensureResponsiveTextHook(code: string): string {
  return ensureHookFunction(code);
}

function ensureHookFunction(code: string): string {
  const callRegex = new RegExp(`\\b${HOOK_NAME}\\s*\\(`);
  // Skip occurrences INSIDE the hook definition itself; those don't count
  // as "user-side" references. We strip the marked block before checking.
  const blockStripped = code.replace(
    new RegExp(`${HOOK_BEGIN_MARKER}[\\s\\S]*?${HOOK_END_MARKER}`),
    '',
  );
  // Also exclude the top-level `function useResponsiveText` declaration if
  // present without markers (defensive — markers should always be paired).
  const declRegex = new RegExp(`function\\s+${HOOK_NAME}\\s*\\(`);
  const blockNoDecl = blockStripped.replace(declRegex, '');
  const used = callRegex.test(blockNoDecl);

  // Detect existence via the marker OR the raw function declaration.
  // Babel's `generate` occasionally drops leading comments when the AST
  // node holding them is replaced/regenerated (the leading `//
  // @useResponsiveText-begin` line gets lost while the FunctionDeclaration
  // it sat on top of stays). Without the declRegex fallback,
  // ensureHookFunction concludes "no definition exists" and inserts a
  // NEW marked block — but the unmarked declaration is still in the
  // file, producing the `Identifier 'useResponsiveText' has already been
  // declared` validation error the user reported on text creation.
  const hasDef = code.includes(HOOK_BEGIN_MARKER) || declRegex.test(code);

  if (used && !hasDef) {
    return insertHookDefinition(code);
  }
  if (!used && hasDef) {
    return removeHookDefinition(code);
  }
  return code;
}

function insertHookDefinition(code: string): string {
  // Make sure useState + useEffect are imported from react. If a `react`
  // import already exists, ensure both names are in its specifier list.
  const next = ensureReactImports(code);

  // Anchor the function above `export default` so it's hoisted into scope
  // for the page component. Falls back to inserting after the last import.
  const exportIdx = next.search(/\nexport\s+default\b/);
  const hookBlock = `\n${HOOK_BEGIN_MARKER}\n${HOOK_DEFINITION}\n${HOOK_END_MARKER}\n`;
  if (exportIdx >= 0) {
    return next.slice(0, exportIdx) + hookBlock + next.slice(exportIdx);
  }
  // No export default? Append to end. Should never happen for Revyme
  // pages, but be safe.
  return next + hookBlock;
}

function removeHookDefinition(code: string): string {
  const re = new RegExp(`\\n?${HOOK_BEGIN_MARKER}[\\s\\S]*?${HOOK_END_MARKER}\\n?`);
  let next = code.replace(re, '');
  // SELF-HEAL: files written before 2026-07-03 could carry the useMediaQuery
  // hook INSIDE this fence (the old before-first-function anchor). Pruning the
  // fence then deleted useMediaQuery while `__mq` gates (responsive viewBox /
  // attrs / motion props) still call it → "undefined useMediaQuery" crash.
  // Re-inject when referenced-but-undefined.
  if (/\buseMediaQuery\s*\(/.test(next) && !/function\s+useMediaQuery\b/.test(next)) {
    next = ensureMediaQueryHook(next);
  }
  return next;
}

/**
 * Make sure `useState`, `useRef`, `useLayoutEffect`, AND a default `React`
 * import are present (the hook uses `React.createElement` to avoid forcing
 * a JSX-runtime import path the user may not have configured).
 */
function ensureReactImports(code: string): string {
  return ensureNamedImport(code, 'react', ['useState', 'useRef', 'useLayoutEffect'], { ensureDefault: 'React' });
}
