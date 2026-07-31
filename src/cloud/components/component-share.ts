// component-share.ts — API client for Code component sharing/publishing to CDN.
// Calls the builder's API routes (same origin via Next.js rewrite).
// Two modes: direct share (instant URL) and community submission (with review).

import { getProjectId } from '@/backend/project-id';
import { trace } from '@/shared/debug-trace';
import { walkBundle } from './bundle-walker';

export interface ComponentShareResult {
  success: boolean;
  /** CDN URL for the compiled Code component bundle (root URL when multi-file) */
  url?: string;
  /** Version hash for stable sharing — root file's hash for multi-file bundles */
  version?: string;
  /** R2 manifest URL for multi-file design bundles (used by Unlink) */
  manifestUrl?: string;
  /** When set, the share aborted because deps weren't found in projectFS */
  missingDeps?: string[];
  error?: string;
}

export interface ComponentSubmitResult {
  success: boolean;
  blockId?: string;
  error?: string;
}

/**
 * Share a component directly — uploads to R2, returns CDN URL.
 * No review needed. The URL is immediately usable by anyone.
 *
 * Both kinds upload to `components/<name>@<hash>.js` for automatic
 * content-hash dedup. The design vs code distinction is detected from
 * the source's shape on the consumer (`withResponsiveProps` +
 * `variantConfig` markers signal a design component).
 *
 * `kind: 'design'` automatically walks the dep graph (every transitive
 * `@/components/X` and `@/icons/X` import), bundles all files into one
 * upload, and produces a manifest sibling so Unlink can fetch every file
 * back. Each child gets its own R2 URL; the root bundle imports children
 * via baked-in URLs (standard recursive URL imports). If a referenced
 * dep is missing from projectFS, the share aborts and surfaces the list.
 *
 * `kind: 'code'` shares as a single file — code components are typically
 * self-contained and don't reference other project files.
 */
export async function shareComponent(
  componentName: string,
  sourceCodeOrPath: string,
  kind: 'code' | 'design' | 'vector' = 'code',
): Promise<ComponentShareResult> {
  trace.action('component-share:start', { componentName, kind });

  try {
    const projectId = getProjectId();
    let body: any;

    // 'design' AND 'vector' share the same multi-file
    // pipeline: walk the projectFS dep graph (`@/components/*` +
    // `@/icons/*`), upload all files together, write
    // a manifest sibling. The backend routes per-file uploads to
    // `components/` or `vectors/` based on each file's
    // source path — so a vector dep inside a design component still
    // lands in the vectors marketplace section, and vice-versa.
    // The kind also determines the ROOT URL's prefix on the response.
    if (kind === 'design' || kind === 'vector') {
      // Walk the projectFS dep graph from the root file's PATH. The
      // caller passes the root path here (not source) so we can resolve
      // relative imports correctly. shareAndCopy() handles the path.
      const rootPath = sourceCodeOrPath;
      const { files, missing } = walkBundle(rootPath);

      if (missing.length > 0) {
        // Hard-fail rather than producing a broken bundle. Surfacing the
        // missing list lets the UI prompt the user to fix the imports
        // before retrying. (Note: the walker only flags imports that
        // POINT at files not in projectFS — typo'd or stale imports.)
        trace.error('component-share:missing-deps', { missing });
        return { success: false, missingDeps: missing, error: `Missing dependencies: ${missing.join(', ')}` };
      }
      if (files.length === 0) {
        return { success: false, error: 'Root file not found in projectFS' };
      }

      body = {
        projectId,
        componentName,
        kind,
        files,
      };
    } else {
      // Code component: single-file. Caller passes source directly.
      body = {
        projectId,
        componentName,
        kind,
        sourceCode: sourceCodeOrPath,
      };
    }

    return await postShare(componentName, kind, body);
  } catch (err: any) {
    trace.error('component-share:error', err);
    return { success: false, error: err.message || 'Network error' };
  }
}

/**
 * Share a component whose FILES are already in hand — the cross-project
 * paste path. The clipboard captured the master bundle at copy time (the
 * source project's files are long gone from projectFS by paste time), so
 * this posts them directly instead of walking the dep graph.
 *
 * Content-hash dedup on the backend makes this idempotent: pasting the
 * same component twice (or into three projects) re-uses the same
 * `components/<Name>@<hash>.js` object.
 */
export async function shareComponentFiles(
  componentName: string,
  files: { path: string; content: string }[],
  kind: 'code' | 'design' | 'vector',
): Promise<ComponentShareResult> {
  trace.action('component-share:files-start', { componentName, kind, fileCount: files.length });
  if (files.length === 0) return { success: false, error: 'No files to share' };
  try {
    const projectId = getProjectId();
    const body = kind === 'code'
      ? { projectId, componentName, kind, sourceCode: files[0]!.content }
      : { projectId, componentName, kind, files };
    return await postShare(componentName, kind, body);
  } catch (err: any) {
    trace.error('component-share:error', err);
    return { success: false, error: err.message || 'Network error' };
  }
}

/** Shared POST + response handling for both share entries. */
async function postShare(
  componentName: string,
  kind: string,
  body: unknown,
): Promise<ComponentShareResult> {
  const res = await fetch('/api/components/share', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await res.json();

  if (!res.ok || !data.success) {
    trace.error('component-share:failed', { status: res.status, error: data.error, kind });
    return { success: false, error: data.error || 'Share failed' };
  }

  trace.action('component-share:success', { componentName, url: data.url, version: data.version, kind, manifestUrl: data.manifestUrl });
  return {
    success: true,
    url: data.url,
    version: data.version,
    manifestUrl: data.manifestUrl,
  };
}
