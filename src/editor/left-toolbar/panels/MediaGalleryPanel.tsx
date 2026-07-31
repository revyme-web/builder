// MediaGalleryPanel.tsx — Media gallery with upload support.
// Cloud mode: uploads to R2 via /api/upload, lists existing uploads.
// Standalone mode: uses object URLs (session-only).
//
// Drop into canvas: tiles use the same toolbar-drag pipeline the Library
// and Insert panels use (`startToolbarDrag` + 5 px movement threshold +
// drop-line indicator + parent-highlight). No HTML5 dataTransfer + no
// click-to-copy-URL — that older flow was inconsistent with the rest
// of the editor (no drop preview, no parent insertion semantics).
//
// Deleting: hovering a tile reveals an × (top-right). Click → ConfirmModal →
// DELETE /api/upload. Shift+click multi-selects tiles; shift+DRAG sweeps a
// marquee over the grid (auto-scrolling at the edges) — the × on any
// selected tile then bulk-deletes the whole selection. Cloud-only (the
// standalone object URLs have no server object to delete).

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { CLOUD_ENABLED } from '@/shared/cloud-flag';
import { ToolSegmentedControl } from '@/editor/controls';
import { trace } from '@/shared/debug-trace';
import SectionLabel from '@/design-system/SectionLabel';
import { backend } from '@/backend';
import { getProjectId } from '@/backend/project-id';
import { startToolbarDrag } from '@/canvas/drag/toolbar-drag-bridge';
import { type ToolbarItem } from '@/canvas/drag/toolbar-item-config';
import { ConfirmModal } from '@/editor/overlays/settings-shared';
import { MULTI_SELECT_OUTLINE } from './LibraryPanel/shared/section-utils';
import { deriveUploadKey, keysInSweep, sweepAutoScrollStep, deleteConfirmMessage, type TileRect } from './media-gallery-utils';

const TAB_OPTIONS = [
  { value: 'images', label: 'Images' },
  { value: 'videos', label: 'Videos' },
];

interface UploadedFile {
  url: string;
  key?: string;
  size?: number;
  lastModified?: string;
}

/** 5 px movement threshold before a tile pointerdown is treated as a drag.
 *  Below this, releasing the pointer is a no-op (no click action — the
 *  panel is drag-only). At/above, the toolbar drag pipeline kicks in.
 *  Same value LibraryPanel uses (`LIBRARY_DRAG_THRESHOLD_PX`). */
const MEDIA_DRAG_THRESHOLD_PX = 5;

/** Shared drag logic for media tiles. Mirrors LibraryPanel's
 *  `useComponentDrag` exactly — kicks off `startToolbarDrag` once the
 *  cursor moves more than `MEDIA_DRAG_THRESHOLD_PX` from the
 *  pointerdown position, with a `ToolbarItem` describing the image /
 *  video to drop. Drop targeting (drop-line indicator, parent-
 *  highlight, layout-vs-canvas insertion) is handled by
 *  `ToolbarDragStrategy` downstream — same path Insert panel cards use. */
function useMediaDrag(url: string, kind: 'image' | 'video') {
  return useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const startEvent = e.nativeEvent;
    // Snapshot the tile's actual rendered size — the panel's grid-cols-2
    // + aspect-square layout means tiles are typically ~112×112, but
    // resizing the panel changes that. Reading from the live DOM lets
    // the drag ghost match exactly what the user sees in the gallery
    // instead of using a hard-coded fallback.
    const tile = e.currentTarget as HTMLElement;
    const rect = tile.getBoundingClientRect();
    const ghostW = Math.round(rect.width)  || 200;
    const ghostH = Math.round(rect.height) || 150;
    const item: ToolbarItem = kind === 'image' ? {
      id: `media-image:${url}`,
      // Drop as a normal <div> with the image as a CSS BACKGROUND, not a bare
      // <img>. It then behaves like any frame: it fills/crops via
      // `background-size: cover`, can hold children + overlays, and is styled
      // like a div (the reference's "image fill" model). The dropped element uses the
      // canonical 200×150 insert size; the ghost matches the gallery tile.
      elementType: 'div',
      name: 'Image',
      defaultStyles: {
        width: '200px',
        height: '150px',
        backgroundImage: `url("${url}")`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        backgroundRepeat: 'no-repeat',
        // No placeholder fill: a grey bg is invisible behind an opaque photo
        // (cover fills the box) but shows through every transparent pixel of a
        // PNG/WebP cutout (logos, icons, 3D assets) — making them look "not
        // transparent". Dropping with no fill respects the image's alpha.
      },
      ghostSize: { width: ghostW, height: ghostH },
    } : {
      id: `media-video:${url}`,
      elementType: 'video',
      // Same split as image: dropped element keeps the canonical
      // 320×240 insert size; ghost matches the gallery tile.
      defaultStyles: {
        display: 'block',
        width: '320px',
        height: '240px',
        maxWidth: 'none',
        backgroundColor: '#1f2937',
      },
      defaultAttrs: { src: url, controls: '' },
      ghostSize: { width: ghostW, height: ghostH },
    };
    let dragStarted = false;
    const cleanup = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    const onMove = (moveEvent: PointerEvent) => {
      if (dragStarted) return;
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      if (dx * dx + dy * dy < MEDIA_DRAG_THRESHOLD_PX * MEDIA_DRAG_THRESHOLD_PX) return;
      dragStarted = true;
      cleanup();
      trace.action('media-panel:drag-start', { kind, url });
      startToolbarDrag(item, startEvent);
    };
    const onUp = () => { cleanup(); };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }, [url, kind]);
}

/** Single tile in the gallery grid. Wraps the image/video preview in a
 *  `<div onPointerDown={handleDrag}>` exactly like LibraryPanel's
 *  ComponentRow — bare div, no forwardRef / memo layers between the
 *  React listener tree and the DOM target (those layers caused
 *  drop-line indicator dropouts in earlier wiring; see LibraryPanel
 *  lines 406-415 for the rationale). */
const MediaTile = React.memo(function MediaTile({ url, kind, mediaKey, isSelected, canDelete, onShiftPointerDown, onPlainPointerDown, onRequestDelete }: {
  url: string;
  kind: 'image' | 'video';
  /** R2 object key — the deletable identity. Null → standalone blob URL. */
  mediaKey: string | null;
  isSelected: boolean;
  canDelete: boolean;
  /** Shift held on pointerdown → the panel's sweep/toggle machinery. */
  onShiftPointerDown: (key: string, e: React.PointerEvent) => void;
  /** Plain pointerdown (drag intent) — panel clears any multi-selection. */
  onPlainPointerDown: () => void;
  onRequestDelete: (key: string) => void;
}) {
  const handleDrag = useMediaDrag(url, kind);
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.shiftKey && mediaKey) {
      // Selection gesture — never arms the canvas drag. stopPropagation is
      // LOAD-BEARING: without it the event bubbles to the grid container's
      // own shift handler, which restarts the gesture with NO toggle target
      // — so shift+clicking an already-selected tile never removed it.
      e.preventDefault();
      e.stopPropagation();
      onShiftPointerDown(mediaKey, e);
      return;
    }
    onPlainPointerDown();
    handleDrag(e);
  };
  return (
    <div
      data-media-key={mediaKey ?? undefined}
      onPointerDown={onPointerDown}
      // Selected: border snaps to accent with NO transition — with the base
      // white border + `transition-colors`, every tile joining the selection
      // flashed white→blue under the instant outline (the reported fringe).
      className={`group relative aspect-square rounded-md overflow-hidden border cursor-grab active:cursor-grabbing ${
        isSelected
          ? 'border-[var(--accent)] transition-none'
          : 'border-[var(--border-light)] hover:border-[var(--accent)] transition-colors'
      }`}
      style={isSelected ? MULTI_SELECT_OUTLINE : undefined}
      title="Drag to canvas"
    >
      {kind === 'image' ? (
        <img src={url} alt="" className="w-full h-full object-cover pointer-events-none" loading="lazy" draggable={false} />
      ) : (
        <video src={url} className="w-full h-full object-cover pointer-events-none" muted />
      )}
      {/* Selected: light accent wash over the artwork so membership reads at
          a glance (the outline alone was easy to miss between busy thumbs). */}
      {isSelected && (
        <div
          className="pointer-events-none absolute inset-0"
          style={{ background: 'var(--accent, #4c8df6)', opacity: 0.22 }}
        />
      )}
      {/* Hover delete — dark grey disc, white ×. pointerdown is stopped so
          clicking it never starts a canvas drag. */}
      {canDelete && mediaKey && (
        <button
          type="button"
          aria-label="Delete asset"
          onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
          onClick={(e) => { e.stopPropagation(); onRequestDelete(mediaKey); }}
          className="absolute top-1 right-1 z-10 flex h-5 w-5 items-center justify-center rounded-md bg-black/60 text-white opacity-0 group-hover:opacity-100 hover:bg-black/80 transition-opacity cursor-pointer"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
            <path d="M6 6l12 12" />
            <path d="M18 6 6 18" />
          </svg>
        </button>
      )}
    </div>
  );
});

interface StorageInfo {
  currentUsageMB: string;
  storageLimitMB: string;
}

export default function MediaGalleryPanel() {
  const [tab, setTab] = useState('images');
  const [uploads, setUploads] = useState<UploadedFile[]>([]);
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  // True while a list fetch is in flight — drives the skeleton grid so the
  // panel never flashes "No images uploaded yet" before the data lands.
  // Starts true in cloud mode (a fetch always fires on mount).
  const [loadingList, setLoadingList] = useState(!!CLOUD_ENABLED);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  // Multi-select (shift+click / shift+sweep) — keyed by R2 object key.
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  // Pending delete confirmation — the keys the ConfirmModal will remove.
  const [confirmKeys, setConfirmKeys] = useState<string[] | null>(null);
  const [deleting, setDeleting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const projectId = getProjectId();
  const isCloud = !!CLOUD_ENABLED;
  const noun: 'image' | 'video' = tab === 'images' ? 'image' : 'video';

  trace.fn('MediaGalleryPanel:render', { tab, count: uploads.length, selected: selectedKeys.size });

  // Fetch existing uploads + storage info
  const fetchUploads = useCallback(async () => {
    if (!isCloud) { setLoadingList(false); return; }
    setLoadingList(true);
    try {
      const [uploadsRes, storageRes] = await Promise.all([
        fetch(`/api/upload?websiteId=${projectId}&type=${tab === 'images' ? 'image' : 'video'}`),
        fetch(`/api/upload?websiteId=${projectId}&type=storage`),
      ]);
      if (uploadsRes.ok) {
        const data = await uploadsRes.json();
        setUploads(data.uploads || []);
        trace.action('media:fetched', { type: tab, count: data.uploads?.length ?? 0 });
      }
      if (storageRes.ok) {
        const data = await storageRes.json();
        setStorage({ currentUsageMB: data.currentUsageMB, storageLimitMB: data.storageLimitMB });
      }
    } catch (err) {
      trace.error('media:fetch-failed', err);
    }
    setLoadingList(false);
  }, [projectId, tab, isCloud]);

  useEffect(() => { fetchUploads(); }, [fetchUploads]);

  // Tab switch invalidates the selection AND the visible list — without the
  // clear, the previous tab's items linger under the new tab until its own
  // fetch lands (images briefly shown under Videos).
  useEffect(() => { setSelectedKeys(new Set()); setUploads([]); }, [tab]);

  // Escape clears the multi-selection (the ConfirmModal handles its own).
  useEffect(() => {
    if (selectedKeys.size === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !confirmKeys) setSelectedKeys(new Set());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedKeys.size, confirmKeys]);

  // Clicking anywhere OUTSIDE the gallery grid clears the multi-selection —
  // same dismissal model as canvas selection. Capture phase so it fires even
  // when the clicked surface (canvas iframe chrome, other panels) stops
  // propagation. Skipped while the confirm modal is open: its buttons live
  // in a document.body portal, which would read as "outside" and wipe the
  // selection under a still-open modal.
  useEffect(() => {
    if (selectedKeys.size === 0) return;
    const onDown = (e: PointerEvent) => {
      if (confirmKeys) return;
      const cont = scrollRef.current;
      if (cont && e.target instanceof Node && cont.contains(e.target)) return;
      trace.action('media-select:clear-outside', { had: selectedKeys.size });
      setSelectedKeys(new Set());
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [selectedKeys.size, confirmKeys]);

  // Handle file upload
  const handleUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setUploadError(null);
    trace.action('media:upload-start', { name: file.name, size: file.size });
    try {
      const url = await backend.uploadAsset(projectId, file);
      setUploads(prev => [{ url, size: file.size }, ...prev]);
      trace.action('media:upload-success', { url });
      // Re-fetch storage so the usage chip updates immediately.
      fetchUploads();
    } catch (err) {
      trace.error('media:upload-failed', err);
      setUploadError(err instanceof Error ? err.message : 'Upload failed');
    }
    setUploading(false);
    // Reset input so same file can be re-uploaded
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [projectId, fetchUploads]);

  // ─── Shift+click toggle / shift+drag marquee sweep ───────────────────────
  // A shift pointerdown arms BOTH: released within the drag threshold it's a
  // TOGGLE of that tile; moved beyond it, it's a marquee sweep in the scroll
  // container's CONTENT space (so the anchor stays put while auto-scroll
  // extends the selection up/down at the edges).
  const sweepRef = useRef<{
    anchor: { x: number; y: number };
    base: Set<string>;
    startClient: { x: number; y: number };
    lastClient: { x: number; y: number };
    moved: boolean;
    toggleKey: string | null;
    raf: number;
  } | null>(null);

  const tileRects = useCallback((): TileRect[] => {
    const cont = scrollRef.current;
    if (!cont) return [];
    const cr = cont.getBoundingClientRect();
    const rects: TileRect[] = [];
    cont.querySelectorAll<HTMLElement>('[data-media-key]').forEach((el) => {
      const key = el.dataset.mediaKey!;
      const r = el.getBoundingClientRect();
      rects.push({
        key,
        left: r.left - cr.left + cont.scrollLeft,
        top: r.top - cr.top + cont.scrollTop,
        right: r.right - cr.left + cont.scrollLeft,
        bottom: r.bottom - cr.top + cont.scrollTop,
      });
    });
    return rects;
  }, []);

  const recomputeSweep = useCallback(() => {
    const s = sweepRef.current;
    const cont = scrollRef.current;
    if (!s || !cont) return;
    const cr = cont.getBoundingClientRect();
    const b = {
      x: s.lastClient.x - cr.left + cont.scrollLeft,
      y: s.lastClient.y - cr.top + cont.scrollTop,
    };
    const swept = keysInSweep(tileRects(), s.anchor, b);
    setSelectedKeys(new Set([...s.base, ...swept]));
  }, [tileRects]);

  const beginShiftGesture = useCallback((toggleKey: string | null, e: React.PointerEvent) => {
    const cont = scrollRef.current;
    if (!cont) return;
    const cr = cont.getBoundingClientRect();
    sweepRef.current = {
      anchor: { x: e.clientX - cr.left + cont.scrollLeft, y: e.clientY - cr.top + cont.scrollTop },
      base: new Set(selectedKeys),
      startClient: { x: e.clientX, y: e.clientY },
      lastClient: { x: e.clientX, y: e.clientY },
      moved: false,
      toggleKey,
      raf: 0,
    };
    trace.action('media-sweep:begin', { toggleKey, selected: selectedKeys.size });

    const onMove = (ev: PointerEvent) => {
      const s = sweepRef.current;
      if (!s) return;
      s.lastClient = { x: ev.clientX, y: ev.clientY };
      if (!s.moved) {
        const dx = ev.clientX - s.startClient.x;
        const dy = ev.clientY - s.startClient.y;
        if (dx * dx + dy * dy < MEDIA_DRAG_THRESHOLD_PX * MEDIA_DRAG_THRESHOLD_PX) return;
        s.moved = true;
      }
      recomputeSweep();
    };
    const onUp = () => {
      const s = sweepRef.current;
      cleanup();
      if (!s) return;
      if (!s.moved && s.toggleKey) {
        // Plain shift+CLICK — toggle the tile in/out of the selection.
        setSelectedKeys((prev) => {
          const next = new Set(prev);
          if (next.has(s.toggleKey!)) next.delete(s.toggleKey!);
          else next.add(s.toggleKey!);
          trace.action('media-select:toggle', { key: s.toggleKey, size: next.size });
          return next;
        });
      }
    };
    const cleanup = () => {
      const s = sweepRef.current;
      if (s?.raf) cancelAnimationFrame(s.raf);
      sweepRef.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);

    // Edge auto-scroll loop — keeps scrolling (and re-selecting) while the
    // pointer parks near the container's top/bottom edge mid-sweep.
    const tick = () => {
      const s = sweepRef.current;
      if (!s) return;
      if (s.moved) {
        const rect = cont.getBoundingClientRect();
        const step = sweepAutoScrollStep(s.lastClient.y, rect.top, rect.bottom);
        if (step !== 0) {
          cont.scrollTop += step;
          recomputeSweep();
        }
      }
      s.raf = requestAnimationFrame(tick);
    };
    sweepRef.current.raf = requestAnimationFrame(tick);
  }, [selectedKeys, recomputeSweep]);

  // Shift+drag started on the grid's EMPTY space sweeps too (no toggle target).
  const onGridPointerDown = useCallback((e: React.PointerEvent) => {
    if (!e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    beginShiftGesture(null, e);
  }, [beginShiftGesture]);

  // ─── Delete flow ─────────────────────────────────────────────────────────
  const requestDelete = useCallback((key: string) => {
    // × on a tile that's part of a multi-selection deletes the WHOLE
    // selection; otherwise just that tile.
    const keys = selectedKeys.size > 1 && selectedKeys.has(key) ? [...selectedKeys] : [key];
    trace.action('media-delete:request', { count: keys.length });
    setConfirmKeys(keys);
  }, [selectedKeys]);

  const confirmDelete = useCallback(async () => {
    if (!confirmKeys || deleting) return;
    setDeleting(true);
    try {
      await backend.deleteAssets(projectId, confirmKeys);
      trace.action('media-delete:done', { count: confirmKeys.length });
      setSelectedKeys(new Set());
      setConfirmKeys(null);
      await fetchUploads();
    } catch (err) {
      trace.error('media-delete:failed', err);
      setUploadError(err instanceof Error ? err.message : 'Delete failed');
      setConfirmKeys(null);
    }
    setDeleting(false);
  }, [confirmKeys, deleting, projectId, fetchUploads]);

  const storageLabel = storage ? `${storage.currentUsageMB} / ${storage.storageLimitMB} MB` : '0.0 / 500 MB';

  return (
    <div className="flex flex-col h-full bg-[var(--bg-surface)]">
      <SectionLabel size="md" right={<span className="text-[11px] text-[var(--text-disabled)]">{storageLabel}</span>}>Media</SectionLabel>

      {/* Tabs */}
      <div className="px-3 mt-3">
        <ToolSegmentedControl value={tab} onChange={setTab} options={TAB_OPTIONS} />
      </div>

      {/* Error banner (e.g. 402 storage cap reached) */}
      {uploadError && (
        <div className="px-3 mt-3">
          <div className="px-2.5 py-1.5 rounded-md bg-red-500/10 border border-red-500/20 text-[11px] text-red-500 dark:text-red-400 leading-snug">
            {uploadError}
          </div>
        </div>
      )}

      {/* Upload button */}
      <div className="px-3 mt-3">
        <input
          ref={fileInputRef}
          type="file"
          accept={tab === 'images' ? 'image/*' : 'video/*'}
          onChange={handleUpload}
          className="hidden"
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          className="w-full flex items-center justify-center gap-2 py-2 rounded-md border border-[var(--border-light)] text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer disabled:opacity-50"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
          {uploading ? 'Uploading...' : `Upload ${tab === 'images' ? 'image' : 'video'}`}
        </button>
      </div>

      {/* Gallery grid */}
      {uploads.length > 0 ? (
        <div ref={scrollRef} onPointerDown={onGridPointerDown} className="flex-1 overflow-y-auto scrollbar-hide p-3">
          <div className="grid grid-cols-2 gap-2">
            {uploads.map((item, i) => (
              <MediaTile
                key={item.url + i}
                url={item.url}
                kind={tab === 'images' ? 'image' : 'video'}
                mediaKey={deriveUploadKey(item)}
                isSelected={(() => { const k = deriveUploadKey(item); return !!k && selectedKeys.has(k); })()}
                canDelete={isCloud}
                onShiftPointerDown={beginShiftGesture}
                onPlainPointerDown={() => { if (selectedKeys.size) setSelectedKeys(new Set()); }}
                onRequestDelete={requestDelete}
              />
            ))}
          </div>
        </div>
      ) : loadingList ? (
        // Pulsating skeleton tiles (same grid + aspect as the real tiles) while
        // the first fetch is in flight — never flash "No images" before data.
        <div className="flex-1 overflow-y-auto scrollbar-hide p-3" aria-hidden>
          <div className="grid grid-cols-2 gap-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="aspect-square rounded-md border border-[var(--border-light)] bg-[var(--bg-hover)] animate-pulse"
                style={{ animationDelay: `${i * 90}ms` }}
              />
            ))}
          </div>
        </div>
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 px-4 text-center">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--text-disabled)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
          <p className="text-xs text-[var(--text-secondary)]">No {tab} uploaded yet</p>
          <p className="text-[10px] text-[var(--text-disabled)] max-w-[180px] leading-relaxed">
            Upload {tab} to see them here
          </p>
        </div>
      )}

      {/* Delete confirmation */}
      <ConfirmModal
        isOpen={confirmKeys !== null}
        title={confirmKeys && confirmKeys.length > 1 ? `Delete ${confirmKeys.length} ${noun}s` : `Delete ${noun}`}
        message={deleteConfirmMessage(confirmKeys?.length ?? 1, noun)}
        confirmText="Delete"
        variant="danger"
        isLoading={deleting}
        onConfirm={confirmDelete}
        onCancel={() => { if (!deleting) setConfirmKeys(null); }}
      />
    </div>
  );
}
