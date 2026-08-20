// ImageListControl.tsx — an ORDERED LIST of images for code-component
// @controls (control type "imageList"). The panel row shows a preview swatch +
// count and opens a ToolPopup with one sub-row per image (thumbnail, index,
// reorder, remove) plus an "Add image" row. Both the "Add image" row and each
// EXISTING row's thumbnail/label open the NATIVE media picker
// (ImageSearchModal — the same Unsplash/upload/URL modal the Fill tool uses):
// Add APPENDS the chosen image, a row click REPLACES that row's image in
// place. Value is the same pipe-separated URL string convention the multi
// `upload` control uses ("a|b|c" — JSX-attribute-safe, no quotes), so
// components parse it identically.

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
  /** Who the native picker is choosing for: 'append' = the Add-image row,
   *  a number = replace THAT row's image in place, null = closed. */
  const [pickerFor, setPickerFor] = useState<number | 'append' | null>(null);
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
        className="w-full h-[var(--control-height-sm)] px-1 flex items-center gap-2 text-xs cut-corners cut-border hover:[--cut-border-color:var(--control-border-hover)] bg-[var(--control-bg)] border border-[var(--control-border)] hover:border-[var(--control-border-hover)] text-[var(--text-primary)] transition-colors min-w-0 overflow-hidden"
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
            {/* Thumbnail + label = a REPLACE button: opens the same native
                picker and swaps this row's image in place (reorder/remove
                stay separate targets to the right). */}
            <button
              onClick={() => setPickerFor(idx)}
              className="flex-1 flex items-center gap-2 min-w-0 group cursor-pointer"
              title="Replace image"
            >
              <div
                className="w-8 h-[var(--control-height)] cut-corners cut-border hover:[--cut-border-color:var(--control-border-hover)] border border-[var(--control-border)] group-hover:border-[var(--control-border-hover)] flex-shrink-0 transition-colors"
                style={{ backgroundColor: '#ffffff', backgroundImage: `url("${url}")`, backgroundSize: 'cover', backgroundPosition: 'center' }}
              />
              <span className="flex-1 text-left text-xs text-[var(--text-secondary)] group-hover:text-[var(--text-primary)] truncate transition-colors">Image {idx + 1}</span>
            </button>
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
        <ControlActionRow onClick={() => setPickerFor('append')} center>
          + Add image
        </ControlActionRow>
      </ToolPopup>

      {/* Native media picker — the same Unsplash / upload / URL modal the
          Fill tool opens. Self-closes on select; a pick APPENDS ('append')
          or REPLACES the clicked row's image (numeric pickerFor). */}
      <ImageSearchModal
        isOpen={pickerFor !== null}
        onClose={() => setPickerFor(null)}
        onSelect={(url) => {
          if (typeof pickerFor === 'number') {
            const next = [...urls];
            next[pickerFor] = url;
            commit(next);
            trace.action('image-list:replaced', { idx: pickerFor, url: url.slice(0, 80) });
          } else {
            commit([...urls, url]);
            trace.action('image-list:picked', { url: url.slice(0, 80) });
          }
          setPickerFor(null);
        }}
      />
    </ToolRow>
  );
}
