// use-before-declare.ts — find a `const`/`let` read before its declaration runs.
//
// Such code parses and passes the undefined-identifier check (the name IS
// declared — just later), and the canvas + preview transforms tolerate it, so
// it looks fine in the editor. Production SSR evaluates it in order and throws
// `ReferenceError: Cannot access 'x' before initialization` → every request
// 500s → Cloudflare 1101 on the live site. Live finds: hero appear hooks whose
// `useEffect` deps named `heroBgInView` above its `const` (2026-06-15), and an
// overlay `useState` re-declared BELOW its runtime effect (PearlRhine,
// 2026-10-06).
//
// Only uses that run SYNCHRONOUSLY with the declaring scope are flagged — a
// hook's dependency array, a JSX tag, a plain expression statement. A use
// inside a nested function (an effect body, an onClick handler) or a class body
// runs later, after the declaration, so it's legal and never reported. That
// keeps false positives at zero: everything reported throws when it executes.
//
// MIRRORED in backend/src/services/use-before-declare.ts (the publish guard) —
// keep the two in step.

import _traverse from '@babel/traverse';
import type { NodePath } from '@babel/traverse';

const traverse = (typeof _traverse === 'function' ? _traverse : (_traverse as any).default) as typeof _traverse;

export interface UseBeforeDeclare {
  name: string;
  /** 1-based line of the offending use. */
  useLine: number;
  /** 1-based line of the declaration it runs ahead of. */
  declLine: number;
}

/** TS nodes that wrap a runtime VALUE. Any other TS node is a type, which is
 *  erased before anything runs — `typeof x` in an annotation is not a read. */
const TS_VALUE_WRAPPERS = new Set([
  'TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion',
  'TSInstantiationExpression', 'TSParameterProperty', 'TSEnumDeclaration', 'TSEnumMember',
  'TSModuleDeclaration', 'TSModuleBlock', 'TSExportAssignment',
]);

/** First use-before-declare in a parsed file, or null. */
export function findUseBeforeDeclare(ast: any): UseBeforeDeclare | null {
  let hit: UseBeforeDeclare | null = null;
  traverse(ast, {
    ReferencedIdentifier(p: NodePath<any>) {
      if (hit) return;
      const node = p.node;
      if (node.start == null) return;
      const binding = p.scope.getBinding(node.name);
      if (!binding || (binding.kind !== 'const' && binding.kind !== 'let')) return;
      // Only variable declarations. A class or catch param also binds as
      // `let`, but its "declaration" spans its whole body.
      if (!binding.path.isVariableDeclarator()) return;
      const declEnd = binding.path.node.end;
      if (declEnd == null || node.start >= declEnd) return;
      // A function or class body between the use and the declaring scope means
      // the use runs later, not now.
      const scopePath = binding.scope.path;
      for (let a: NodePath<any> | null = p.parentPath; a && a !== scopePath; a = a.parentPath) {
        if (a.isFunction() || a.isClassBody()) return;
        if (a.node.type.startsWith('TS') && !TS_VALUE_WRAPPERS.has(a.node.type)) return;
      }
      hit = {
        name: node.name,
        useLine: node.loc?.start.line ?? 0,
        declLine: binding.identifier.loc?.start.line ?? 0,
      };
      p.stop();
    },
  });
  return hit;
}

/** The validator / oracle sentence for a hit. */
export function describeUseBeforeDeclare(h: UseBeforeDeclare): string {
  return `\`${h.name}\` is used at line ${h.useLine} before its declaration at line ${h.declLine} — the live site crashes with "Cannot access '${h.name}' before initialization" (the canvas tolerates it, production does not). Move the declaration above its first use.`;
}
