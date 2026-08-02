// EditAssetPresetPanel.tsx — Sliding panel for editing or deleting an existing
// image/video preset. Shown via ToolPopup.pushPanel from the asset preset grid.
// Features: thumbnail preview + Change picker + Delete + Done.

import { useState, useCallback, useEffect } from 'react';
import { useDebouncedCallback } from '@/editor/hooks/useDebouncedCallback';
import { useSetAtom } from 'jotai';
import ImageSearchModal from './ImageSearchModal';
import VideoSearchModal from './VideoSearchModal';
import { queueMutation } from '@/code/mutation/mutation-queue';
import { projectVersionAtom } from '@/code/project/project-fs';
import { refreshCanvasTokens } from '@/canvas/node-ops';
import { trace } from '@/shared/debug-trace';

interface Props {
  presetName: string;
  type: 'image' | 'video';
  /** Current value (`url(...)` form). */
  initialValue: string;
  /** Called after delete (to pop the panel). */
  onDeleted?: () => void;
}

export default function EditAssetPresetPanel({ presetName, type, initialValue, onDeleted }: Props) {
  const [url, setUrl] = useState(() => extractUrl(initialValue) ?? '');
  const [pickerOpen, setPickerOpen] = useState(false);
  const bumpVersion = useSetAtom(projectVersionAtom);

  // Debounced version bump — avoids re-render storm when picker fires multiple updates.
  const debouncedBump = useDebouncedCallback(() => bumpVersion(v => v + 1), 300);

  // Final bump on unmount so derived atoms see the change.
  useEffect(() => {
    return () => {
      debouncedBump.cancel();
      bumpVersion(v => v + 1);
    };
  }, [bumpVersion, debouncedBump]);

  const handlePicked = useCallback((picked: string) => {
    setUrl(picked);
    // Image presets are stored as `url(...)` (direct CSS use in backgroundImage);
    // video presets are stored bare (consumed by runtime as <video src>).
    const stored = type === 'image' ? `url(${picked})` : picked;
    queueMutation({ type: 'updatePresetToken', name: presetName, value: stored });
    refreshCanvasTokens();
    debouncedBump.call();
    trace.action('edit-asset-preset:picked', { type, name: presetName, urlLength: picked.length });
  }, [presetName, type, debouncedBump]);

  const handleDelete = useCallback(() => {
    queueMutation({ type: 'removePresetToken', name: presetName });
    bumpVersion(v => v + 1);
    refreshCanvasTokens();
    trace.action('edit-asset-preset:delete', { type, name: presetName });
    onDeleted?.();
  }, [presetName, type, bumpVersion, onDeleted]);

  trace.fn('EditAssetPresetPanel:render', { presetName, type, hasUrl: !!url });

  return (
    <div className="flex flex-col gap-3">
      {/* Preview */}
      {url ? (
        <div
          className="w-full h-28 rounded-lg border border-[var(--border-light)] overflow-hidden cursor-pointer hover:opacity-90 transition-opacity bg-[var(--grid-line)]"
          onClick={() => setPickerOpen(true)}
        >
          {type === 'image' ? (
            <div
              className="w-full h-full"
              style={{
                backgroundImage: `url(${url})`,
                backgroundSize: 'cover',
                backgroundPosition: 'center',
              }}
            />
          ) : (
            <video
              src={url}
              muted
              loop
              autoPlay
              playsInline
              preload="metadata"
              className="w-full h-full object-cover pointer-events-none"
            />
          )}
        </div>
      ) : (
        <button
          onClick={() => setPickerOpen(true)}
          className="w-full h-28 rounded-lg border-2 border-dashed border-[var(--control-border)] hover:border-[var(--accent)] text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer flex items-center justify-center"
        >
          Choose {type === 'image' ? 'Image' : 'Video'}
        </button>
      )}

      <div className="flex gap-1.5">
        <button
          onClick={() => setPickerOpen(true)}
          className="flex-1 h-[var(--control-height-sm)] text-xs bg-[var(--grid-line)] border border-[var(--control-border)] rounded-[var(--radius-lg)] text-[var(--text-primary)] hover:border-[var(--control-border-hover)] transition-colors cursor-pointer"
        >
          Change
        </button>
        <button
          onClick={handleDelete}
          className="h-[var(--control-height-sm)] px-3 text-xs text-red-400 hover:text-red-300 border border-[var(--control-border)] rounded-[var(--radius-lg)] transition-colors cursor-pointer"
        >
          Delete
        </button>
      </div>

      {type === 'image' ? (
        <ImageSearchModal
          isOpen={pickerOpen}
          onClose={() => setPickerOpen(false)}
          onSelect={handlePicked}
        />
      ) : (
        <VideoSearchModal
          isOpen={pickerOpen}
          onClose={() => setPickerOpen(false)}
          onSelect={handlePicked}
        />
      )}
    </div>
  );
}

function extractUrl(value: string): string | null {
  const m = value.match(/url\(\s*['"]?([^'")]+)['"]?\s*\)/);
  if (m) return m[1];
  if (/^https?:\/\//i.test(value) || value.startsWith('/')) return value;
  return null;
}
