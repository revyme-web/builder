// ImageListControl.tsx — an ORDERED LIST of images for code-component
// @controls (control type "imageList"). The panel row shows a preview swatch +
// count and opens a ToolPopup with one sub-row per image (thumbnail, index,
// reorder, remove) plus an "Add image" row that opens the NATIVE media picker
// (ImageSearchModal — the same Unsplash/upload/URL modal the Fill tool uses)
// and APPENDS the chosen image. Value is the same pipe-separated URL string
// convention the multi `upload` control uses ("a|b|c" — JSX-attribute-safe,
// no quotes), so components parse it identically.

import { useRef, useState } from 'react';
import { ToolRow } from '../controls';
import ToolPopup from '../ui/ToolPopup';
import ImageSearchModal from '../ui/ImageSearchModal';
import { ControlActionRow } from '../controls/ControlActionRow';
import { RemoveButton } from '../controls/RemoveButton';
import { ColorSwatch } from '../controls/ColorSwatch';
import { trace } from '@/shared/debug-trace';

interface ImageListControlProps {
  label: string;
  /** Pipe-separated URLs ('a|b|c'), '' for empty. */
  value: string;
  onChange: (value: string) => void;
  /** Accepted for control-def compat; the native picker manages its own upload target. */
  uploadSource?: string;
}

const parseUrls = (v: string): string[] => (v ? v.split('|').filter(Boolean) : []);

export default function ImageListControl({ label, value, onChange }: ImageListControlProps) {
  const [open, setOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const urls = parseUrls(value);

  const commit = (next: string[]) => {
    trace.action('image-list:commit', { count: next.length });
    onChange(next.join('|'));
  };

  const move = (idx: number, dir: -1 | 1) => {
    const next = [...urls];
    const to = idx + dir;
    if (to < 0 || to >= next.length) return;
    const [item] = next.splice(idx, 1);
    next.splice(to, 0, item);
    commit(next);
  };

  const remove = (idx: number) => {
    const next = urls.filter((_, i) => i !== idx);
    commit(next);
  };

  return (
    <ToolRow label={label}>
      <button
        ref={btnRef}
        onClick={() => setOpen((o) => !o)}
        className="w-full h-[var(--control-height-sm)] px-1 flex items-center gap-2 text-xs rounded-md bg-[var(--control-bg)] border border-[var(--control-border)] hover:border-[var(--control-border-hover)] text-[var(--text-primary)] transition-colors min-w-0 overflow-hidden"
      >
        <ColorSwatch
          style={urls[0]
            ? { backgroundColor: '#ffffff', backgroundImage: `url("${urls[0]}")`, backgroundSize: 'cover', backgroundPosition: 'center' }
            : { backgroundColor: 'var(--grid-line)' }}
        />
        <span className="flex-1 text-left text-[var(--text-tertiary)] truncate">
          {urls.length === 0 ? 'No images' : `${urls.length} image${urls.length === 1 ? '' : 's'}`}
        </span>
      </button>

      <ToolPopup isOpen={open} onClose={() => setOpen(false)} title={label} anchorRef={btnRef}>
        {urls.map((url, idx) => (
          <div key={`${url}-${idx}`} className="flex items-center gap-2 min-w-0">
            <div
              className="w-8 h-[var(--control-height)] rounded-md border border-[var(--control-border)] flex-shrink-0"
              style={{ backgroundColor: '#ffffff', backgroundImage: `url("${url}")`, backgroundSize: 'cover', backgroundPosition: 'center' }}
            />
            <span className="flex-1 text-xs text-[var(--text-secondary)] truncate">Image {idx + 1}</span>
            <button
              onClick={() => move(idx, -1)}
              disabled={idx === 0}
              className="w-5 h-5 flex items-center justify-center rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] disabled:opacity-30"
              title="Move up"
            >↑</button>
            <button
              onClick={() => move(idx, 1)}
              disabled={idx === urls.length - 1}
              className="w-5 h-5 flex items-center justify-center rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] disabled:opacity-30"
              title="Move down"
            >↓</button>
            <RemoveButton onClick={() => remove(idx)} />
          </div>
        ))}
        <ControlActionRow onClick={() => setPickerOpen(true)} center>
          + Add image
        </ControlActionRow>
      </ToolPopup>

      {/* Native media picker — the same Unsplash / upload / URL modal the
          Fill tool opens. Self-closes on select; each pick APPENDS. */}
      <ImageSearchModal
        isOpen={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={(url) => {
          commit([...urls, url]);
          trace.action('image-list:picked', { url: url.slice(0, 80) });
        }}
      />
    </ToolRow>
  );
}
