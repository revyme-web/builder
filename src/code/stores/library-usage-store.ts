// library-usage-store.ts — usage counts for LIBRARY entries (design components,
// code components, and vector/icon sets), mirroring the preset usage scanner.
//
// A library entry is identified by its file path (`components/Header.tsx`,
// `icons/Shapes.tsx`). An INSTANCE of it is an uppercase JSX tag whose import
// resolves back to that file — e.g. `<Header data-id="…"/>` imported from
// `@/components/Header`. Instances live on pages AND nested inside other
// component masters, so we scan `app/**`, `components/**` and `icons/**` (minus
// layout files, which are merged into pages at parse time and would double-count).
//
// The result reuses the preset `PresetUsage` shape so the existing `UsageBadge` /
// `UsagePopup` (which already navigate to nodes inside master files) work verbatim.

import { atom } from 'jotai';
import { projectFS, projectVersionAtom } from '../project/project-fs';
import { parseJSXToNodes } from '../parsing/parser';
import { extractImports, resolveImportPath } from '../components/import-resolver';
import { trace } from '@/shared/debug-trace';
import { deriveFileLabel, type PresetUsage } from './preset-store';

/** A JSX tag is a component/vector instance iff it starts uppercase and has no
 *  member access (`motion.div` is a motion element, not a library instance). */
function isInstanceTag(tag: string | undefined): boolean {
  return !!tag && /^[A-Z]/.test(tag) && !tag.includes('.');
}

/** Friendly label for the file that CONTAINS an instance. Template/layout files
 *  (`app/(Body)/LayoutClient.tsx`) get a "<Group> Template" label so the popup
 *  reads nicely; everything else delegates to the shared preset labeller
 *  (`Home`, `/about`, `Hero`, …). */
function containerLabel(filePath: string): string {
  const m = filePath.match(/^app\/(?:\(([^)]+)\)\/)?(?:layout|LayoutClient)\.tsx$/);
  if (m) return `${m[1] ?? 'Root'} Template`;
  return deriveFileLabel(filePath);
}

/**
 * Pure, file-map-driven scanner: Map<libraryFilePath, PresetUsage[]>.
 *
 * For every scanned file we build its import map (localName → specifier) once,
 * then walk its parsed nodes; any uppercase-tag node whose import resolves to a
 * `components/**` or `icons/**` file is one instance of that library entry. The
 * usage records the CONTAINING file (page or master) + the instance's node id so
 * the popup can switch to that file, select the node, and zoom to it.
 *
 * Extracted from the atom so it's unit-testable without bootstrapping projectFS.
 */
export function scanComponentUsage(files: Map<string, string>): Map<string, PresetUsage[]> {
  const result = new Map<string, PresetUsage[]>();
  // Templates (layout / LayoutClient) are a PRIMARY home for component instances —
  // Header, footer CTA, nav, forms all live in the template, not the pages. Unlike
  // the PRESET scanner (which skips layouts), we MUST scan them. This does NOT
  // double-count: every instance lives in exactly one SOURCE file (a page's raw
  // source never contains the template's tags — they're separate files), so the
  // template's Header is counted once against `components/Header.tsx`.
  const targets = Array.from(files.keys()).filter((p) =>
    (p.startsWith('app/') && p.endsWith('.tsx')) ||
    (p.startsWith('components/') && p.endsWith('.tsx')) ||
    (p.startsWith('icons/') && p.endsWith('.tsx'))
  );

  for (const filePath of targets) {
    const code = files.get(filePath);
    if (!code) continue;

    const imports = extractImports(code);
    if (imports.size === 0) continue;

    let parsed: Map<string, { name?: string; type?: string }> | null = null;
    try {
      parsed = parseJSXToNodes(code) as unknown as Map<string, { name?: string; type?: string }>;
    } catch {
      continue; // unparseable file — skip (its instances just won't count)
    }
    if (!parsed) continue;

    const fileLabel = containerLabel(filePath);

    for (const [nodeId, n] of parsed) {
      const tag = n.type;
      if (!isInstanceTag(tag)) continue;
      const spec = imports.get(tag as string);
      if (!spec) continue; // a const-defined tag (e.g. MotionLink) or unknown — not a library entry
      // CDN-linked components import from a URL (`https://assets.revyme.app/
      // components/<Name>@<hash>.js`) — resolveImportPath treats that as an
      // external package (null), which left imported library rows with NO
      // usage badge. Key those usages by the URL itself: the Linked rows in
      // the Library are identified by the same URL string.
      const isCdnSpec = /^https:\/\/[^\s'"]+\/(?:components|vectors)\/[^@/]+@[a-f0-9]+\.js$/.test(spec);
      const target = resolveImportPath(spec, filePath) ?? (isCdnSpec ? spec : null);
      // Only library entries (project components + vector sets + CDN links).
      // Other external packages resolve to null; other project files
      // (page-transitions, etc.) are ignored.
      if (!target || (!target.startsWith('components/') && !target.startsWith('icons/') && !isCdnSpec)) continue;
      // A master never counts an instance of ITSELF (defensive against recursion).
      if (target === filePath) continue;

      let arr = result.get(target);
      if (!arr) { arr = []; result.set(target, arr); }
      arr.push({
        filePath,
        fileLabel,
        nodeId,
        nodeName: n.name || (tag as string),
      });
    }
  }

  return result;
}

/** Map<libraryFilePath, PresetUsage[]> for every design component, code component,
 *  and vector set. Re-derives on any `projectVersion` bump (edits/undo/redo/file
 *  swaps); jotai memoizes between bumps. Wraps {@link scanComponentUsage} with
 *  projectFS access + a diagnostic trace. */
export const componentUsageAtom = atom<Map<string, PresetUsage[]>>((get) => {
  get(projectVersionAtom);

  const files = new Map<string, string>();
  for (const path of projectFS.listFiles()) {
    const content = projectFS.readFile(path);
    if (content !== null) files.set(path, content);
  }

  const result = scanComponentUsage(files);

  trace.action('library-usage:scan', {
    files: files.size,
    entries: result.size,
    totalUsages: Array.from(result.values()).reduce((s, l) => s + l.length, 0),
  });

  return result;
});
