// cms-page-store.ts — Atoms for CMS detail-page editor mode.
//
// Two pieces of editor-only state:
//   - `cmsPageMetaAtom`     — derives the @cmsPage annotation from the
//     active file's code (collection + kind). Null on regular pages.
//   - `previewSlugAtom`     — per-file map of the slug currently being
//     previewed in the editor. Detail pages render ONE item at a time;
//     this controls which one. Defaults to the first item.

import { atom } from 'jotai';
// LIVE code, not the stable mirror: the mirror lags ~450ms BY CONTRACT
// (useStableAtomSync defers so undo visuals beat the parser cascade) — and
// riding it made the slug breadcrumb + detail-page bindings pop in half a
// second AFTER a page switch. The annotation-substring cache below keeps the
// live subscription cheap: per-keystroke code changes never touch the
// @cmsPage block, so the atom re-emits only when the block itself changes.
import { codeAtom } from './store';
import { activeFilePathAtom } from '@/code/project/active-file-store';
import { collectionDataAtom } from './cms-store';
import { parseCmsPageMeta, type CmsPageMeta } from '@/code/project/cms-page-ops';
import { trace } from '@/shared/debug-trace';

/**
 * Parsed @cmsPage annotation for the active file. Null when:
 *   - the file isn't a CMS detail/index page, OR
 *   - the annotation is malformed (the parser logs to trace.error)
 */
const CMS_PAGE_BLOCK_RE = /\/\*\*\s*@cmsPage\s*\{[\s\S]*?\}\s*\*\//;
let _metaSrc: string | null | undefined;
let _metaResult: CmsPageMeta | null = null;
export const cmsPageMetaAtom = atom<CmsPageMeta | null>((get) => {
  const code = get(codeAtom);
  if (!code) return null;
  // Same-reference cache keyed on the annotation block text — a live-code
  // subscription otherwise re-parses (and re-notifies subscribers with a
  // fresh object) on EVERY edit/drag frame even though the annotation is
  // untouched.
  const src = code.match(CMS_PAGE_BLOCK_RE)?.[0] ?? null;
  if (src === _metaSrc) return _metaResult;
  _metaSrc = src;
  _metaResult = src ? parseCmsPageMeta(code) : null;
  trace.fn('cms-page-store:meta', { kind: _metaResult?.kind ?? null, collection: _metaResult?.collection ?? null });
  return _metaResult;
});

/**
 * Per-file preview-slug mapping. We key by file path because each detail
 * page can be designed against a different "active" item independently.
 * Editing /articles/[slug] with `post-1` previewed shouldn't affect a
 * later visit to /authors/[slug] which might be previewing a different
 * person.
 */
export const previewSlugByFileAtom = atom<Map<string, string>>(new Map());

/**
 * Per-slug-page "where did I come from" map (slugPageFile → referrerFile).
 * Recorded when the user navigates INTO a `[slug]` detail page, so the slug
 * breadcrumb can lead with an [origin page] segment to go back to. In-memory
 * (resets on reload) — the breadcrumb falls back to the slug page's PARENT
 * route (`getSlugPageParentFile`) when there's no recorded referrer.
 */
export const slugPageReferrerByFileAtom = atom<Map<string, string>>(new Map());

/**
 * Convenience — the slug currently previewed for the ACTIVE file. Falls
 * back to the first item's slug in the relevant collection so a freshly-
 * opened detail page renders something instead of an empty template.
 */
export const activePreviewSlugAtom = atom<string | null>((get) => {
  const meta = get(cmsPageMetaAtom);
  if (meta?.kind !== 'detail') return null;
  const filePath = get(activeFilePathAtom);
  const explicit = get(previewSlugByFileAtom).get(filePath);
  if (explicit) return explicit;
  // Fallback to the first item in the collection — matches the runtime
  // `find(...) ?? collection[0]` fallback in the generated page so the
  // canvas matches what a user would see if they visited the bare URL.
  const items = get(collectionDataAtom).get(meta.collection) ?? [];
  return items[0]?._slug ?? null;
});

/**
 * The actual item record being previewed. Resolves to null when no detail
 * page is active or no items exist.
 */
export const activePreviewItemAtom = atom<Record<string, any> | null>((get) => {
  const meta = get(cmsPageMetaAtom);
  if (meta?.kind !== 'detail') return null;
  const slug = get(activePreviewSlugAtom);
  if (!slug) return null;
  const items = get(collectionDataAtom).get(meta.collection) ?? [];
  return items.find(i => i._slug === slug) ?? items[0] ?? null;
});
