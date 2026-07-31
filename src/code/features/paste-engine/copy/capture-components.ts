// capture-components.ts — Component-master capture for cross-project paste.
//
// At COPY time (the only moment the SOURCE project's files are still in
// projectFS) this walks every component instance in the clipboard subtree
// and snapshots its master's full file set (root + transitive
// `@/components/*` / `@/icons/*` deps) into the clipboard payload.
//
// Paste then decides what to do with the snapshot:
//   - same project      → just ensure the local import (cross-PAGE paste)
//   - cross project (cloud) → share the files to the CDN, link the instance
//   - cross project (standalone) → materialize the files locally
//
// Detection is two-tier: the parser marks design-component instances with
// `componentFile`; CODE components (Marquee, CountUp, …) are plain tags, so
// they're resolved from the source file's own import lines instead.

import { projectFS } from '@/code/project/project-fs';
import { walkBundle } from '@/cloud/components/bundle-walker';
import { trace } from '@/shared/debug-trace';
import type { ClipboardComponentMaster, ClipboardNode } from '../types';

/** Default-import lines pointing at project component/icon files:
 *  `import Marquee from '@/components/Marquee';` → tag → projectFS path. */
const LOCAL_DEFAULT_IMPORT_RE = /import\s+([A-Za-z_$][\w$]*)\s+from\s+['"]@\/(components|icons)\/([\w./-]+?)(?:\.tsx)?['"]/g;

/** Tags that look like components but never map to a project master file. */
function isNonProjectTag(tag: string): boolean {
  return !/^[A-Z]/.test(tag) || tag.startsWith('motion') || tag === 'Link' || tag === 'MotionLink'
    || tag === 'AnimatePresence' || tag === 'LayoutGroup' || tag === 'MotionConfig' || tag === 'Fragment';
}

/** Build tag → masterPath from the source file's import lines. */
export function importMapFromSource(sourceCode: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of sourceCode.matchAll(LOCAL_DEFAULT_IMPORT_RE)) {
    const [, localName, dir, base] = m;
    map.set(localName, `${dir}/${base}.tsx`);
  }
  return map;
}

function detectKind(masterPath: string, rootContent: string): ClipboardComponentMaster['kind'] {
  if (masterPath.startsWith('icons/')) return 'vector';
  // The same marker pair the CDN consumer uses to spot a design bundle.
  if (rootContent.includes('variantConfig') && rootContent.includes('withResponsiveProps')) return 'design';
  return 'code';
}

/**
 * Capture the master bundle for every component instance in the clipboard
 * nodes. Never throws — a failed capture just means that component pastes
 * the old (broken-tag) way, which the caller's toast can surface.
 */
export function captureComponentMasters(
  clipboardNodes: ClipboardNode[],
  sourceCode: string,
): ClipboardComponentMaster[] {
  const importMap = importMapFromSource(sourceCode);

  // tag → masterPath, deduped (many instances of one master = one entry).
  const wanted = new Map<string, string>();
  for (const node of clipboardNodes) {
    if (isNonProjectTag(node.type)) continue;
    const path = node.componentFile ?? importMap.get(node.type);
    if (!path) continue;
    if (!projectFS.exists(path)) continue;
    if (!wanted.has(node.type)) wanted.set(node.type, path);
  }
  if (wanted.size === 0) return [];

  const masters: ClipboardComponentMaster[] = [];
  for (const [tagName, masterPath] of wanted) {
    try {
      const { files, missing } = walkBundle(masterPath);
      if (files.length === 0) continue;
      masters.push({
        tagName,
        masterPath,
        kind: detectKind(masterPath, files[0]!.content),
        files,
        ...(missing.length > 0 ? { missingDeps: missing } : {}),
      });
    } catch (err) {
      trace.error('clipboard:component-capture-failed', { tagName, masterPath, err: String(err) });
    }
  }
  trace.action('clipboard:components-captured', {
    count: masters.length,
    tags: masters.map((m) => m.tagName),
  });
  return masters;
}
