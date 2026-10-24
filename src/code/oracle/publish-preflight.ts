// publish-preflight.ts — the read-only tier-3 sweep that runs BEFORE a publish
// request leaves the editor.
//
// The publish pipeline (backend build-project.ts) runs no oracle: it strips
// `@canvas` / `data-form` and ships the user's `.tsx` verbatim. A file that
// parses but crashes React at runtime — a string `style="…"` attribute
// (NoShit outage; site 82e2fff1), an identifier nothing declares — therefore
// reached production as a white page. The gate only ever saw AI/MCP submits;
// builder producers that have since been fixed (paste of hook-text nodes,
// primary edit on a marked text, the shape-edit style mirror) had already
// written such files, and a grandfathered project publishes the crash the
// first time its owner clicks Publish without re-opening the culprit.
//
// This sweep asks the SAME oracle the AI gate uses, keeps only the codes that
// mean "the live site will not render", and reports file + line so the user
// can open the code view and fix it (or ask the AI to). Tier-2 dialect
// findings are deliberately ignored here — they never block a human.

import { projectFS } from '@/code/project/project-fs';
import { isLayoutFile, listPageFiles } from '@/code/project/active-file-store';
import { checkFile, type FileKind } from './check-file';
import { isCodeComponentSource } from './checks/shared';
import { trace } from '@/shared/debug-trace';

/** Violations that mean the published site crashes or does not build. */
export const PUBLISH_FATAL_CODES = new Set(['SYNTAX_ERROR', 'STRING_STYLE_ATTR', 'WOULD_CRASH',
  // `<Override>` around zero/several elements throws in React.Children.only;
  // an un-imported override is a ReferenceError at render.
  'OVERRIDE_CHILD_COUNT', 'OVERRIDE_NOT_IMPORTED',
  // An un-imported (or shadowed) RevymeTicker is a ReferenceError / duplicate
  // binding. (TICKER_CHILD_COUNT is NOT fatal: the runtime then renders its
  // children still — nothing crashes — so it bounces AI writes only.)
  'TICKER_NOT_IMPORTED']);

export interface PreflightIssue {
  path: string;
  code: string;
  line?: number;
  message: string;
}

/** Every file the oracle gates: pages, LayoutClient templates, components. */
export function publishGatedFiles(): Array<{ path: string; kind: FileKind }> {
  const seen = new Set<string>();
  const out: Array<{ path: string; kind: FileKind }> = [];
  const push = (path: string, kind: FileKind) => { if (!seen.has(path)) { seen.add(path); out.push({ path, kind }); } };
  for (const p of listPageFiles()) push(p, isLayoutFile(p) ? 'template' : 'page');
  for (const p of projectFS.listFiles()) {
    if (!p.endsWith('.tsx')) continue;
    if (isLayoutFile(p)) push(p, 'template');
    else if (p.startsWith('components/')) {
      const code = projectFS.readFile(p) ?? '';
      push(p, isCodeComponentSource(code) ? 'code-component' : 'component');
    }
  }
  return out;
}

/** Run the fatal-only sweep over the whole project. Empty = safe to publish. */
export function runPublishPreflight(): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  const files = publishGatedFiles();
  for (const { path, kind } of files) {
    const code = projectFS.readFile(path);
    if (code == null) continue;
    let violations;
    try {
      violations = checkFile(code, { kind, path });
    } catch (err) {
      // The oracle itself failing is not the user's file failing — never block on it.
      trace.error('publish-preflight:check-threw', { path, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    for (const v of violations) {
      if (!PUBLISH_FATAL_CODES.has(v.code)) continue;
      issues.push({ path, code: v.code, line: v.line, message: v.message });
    }
  }
  trace.action('publish-preflight:done', { files: files.length, issues: issues.map((i) => `${i.path}:${i.line ?? '?'} ${i.code}`) });
  return issues;
}

/** One line per issue, the shape the publish error banner renders. */
export function formatPreflightIssues(issues: PreflightIssue[]): string {
  const head = issues.length === 1
    ? 'Publish blocked — this file would crash the live site:'
    : `Publish blocked — ${issues.length} problems would crash the live site:`;
  const lines = issues.slice(0, 8).map((i) => `${i.path}${i.line != null ? `:${i.line}` : ''} — ${i.message}`);
  if (issues.length > 8) lines.push(`… and ${issues.length - 8} more`);
  return [head, ...lines].join('\n');
}
