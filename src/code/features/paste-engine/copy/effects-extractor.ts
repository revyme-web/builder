// effects-extractor.ts — Capture function-scope code that "owns" a set
// of copied node IDs so paste can re-inject it into a destination page.
//
// What counts as "owned":
//   1. A `VariableDeclaration` whose source slice mentions a copied
//      node — by var-prefix (`frameMpo91uhh_8…`) or by string literal
//      `data-id="<copiedNodeId>"` / `'<copiedNodeId>'`.
//   2. A `useEffect(() => {...}, [])` whose body mentions a copied node
//      (same two channels).
//   3. A bare effect call expression referencing
//      a copied node by `[data-id="<copiedNodeId>"]` selector.
//   4. Leading comments on any of the above
//      annotations tool generators emit — travel with the
//      statement they annotate.
//
// Cross-references to OTHER node IDs (ones the user didn't copy) stay
// VERBATIM. Per user spec: "we don't copy the other nodes — it would
// just not target anything." The injected effect runs as a no-op on
// the destination if `getElementById` / effect selectors miss; that's
// the contract.
//
// IMPORTANT: callers must pass the FULL recursive subtree node-id set
// (including grandchildren and multi-select roots), not just the
// user-selected roots. An effect attached to a grandchild needs to
// travel even when the user only clicked the parent.

import { parse } from '@babel/parser';
import { nodeIdToVarName } from '@/shared/id-utils';
import { escapeRegExp } from '@/shared/regex-utils';
import { trace } from '@/shared/debug-trace';
import type { EffectsBundle } from '../types';

export type { EffectsBundle };

/**
 * Parse `sourceCode` and return all function-scope statements that
 * "own" any of `ownedNodeIds`. Returns `null` when there's no JSX-
 * returning function to scan or when the file fails to parse — the
 * caller should treat null the same as "no effects to carry".
 */
export function extractEffectsForNodes(
  sourceCode: string,
  ownedNodeIds: string[],
): EffectsBundle | null {
  trace.fn('paste-engine.extractEffectsForNodes', {
    ownedCount: ownedNodeIds.length,
  });

  if (ownedNodeIds.length === 0) return null;

  let ast: any;
  try {
    ast = parse(sourceCode, {
      sourceType: 'module',
      plugins: ['jsx', 'typescript'],
    });
  } catch {
    trace.action('paste-engine.extractEffectsForNodes:parseError');
    return null;
  }

  // Find the function whose body returns JSX. Pages export it as
  // `export default function Page()`, component files use
  // `function Foo() { ... } export default withResponsiveProps(Foo)`.
  // Either way the function with a JSX return is the one we want.
  const fnBody = findJSXReturningFunctionBody(ast);
  if (!fnBody) {
    trace.action('paste-engine.extractEffectsForNodes:no-function-body');
    return null;
  }

  // Build the set of patterns to match against each statement's source
  // slice. Two channels per owned node:
  //  - var-prefix (variable names embed it: `<prefix>Sec0Ref`, `<prefix>Opacity`, …)
  //  - the raw node ID itself (selector strings, `getElementById('<id>')`)
  const prefixes = ownedNodeIds.map(id => nodeIdToVarName(id));
  const idLiterals = ownedNodeIds.slice(); // Match data-id="<id>" or '<id>'

  const ownsSlice = (slice: string): boolean => {
    for (const prefix of prefixes) {
      // Prefix can stand alone (`heroProgress`) or be followed by
      // an uppercase letter / `_` / end-of-word — guard against
      // accidental substring hits on unrelated names.
      const re = new RegExp(`\\b${escapeRegExp(prefix)}(?=[A-Z_]|\\b)`);
      if (re.test(slice)) return true;
    }
    for (const id of idLiterals) {
      // BOUNDED match — node ids are `[\w-]+`, so require a non-id char on each
      // side (quote / bracket / paren around a selector or getElementById). A bare
      // `slice.includes(id)` substring-matched a SHORT id inside a longer word —
      // e.g. a trigger id `"trig"` hit the word `trigger`/`triggerId` inside an
      // overlay positioner effect, falsely "owning" it → an orphaned
      // useLayoutEffect referencing a non-existent `useState` got injected on paste.
      const re = new RegExp(`(^|[^\\w-])${escapeRegExp(id)}([^\\w-]|$)`);
      if (re.test(slice)) return true;
    }
    return false;
  };

  // Walk top-level statements, collect slices that own any of the IDs.
  // We dedupe by (start..end) range so the same statement doesn't get
  // captured twice when multiple owned IDs hit the same effect.
  //
  // STATEMENT FILTER — only consider statement shapes that represent
  // function-scope SIDE EFFECTS or DECLARATIONS:
  //   - `const X = ...` (refs, useScroll output, useTransform, useSpring,
  //     useState destructured arrays, plain consts holding effect state)
  //   - bare expression statements (`useEffect(...)`,
  //     other effect call expressions)
  //
  // We DO NOT consider `ReturnStatement` even when its JSX mentions a
  // copied node id — paste-engine already handles the JSX surface; the
  // function-scope extractor must not duplicate it. Same reasoning for
  // import declarations, top-level type aliases, etc.
  const slices: { start: number; end: number; slice: string }[] = [];
  const seenRanges = new Set<string>();

  for (const stmt of fnBody) {
    if (stmt.type !== 'VariableDeclaration' && stmt.type !== 'ExpressionStatement') {
      continue;
    }

    // Include leading comments — tool annotations live there.
    const leadingComments = (stmt.leadingComments as any[]) ?? [];
    const startOfStmtWithComments = leadingComments.length > 0
      ? leadingComments[0].start
      : stmt.start;
    const sliceWithComments = sourceCode.slice(startOfStmtWithComments, stmt.end);

    // NEVER carry OVERLAY runtime machinery as an "effect". The overlay's
    // positioner (`useLayoutEffect`/`useEffect` reading `getAttribute('data-overlay')`)
    // + its `useState` are rebuilt by reattach (runtime paste) or rehydrate
    // (canvas→viewport drag), and a copied overlay's children might falsely "own"
    // it. Injecting it would emit a `useLayoutEffect` referencing a `useState` that
    // doesn't exist (canvas overlays are static) → "undefined identifier" crash.
    if (sliceWithComments.includes("getAttribute('data-overlay')")) continue;

    if (!ownsSlice(sliceWithComments)) continue;

    const key = `${startOfStmtWithComments}-${stmt.end}`;
    if (seenRanges.has(key)) continue;
    seenRanges.add(key);

    slices.push({
      start: startOfStmtWithComments,
      end: stmt.end,
      slice: sliceWithComments,
    });
  }

  if (slices.length === 0) return null;

  // Preserve original-file order so the injected block respects the
  // declaration sequence required by JS (refs declared before the
  // useEffect that touches them, motion values declared before the
  // JSX that consumes them).
  slices.sort((a, b) => a.start - b.start);

  trace.action('paste-engine.extractEffectsForNodes:captured', {
    sliceCount: slices.length,
    ownedCount: ownedNodeIds.length,
  });

  return {
    sourceSlices: slices.map(s => s.slice),
    ownedNodeIds: ownedNodeIds.slice(),
  };
}

// ─── Internals ──────────────────────────────────────────────────────────────

/**
 * Locate the function body that returns JSX. Pages and component files
 * both have one. Returns the statement array, or null when no match.
 */
function findJSXReturningFunctionBody(ast: any): any[] | null {
  // Try each candidate function and return the first one whose body
  // contains a `return <JSXElement/>`-style statement.
  const candidates: any[] = [];
  for (const stmt of ast.program.body) {
    if (stmt.type === 'ExportDefaultDeclaration') {
      const decl: any = stmt.declaration;
      if (decl?.type === 'FunctionDeclaration' && decl.body?.body) candidates.push(decl);
      // Skip CallExpression (withResponsiveProps(Foo)) — the named
      // `function Foo` lives elsewhere at top level and gets picked up
      // by the next branch.
    }
    if (stmt.type === 'FunctionDeclaration' && stmt.body?.body) candidates.push(stmt);
    if (stmt.type === 'VariableDeclaration') {
      for (const d of stmt.declarations) {
        const init = d.init;
        if (init?.type === 'ArrowFunctionExpression' || init?.type === 'FunctionExpression') {
          if (init.body?.body) candidates.push(init);
        }
      }
    }
  }

  for (const fn of candidates) {
    if (hasJSXReturn(fn.body.body)) return fn.body.body;
  }
  return null;
}

function hasJSXReturn(stmts: any[]): boolean {
  for (const s of stmts) {
    if (s.type === 'ReturnStatement') {
      const a = s.argument;
      if (a?.type === 'JSXElement' || a?.type === 'JSXFragment') return true;
      // Allow `return ( <jsx/> )` (ParenthesizedExpression isn't a
      // real Babel type — the inner is already the JSX), and
      // `return condition ? <jsx/> : ...` patterns.
      if (a?.type === 'ConditionalExpression') {
        if (a.consequent?.type === 'JSXElement' || a.consequent?.type === 'JSXFragment') return true;
        if (a.alternate?.type === 'JSXElement' || a.alternate?.type === 'JSXFragment') return true;
      }
    }
  }
  return false;
}
