// EditPopupContent — the edit-preset dialog body (color/typography/asset/
// border/etc). AssetValueEditor and BorderPresetEditor are sub-editors
// for the asset (image/video) and border categories respectively.

import React, { useState, useRef, useCallback, useEffect } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { projectVersionAtom } from '@/code/project/project-fs';
import { livePresetTokenAtom } from '@/code/stores/preset-store';
import { getDarkTokenValue } from '@/code/project/preset-ops';
import { queueMutation } from '@/code/mutation/mutation-queue';
import { getCanvasBridge } from '@/canvas/canvas-bridge';
import { PresetSunIcon, PresetMoonIcon } from '@/shared/icons';
import type { PresetToken } from '@/shared/types';
import ColorPicker from '@/editor/ui/ColorPicker';
import ImageSearchModal from '@/editor/ui/ImageSearchModal';
import VideoSearchModal from '@/editor/ui/VideoSearchModal';
import ToolInput from '@/editor/controls/ToolInput';
import ToolSelect from '@/editor/controls/ToolSelect';
import ToolSegmentedControl from '@/editor/controls/ToolSegmentedControl';
import { ShadowControl } from '@/editor/tools/StylesTool/atoms/ShadowControl';
import { parseBorderShorthand, formatBorderShorthand, type BorderSide } from '@/editor/ui/border-utils';
import ColorInput from '@/editor/controls/ColorInput';
import ControlLabel from '@/editor/controls/ControlLabel';
import SpacingControl from '@/editor/controls/SpacingControl';
import { parseShorthand } from '@/shared/css-utils';
import { trace } from '@/shared/debug-trace';
import { extractAssetUrl, formatShorthand } from '../shared/format-utils';

// ─── Border Preset Editor (width + style + color → shorthand) ──────────────

const BORDER_STYLE_OPTIONS = [
  { value: 'solid', label: 'Solid' },
  { value: 'dashed', label: 'Dashed' },
  { value: 'dotted', label: 'Dotted' },
  { value: 'double', label: 'Double' },
  { value: 'groove', label: 'Groove' },
  { value: 'ridge', label: 'Ridge' },
  { value: 'inset', label: 'Inset' },
  { value: 'outset', label: 'Outset' },
];

/**
 * Edit a border preset value (CSS shorthand `<width> <style> <color>`).
 * Three rows: width input, style select, color picker. Writes the canonical
 * shorthand string. The full canvas BorderControl handles per-side borders,
 * gradient borders, and ::after overlays — none of which apply to a single
 * stored preset value.
 */
export function BorderPresetEditor({ value, onChange, onChangeLive }: { value: string; onChange: (v: string) => void; onChangeLive?: (v: string) => void }) {
  const side: BorderSide = parseBorderShorthand(value || '1px solid #000000');
  const buildNext = (patch: Partial<BorderSide>): BorderSide => {
    const next: BorderSide = { ...side, ...patch };
    if (next.width > 0 && (next.style === 'none' || !next.style)) next.style = 'solid';
    return next;
  };
  const update = (patch: Partial<BorderSide>) => onChange(formatBorderShorthand(buildNext(patch)));
  // Per-frame color-picker drag → live canvas paint only (no tokens.css write).
  const updateLive = (patch: Partial<BorderSide>) => onChangeLive?.(formatBorderShorthand(buildNext(patch)));
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Width" property="borderWidth" plain />
        <ToolInput
          value={`${side.width}px`}
          onChange={(v) => update({ width: parseInt(v) || 0 })}
          step={1}
        />
      </div>
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Style" property="borderStyle" plain />
        <ToolSelect
          value={side.style || 'solid'}
          onChange={(v) => update({ style: v })}
          options={BORDER_STYLE_OPTIONS}
        />
      </div>
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Color" property="borderColor" plain />
        <ColorInput
          value={side.color}
          onChange={(v) => update({ color: v })}
          onChangeLive={onChangeLive ? (v) => updateLive({ color: v }) : undefined}
          showAlpha
        />
      </div>
    </div>
  );
}

// ─── Asset Value Editor (image/video preview + picker) ─────────────────────

export function AssetValueEditor({ value, type, onChange }: {
  value: string;
  type: 'image' | 'video';
  onChange: (newValue: string) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const url = extractAssetUrl(value);

  const handlePicked = useCallback((picked: string) => {
    // Image presets serialize as `url(...)` (consumed by backgroundImage CSS);
    // video presets are stored bare (consumed by runtime <video src>).
    const stored = type === 'image' ? `url(${picked})` : picked;
    onChange(stored);
  }, [type, onChange]);

  return (
    <div className="flex flex-col gap-2">
      {url ? (
        <div
          className="w-full h-28 rounded-lg border border-[var(--border-light)] overflow-hidden cursor-pointer hover:opacity-90 transition-opacity bg-[var(--grid-line)]"
          onClick={() => setPickerOpen(true)}
        >
          {type === 'image' ? (
            <div
              className="w-full h-full"
              style={{ backgroundImage: `url(${url})`, backgroundSize: 'cover', backgroundPosition: 'center' }}
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
      {url && (
        <button
          onClick={() => setPickerOpen(true)}
          className="w-full h-[var(--control-height-sm)] text-xs bg-[var(--grid-line)] border border-[var(--control-border)] rounded-[var(--radius-lg)] text-[var(--text-primary)] hover:border-[var(--control-border-hover)] transition-colors cursor-pointer"
        >
          Change {type === 'image' ? 'Image' : 'Video'}
        </button>
      )}

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

// ─── Edit Popup Content ─────────────────────────────────────────────────────

interface EditPopupContentProps {
  token: PresetToken;
  onUpdate: (name: string, value: string) => void;
  onDelete: (name: string) => void;
  onClose: () => void;
}

export function EditPopupContent({ token, onUpdate, onDelete, onClose }: EditPopupContentProps) {
  const [value, setValue] = useState(token.value);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [darkValue, setDarkValue] = useState(() => getDarkTokenValue(token.name) || token.value);
  const version = useAtomValue(projectVersionAtom);
  const setLivePreset = useSetAtom(livePresetTokenAtom);

  // Clear the live preset override once a commit lands (any version bump
  // re-derives presetTokensAtom, so the swatches read the real value now) and
  // on unmount (popup closed without committing). Flicker-free: the override's
  // value equals the just-committed value at that point. The override is set
  // per-frame in handleColorLive (light theme only — that's what the panel
  // swatches show).
  useEffect(() => { setLivePreset(null); }, [version, setLivePreset]);
  useEffect(() => () => setLivePreset(null), [setLivePreset]);

  // Sync local state when token changes externally (undo/redo).
  // Use version as trigger — covers both light and dark value changes.
  const lastVersionRef = useRef(version);
  const lastExternalRef = useRef(token.value);
  if (version !== lastVersionRef.current) {
    lastVersionRef.current = version;
    // Sync light value
    if (token.value !== lastExternalRef.current) {
      lastExternalRef.current = token.value;
      if (token.value !== value) {
        setValue(token.value);
      }
    }
    // Sync dark value (null means no dark override — fall back to light value)
    const freshDark = getDarkTokenValue(token.name);
    const expectedDark = freshDark ?? token.value;
    if (expectedDark !== darkValue) {
      setDarkValue(expectedDark);
    }
  }

  const activeValue = token.category === 'color' ? (theme === 'light' ? value : darkValue) : value;

  const handleValueChange = useCallback((newValue: string) => {
    lastExternalRef.current = newValue;
    if (token.category === 'color' && theme === 'dark') {
      setDarkValue(newValue);
      queueMutation({ type: 'setDarkTokenValue', tokenName: token.name, darkValue: newValue });
      trace.action('preset-edit:dark-value-change', { name: token.name, value: newValue });
    } else {
      setValue(newValue);
      onUpdate(token.name, newValue);
      trace.action('preset-edit:value-change', { name: token.name, value: newValue });
    }
  }, [token.name, theme, token.category, onUpdate]);

  // COLOR picker only — split live (every frame, cheap canvas preview, NO
  // tokens.css write) from commit (release / one-shot → the only code write).
  // Other categories keep `handleValueChange` (not drag-heavy color scrubs).
  const handleColorLive = useCallback((newValue: string) => {
    lastExternalRef.current = newValue;
    if (theme === 'dark') {
      setDarkValue(newValue); // previews on commit (canvas is usually light)
    } else {
      setValue(newValue);
      const bridge = getCanvasBridge() as any;
      if (typeof bridge?.setCanvasTokenVar === 'function') bridge.setCanvasTokenVar(token.name, newValue);
      // Mirror to the editor swatches (presets panel + Fill row) in real time.
      setLivePreset({ name: token.name, value: newValue });
    }
  }, [token.name, theme, setLivePreset]);
  const handleColorCommit = useCallback((finalValue: string) => {
    lastExternalRef.current = finalValue;
    if (theme === 'dark') {
      queueMutation({ type: 'setDarkTokenValue', tokenName: token.name, darkValue: finalValue });
      trace.action('preset-edit:dark-value-change', { name: token.name, value: finalValue });
    } else {
      onUpdate(token.name, finalValue);
      trace.action('preset-edit:value-change', { name: token.name, value: finalValue });
    }
  }, [token.name, theme, onUpdate]);

  const handleDelete = useCallback(() => {
    trace.action('preset-edit:delete', { name: token.name });
    onDelete(token.name);
    onClose();
  }, [token.name, onDelete, onClose]);

  return (
    <div className="flex flex-col gap-3">
      {/* Light/Dark tabs for color presets */}
      {token.category === 'color' && (
        <ToolSegmentedControl
          value={theme}
          onChange={(v) => setTheme(v as 'light' | 'dark')}
          options={[
            { value: 'light', icon: <PresetSunIcon /> },
            { value: 'dark', icon: <PresetMoonIcon /> },
          ]}
          size="sm"
        />
      )}

      {/* Value editor — category-specific control only */}
      {token.category === 'color' ? (
        <ColorPicker key={theme} value={activeValue} onChange={handleColorLive} onChangeEnd={handleColorCommit} />
      ) : token.category === 'image' ? (
        <AssetValueEditor value={value} type="image" onChange={handleValueChange} />
      ) : token.category === 'video' ? (
        <AssetValueEditor value={value} type="video" onChange={handleValueChange} />
      ) : token.category === 'radius' ? (
        <SpacingControl
          values={[value, value, value, value] as [string, string, string, string]}
          labels={['TL', 'TR', 'BR', 'BL']}
          onChange={(_, val) => handleValueChange(val)}
          onChangeAll={handleValueChange}
        />
      ) : token.category === 'spacing' || token.category === 'margin' ? (
        (() => {
          // Padding & Margin support full 4-side shorthand. Parse the stored
          // value into [T, R, B, L] and write back the shortest canonical form.
          const sides = parseShorthand(value);
          return (
            <SpacingControl
              values={sides}
              labels={['T', 'R', 'B', 'L']}
              onChange={(idx, val) => {
                const next: [string, string, string, string] = [...sides];
                next[idx] = val;
                handleValueChange(formatShorthand(next));
              }}
              onChangeAll={handleValueChange}
            />
          );
        })()
      ) : token.category === 'shadow' ? (
        <ShadowControl
          mode="preset"
          externalValue={value}
          externalOnChange={handleValueChange}
        />
      ) : token.category === 'border' ? (
        <BorderPresetEditor
          value={value}
          onChange={handleValueChange}
          onChangeLive={(v) => {
            // Live preview: paint the border-shorthand CSS var on the canvas
            // (every `var(--name)` consumer repaints) without a tokens.css
            // write. The commit lands once on release via handleValueChange.
            setValue(v);
            const bridge = getCanvasBridge() as any;
            if (typeof bridge?.setCanvasTokenVar === 'function') bridge.setCanvasTokenVar(token.name, v);
          }}
        />
      ) : (
        /* typography + fallback */
        <ToolInput value={value} onChange={handleValueChange} />
      )}

    </div>
  );
}
