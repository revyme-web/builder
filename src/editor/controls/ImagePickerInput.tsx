// ImagePickerInput.tsx — Reusable image-picker input row.
//
// Shows a small thumbnail + URL chip (truncated) + ×, click anywhere on the
// row opens the existing `ImageSearchModal` (Unsplash + upload + URL paste).
// On select, wraps the chosen URL in `url(...)` so the value drops straight
// into a CSS `backgroundImage:` slot (or any other image-bearing property)
// without runtime wrapping.
//
// Used by:
//   - PageVariablesModal — default-value editor for `image` variables
//   - InteractionsTool   — Set Variable form's value control on `image` vars
//
// Why centralise this? Both call sites need the same behaviour (show
// thumbnail, swap via picker, clear via ×) and divergence between them
// would be a paper-cut whenever the picker UX changes.

import { useState, useCallback } from 'react';
import ImageSearchModal from '../ui/ImageSearchModal';
import { trace } from '@/shared/debug-trace';

interface ImagePickerInputProps {
  /** CSS image value — e.g. `url(https://...)` or empty. */
  value: string;
  onChange: (value: string) => void;
  /** Optional placeholder text shown when no image is set. */
  placeholder?: string;
}

/** Pull URL out of `url(...)` wrapper (handles single/double/no quotes). */
function extractUrl(value: string): string | null {
  const m = value.match(/url\(\s*['"]?([^'")]+)['"]?\s*\)/);
  return m ? m[1] : null;
}

export default function ImagePickerInput({
  value,
  onChange,
  placeholder = 'Choose image…',
}: ImagePickerInputProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const url = extractUrl(value) ?? (value.startsWith('http') ? value : '');
  const hasImage = url.length > 0;

  const handleSelect = useCallback((picked: string) => {
    // Always store as a CSS-ready value so the generated JSX doesn't need a
    // runtime wrap layer. ImageSearchModal hands us the bare URL.
    onChange(`url(${picked})`);
    trace.action('image-picker-input:select', { url: picked.slice(0, 80) });
  }, [onChange]);

  const handleClear = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onChange('');
    trace.action('image-picker-input:clear');
  }, [onChange]);

  return (
    <>
      <button
        type="button"
        onClick={() => setPickerOpen(true)}
        className="w-full h-8 flex items-center gap-2 px-1.5 bg-[var(--grid-line)] border border-[var(--control-border)] rounded-[var(--radius-lg)] hover:border-[var(--border-focus)] transition-colors cursor-pointer text-left"
        title={hasImage ? url : placeholder}
      >
        {/* Thumbnail (or placeholder square when empty) */}
        <span
          className="w-5 h-5 rounded shrink-0 border border-[var(--border-light)]"
          style={
            hasImage
              ? { backgroundImage: `url(${url})`, backgroundSize: 'cover', backgroundPosition: 'center' }
              : { backgroundColor: 'var(--bg-hover)' }
          }
        />
        {/* URL/label chip */}
        <span className="flex-1 text-xs text-[var(--text-primary)] truncate">
          {hasImage ? url : <span className="text-[var(--text-disabled)]">{placeholder}</span>}
        </span>
        {/* Clear */}
        {hasImage && (
          <span
            role="button"
            tabIndex={0}
            onClick={handleClear}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleClear(e as any); }}
            className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] text-sm leading-none shrink-0 cursor-pointer px-1"
            title="Clear image"
          >
            ×
          </span>
        )}
      </button>

      <ImageSearchModal
        isOpen={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={(picked) => {
          handleSelect(picked);
          setPickerOpen(false);
        }}
      />
    </>
  );
}
