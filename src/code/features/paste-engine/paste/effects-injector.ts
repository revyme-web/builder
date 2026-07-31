// effects-injector.ts — Re-inject captured function-scope effects into
// a destination page on paste.
//
// Input:
//   - `destCode`: the destination file's current source.
//   - `bundle`: the EffectsBundle captured at copy-time (see
//     `copy/effects-extractor.ts`).
//   - `idMap`: source-node-id → destination-node-id, produced by the
//     paste-engine's id-mapper. Used to remap both:
//       * data-id="<sourceId>" / '<sourceId>' literals — selector
//         strings in effect selectors / tool annotations
//         comments / `getElementById('<sourceId>')` etc.
//       * Variable-name prefixes — e.g. `frameMpo91uhh_8` →
//         <newId>'s prefix. Hooks/refs/state declared at function
//         scope use this prefix consistently.
//
// Cross-references — IDs that appear in slices but are NOT in `idMap` —
// stay verbatim. Per user spec, we don't copy the referenced targets,
// so the effect will run as a no-op on the destination when those
// targets don't exist.

import { parse } from '@babel/parser';
import { trace } from '@/shared/debug-trace';
import { applyAllRenames, buildIdRenamePairs } from '../core/id-renames';
import type { EffectsBundle } from '../types';

/**
 * Rewrite `bundle.sourceSlices` with the IDs in `idMap` remapped, then
 * inject the resulting block at the top of `destCode`'s default-
 * exported function body — right before the `return` statement that
 * renders JSX. Returns the new code; returns `destCode` unchanged when
 * no target function body can be found.
 */
export function injectEffectsBundle(
  destCode: string,
  bundle: EffectsBundle,
  idMap: Map<string, string>,
): string {
  trace.fn('paste-engine.injectEffectsBundle', {
    slices: bundle.sourceSlices.length,
    idMapSize: idMap.size,
  });

  if (bundle.sourceSlices.length === 0) return destCode;

  // 1. Build the rename pass. See `core/id-renames.ts` — same logic
  //    powers the `var:` style-value rename in `node-creator.ts`.
  const pairs = buildIdRenamePairs(idMap);
  const renamedSlices = bundle.sourceSlices.map(slice => applyAllRenames(slice, pairs));

  // 2. Concatenate. Slices are statements with their own trailing
  // newlines — separate with a blank line for readability.
  const block = renamedSlices.join('\n\n') + '\n\n';

  // 3. Find the insertion point — just before the JSX-returning
  // function's `return` statement.
  const insertOffset = findReturnStmtStart(destCode);
  if (insertOffset === -1) {
    trace.action('paste-engine.injectEffectsBundle:no-return-found');
    return destCode;
  }

  // Splice. Indent the block to match the surrounding function body —
  // walk back from the insert point to the previous newline and reuse
  // that indentation for the injected lines.
  const indent = inferIndent(destCode, insertOffset);
  const indentedBlock = indent
    ? block.replace(/^(?=.)/gm, indent).slice(indent.length) // leading line stays unindented (we splice after the indent)
    : block;

  return destCode.slice(0, insertOffset) + indentedBlock + destCode.slice(insertOffset);
}

// ─── Internals ──────────────────────────────────────────────────────────────

/**
 * Locate the start offset of the `return` statement in the default-
 * exported JSX-returning function body. The injector splices the
 * effects block immediately before this offset, so the new decls and
 * useEffect calls land at the bottom of the function body (after
 * everything already declared, before the return) — matching the
 * order the generator originally emits in.
 */
function findReturnStmtStart(code: string): number {
  let ast: any;
  try {
    ast = parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] });
  } catch {
    return -1;
  }

  const candidates: any[] = [];
  for (const stmt of ast.program.body) {
    if (stmt.type === 'ExportDefaultDeclaration') {
      const decl: any = stmt.declaration;
      if (decl?.type === 'FunctionDeclaration' && decl.body?.body) candidates.push(decl);
    }
    if (stmt.type === 'FunctionDeclaration' && stmt.body?.body) candidates.push(stmt);
    if (stmt.type === 'VariableDeclaration') {
      for (const d of stmt.declarations) {
        const init = d.init;
        if ((init?.type === 'ArrowFunctionExpression' || init?.type === 'FunctionExpression') && init.body?.body) {
          candidates.push(init);
        }
      }
    }
  }

  for (const fn of candidates) {
    for (const s of fn.body.body) {
      if (s.type !== 'ReturnStatement') continue;
      const a = s.argument;
      const isJsx = a?.type === 'JSXElement' || a?.type === 'JSXFragment'
        || (a?.type === 'ConditionalExpression' && (
          a.consequent?.type === 'JSXElement' || a.consequent?.type === 'JSXFragment'
          || a.alternate?.type === 'JSXElement' || a.alternate?.type === 'JSXFragment'
        ));
      if (isJsx) {
        // Include any leading comments — splice BEFORE them so the
        // effects block doesn't slot between the comments and the
        // return statement they presumably describe.
        const lc = (s.leadingComments as any[]) ?? [];
        return lc.length > 0 ? lc[0].start : s.start;
      }
    }
  }
  return -1;
}

/**
 * Walk backward from `offset` to the previous newline; return the
 * whitespace prefix on that line. Used to indent the injected block
 * so it matches the surrounding function body's indentation.
 */
function inferIndent(code: string, offset: number): string {
  let start = offset;
  while (start > 0 && code[start - 1] !== '\n') start--;
  let end = start;
  while (end < code.length && (code[end] === ' ' || code[end] === '\t')) end++;
  return code.slice(start, end);
}
