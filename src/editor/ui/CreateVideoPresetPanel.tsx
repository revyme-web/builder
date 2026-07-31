// CreateVideoPresetPanel.tsx — Sliding panel for creating a new video preset.
// Pushed via ToolPopup.pushPanel from Video preset grid's "Create new video preset" button.
// Features: name input, video preview, VideoSearchModal picker, Create button.

import { useState, useCallback } from 'react';
import { useSetAtom } from 'jotai';
import VideoSearchModal from './VideoSearchModal';
import { queueMutation } from '@/code/mutation/mutation-queue';
import { projectVersionAtom } from '@/code/project/project-fs';
import { trace } from '@/shared/debug-trace';

interface Props {
  /** Initial value from caller (raw URL or url(...) wrapper) */
  initialValue?: string;
  /** Called after preset is created (to close the panel, etc.) */
  onCreated?: () => void;
}

export default function CreateVideoPresetPanel({ initialValue, onCreated }: Props) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState(() => normalizeUrl(initialValue));
  const [pickerOpen, setPickerOpen] = useState(false);

  const bumpVersion = useSetAtom(projectVersionAtom);

  const handleCreate = useCallback(() => {
    if (!name.trim() || !url) return;

    const tokenName = 'video-' + name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');

    // Store as bare URL — backgroundVideo is a custom property read by the
    // runtime as a <video src=...>, not a CSS background-image. Wrapping in
    // url() would force every consumer to strip it back out.
    queueMutation({ type: 'addPresetToken', token: {
      name: tokenName,
      value: url,
      category: 'video',
      label: name.trim(),
    } });

    bumpVersion(v => v + 1);

    trace.action('create-video-preset:created', {
      name: tokenName,
      urlLength: url.length,
    });

    onCreated?.();
  }, [name, url, bumpVersion, onCreated]);

  trace.fn('CreateVideoPresetPanel:render', { name, hasUrl: !!url });

  return (
    <div className="flex flex-col gap-3">
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Preset name"
        className="w-full bg-[var(--grid-line)] border border-[var(--control-border)] focus:border-[var(--border-focus)] rounded-[var(--radius-lg)] px-2.5 py-2 text-xs text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)]"
      />

      {url ? (
        <div className="flex flex-col gap-2">
          <div
            className="w-full h-28 rounded-lg border border-[var(--border-light)] overflow-hidden cursor-pointer hover:opacity-90 transition-opacity bg-black"
            onClick={() => setPickerOpen(true)}
          >
            <video
              src={url}
              muted
              loop
              autoPlay
              playsInline
              preload="metadata"
              className="w-full h-full object-cover pointer-events-none"
            />
          </div>
          <button
            onClick={() => setPickerOpen(true)}
            className="w-full h-7 text-xs bg-[var(--grid-line)] border border-[var(--control-border)] rounded-[var(--radius-lg)] text-[var(--text-primary)] hover:border-[var(--control-border-hover)] transition-colors cursor-pointer"
          >
            Change Video
          </button>
        </div>
      ) : (
        <button
          onClick={() => setPickerOpen(true)}
          className="w-full h-28 rounded-lg border-2 border-dashed border-[var(--control-border)] hover:border-[var(--accent)] text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer flex items-center justify-center gap-1.5"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="23 7 16 12 23 17 23 7" /><rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
          </svg>
          Choose Video
        </button>
      )}

      <button
        onClick={handleCreate}
        disabled={!name.trim() || !url}
        className={`w-full h-8 rounded-[var(--radius-lg)] text-xs font-medium transition-colors ${
          name.trim() && url
            ? 'bg-[var(--accent)] text-white cursor-pointer hover:opacity-90'
            : 'bg-[var(--grid-line)] text-[var(--text-disabled)] cursor-not-allowed'
        }`}
      >
        Create
      </button>

      <VideoSearchModal
        isOpen={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={(picked) => {
          setUrl(picked);
          trace.action('create-video-preset:picked', { urlLength: picked.length });
        }}
      />
    </div>
  );
}

/** Accept either a bare URL or `url(...)` wrapper; return the bare URL. */
function normalizeUrl(value: string | undefined): string {
  if (!value) return '';
  const m = value.match(/url\(\s*['"]?([^'")]+)['"]?\s*\)/);
  return m ? m[1] : value;
}
