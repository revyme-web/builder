// project-id.ts — Extract the project ID from the current browser URL.
// Cloud: URL is /builder/[id] (served via Next.js rewrite proxy).
// Standalone: URL is / — falls back to 'local'.

/**
 * Returns the project ID from the URL path.
 * /builder/abc123 → 'abc123'
 * / or /builder  → 'local' (standalone mode)
 */
export function getProjectId(): string {
  if (typeof window === 'undefined') return 'local';
  const parts = window.location.pathname.split('/').filter(Boolean);
  // Expect path like ['builder', 'abc123']
  const builderIdx = parts.indexOf('builder');
  if (builderIdx !== -1 && parts[builderIdx + 1]) {
    return parts[builderIdx + 1];
  }
  return 'local';
}
