// ImageSearchModal.tsx — Media search modal matching old builder design.
// Three tabs: Unsplash (search), Upload (drag-drop), Create (AI — placeholder).
// 6-column grid, aspect-square thumbnails, hover zoom + dark overlay.
// Search on Enter key, not on typing.
// Uses shared Modal shell for portal, backdrop, Escape key, and close button.

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { CLOUD_ENABLED } from '@/shared/cloud-flag';
import { trace } from '@/shared/debug-trace';
import Modal from '@/design-system/Modal';
import { backend } from '@/backend';
import { getProjectId } from '@/backend/project-id';

// Unsplash search. In CLOUD mode it goes through the backend proxy
// (`/api/media/unsplash`) so Revyme's key stays server-side and out of the
// browser bundle; in STANDALONE mode a self-hoster's own VITE key calls
// Unsplash directly. Without either, the Unsplash tab is hidden (Upload +
// Create remain fully functional).
const UNSPLASH_ACCESS_KEY = import.meta.env.VITE_UNSPLASH_ACCESS_KEY as string | undefined;
const HAS_UNSPLASH = CLOUD_ENABLED || !!UNSPLASH_ACCESS_KEY;

const SEARCH_TERMS = ['nature', 'architecture', 'abstract', 'texture', 'gradient', 'minimal', 'dark', 'city', 'ocean', 'mountains'];

// Unsplash pagination — infinite scroll, but CAPPED so scrolling can't drain the
// API quota. 30/page (Unsplash's max per_page) × 8 pages = up to 240 results.
const UNSPLASH_PER_PAGE = 30;
const UNSPLASH_MAX_PAGES = 8;

interface ImageSearchModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (url: string) => void;
}

interface UnsplashImage {
  id: string;
  urls: { small: string; regular: string; thumb: string };
  alt_description: string | null;
}

// Admin-only platform 3D assets (LEGO-style renders) — license-restricted, so
// the tab only appears for admins and the server gates /api/admin/3d-assets.
// Subset of the manifest's Asset3D shape (the fields we render/search).
interface Asset3D {
  id: string;
  url: string;          // full CDN URL to the WebP — used as <img src> and the pick value
  shape: string;        // display name
  material: string;
  color: string | null;
  packSlug: string;
  keywords: string[];
}

type Tab = 'unsplash' | 'upload' | 'create' | '3d';

export default function ImageSearchModal({ isOpen, onClose, onSelect }: ImageSearchModalProps) {
  const [tab, setTab] = useState<Tab>(HAS_UNSPLASH ? 'unsplash' : 'upload');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<UnsplashImage[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const loadingMoreRef = useRef(false); // sync guard against concurrent page fetches
  const pageRef = useRef(1);            // sync last-fetched page (avoids a stale-closure re-fetch)
  const unsplashGridRef = useRef<HTMLDivElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  // Already-uploaded project media — the SAME source the LeftPanel
  // MediaGalleryPanel reads (`/api/upload?...&type=image`), so the Upload tab
  // lists the website's existing images instead of only an empty drop zone.
  const [uploads, setUploads] = useState<{ url: string; size?: number }[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  // ── Admin-only 3D assets tab ──
  const [isAdmin, setIsAdmin] = useState(false);
  const [assets3d, setAssets3d] = useState<Asset3D[]>([]);
  const [assets3dLoaded, setAssets3dLoaded] = useState(false);
  const [query3d, setQuery3d] = useState('');

  // Search Unsplash. `pageNum`/`append` drive the capped infinite scroll: a fresh
  // search (append=false) replaces results + resets scroll; scrolling near the
  // bottom calls this with append=true to APPEND the next page (up to the cap).
  const searchUnsplash = useCallback(async (q: string, pageNum = 1, append = false) => {
    if (!q.trim()) return;
    if (append) {
      setLoadingMore(true);
    } else {
      setLoading(true);
      setHasMore(false);
      unsplashGridRef.current?.scrollTo({ top: 0 }); // reset scroll on a new search
    }
    trace.action('image-search:query', { query: q, page: pageNum, append });
    try {
      // Cloud → same-origin backend proxy (key server-side); standalone → direct
      // with the self-hoster's own key. Both return the raw Unsplash shape.
      const res = CLOUD_ENABLED
        ? await fetch(
            `/api/media/unsplash?query=${encodeURIComponent(q)}&per_page=${UNSPLASH_PER_PAGE}&page=${pageNum}`,
            { credentials: 'same-origin' }
          )
        : await fetch(
            `https://api.unsplash.com/search/photos?query=${encodeURIComponent(q)}&per_page=${UNSPLASH_PER_PAGE}&page=${pageNum}`,
            { headers: { Authorization: `Client-ID ${UNSPLASH_ACCESS_KEY}` } }
          );
      const data = await res.json();
      const imgs = (data.results || []) as UnsplashImage[];
      setResults((prev) => {
        if (!append) return imgs;
        // Dedup by id — Unsplash pages don't normally overlap, but guard React keys.
        const seen = new Set(prev.map((i) => i.id));
        return [...prev, ...imgs.filter((i) => !seen.has(i.id))];
      });
      pageRef.current = pageNum;
      const totalPages = typeof data.total_pages === 'number' ? data.total_pages : pageNum;
      // More available only if the page was full AND we're under BOTH the API's
      // page count and our own cap (protects the quota).
      setHasMore(imgs.length > 0 && pageNum < Math.min(totalPages, UNSPLASH_MAX_PAGES));
      trace.action('image-search:results', { count: imgs.length, page: pageNum });
    } catch (err) {
      trace.error('image-search:error', err);
      if (!append) setResults([]);
      setHasMore(false);
    } finally {
      if (append) setLoadingMore(false); else setLoading(false);
    }
  }, []);

  // Fetch the next page when the grid scrolls near its bottom (capped infinite
  // scroll). The ref guard fires synchronously so a fast scroll can't kick off
  // several overlapping page fetches.
  const loadMoreUnsplash = useCallback(() => {
    if (loadingMoreRef.current || loading || !hasMore || !query.trim()) return;
    loadingMoreRef.current = true;
    searchUnsplash(query, pageRef.current + 1, true).finally(() => { loadingMoreRef.current = false; });
  }, [loading, hasMore, query, searchUnsplash]);

  const onUnsplashScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 340) loadMoreUnsplash();
  }, [loadMoreUnsplash]);

  // Load random results on open
  useEffect(() => {
    if (isOpen) {
      const term = SEARCH_TERMS[Math.floor(Math.random() * SEARCH_TERMS.length)];
      setQuery(term);
      setResults([]);
      setUploadError(null);
      setTab(HAS_UNSPLASH ? 'unsplash' : 'upload');
      if (HAS_UNSPLASH) searchUnsplash(term);
    }
  }, [isOpen, searchUnsplash]);

  // Load the project's already-uploaded images for the Upload tab (mirrors
  // MediaGalleryPanel.fetchUploads — same endpoint + response shape, cloud-
  // gated). So the Upload tab shows the website's media, not just a drop zone.
  const fetchUploadedMedia = useCallback(async () => {
    if (!CLOUD_ENABLED) return;
    try {
      const res = await fetch(`/api/upload?websiteId=${getProjectId()}&type=image`);
      if (res.ok) {
        const data = await res.json();
        setUploads(data.uploads || []);
        trace.action('image-search:uploads-loaded', { count: data.uploads?.length ?? 0 });
      }
    } catch (err) {
      trace.error('image-search:uploads-fetch-failed', err);
    }
  }, []);

  useEffect(() => {
    if (isOpen && tab === 'upload') fetchUploadedMedia();
  }, [isOpen, tab, fetchUploadedMedia]);

  // Detect admin on open so the 3D-assets tab only shows for admins. The server
  // still gates /api/admin/3d-assets (403 for non-admins) — this is just UI.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    Promise.resolve(backend.getUser?.()).then(u => { if (!cancelled) setIsAdmin(!!u?.isAdmin); }).catch(() => {});
    return () => { cancelled = true; };
  }, [isOpen]);

  // Load the platform 3D-asset manifest (admin proxy, cookie-auth). Deduped to
  // one tile per distinct asset (the manifest has many angles per shape) to
  // keep the grid light; search narrows further.
  const fetch3dAssets = useCallback(async () => {
    if (assets3dLoaded) return;
    try {
      const res = await fetch('/api/admin/3d-assets', { credentials: 'include' });
      if (!res.ok) return; // 403 for non-admins — leave the list empty
      const data = await res.json();
      const seen = new Set<string>();
      const deduped: Asset3D[] = [];
      for (const a of (data.assets || []) as Asset3D[]) {
        const k = `${a.packSlug}/${a.shape}`;
        if (seen.has(k)) continue;
        seen.add(k);
        deduped.push(a);
      }
      setAssets3d(deduped);
      setAssets3dLoaded(true);
      trace.action('image-search:3d-loaded', { count: deduped.length });
    } catch (err) {
      trace.error('image-search:3d-fetch-failed', err);
    }
  }, [assets3dLoaded]);

  useEffect(() => {
    if (isOpen && tab === '3d' && isAdmin) fetch3dAssets();
  }, [isOpen, tab, isAdmin, fetch3dAssets]);

  const filtered3d = useMemo(() => {
    const q = query3d.trim().toLowerCase();
    if (!q) return assets3d;
    return assets3d.filter(a =>
      a.shape.toLowerCase().includes(q) ||
      a.material.toLowerCase().includes(q) ||
      (a.color || '').toLowerCase().includes(q) ||
      a.keywords.some(k => k.toLowerCase().includes(q)));
  }, [assets3d, query3d]);

  // Upload to the real backend (R2 in cloud mode, localStorage in
  // local-backend mode) via the shared `backend.uploadAsset` API —
  // exact same path the LeftPanel's MediaGalleryPanel uses. Without
  // this the modal was reading the picked file as a `data:` URL via
  // FileReader and dropping it straight into the style/attr, so the
  // bytes lived only inside the page source — nothing ever hit the
  // bucket and the file never appeared in the gallery. The returned
  // URL is the canonical CDN URL, which we forward via `onSelect`.
  const handleFileUpload = useCallback(async (file: File) => {
    setUploading(true);
    setUploadError(null);
    trace.action('image-search:upload-start', { name: file.name, size: file.size });
    try {
      const projectId = getProjectId();
      const url = await backend.uploadAsset(projectId, file);
      trace.action('image-search:upload-success', { url });
      onSelect(url);
      onClose();
    } catch (err) {
      trace.error('image-search:upload-failed', err);
      setUploadError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }, [onSelect, onClose]);

  const handleSelect = (url: string) => {
    trace.action('image-search:select', { url: url.slice(0, 80) });
    onSelect(url);
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      searchUnsplash(query);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Media" width={896}>
      <div className="p-4 space-y-3 min-h-[500px]">
        {/* Header: tabs + search */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1">
            {/* Tabs */}
            {([...((HAS_UNSPLASH ? ['unsplash', 'upload', 'create'] : ['upload', 'create']) as Tab[]), ...(isAdmin ? ['3d' as Tab] : [])]).map(t => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-4 py-2 cut-corners text-xs font-medium transition-colors ${
                  tab === t
                    ? 'bg-[var(--choice-bg)] text-[var(--text-primary)]'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                }`}
              >
                {t === 'unsplash' ? 'Unsplash' : t === 'upload' ? 'Upload' : t === '3d' ? '3D Assets' : 'Create'}
              </button>
            ))}
          </div>

          {/* Search input — only on Unsplash tab */}
          {tab === 'unsplash' && (
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              // Select the whole query on focus so a click lets you retype
              // immediately without clearing first.
              onFocus={(e) => e.currentTarget.select()}
              placeholder="Search images... (Enter to search)"
              className="w-64 h-[var(--control-height)] px-3 text-xs bg-[var(--grid-line)] border border-[var(--control-border)] [--cut-border-color:var(--control-border)] hover:border-[var(--control-border-hover)] focus:border-[var(--border-focus)] text-[var(--text-primary)] cut-corners cut-border hover:[--cut-border-color:var(--control-border-hover)] focus:[--cut-border-color:var(--border-focus)] focus:outline-none transition-colors"
            />
          )}

          {/* Search input — 3D assets (client-side filter, no Enter needed) */}
          {tab === '3d' && (
            <input
              type="text"
              value={query3d}
              onChange={(e) => setQuery3d(e.target.value)}
              onFocus={(e) => e.currentTarget.select()}
              placeholder="Search 3D assets..."
              className="w-64 h-[var(--control-height)] px-3 text-xs bg-[var(--grid-line)] border border-[var(--control-border)] [--cut-border-color:var(--control-border)] hover:border-[var(--control-border-hover)] focus:border-[var(--border-focus)] text-[var(--text-primary)] cut-corners cut-border hover:[--cut-border-color:var(--control-border-hover)] focus:[--cut-border-color:var(--border-focus)] focus:outline-none transition-colors"
            />
          )}
        </div>

        {/* ─── Unsplash Tab ─── */}
        {tab === 'unsplash' && (
          <div ref={unsplashGridRef} onScroll={onUnsplashScroll} className="grid grid-cols-6 gap-3 max-h-[500px] min-h-[400px] overflow-y-auto scrollbar-hide">
            {loading && Array.from({ length: 24 }).map((_, i) => (
              <div key={i} className="aspect-square cut-corners overflow-hidden animate-pulse bg-gradient-to-r from-[var(--grid-line)] via-[var(--bg-hover)] to-[var(--grid-line)]" />
            ))}
            {!loading && results.map(img => (
              <button
                key={img.id}
                onClick={() => handleSelect(img.urls.regular)}
                className="relative group cursor-pointer aspect-square cut-corners overflow-hidden"
              >
                <div
                  className="w-full h-full bg-cover bg-center transition-transform group-hover:scale-105"
                  style={{ backgroundImage: `url(${img.urls.small})` }}
                />
                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-all" />
              </button>
            ))}
            {/* Loading-more skeletons (append) — existing results stay visible. */}
            {loadingMore && Array.from({ length: 6 }).map((_, i) => (
              <div key={`more-${i}`} className="aspect-square cut-corners overflow-hidden animate-pulse bg-gradient-to-r from-[var(--grid-line)] via-[var(--bg-hover)] to-[var(--grid-line)]" />
            ))}
            {!loading && results.length === 0 && (
              <div className="col-span-6 text-center py-8 text-xs text-[var(--text-secondary)]">
                No images found. Try a different search term.
              </div>
            )}
            {!loading && !loadingMore && !hasMore && results.length > 0 && (
              <div className="col-span-6 text-center py-4 text-[10px] text-[var(--text-disabled)]">
                That's all for this search — refine the term for different results.
              </div>
            )}
          </div>
        )}

        {/* ─── Upload Tab ─── */}
        {tab === 'upload' && (
          <div className="space-y-3">
            <div className="grid grid-cols-6 gap-3 max-h-[500px] min-h-[400px] overflow-y-auto scrollbar-hide">
              {/* Upload drop zone — routes through `backend.uploadAsset`
                  so the file lands in the project's R2 bucket (cloud) or
                  local backend store and shows up in the LeftPanel media
                  gallery alongside every other upload. */}
              <label className={`aspect-square cut-corners cut-border bg-[var(--bg-surface)] border-2 border-dashed border-[var(--control-border)] [--cut-border-color:var(--control-border)] flex flex-col items-center justify-center gap-2 transition-colors ${uploading ? 'opacity-60 cursor-progress' : 'hover:bg-[var(--bg-hover)] cursor-pointer'}`}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--text-secondary)]">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
                </svg>
                <span className="text-xs text-[var(--text-secondary)]">{uploading ? 'Uploading…' : 'Upload'}</span>
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  disabled={uploading}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    handleFileUpload(file);
                    e.target.value = ''; // allow re-uploading the same file
                  }}
                />
              </label>
              {/* The website's already-uploaded images — same library as the
                  LeftPanel Media gallery. Click one to use it as the fill. */}
              {uploads.map((item, i) => (
                <button
                  key={item.url + i}
                  onClick={() => handleSelect(item.url)}
                  className="relative group cursor-pointer aspect-square cut-corners overflow-hidden"
                >
                  <div
                    className="w-full h-full bg-cover bg-center transition-transform group-hover:scale-105"
                    style={{ backgroundImage: `url(${item.url})` }}
                  />
                  <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-all" />
                </button>
              ))}
            </div>
            {uploadError && (
              <div className="px-2.5 py-1.5 cut-corners cut-border bg-red-500/10 border border-red-500/20 text-[11px] text-red-500 dark:text-red-400 leading-snug">
                {uploadError}
              </div>
            )}
          </div>
        )}

        {/* ─── Create Tab (AI placeholder) ─── */}
        {tab === 'create' && (
          <div className="grid grid-cols-6 gap-3 max-h-[500px] min-h-[400px] overflow-y-auto scrollbar-hide">
            {/* Generate button */}
            <button className="aspect-square cut-corners bg-gradient-to-br from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 flex flex-col items-center justify-center gap-2 cursor-pointer transition-colors">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
              </svg>
              <span className="text-xs text-white font-medium">Generate</span>
            </button>

            {/* Placeholder message */}
            <div className="col-span-5 flex items-center justify-center">
              <p className="text-xs text-[var(--text-secondary)]">
                AI image generation requires a backend API. Connect your Replicate or DALL-E API key to enable this feature.
              </p>
            </div>
          </div>
        )}

        {/* ─── 3D Assets Tab (admin only) ─── */}
        {tab === '3d' && (
          <div className="grid grid-cols-6 gap-3 max-h-[500px] min-h-[400px] overflow-y-auto scrollbar-hide">
            {!assets3dLoaded && Array.from({ length: 18 }).map((_, i) => (
              <div key={i} className="aspect-square cut-corners overflow-hidden animate-pulse bg-gradient-to-r from-[var(--grid-line)] via-[var(--bg-hover)] to-[var(--grid-line)]" />
            ))}
            {assets3dLoaded && filtered3d.map(a => (
              <button
                key={a.id}
                onClick={() => handleSelect(a.url)}
                title={`${a.shape} · ${a.material}${a.color ? ` · ${a.color}` : ''}`}
                // Light tile so dark + light renders are both visible (the WebPs
                // are trimmed/transparent), matching the revyme-cloud asset cards.
                className="relative group cursor-pointer aspect-square cut-corners overflow-hidden bg-[#ececec]"
              >
                <img src={a.url} loading="lazy" alt={a.shape} className="w-full h-full object-contain p-2 transition-transform group-hover:scale-105" />
                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-all" />
              </button>
            ))}
            {assets3dLoaded && filtered3d.length === 0 && (
              <div className="col-span-6 text-center py-8 text-xs text-[var(--text-secondary)]">
                No 3D assets found.
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
