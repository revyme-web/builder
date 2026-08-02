// VideoSearchModal.tsx — Video search modal with Pixabay integration.
// Three tabs: Pixabay (search), Upload (drag-drop + URL paste), Create (AI placeholder).
// 4-column grid, 16:9 thumbnails, hover overlay with play icon.
// Search on Enter key, not on typing.
// Uses shared Modal shell for portal, backdrop, Escape key, and close button.

import { useState, useCallback, useRef, useEffect } from 'react';
import { CLOUD_ENABLED } from '@/shared/cloud-flag';
import { trace } from '@/shared/debug-trace';
import Modal from '@/design-system/Modal';

// Pixabay video search. In CLOUD mode it goes through the backend proxy
// (`/api/media/pixabay`) so Revyme's key stays server-side and out of the
// browser bundle; in STANDALONE mode a self-hoster's own VITE key calls
// Pixabay directly. Without either, the Pixabay tab is hidden (Upload +
// Create remain fully functional).
const PIXABAY_API_KEY = import.meta.env.VITE_PIXABAY_KEY as string | undefined;
const HAS_PIXABAY = CLOUD_ENABLED || !!PIXABAY_API_KEY;

const SEARCH_TERMS = ['nature', 'ocean', 'city', 'abstract', 'sky', 'technology', 'minimal', 'dark', 'clouds', 'fire'];

// Pixabay pagination — capped infinite scroll (protects the API quota).
// 30/page × 8 pages = up to 240 videos.
const PIXABAY_PER_PAGE = 30;
const PIXABAY_MAX_PAGES = 8;

interface VideoSearchModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (url: string) => void;
}

interface PixabayVideoSize {
  url: string;
  width: number;
  height: number;
  thumbnail?: string;
}

interface PixabayVideo {
  id: number;
  videos: {
    tiny: PixabayVideoSize;
    small: PixabayVideoSize;
    medium?: PixabayVideoSize;
    large?: PixabayVideoSize;
  };
  tags: string;
  duration: number;
  picture_id: string;
}

type Tab = 'pixabay' | 'upload' | 'create';

/** Format seconds to MM:SS */
function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function VideoSearchModal({ isOpen, onClose, onSelect }: VideoSearchModalProps) {
  const [tab, setTab] = useState<Tab>(HAS_PIXABAY ? 'pixabay' : 'upload');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PixabayVideo[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [urlInput, setUrlInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const loadingMoreRef = useRef(false); // sync guard against concurrent page fetches
  const pageRef = useRef(1);            // sync last-fetched page
  const pixabayGridRef = useRef<HTMLDivElement>(null);

  // Search Pixabay videos. `pageNum`/`append` drive the capped infinite scroll:
  // fresh search replaces + resets scroll; scrolling near the bottom appends the
  // next page (up to PIXABAY_MAX_PAGES).
  const searchPixabay = useCallback(async (q: string, pageNum = 1, append = false) => {
    if (!q.trim()) return;
    if (append) {
      setLoadingMore(true);
    } else {
      setLoading(true);
      setHasMore(false);
      pixabayGridRef.current?.scrollTo({ top: 0 });
    }
    trace.action('video-search:query', { query: q, page: pageNum, append });
    try {
      // Cloud → same-origin backend proxy (key server-side); standalone → direct
      // with the self-hoster's own key. Both return the raw Pixabay shape.
      const res = CLOUD_ENABLED
        ? await fetch(
            `/api/media/pixabay?q=${encodeURIComponent(q)}&per_page=${PIXABAY_PER_PAGE}&page=${pageNum}`,
            { credentials: 'same-origin' }
          )
        : await fetch(
            `https://pixabay.com/api/videos/?key=${PIXABAY_API_KEY}&q=${encodeURIComponent(q)}&per_page=${PIXABAY_PER_PAGE}&page=${pageNum}`
          );
      const data = await res.json();
      const hits = (data.hits || []) as PixabayVideo[];
      setResults((prev) => {
        if (!append) return hits;
        // Dedup by id — guards React keys if a page ever overlaps.
        const seen = new Set(prev.map((v) => v.id));
        return [...prev, ...hits.filter((v) => !seen.has(v.id))];
      });
      pageRef.current = pageNum;
      // Pixabay 400s if you request a page past totalHits — bound by BOTH the
      // API's page count and our own cap.
      const totalHits = typeof data.totalHits === 'number' && data.totalHits > 0 ? data.totalHits : Infinity;
      const apiMaxPage = Number.isFinite(totalHits) ? Math.ceil(totalHits / PIXABAY_PER_PAGE) : PIXABAY_MAX_PAGES;
      setHasMore(hits.length > 0 && pageNum < Math.min(apiMaxPage, PIXABAY_MAX_PAGES));
      trace.action('video-search:results', { count: hits.length, page: pageNum });
    } catch (err) {
      trace.error('video-search:error', err);
      if (!append) setResults([]);
      setHasMore(false);
    } finally {
      if (append) setLoadingMore(false); else setLoading(false);
    }
  }, []);

  // Fetch the next page when the grid scrolls near its bottom (capped). Sync ref
  // guard prevents a fast scroll from firing overlapping page fetches.
  const loadMorePixabay = useCallback(() => {
    if (loadingMoreRef.current || loading || !hasMore || !query.trim()) return;
    loadingMoreRef.current = true;
    searchPixabay(query, pageRef.current + 1, true).finally(() => { loadingMoreRef.current = false; });
  }, [loading, hasMore, query, searchPixabay]);

  const onPixabayScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 340) loadMorePixabay();
  }, [loadMorePixabay]);

  // Load random results on open
  useEffect(() => {
    if (isOpen) {
      const term = SEARCH_TERMS[Math.floor(Math.random() * SEARCH_TERMS.length)];
      setQuery(term);
      setResults([]);
      setUrlInput('');
      setTab(HAS_PIXABAY ? 'pixabay' : 'upload');
      if (HAS_PIXABAY) searchPixabay(term);
    }
  }, [isOpen, searchPixabay]);

  const handleSelect = (url: string) => {
    trace.action('video-search:select', { url: url.slice(0, 80) });
    onSelect(url);
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      searchPixabay(query);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Video" width={896}>
      <div className="p-4 space-y-3 min-h-[500px]">
        {/* Header: tabs + search */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1">
            {((HAS_PIXABAY ? ['pixabay', 'upload', 'create'] : ['upload', 'create']) as Tab[]).map(t => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-4 py-2 rounded-md text-xs font-medium transition-colors ${
                  tab === t
                    ? 'bg-[var(--choice-bg)] text-[var(--text-primary)]'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                }`}
              >
                {t === 'pixabay' ? 'Pixabay' : t === 'upload' ? 'Upload' : 'Create'}
              </button>
            ))}
          </div>

          {/* Search input — only on Pixabay tab */}
          {tab === 'pixabay' && (
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Search videos... (Enter to search)"
              className="w-64 h-[var(--control-height)] px-3 text-xs bg-[var(--grid-line)] border border-[var(--control-border)] hover:border-[var(--control-border-hover)] focus:border-[var(--border-focus)] text-[var(--text-primary)] rounded-[var(--radius-lg)] focus:outline-none transition-colors"
            />
          )}
        </div>

        {/* ─── Pixabay Tab ─── */}
        {tab === 'pixabay' && (
          <div ref={pixabayGridRef} onScroll={onPixabayScroll} className="grid grid-cols-4 gap-3 max-h-[500px] min-h-[400px] overflow-y-auto scrollbar-hide">
            {loading && Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="aspect-video rounded-md overflow-hidden animate-pulse bg-gradient-to-r from-[var(--grid-line)] via-[var(--bg-hover)] to-[var(--grid-line)]" />
            ))}
            {!loading && results.map(vid => {
              const videoUrl = vid.videos.small?.url || vid.videos.tiny?.url || vid.videos.medium?.url || '';
              // Use tiny video URL as thumbnail — <video> loads first frame via preload="metadata"
              const tinyUrl = vid.videos.tiny?.url || videoUrl;
              return (
                <button
                  key={vid.id}
                  onClick={() => handleSelect(videoUrl)}
                  className="relative group cursor-pointer aspect-video rounded-md overflow-hidden bg-[var(--grid-line)]"
                >
                  <video
                    src={tinyUrl}
                    className="w-full h-full object-cover transition-transform group-hover:scale-105"
                    muted
                    playsInline
                    preload="metadata"
                    onMouseEnter={(e) => { try { (e.target as HTMLVideoElement).play(); } catch {} }}
                    onMouseLeave={(e) => { try { const v = e.target as HTMLVideoElement; v.pause(); v.currentTime = 0; } catch {} }}
                  />
                  <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-all flex items-center justify-center pointer-events-none">
                    <svg
                      width="32" height="32" viewBox="0 0 24 24" fill="white" className="opacity-60 group-hover:opacity-0 transition-opacity drop-shadow-lg"
                    >
                      <polygon points="5 3 19 12 5 21 5 3" />
                    </svg>
                  </div>
                  {/* Duration badge */}
                  <div className="absolute bottom-1.5 right-1.5 bg-black/60 text-white text-[10px] px-1.5 py-0.5 rounded font-mono">
                    {formatDuration(vid.duration)}
                  </div>
                </button>
              );
            })}
            {/* Loading-more skeletons (append) — existing results stay visible. */}
            {loadingMore && Array.from({ length: 4 }).map((_, i) => (
              <div key={`more-${i}`} className="aspect-video rounded-md overflow-hidden animate-pulse bg-gradient-to-r from-[var(--grid-line)] via-[var(--bg-hover)] to-[var(--grid-line)]" />
            ))}
            {!loading && results.length === 0 && (
              <div className="col-span-4 text-center py-8 text-xs text-[var(--text-secondary)]">
                No videos found. Try a different search term.
              </div>
            )}
            {!loading && !loadingMore && !hasMore && results.length > 0 && (
              <div className="col-span-4 text-center py-4 text-[10px] text-[var(--text-disabled)]">
                That's all for this search — refine the term for different results.
              </div>
            )}
          </div>
        )}

        {/* ─── Upload Tab ─── */}
        {tab === 'upload' && (
          <div className="flex flex-col gap-4 min-h-[400px]">
            {/* Upload drop zone */}
            <label className="flex-shrink-0 h-32 rounded-md bg-[var(--bg-surface)] border-2 border-dashed border-[var(--control-border)] flex flex-col items-center justify-center gap-2 hover:bg-[var(--bg-hover)] cursor-pointer transition-colors">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--text-secondary)]">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              <span className="text-xs text-[var(--text-secondary)]">Upload video file</span>
              <input type="file" accept="video/*" className="hidden" onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = () => {
                  if (typeof reader.result === 'string') handleSelect(reader.result);
                };
                reader.readAsDataURL(file);
              }} />
            </label>

            {/* URL paste */}
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && urlInput.trim()) handleSelect(urlInput.trim()); }}
                placeholder="Or paste a video URL..."
                className="flex-1 h-[var(--control-height)] px-3 text-xs bg-[var(--grid-line)] border border-[var(--control-border)] hover:border-[var(--control-border-hover)] focus:border-[var(--border-focus)] text-[var(--text-primary)] rounded-[var(--radius-lg)] focus:outline-none transition-colors"
              />
              {urlInput.trim() && (
                <button
                  onClick={() => handleSelect(urlInput.trim())}
                  className="h-8 px-3 text-xs font-medium text-[var(--accent-fg)] bg-[var(--accent)] rounded-[var(--radius-lg)] hover:brightness-110 transition-all"
                >
                  Use
                </button>
              )}
            </div>
          </div>
        )}

        {/* ─── Create Tab (AI placeholder) ─── */}
        {tab === 'create' && (
          <div className="flex flex-col items-center justify-center min-h-[400px] gap-4">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--text-tertiary)]">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
            </svg>
            <p className="text-xs text-[var(--text-secondary)] text-center max-w-xs">
              AI video generation requires a backend API. Connect your Runway or Pika API key to enable this feature.
            </p>
          </div>
        )}
      </div>
    </Modal>
  );
}
