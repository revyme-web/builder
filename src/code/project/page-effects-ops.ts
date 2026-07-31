/**
 * page-effects-ops.ts — project-level read/write for Page Effects.
 *
 * Resolves the active page → its route + its route group's LayoutClient (where
 * the page-effects.ts data module lives), scaffolds the runtime on first write,
 * and reads/writes the PAGE_EFFECTS map via modifyProjectFile. Pure map logic
 * lives in page-effects-config.ts; runtime source in page-transitions-gen.ts.
 */

import { trace } from '@/shared/debug-trace';
import { projectFS } from './project-fs';
import { modifyProjectFile } from './modify-file';
import { getLayoutForPage, getLayoutClientPath, filePathToSlug } from './active-file-store';
import {
  parsePageEffects,
  serializePageEffects,
  upsertEffectInMap,
  removeEffectFromMap,
  listEffectsForPage,
  type PageEffect,
  type PageEffectsMap,
} from './page-effects-config';
import { ensurePageEffectsScaffold, pageEffectsDataPath, injectPageTransitionsInCode } from '../generation/page-transitions-gen';

/** slug ('home' | 'team' | 'blog/post') → route pathname ('/' | '/team' | '/blog/post'). */
function slugToRoute(slug: string): string {
  if (!slug || slug === 'home') return '/';
  return '/' + slug.replace(/^\//, '');
}

/** The page's route pathname (what the runtime matches against location.pathname). */
export function routeForPage(pageFile: string): string {
  return slugToRoute(filePathToSlug(pageFile));
}

/** The LayoutClient that persists across this page's navigations (where the
 *  data module + controller live). Null if the page has no layout. */
function layoutClientForPage(pageFile: string): string | null {
  const layout = getLayoutForPage(pageFile);
  if (!layout) return null;
  return getLayoutClientPath(layout);
}

/** Read the effects map for a page's route group (empty when none yet). */
function getPageEffectsMap(pageFile: string): PageEffectsMap {
  const lc = layoutClientForPage(pageFile);
  if (!lc) return { pages: {} };
  const code = projectFS.readFile(pageEffectsDataPath(lc));
  return code ? parsePageEffects(code) : { pages: {} };
}

/** The effects authored on this page (for the editor's Effects list). */
export function getEffectsForPage(pageFile: string): PageEffect[] {
  return listEffectsForPage(getPageEffectsMap(pageFile), routeForPage(pageFile));
}

/** Insert/replace an effect for the active page. Scaffolds the runtime + injects
 *  `<PageTransitions>` on first use. Returns false when the page has no layout. */
export function setPageEffectForPage(pageFile: string, effect: PageEffect): boolean {
  const lc = layoutClientForPage(pageFile);
  if (!lc) {
    trace.error('page-effects-ops:set', { pageFile, reason: 'no-layout' });
    return false;
  }
  ensurePageEffectsScaffold(lc);
  // Inject <PageTransitions> into the LayoutClient (existing file → modifyProjectFile).
  modifyProjectFile(lc, (code) => injectPageTransitionsInCode(code));
  const sourceRoute = routeForPage(pageFile);
  modifyProjectFile(pageEffectsDataPath(lc), (code) =>
    serializePageEffects(upsertEffectInMap(parsePageEffects(code), sourceRoute, effect)),
  );
  trace.action('page-effects-ops:set', { pageFile, sourceRoute, target: effect.target, preset: effect.preset });
  return true;
}

/** Remove an effect (by its target) for the active page. */
export function removePageEffectForPage(pageFile: string, target: string): void {
  const lc = layoutClientForPage(pageFile);
  if (!lc) return;
  const sourceRoute = routeForPage(pageFile);
  modifyProjectFile(pageEffectsDataPath(lc), (code) =>
    serializePageEffects(removeEffectFromMap(parsePageEffects(code), sourceRoute, target)),
  );
  trace.action('page-effects-ops:remove', { pageFile, sourceRoute, target });
}
