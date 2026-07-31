// cross-project-paste.ts — standard component linking for pastes that
// cross a project boundary.
//
// The clipboard captured every instance's MASTER bundle at copy time
// (paste-engine/copy/capture-components.ts). When the paste lands in a
// DIFFERENT project, emitting the bare instance tags would reference
// components that don't exist there — the "huge mess" failure. Instead:
//
//   CLOUD      → share the captured files to the CDN (lazy — only now, so
//                copies that never leave a project upload nothing) and
//                import the instance from the immutable
//                `components/<Name>@<hash>.js` URL. The instance behaves
//                exactly like a pasted Copy-URL component: double-click
//                opens LinkedComponentModal with Unlink / Unlink & Replace.
//   STANDALONE → no CDN; materialize the captured files into the target
//                projectFS (skipping identical ones, aliasing the root on
//                content conflicts) and import locally. Effectively an
//                automatic "Unlink" at paste time.
//
// Same-project pastes never enter this module's async path — the paste
// engine stays synchronous for them (ensureLocalComponentImports covers the
// cross-PAGE case where the target file simply lacks the import line).

import { CLOUD_ENABLED } from '@/shared/cloud-flag';
import { projectFS } from '@/code/project/project-fs';
import { modifyProjectFile } from '@/code/project/modify-file';
import { getProjectId } from '@/backend/project-id';
import { shareComponentFiles } from './component-share';
import { ensureDefaultImport } from './component-paste';
import { trace } from '@/shared/debug-trace';
import type { ClipboardComponentMaster, ClipboardData, ClipboardNode } from '@/code/features/paste-engine/types';

// ─── Detection ────────────────────────────────────────────────────────────────

/**
 * True when the clipboard came from another project AND carries component
 * masters to link. Two standalone projects both report `'local'` — for them
 * the missing-master check in `ensureLocalComponentImports` does the work
 * instead (it materializes bundles whose master file isn't present).
 */
export function isCrossProjectPaste(data: ClipboardData): boolean {
  if (!data.components?.length) return false;
  if (!data.sourceProjectId) return false;
  try {
    const current = getProjectId();
    return data.sourceProjectId !== current;
  } catch {
    return false;
  }
}

// ─── Expanded-internal strip ──────────────────────────────────────────────────

/**
 * Drop nodes that are a design-component instance's EXPANDED internals.
 * Their ids are `instanceId:masterNodeId` (the write-redirect format) —
 * they're virtual master content, not page content. They land in the
 * clipboard when a select-all sweeps them up as individual roots; pasting
 * them reconstructs the master's internals INSIDE the instance tag (double
 * render) or as orphan junk. The instance tag itself carries everything.
 */
export function stripExpandedInternals(nodes: ClipboardNode[]): ClipboardNode[] {
  const kept = nodes.filter((n) => !n.id.includes(':'));
  if (kept.length === nodes.length) return nodes;
  const keptIds = new Set(kept.map((n) => n.id));
  trace.action('cross-project-paste:stripped-internals', { dropped: nodes.length - kept.length });
  // Scrub dangling child references so the paste tree stays consistent.
  return kept.map((n) =>
    n.children.some((c) => !keptIds.has(c))
      ? { ...n, children: n.children.filter((c) => keptIds.has(c)) }
      : n,
  );
}

// ─── Local materialization (standalone / share-failure fallback) ─────────────

/** `components/NuSuBi.tsx` → `@/components/NuSuBi` */
export function localImportPathFor(masterPath: string): string {
  return `@/${masterPath.replace(/\.tsx?$/, '')}`;
}

/**
 * Write a captured master bundle into the target projectFS. Returns the
 * import specifier + desired tag to use (root may be aliased on conflict).
 *
 *   - file missing            → write it
 *   - file present, identical → keep (shared dep across pastes)
 *   - ROOT present, different → write aliased copy `<Name>Linked.tsx`
 *   - DEP present, different  → keep the target's version (v1 tradeoff:
 *     shared dep names are rare and a silent overwrite would be worse)
 */
function materializeBundle(master: ClipboardComponentMaster): { specifier: string; desiredName: string } {
  const [root, ...deps] = master.files;
  let rootPath = master.masterPath;
  let desiredName = master.tagName;

  const existingRoot = projectFS.exists(rootPath) ? projectFS.readFile(rootPath) : null;
  if (existingRoot != null && existingRoot !== root!.content) {
    const base = rootPath.replace(/\.tsx?$/, '');
    rootPath = `${base}Linked.tsx`;
    for (let i = 2; projectFS.exists(rootPath) && projectFS.readFile(rootPath) !== root!.content; i++) {
      rootPath = `${base}Linked${i}.tsx`;
    }
    desiredName = `${master.tagName}Linked`;
  }
  if (!projectFS.exists(rootPath)) projectFS.writeFile(rootPath, root!.content);

  for (const dep of deps) {
    if (!projectFS.exists(dep.path)) projectFS.writeFile(dep.path, dep.content);
  }
  trace.action('cross-project-paste:materialized', { tag: master.tagName, rootPath, deps: deps.length });
  return { specifier: localImportPathFor(rootPath), desiredName };
}

// ─── The link pass ────────────────────────────────────────────────────────────

export interface LinkComponentsResult {
  /** Original tag → local name to emit (only entries that CHANGED). */
  tagRenames: Map<string, string>;
  linked: number;
  materialized: number;
  failed: string[];
}

/**
 * Link (cloud) or materialize (fallback) every clipboard master into the
 * target file, returning the tag renames the paste must apply. Failures
 * degrade per-component: an unmapped tag pastes as-is (today's behavior)
 * and lands in `failed` for the caller's toast.
 */
export async function linkClipboardComponents(
  data: ClipboardData,
  targetFilePath: string,
): Promise<LinkComponentsResult> {
  const result: LinkComponentsResult = { tagRenames: new Map(), linked: 0, materialized: 0, failed: [] };
  if (!data.components?.length) return result;

  for (const master of data.components) {
    try {
      let specifier: string | null = null;
      let desiredName = master.tagName;

      if (CLOUD_ENABLED) {
        const share = await shareComponentFiles(master.tagName, master.files, master.kind);
        if (share.success && share.url) {
          specifier = share.url;
          result.linked++;
        } else {
          trace.error('cross-project-paste:share-failed', { tag: master.tagName, error: share.error });
        }
      }
      if (specifier) {
        // CDN link — inject the URL import explicitly. `syncImports` keeps
        // custom-specifier imports unconditionally, so injecting BEFORE the
        // nodes land is safe (unlike `@/components/*` imports, which its
        // unused-prune would strip until the tags exist).
        let localName = desiredName;
        modifyProjectFile(targetFilePath, (code) => {
          const r = ensureDefaultImport(code, desiredName, specifier!);
          localName = r.localName;
          return r.code;
        });
        if (localName !== master.tagName) result.tagRenames.set(master.tagName, localName);
      } else {
        // Standalone, or the share failed — materialize locally instead.
        // NO import injection here: the mutation queue's `syncImports`
        // auto-adds `import <Tag> from '@/components/<Tag>'` for any used
        // tag whose file exists, on the very flush that writes the pasted
        // nodes. (Injecting now would be pruned as unused — the tags
        // don't exist in the file yet.)
        const local = materializeBundle(master);
        if (local.desiredName !== master.tagName) result.tagRenames.set(master.tagName, local.desiredName);
        result.materialized++;
      }
    } catch (err) {
      trace.error('cross-project-paste:link-failed', { tag: master.tagName, err: String(err) });
      result.failed.push(master.tagName);
    }
  }

  trace.action('cross-project-paste:linked', {
    linked: result.linked,
    materialized: result.materialized,
    failed: result.failed,
    renames: Array.from(result.tagRenames.entries()),
  });
  return result;
}

/** Apply tag renames to the clipboard nodes (returns a new array). */
export function applyTagRenames(nodes: ClipboardNode[], renames: Map<string, string>): ClipboardNode[] {
  if (renames.size === 0) return nodes;
  return nodes.map((n) => (renames.has(n.type) ? { ...n, type: renames.get(n.type)! } : n));
}

// ─── Same-project cross-PAGE imports ─────────────────────────────────────────

/**
 * Same-project paste into a DIFFERENT page: the tags are valid in the
 * project, and the import lines are `syncImports`' job — it auto-injects
 * `@/components/<Tag>` for any used tag whose file exists, on the flush
 * that writes the pasted nodes. The ONE case needing work here is two
 * STANDALONE projects (both ids read `'local'`): a master that doesn't
 * exist in this project at all must be materialized from the clipboard
 * bundle so the auto-inject probe has a file to find.
 */
export function ensureLocalComponentImports(data: ClipboardData, _targetFilePath: string): Map<string, string> {
  const renames = new Map<string, string>();
  if (!data.components?.length) return renames;
  for (const master of data.components) {
    try {
      if (projectFS.exists(master.masterPath)) continue; // syncImports handles it
      const local = materializeBundle(master);
      if (local.desiredName !== master.tagName) renames.set(master.tagName, local.desiredName);
    } catch (err) {
      trace.error('cross-project-paste:local-import-failed', { tag: master.tagName, err: String(err) });
    }
  }
  return renames;
}
