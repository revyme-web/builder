// marketplace-client.ts — fetches plugin metadata from revyme-cloud.
//
// Talks to the public `/api/plugins/approved` endpoint on the Revyme
// backend. The endpoint requires no auth — anyone can browse the
// marketplace. Same-origin: Vite dev proxy + prod dispatcher both
// route `/api/*` to the Hono backend, so a relative URL works without
// any base-URL configuration here.

import { trace } from '@/shared/debug-trace';

/** Marketplace plugin metadata as it'll appear in the palette grid. */
export interface MarketplacePlugin {
  id: string;
  slug: string | null;
  name: string;
  description: string | null;
  /** URL to the self-contained HTML/JS bundle the iframe loads as its
   *  `src`. Always present once published — drafts share the same shape. */
  bundleUrl: string;
  /** Public source URL — only set when the author published with
   *  visibility = "open". Drives "Import locally" (single) or
   *  "Download source" (multi) in the LibraryPanel right-click menu. */
  sourceUrl: string | null;
  /** Single-file source can be Import-locally'd (auto-forked into
   *  `plugins/<Name>.tsx`); multi-file gets Download source only.
   *  `null` when closed-source. */
  sourceKind: 'single' | 'multi' | null;
  iconUrl: string | null;
  /** Single screenshot/preview for the card thumbnail. */
  thumbnailUrl: string | null;
  /** Optional small gallery shown on the plugin detail page. */
  galleryUrls: string[] | null;
  version: string;
  visibility: 'open' | 'closed';
  author: string | null;
}

/** Shape of the row the backend returns from `/api/plugins/approved`.
 *  Mirrors the `shape()` function in `backend/src/routes/plugins.ts`. */
interface ApiPluginRow {
  id: string;
  slug: string | null;
  name: string;
  description: string | null;
  bundle_url: string;
  source_url: string | null;
  source_kind?: 'single' | 'multi' | null;
  visibility: 'open' | 'closed';
  thumbnail_url: string | null;
  preview_url: string | null;
  gallery_urls: string[] | null;
  version: string;
  author: string | null;
  avatar: string | null;
}

function rowToPlugin(row: ApiPluginRow): MarketplacePlugin {
  // Older shares may predate the source_kind field — fall back to the
  // URL extension. .zip → multi, anything else → single.
  const sourceKind: 'single' | 'multi' | null = row.source_kind ?? (
    row.source_url
      ? (row.source_url.toLowerCase().endsWith('.zip') ? 'multi' : 'single')
      : null
  );
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    bundleUrl: row.bundle_url,
    sourceUrl: row.source_url,
    sourceKind,
    iconUrl: row.thumbnail_url, // no separate icon column yet — reuse thumbnail
    thumbnailUrl: row.thumbnail_url,
    galleryUrls: row.gallery_urls,
    version: row.version,
    visibility: row.visibility,
    author: row.author,
  };
}

/**
 * Fetch the approved marketplace plugin list, optionally filtered by
 * a search query (matches name + description + tags, case-insensitive
 * substring). Returns at most `limit` entries, default 30, max 100.
 *
 * Errors are swallowed and surfaced as an empty list — the palette
 * renders an empty state regardless. Errors trace through
 * `revyme:marketplace:fetch-failed`.
 */
export async function fetchMarketplacePlugins(
  search?: string,
  limit = 30,
): Promise<MarketplacePlugin[]> {
  try {
    const params = new URLSearchParams();
    if (search && search.trim().length >= 2) params.set('search', search.trim());
    params.set('limit', String(limit));
    const res = await fetch(`/api/plugins/approved?${params}`);
    if (!res.ok) {
      trace.error('marketplace:fetch-failed', { status: res.status });
      return [];
    }
    const data = (await res.json()) as { plugins?: ApiPluginRow[] };
    const plugins = (data.plugins ?? []).map(rowToPlugin);
    trace.action('marketplace:fetch', { count: plugins.length, search });
    return plugins;
  } catch (err) {
    trace.error('marketplace:fetch-failed', { error: String(err) });
    return [];
  }
}

/**
 * Parse a pasted plugin URL into an id + kind, or return null if the
 * string doesn't look like a Revyme plugin URL.
 *
 * Accepted shapes:
 *   - `…/api/plugins/share/<hash>`    — content-addressable R2 share link
 *   - `…/api/plugins/approved/<id>`   — approved marketplace plugin
 *
 * The `kind` field tells `fetchPluginByIdOrShare` which endpoint to hit
 * — share links are stored as R2 objects (no DB row), approved plugins
 * live in `creator_components`.
 */
export function parsePluginUrl(input: string): { id: string; kind: 'share' | 'approved' } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const shareMatch = trimmed.match(/\/api\/plugins\/share\/([0-9a-f]{8,})/i);
  if (shareMatch) return { id: shareMatch[1], kind: 'share' };
  const approvedMatch = trimmed.match(/\/api\/plugins\/approved\/([0-9a-f-]{8,})/i);
  if (approvedMatch) return { id: approvedMatch[1], kind: 'approved' };
  return null;
}

/**
 * Fetch a plugin (share-link or approved) by id. Used by the
 * paste-URL-to-install flow in the cmd+K palette.
 */
export async function fetchPluginByIdOrDraft(
  id: string,
  kind: 'share' | 'approved',
): Promise<MarketplacePlugin | null> {
  try {
    const path = kind === 'share' ? `/api/plugins/share/${id}` : `/api/plugins/approved/${id}`;
    const res = await fetch(path);
    if (!res.ok) return null;
    const row = (await res.json()) as ApiPluginRow;
    return rowToPlugin(row);
  } catch (err) {
    trace.error('marketplace:fetch-share-failed', { id, kind, error: String(err) });
    return null;
  }
}
