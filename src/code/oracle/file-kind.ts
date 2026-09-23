// oracle/file-kind.ts — which oracle rule set judges a project file, by PATH.
//
// The gate judges what a model SUBMITS (pages, templates, components). Anything
// that scans a whole project — the publish check, the capability suite — must
// make the same distinction and skip the builder's own plumbing: server page
// wrappers (`page.tsx`), route layouts (`layout.tsx`), providers, generated
// runtimes (`smooth-scroll-controller.tsx`, `page-transitions.tsx`, …). Those
// files are never edited on the canvas, carry no data-ids, and importing
// `./x` is how they are built — judged as pages they fail a dozen rules.

import { isCodeComponentSource, type FileKind } from './checks/shared';

/** The rule set for a file, or null for a file the oracle does not judge. */
export function oracleFileKind(path: string, code: string): FileKind | null {
  if (!/\.tsx$/.test(path)) return null;
  if (path.startsWith('components/')) return isCodeComponentSource(code) ? 'code-component' : 'component';
  if (/(^|\/)LayoutClient\.tsx$/.test(path)) return 'template';
  if (/(^|\/)page\.client\.tsx$/.test(path)) return 'page';
  return null;
}

/** Builder-materialized files that ship with their own documentation
 *  comments and never pass through the model: generator-stamped runtimes and
 *  the masters a feature installs (Load More / Form Submit / Spinner). */
export function isBuilderMaterializedFile(code: string): boolean {
  const head = code.slice(0, 600);
  return /@[a-z-]+-(gen|providers) v\d/.test(head) || /\/\*\* @name "(Load More|Form Submit|Spinner)" \*\//.test(head);
}
