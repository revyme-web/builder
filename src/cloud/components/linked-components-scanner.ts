// linked-components-scanner.ts — Walk projectFS for unique CDN component
// URLs imported anywhere in the project. Used by the Library panel's
// "Linked" section to surface CDN-linked components alongside the
// user's own local components.
//
// Returns a Set of URLs (deduped by exact URL string — different hashes
// of the same component count as separate entries, which is correct
// because they're literally different versions).

import type { ProjectFS } from '@/code/project/project-fs';
import { escapeRegExp } from '@/shared/regex-utils';
import { CDN_HOST } from '@/shared/hosts';

// Matches component bundles (`/components/...`) and vector bundles
// (`/vectors/...`). Both
// share the same R2 host + URL shape; only the path prefix differs.
// Library panel groups them by prefix into the Linked Components
// and Linked Vectors sections.
const CDN_URL_REGEX = new RegExp(`${escapeRegExp(CDN_HOST)}/(?:components|vectors)/[^"'\\s]+\\.(?:js|tsx)`, 'g');

export function scanLinkedComponentUrls(fs: ProjectFS): Set<string> {
  const urls = new Set<string>();
  for (const path of fs.listFiles()) {
    if (!path.endsWith('.tsx') && !path.endsWith('.ts') && !path.endsWith('.jsx')) continue;
    const code = fs.readFile(path);
    if (!code) continue;
    const matches = code.matchAll(CDN_URL_REGEX);
    for (const m of matches) urls.add(m[0]);
  }
  return urls;
}
