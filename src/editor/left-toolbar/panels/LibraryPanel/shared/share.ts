// Share helper for LibraryPanel — pushes a component bundle to the
// marketplace CDN and copies the URL/import line to the clipboard.
// Extracted as part of the LibraryPanel folder split.

import { toast } from 'sonner';
import { projectFS } from '@/code/project/project-fs';
import { shareComponent } from '@/cloud/components/component-share';

/**
 * Share a code component to the marketplace CDN and write either the
 * bare URL or a wrapped `import` statement to the clipboard.
 *
 * Reads source from projectFS, calls /api/components/share, gets back
 * the immutable `assets.revyme.app/components/<Name>@<hash>.js` URL,
 * then copies. Used by the LibraryPanel right-click menu's "Copy URL"
 * and "Copy Import (CDN)" items.
 *
 * Best-effort UX: shows a brief alert on failure. No toast system
 * integrated here yet.
 */
export async function shareAndCopy(
  componentName: string,
  filePath: string,
  mode: 'url' | 'import',
  kind: 'code' | 'design' | 'vector' = 'code',
): Promise<void> {
  // For code components we pass source. For design / vector
  // bundles we pass the path so the share helper can walk the
  // projectFS dep graph (transitive `@/components/X` + `@/icons/X`
  // imports). The backend bundles all files together
  // and returns a single root URL.
  let payload: string;
  if (kind === 'design' || kind === 'vector') {
    if (!projectFS.exists(filePath)) {
      toast.error(`File not found: ${filePath}`);
      return;
    }
    payload = filePath;
  } else {
    const source = projectFS.readFile(filePath);
    if (!source) {
      toast.error(`Could not read source for ${componentName}`);
      return;
    }
    payload = source;
  }
  // Sonner doesn't ship a long-lived progress toast in the basic API,
  // so use `toast.loading` which auto-dismisses when promise resolves
  // via the `id` we hold onto.
  const tId = toast.loading(`Sharing ${componentName}…`);
  const result = await shareComponent(componentName, payload, kind);
  if (!result.success || !result.url) {
    // Specific error path: missing transitive deps on a design share.
    // Surface them so the user can fix imports before retry.
    if (result.missingDeps && result.missingDeps.length > 0) {
      toast.error(
        `Cannot share — missing dependencies: ${result.missingDeps.join(', ')}`,
        { id: tId, duration: 6000 },
      );
      return;
    }
    toast.error(`Share failed: ${result.error ?? 'unknown error'}`, { id: tId });
    return;
  }
  const text = mode === 'import'
    ? `import ${componentName} from "${result.url}";`
    : result.url;
  try {
    await navigator.clipboard.writeText(text);
    toast.success(mode === 'import' ? 'Import statement copied' : 'URL copied', { id: tId });
  } catch {
    // Clipboard can fail in non-secure contexts (e.g. http://localhost in
    // some Safari builds). Surface the URL inline so the user can copy
    // it manually from the toast.
    toast(`${mode === 'import' ? 'Import' : 'URL'}: ${text}`, { id: tId, duration: 8000 });
  }
}
