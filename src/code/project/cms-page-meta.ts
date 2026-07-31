// cms-page-meta.ts — Parse the `/** @cmsPage { collection, kind } *​/`
// annotation (leaf module: imports only trace). Extracted from
// cms-page-ops.ts so cms-ops can read the annotation without a
// cms-ops ↔ cms-page-ops import cycle; cms-page-ops re-exports it.

import { trace } from '@/shared/debug-trace';

const CMS_PAGE_REGEX = /\/\*\*\s*@cmsPage\s*(\{[\s\S]*?\})\s*\*\/\s*\n?/;

export interface CmsPageMeta {
  collection: string;
  kind: 'detail' | 'index';
}

/**
 * Parse `/** @cmsPage { collection, kind } *​/` from a page file. Returns
 * null when the annotation is absent — that's how the editor distinguishes
 * a regular page (no annotation) from a detail page (`kind: 'detail'`). An
 * `index` kind is reserved for future "is this an auto-generated index
 * page" detection but isn't required — index pages function as regular
 * pages with a single `.map()` at root.
 */
export function parseCmsPageMeta(code: string): CmsPageMeta | null {
  const match = code.match(CMS_PAGE_REGEX);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    if (typeof parsed.collection !== 'string') return null;
    if (parsed.kind !== 'detail' && parsed.kind !== 'index') return null;
    return { collection: parsed.collection, kind: parsed.kind };
  } catch {
    trace.error('cms-page-ops:parse-meta-failed', { raw: match[1].slice(0, 100) });
    return null;
  }
}
