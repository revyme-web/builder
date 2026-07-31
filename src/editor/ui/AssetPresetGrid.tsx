// AssetPresetGrid.tsx — Reusable preset list for image/video presets.
// Identical row layout to the color preset list inside ColorPicker.tsx —
// "Create new ..." row at top, then one row per preset with: name on the
// left (flex-1), Edit button hover-revealed in the middle, small thumbnail
// (w-5 h-5) on the right, active state = bg-hover.

import type { PresetToken } from '@/shared/types';
import { trace } from '@/shared/debug-trace';

interface Props {
  /** Preset tokens to render. Caller filters by category before passing. */
  presets: PresetToken[];
  /** Tile media type — picks the renderer (image bg vs <video>). */
  type: 'image' | 'video';
  /** Click handler — applies a preset reference (`var(--name)`). Required. */
  onApplyPreset: (varValue: string) => void;
  /** Optional: open the create-new-preset panel. Hidden when omitted. */
  onCreatePreset?: () => void;
  /** Optional: open the edit-existing-preset panel. Hidden when omitted. */
  onEditPreset?: (name: string) => void;
  /** Token name (without `--`) of the currently-applied preset, for highlighting. */
  activePresetName?: string;
}

export default function AssetPresetGrid({
  presets,
  type,
  onApplyPreset,
  onCreatePreset,
  onEditPreset,
  activePresetName,
}: Props) {
  trace.fn('AssetPresetGrid:render', { type, count: presets.length, activePresetName });

  const hasContent = presets.length > 0 || !!onCreatePreset;
  if (!hasContent) return null;

  return (
    <div className="mt-3 border-t border-[var(--border-light)] pt-2">
      {/* Create-new row — same shape as color picker */}
      {onCreatePreset && (
        <button
          type="button"
          onClick={() => {
            trace.action('asset-preset-grid:create-click', { type });
            onCreatePreset();
          }}
          className="w-full flex items-center justify-between px-1 py-1.5 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] rounded-[var(--radius-md)] cursor-pointer transition-colors"
        >
          <span>Create new {type} preset</span>
          <PlusIcon />
        </button>
      )}

      {/* Preset rows — name on left, edit-on-hover, swatch on right */}
      {presets.length > 0 && (
        <div className="flex flex-col max-h-[200px] overflow-y-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
          {presets.map(preset => {
            const displayName = formatName(preset, type);
            const url = extractUrl(preset.value);
            const isActive = activePresetName === preset.name;
            return (
              <div
                key={preset.name}
                className={`group flex items-center gap-2 px-1 py-1.5 rounded-[var(--radius-md)] cursor-pointer transition-colors ${
                  isActive ? 'bg-[var(--bg-hover)]' : 'hover:bg-[var(--bg-hover)]'
                }`}
                onClick={() => {
                  trace.action('asset-preset-grid:apply', { type, name: preset.name });
                  onApplyPreset(`var(--${preset.name})`);
                }}
              >
                <span className={`flex-1 text-xs font-medium truncate ${
                  isActive ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'
                }`}>
                  {displayName}
                </span>
                {onEditPreset && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      trace.action('asset-preset-grid:edit-click', { type, name: preset.name });
                      onEditPreset(preset.name);
                    }}
                    className="opacity-0 group-hover:opacity-100 text-[10px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] bg-[var(--grid-line)] border border-[var(--control-border)] rounded px-2 py-0.5 transition-all cursor-pointer"
                  >
                    Edit
                  </button>
                )}
                {/* Thumbnail swatch — same w-5 h-5 footprint as the color
                    swatch, image bg or muted-loop <video> for the media. */}
                {type === 'image' ? (
                  <div
                    className="w-5 h-5 rounded-md border border-white/10 flex-shrink-0 bg-[var(--grid-line)]"
                    style={url ? { backgroundImage: `url(${url})`, backgroundSize: 'cover', backgroundPosition: 'center' } : undefined}
                  />
                ) : (
                  <div className="w-5 h-5 rounded-md border border-white/10 flex-shrink-0 bg-black overflow-hidden flex items-center justify-center">
                    {url ? (
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="white"><polygon points="5,3 19,12 5,21" /></svg>
                    ) : null}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Pull URL out of `url(...)` wrapper, or return the value as-is if already bare. */
function extractUrl(value: string): string | null {
  const m = value.match(/url\(\s*['"]?([^'")]+)['"]?\s*\)/);
  if (m) return m[1];
  if (/^https?:\/\//i.test(value) || value.startsWith('/')) return value;
  return null;
}

/** Token → human-readable display name. Mirrors color preset formatting. */
function formatName(preset: PresetToken, type: 'image' | 'video'): string {
  if (preset.label) return preset.label;
  const prefix = type === 'image' ? 'image-' : 'video-';
  return preset.name
    .replace(new RegExp('^' + prefix), '')
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function PlusIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}
