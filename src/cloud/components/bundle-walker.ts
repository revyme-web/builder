// bundle-walker.ts — Walk a design component's transitive deps in projectFS.
//
// Given a root TSX file path, returns every projectFS file the bundle needs
// to be self-contained when shared as a multi-file design bundle:
//   - the root TSX itself
//   - every `@/components/X` import recursively (design + code components)
//   - every `@/icons/X` import recursively (icon sets)
//
// External imports (react, framer-motion, @revyme/runtime, motion/react,
// next-*, gsap, etc.) are NEVER walked — they're peer deps the consumer
// provides. Same dividing line as the backend's `processMultiFileBundle`
// import rewriter: anything under `@/components/` or `@/icons/`
// is bundle-internal; everything else is external.
//
// The output is intentionally NOT topologically sorted — the backend
// re-derives the dep edges and sorts there for compile order. We just
// hand it the flat set; sorting at both ends would risk drift.

import { projectFS } from '@/code/project/project-fs';
import { trace } from '@/shared/debug-trace';

interface BundleFile {
  /** Original projectFS path, e.g. `components/Hero.tsx`, `icons/Logo.tsx` */
  path: string;
  /** TSX source as-is in projectFS (pre-rewrite — backend rewrites at compile) */
  content: string;
}

export interface WalkResult {
  /** Every file in the transitive bundle, including the root. Flat list. */
  files: BundleFile[];
  /** Local imports that pointed at files which DO NOT exist in projectFS.
   *  Surfaced so the share can show an actionable error rather than
   *  silently producing a broken bundle. */
  missing: string[];
}

const LOCAL_IMPORT_REGEX = /from\s*["']@\/(?:components|icons)\/([\w-]+)["']/g;

/**
 * Walk the dep graph from `rootPath`. Caps at `maxFiles` (default 50) to
 * defend against pathological cycles even though the visited-set should
 * prevent infinite recursion — belt-and-braces.
 */
export function walkBundle(rootPath: string, maxFiles = 50): WalkResult {
  const files: BundleFile[] = [];
  const missing: string[] = [];
  const visited = new Set<string>();

  function visit(path: string): void {
    if (visited.has(path)) return;
    visited.add(path);

    if (files.length >= maxFiles) {
      trace.action('bundle-walker:cap-reached', { maxFiles, path });
      return;
    }

    const content = projectFS.readFile(path);
    if (content == null) {
      // The root caller is responsible for verifying the root exists;
      // missing children are reported but don't abort the walk so the
      // share UI can list ALL missing files at once.
      missing.push(path);
      return;
    }

    files.push({ path, content });

    // Find every `@/components/X` and `@/icons/X`
    // import in this file and recurse into each that exists in
    // projectFS.
    const importRegex = new RegExp(LOCAL_IMPORT_REGEX.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = importRegex.exec(content)) !== null) {
      const name = m[1];
      const fullMatch = m[0];
      // Disambiguate the two master directories. The substrings are
      // mutually exclusive — each import path uses exactly one of
      // these prefixes.
      const dir = fullMatch.includes('/icons/') ? 'icons'
        : 'components';
      const candidate = `${dir}/${name}.tsx`;
      if (projectFS.exists(candidate)) {
        visit(candidate);
      } else {
        missing.push(candidate);
      }
    }
  }

  visit(rootPath);

  trace.fn('walkBundle', {
    root: rootPath,
    fileCount: files.length,
    missingCount: missing.length,
  });

  return { files, missing };
}

/**
 * Quick check: does this file have ANY local-component imports? Used to
 * decide whether the share endpoint needs the multi-file path or can use
 * the simpler single-file `sourceCode` path.
 */
export function hasLocalDeps(content: string): boolean {
  return new RegExp(LOCAL_IMPORT_REGEX.source).test(content);
}
