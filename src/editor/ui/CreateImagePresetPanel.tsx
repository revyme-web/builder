// CreateImagePresetPanel.tsx — Sliding panel for creating a new image preset.
// Pushed via ToolPopup.pushPanel from Image preset grid's "Create new image preset" button.
// Features: name input, current thumbnail preview, ImageSearchModal picker, Create button.

import { useState, useCallback } from 'react';
import { useSetAtom } from 'jotai';
import ImageSearchModal from './ImageSearchModal';
import { queueMutation } from '@/code/mutation/mutation-queue';
import { projectVersionAtom } from '@/code/project/project-fs';
import { trace } from '@/shared/debug-trace';

interface Props {
  /** Initial url(...) value from the caller (e.g. the image currently in backgroundImage) */
  initialValue?: string;
  /** Called after preset is created (to close the panel, etc.) */
  onCreated?: () => void;
}

export default function CreateImagePresetPanel({ initialValue, onCreated }: Props) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState(() => extractUrl(initialValue) ?? '');
  const [pickerOpen, setPickerOpen] = useState(false);

  const bumpVersion = useSetAtom(projectVersionAtom);

  const handleCreate = useCallback(() => {
    if (!name.trim() || !url) return;

    const tokenName = 'image-' + name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');

    queueMutation({ type: 'addPresetToken', token: {
      name: tokenName,
      value: `url(${url})`,
      category: 'image',
      label: name.trim(),
    } });

    bumpVersion(v => v + 1);

    trace.action('create-image-preset:created', {
      name: tokenName,
      urlLength: url.length,
    });

    onCreated?.();
  }, [name, url, bumpVersion, onCreated]);

  trace.fn('CreateImagePresetPanel:render', { name, hasUrl: !!url });

  return (
    <div className="flex flex-col gap-3">
      {/* Name input */}
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Preset name"
        className="w-full bg-[var(--grid-line)] border border-[var(--control-border)] focus:border-[var(--border-focus)] cut-corners cut-border focus:[--cut-border-color:var(--border-focus)] px-2.5 py-2 text-xs text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)]"
      />

      {/* Thumbnail preview / picker entry */}
      {url ? (
        <div className="flex flex-col gap-2">
          <div
            className="w-full h-28 cut-corners cut-border [--cut-border-color:var(--border-light)] border border-[var(--border-light)] overflow-hidden cursor-pointer hover:opacity-90 transition-opacity"
            onClick={() => setPickerOpen(true)}
            style={{
              backgroundImage: `url(${url})`,
              backgroundSize: 'cover',
              backgroundPosition: 'center',
            }}
          />
          <button
            onClick={() => setPickerOpen(true)}
            className="w-full h-[var(--control-height-sm)] text-xs bg-[var(--grid-line)] border border-[var(--control-border)] cut-corners cut-border hover:[--cut-border-color:var(--control-border-hover)] text-[var(--text-primary)] hover:border-[var(--control-border-hover)] transition-colors cursor-pointer"
          >
            Change Image
          </button>
        </div>
      ) : (
        <button
          onClick={() => setPickerOpen(true)}
          className="w-full h-28 cut-corners border-2 border-dashed border-[var(--control-border)] hover:border-[var(--accent)] text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer flex items-center justify-center gap-1.5"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>
          </svg>
          Choose Image
        </button>
      )}

      {/* Create */}
      <button
        onClick={handleCreate}
        disabled={!name.trim() || !url}
        className={`w-full h-[var(--control-height)] cut-corners text-xs font-medium transition-colors ${
          name.trim() && url
            ? 'bg-[var(--accent)] text-[var(--accent-fg)] cursor-pointer hover:opacity-90'
            : 'bg-[var(--grid-line)] text-[var(--text-disabled)] cursor-not-allowed'
        }`}
      >
        Create
      </button>

      <ImageSearchModal
        isOpen={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={(picked) => {
          setUrl(picked);
          trace.action('create-image-preset:picked', { urlLength: picked.length });
        }}
      />
    </div>
  );
}

/** Pull the inner URL out of `url(...)` (handles single/double/no quotes). */
function extractUrl(value: string | undefined): string | null {
  if (!value) return null;
  const m = value.match(/url\(\s*['"]?([^'")]+)['"]?\s*\)/);
  return m ? m[1] : null;
}
