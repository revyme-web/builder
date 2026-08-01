// sources/pages.ts — Every page file in the project (`app/**/page.tsx`).
//
// Activating switches the active file through `pendingFileSwitchAtom`,
// which is the cross-component-safe entry point: Canvas.tsx watches it
// and runs the full switch flow (mutation-queue flush + selection clear)
// rather than swapping the path underneath a dirty queue.

import { listPageFiles, getFileDisplayName } from '@/code/project/active-file-store';
import type { SearchableItem } from '../search-types';
import type { SearchSource } from './types';

/** Human route for a page file — `app/blog/[slug]/page.tsx` → `/blog/[slug]`.
 *  Shown as the breadcrumb so two pages named "Page" are distinguishable. */
function pageRoute(file: string): string {
  const route = file
    .replace(/^app\//, '')
    .replace(/\/?page\.(client\.)?tsx$/, '')
    // Route groups — `(Body)` — are organisational, not part of the URL.
    .replace(/\([^)]*\)\/?/g, '');
  return `/${route}`.replace(/\/+$/, '') || '/';
}

export const pagesSource: SearchSource = () => {
  const items: SearchableItem[] = [];
  for (const file of listPageFiles()) {
    const name = getFileDisplayName(file);
    const route = pageRoute(file);
    items.push({
      id: `page:${file}`,
      name,
      category: 'pages',
      subcategory: file === 'app/page.tsx' ? 'Home' : 'Page',
      breadcrumb: [route],
      // The route is searchable too — typing "/blog" should find the
      // blog page even when its display name is something else.
      keywords: [name.toLowerCase(), route.toLowerCase(), 'page', 'route', 'url'],
      action: { type: 'switch-active-file', filePath: file },
    });
  }
  return items;
};
