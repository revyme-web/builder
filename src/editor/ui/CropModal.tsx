// CropModal.tsx — crop an image fill in a design-tool-style modal. Shows the
// image fitted, with a draggable/resizable crop rectangle (8 handles + move
// interior + dimmed outside), and Apply / Cancel at the bottom.
//
// Apply rasterises the crop region to a new image (canvas), uploads it through
// the shared backend (data-URL locally, R2/CDN in cloud), and hands the new
// URL back — the caller writes it as the fill's background-image via the normal
// undo-safe style path, so Cmd+Z reverts to the original image.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import Modal from '@/design-system/Modal';
import { backend } from '@/backend';
import { getProjectId } from '@/backend/project-id';
import {
  type CropRect, type CropHandle, type Size,
  fullCrop, resizeCrop, displayToNaturalCrop, isFullCrop,
} from '@/shared/crop-utils';
import { loadCropImage, naturalSize, cropLoadedImageToBlob, cropOutputMime } from './crop-image';
import { trace } from '@/shared/debug-trace';

const MAX_W = 620;
const MAX_H = 440;
const HANDLE = 12; // px hit-size of each handle square

interface CropModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Resolved image URL currently in the fill. */
  src: string | null;
  /** Called with the NEW (cropped + uploaded) image URL on Apply. */
  onApply: (url: string) => void;
}

/** Fit a natural size inside the MAX_W×MAX_H stage, preserving aspect. */
function fitDisplaySize(nat: Size): Size {
  if (nat.width <= 0 || nat.height <= 0) return { width: MAX_W, height: MAX_H };
  const scale = Math.min(MAX_W / nat.width, MAX_H / nat.height, 1);
  return { width: Math.round(nat.width * scale), height: Math.round(nat.height * scale) };
}

const HANDLE_CURSOR: Record<CropHandle, string> = {
  nw: 'nwse-resize', se: 'nwse-resize',
  ne: 'nesw-resize', sw: 'nesw-resize',
  n: 'ns-resize', s: 'ns-resize',
  e: 'ew-resize', w: 'ew-resize',
  move: 'move',
};

export default function CropModal({ isOpen, onClose, src, onApply }: CropModalProps) {
  const [natSize, setNatSize] = useState<Size | null>(null);
  const [dispSize, setDispSize] = useState<Size>({ width: 0, height: 0 });
  const [crop, setCrop] = useState<CropRect>({ x: 0, y: 0, width: 0, height: 0 });
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The loaded (untainted) image + its render URL. Loaded ONCE through the
  // media proxy so both the preview and the Apply-time crop read the same
  // untainted source — no re-fetch, no CORS taint on toBlob.
  const imgRef = useRef<HTMLImageElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const [displayUrl, setDisplayUrl] = useState<string | null>(null);

  // Load + measure the image whenever the modal opens with a src.
  useEffect(() => {
    if (!isOpen || !src) return;
    let cancelled = false;
    setLoadState('loading');
    setError(null);
    loadCropImage(src)
      .then(({ img, objectUrl }) => {
        if (cancelled) { if (objectUrl) URL.revokeObjectURL(objectUrl); return; }
        imgRef.current = img;
        objectUrlRef.current = objectUrl;
        const nat = naturalSize(img);
        const disp = fitDisplaySize(nat);
        setNatSize(nat);
        setDispSize(disp);
        setCrop(fullCrop(disp));
        setDisplayUrl(objectUrl ?? src);
        setLoadState('ready');
        trace.action('crop-modal:image-ready', { nat, disp, viaProxy: !!objectUrl });
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadState('error');
        setError('Could not load this image for cropping.');
        trace.error('crop-modal:load-failed', { error: err instanceof Error ? err.message : String(err) });
      });
    return () => { cancelled = true; };
  }, [isOpen, src]);

  // Reset transient state on close so a reopen starts fresh (+ free the blob URL).
  useEffect(() => {
    if (!isOpen) {
      if (objectUrlRef.current) { URL.revokeObjectURL(objectUrlRef.current); objectUrlRef.current = null; }
      imgRef.current = null;
      setDisplayUrl(null);
      setNatSize(null);
      setDispSize({ width: 0, height: 0 });
      setLoadState('idle');
      setBusy(false);
      setError(null);
    }
  }, [isOpen]);

  // ─── Drag: a handle or the interior ──────────────────────────────────────
  const dragRef = useRef<{ handle: CropHandle; startX: number; startY: number; start: CropRect } | null>(null);

  const onHandleDown = useCallback((handle: CropHandle) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = { handle, startX: e.clientX, startY: e.clientY, start: crop };
    trace.action('crop-modal:drag-start', { handle });
  }, [crop]);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      // The stage is 1:1 with the screen (no zoom), so screen delta === display delta.
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      setCrop(resizeCrop(d.start, d.handle, dx, dy, dispSize));
    };
    const onUp = () => { if (dragRef.current) { dragRef.current = null; trace.action('crop-modal:drag-end', {}); } };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [dispSize]);

  // ─── Apply ───────────────────────────────────────────────────────────────
  const handleApply = useCallback(async () => {
    if (!src || !natSize || !imgRef.current || busy) return;
    // Untouched (full) crop → nothing to do; just close.
    if (isFullCrop(crop, dispSize)) {
      trace.action('crop-modal:apply-noop-full', {});
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const natCrop = displayToNaturalCrop(crop, dispSize, natSize);
      // Crop the ALREADY-LOADED (untainted) image — no re-fetch, no CORS taint.
      const { blob, mime } = await cropLoadedImageToBlob(imgRef.current, natCrop, cropOutputMime(src));
      const ext = mime === 'image/png' ? 'png' : 'jpg';
      const file = new File([blob], `crop.${ext}`, { type: mime });
      const url = await backend.uploadAsset(getProjectId(), file);
      trace.action('crop-modal:applied', { natCrop, mime, url: url.slice(0, 80) });
      onApply(url);
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg.includes('CORS') || msg.includes('cross-origin')
        ? 'This image can’t be cropped in place (its host blocks reading the pixels).'
        : 'Crop failed. Please try again.');
      trace.error('crop-modal:apply-failed', { error: msg });
    } finally {
      setBusy(false);
    }
  }, [src, natSize, dispSize, crop, busy, onApply, onClose]);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Crop Image" width={MAX_W + 48}>
      <div className="flex flex-col">
        {/* Stage area (padded) */}
        <div className="px-5 pt-5 pb-4 flex flex-col gap-3">
          <div className="w-full flex items-center justify-center min-h-[240px]">
            {loadState === 'loading' && (
              <span className="text-xs text-[var(--text-tertiary)]">Loading image…</span>
            )}
            {loadState === 'error' && (
              <span className="text-xs text-[var(--text-error,#e5484d)]">{error}</span>
            )}
            {loadState === 'ready' && (
              <CropStage src={displayUrl ?? src!} dispSize={dispSize} crop={crop} onHandleDown={onHandleDown} />
            )}
          </div>
          {error && loadState === 'ready' && (
            <div className="text-xs text-[var(--text-error,#e5484d)] text-center">{error}</div>
          )}
        </div>

        {/* Footer — a full-width, opaque, bordered bar so the Cancel/Apply
            buttons are always clearly SEPARATED from (and above) the crop
            stage's dim, never behind it. */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[var(--border-light)] bg-[var(--bg-surface)]">
          <button
            onClick={onClose}
            disabled={busy}
            className="h-8 px-4 text-xs rounded-[var(--radius-lg)] bg-[var(--grid-line)] border border-[var(--control-border)] text-[var(--text-primary)] hover:border-[var(--control-border-hover)] transition-colors cursor-pointer disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleApply}
            data-crop-apply
            disabled={busy || loadState !== 'ready'}
            className="h-8 px-4 text-xs rounded-[var(--radius-lg)] bg-[var(--accent)] text-white hover:opacity-90 transition-opacity cursor-pointer disabled:opacity-50"
          >
            {busy ? 'Applying…' : 'Apply'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ─── The image + crop overlay ────────────────────────────────────────────────

function CropStage({
  src, dispSize, crop, onHandleDown,
}: {
  src: string;
  dispSize: Size;
  crop: CropRect;
  onHandleDown: (h: CropHandle) => (e: React.PointerEvent) => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  // Prevent the browser's native image-drag ghost from hijacking the pointer.
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const prevent = (e: Event) => e.preventDefault();
    el.addEventListener('dragstart', prevent);
    return () => el.removeEventListener('dragstart', prevent);
  }, []);

  const handles: CropHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
  const handlePos = (h: CropHandle): { left: number; top: number } => {
    const cx = crop.x + crop.width / 2;
    const cy = crop.y + crop.height / 2;
    const left = h.includes('w') ? crop.x : h.includes('e') ? crop.x + crop.width : cx;
    const top = h.includes('n') ? crop.y : h.includes('s') ? crop.y + crop.height : cy;
    return { left, top };
  };

  return (
    <div
      ref={stageRef}
      data-crop-stage
      className="relative select-none"
      style={{ width: dispSize.width, height: dispSize.height }}
    >
      {/* The image */}
      <img
        src={src}
        alt=""
        draggable={false}
        className="absolute inset-0 w-full h-full object-fill pointer-events-none rounded-md"
        style={{ width: dispSize.width, height: dispSize.height }}
      />

      {/* Dim layer — CLIPPED to the image (overflow-hidden) so the big
          box-shadow "hole" only darkens the non-cropped part of the IMAGE and
          never bleeds over the modal footer. pointer-events-none on the clip so
          it doesn't swallow clicks; the crop-hole re-enables them for the move
          drag. */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none rounded-md">
        <div
          onPointerDown={onHandleDown('move')}
          className="absolute pointer-events-auto"
          style={{
            left: crop.x, top: crop.y, width: crop.width, height: crop.height,
            boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)',
            outline: '1px solid rgba(255,255,255,0.9)',
            cursor: 'move',
          }}
        >
          {/* Rule-of-thirds guide lines */}
          <div className="absolute inset-0 pointer-events-none" style={{
            backgroundImage:
              'linear-gradient(rgba(255,255,255,0.4) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.4) 1px, transparent 1px)',
            backgroundSize: `${crop.width / 3}px ${crop.height / 3}px`,
            backgroundPosition: '0 0',
          }} />
        </div>
      </div>

      {/* Handles — rendered OUTSIDE the clip so edge handles aren't cut off. */}
      {handles.map((h) => {
        const p = handlePos(h);
        return (
          <div
            key={h}
            data-crop-handle={h}
            onPointerDown={onHandleDown(h)}
            className="absolute rounded-sm bg-white border border-[rgba(0,0,0,0.35)]"
            style={{
              left: p.left - HANDLE / 2,
              top: p.top - HANDLE / 2,
              width: HANDLE,
              height: HANDLE,
              cursor: HANDLE_CURSOR[h],
            }}
          />
        );
      })}
    </div>
  );
}
