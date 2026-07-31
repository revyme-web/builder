// ColorPresetEditPanel.tsx — Shared color-preset editor used by every place
// that pushes an "Edit color preset" sliding panel: the row picker
// (ColorInput → ColorPicker → preset Edit hover button), the gradient stop
// picker (GradientEditor), and the Fill control's color tab. Previously
// duplicated as `PresetEditPanel` in ColorInput.tsx and
// `PresetEditPanelInline` in FillControl.tsx — those copies drifted apart;
// this is the single source.
//
// UX:
//   - Light/Dark toggle at the top (sun/moon icons).
//   - Color picker below — edits the active theme's value.
//   - Light edits stream via the caller's `onUpdate` (writes the token
//     value); Dark edits go straight to a `setDarkTokenValue` mutation.
//   - 300ms debounced project-version bump so other consumers refresh.
//   - On unmount, an immediate version bump flushes pending state.
//
// External consumers should mount this inside a parent ToolPopup via
// `pushPanel(...)` so the slide-back chevron returns to the picker.

import { useState, useRef, useCallback, useEffect } from 'react';
import { useDebouncedCallback } from '@/editor/hooks/useDebouncedCallback';
import { useAtomValue, useSetAtom } from 'jotai';
import ColorPicker from './ColorPicker';
import ToolSegmentedControl from '../controls/ToolSegmentedControl';
import { getDarkTokenValue, getPresetTokens } from '@/code/project/preset-ops';
import { queueMutation } from '@/code/mutation/mutation-queue';
import { getCanvasBridge } from '@/canvas/canvas-bridge';
import { projectVersionAtom } from '@/code/project/project-fs';
import { livePresetTokenAtom } from '@/code/stores/preset-store';
import { PresetSunIcon, PresetMoonIcon } from '@/shared/icons';
import { trace } from '@/shared/debug-trace';

interface ColorPresetEditPanelProps {
  /** Token name without the leading `--` (e.g. `color-brand`). */
  presetName: string;
  /** Light-mode value the panel opens with. */
  initialValue: string;
  /**
   * Called for every LIGHT-mode change. Implementations typically write the
   * token value (canvas-side fast path + queued mutation). Dark-mode changes
   * are routed directly to `setDarkTokenValue` — they never hit `onUpdate`.
   */
  onUpdate: (value: string) => void;
}

export default function ColorPresetEditPanel({
  presetName,
  initialValue,
  onUpdate,
}: ColorPresetEditPanelProps) {
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [lightVal, setLightVal] = useState(initialValue);
  const [darkVal, setDarkVal] = useState(() => getDarkTokenValue(presetName) || initialValue);
  const bumpVersion = useSetAtom(projectVersionAtom);
  const version = useAtomValue(projectVersionAtom);
  const setLivePreset = useSetAtom(livePresetTokenAtom);
  // Debounced version bump — the single tokens.css write happens on commit;
  // the version fan-out is deferred so drags stay smooth.
  const debouncedBump = useDebouncedCallback(() => bumpVersion(v => v + 1), 300);

  // Clear the live editor-swatch override once a commit re-derives the tokens
  // (version bump). Flicker-free: by then the committed value == the override.
  useEffect(() => { setLivePreset(null); }, [version, setLivePreset]);

  // Sync local state when the token changes externally (undo/redo / another
  // edit panel in a different surface).
  const lastVersionRef = useRef(version);
  if (version !== lastVersionRef.current) {
    lastVersionRef.current = version;
    const tokens = getPresetTokens();
    const token = tokens.find(t => t.name === presetName);
    if (token && token.value !== lightVal) setLightVal(token.value);
    const freshDark = getDarkTokenValue(presetName);
    const expectedDark = freshDark ?? (token?.value ?? lightVal);
    if (expectedDark !== darkVal) setDarkVal(expectedDark);
  }

  const activeVal = theme === 'light' ? lightVal : darkVal;
  trace.fn('ColorPresetEditPanel:render', { presetName, version, lightVal, darkVal, activeVal });

  // Flush pending state on unmount.
  useEffect(() => {
    return () => {
      debouncedBump.cancel();
      bumpVersion(v => v + 1);
      setLivePreset(null);
    };
  }, [bumpVersion, setLivePreset, debouncedBump]);

  // LIVE — fires EVERY drag frame. Local state + (light mode) a cheap canvas
  // token preview via the bridge. NO `queueMutation` (no tokens.css write) and
  // NO version bump per frame — that was the low-FPS path + caused the version
  // re-read to clobber the in-progress drag. The single tokens.css write
  // happens in `handleCommit` on release.
  const handleChange = useCallback((newVal: string) => {
    if (theme === 'dark') {
      setDarkVal(newVal); // dark value previews on commit (the canvas is usually in light mode)
    } else {
      setLightVal(newVal);
      const bridge = getCanvasBridge() as any;
      if (typeof bridge?.setCanvasTokenVar === 'function') bridge.setCanvasTokenVar(presetName, newVal);
      // Mirror to the React-rendered editor swatches (presets panel + Fill row).
      setLivePreset({ name: presetName, value: newVal });
    }
  }, [theme, presetName, setLivePreset]);

  // COMMIT — fires once on pointer release (and immediately for one-shot edits:
  // hex input, eyedropper). The ONLY write to tokens.css. The version bump
  // stays debounced so it lands AFTER the queued write settles (re-reading the
  // token earlier would set stale local state).
  const handleCommit = useCallback((finalVal: string) => {
    if (theme === 'dark') {
      queueMutation({ type: 'setDarkTokenValue', tokenName: presetName, darkValue: finalVal });
    } else {
      onUpdate(finalVal); // bridge token preview + queueMutation(updatePresetToken)
    }
    debouncedBump.call();
  }, [theme, presetName, onUpdate, debouncedBump]);

  return (
    <div className="flex flex-col gap-3">
      <ToolSegmentedControl
        value={theme}
        onChange={(v) => setTheme(v as 'light' | 'dark')}
        options={[
          { value: 'light', icon: <PresetSunIcon /> },
          { value: 'dark', icon: <PresetMoonIcon /> },
        ]}
        size="sm"
      />
      {/* `key={theme}` resets the picker's internal HSV/hue state on theme
          flip so the wheel jumps to the new active value instead of
          interpolating from the previous theme's color. */}
      <ColorPicker key={theme} value={activeVal} onChange={handleChange} onChangeEnd={handleCommit} showAlpha />
    </div>
  );
}
