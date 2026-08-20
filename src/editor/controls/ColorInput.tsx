// ColorInput.tsx — Color swatch + value label as a single button.
// Clicking opens ColorPicker in a ToolPopup (standalone) or pushes a panel (inside ToolPopup).
// The whole thing is one clickable row — swatch square + hex/rgb value text.

import { useState, useRef, useCallback, type CSSProperties } from 'react';
import { useLivePreview } from '../hooks/useLivePreview';
import { useAtomValue } from 'jotai';
import ToolPopup, { useToolPopupOptional, useToolPopup } from '../ui/ToolPopup';
import ColorPicker from '../ui/ColorPicker';
import CreateColorPresetPanel from '../ui/CreateColorPresetPanel';
import ColorPresetEditPanel from '../ui/ColorPresetEditPanel';
import { ColorSwatch } from './ColorSwatch';
import { RemoveButton } from './RemoveButton';
import { presetTokensAtom, livePresetTokenAtom } from '@/code/stores/preset-store';
import { queueMutation, flushNow } from '@/code/mutation/mutation-queue';
import { getCanvasBridge } from '@/canvas/canvas-bridge';
import { toHexDisplay } from '../ui/color-utils';
import { trace } from '@/shared/debug-trace';
import { parseVarRef } from '@/shared/css-utils';

interface ColorInputProps {
  value: string;
  onChange: (color: string) => void;
  /** Optional cheap live-preview callback. When provided, the color picker
   *  routes its per-frame drag updates here and commits to code via
   *  `onChange` only on pointer-up — keeps the picker drag at 60fps. */
  onChangeLive?: (color: string) => void;
  showAlpha?: boolean;
  /** Show only the color swatch square, no hex text */
  swatchOnly?: boolean;
  /** Show a × remove button inside the control. Clicking calls this instead of onChange. */
  onRemove?: () => void;
  /** Multiple selected items hold different colors. Renders the label as
   *  "Mixed" with a checkerboard swatch (design-tool parity) — picking any
   *  color unifies them. `value` is still used as the picker's starting
   *  color when opened. */
  mixed?: boolean;
  /** No color is set at all. Renders the checkerboard swatch and an "Add"
   *  label instead of a color — the same empty state the Styles Fill row uses,
   *  so "no fill" reads as no fill rather than as a real color. `value` is
   *  still the picker's starting color when opened (same contract as `mixed`).
   *  Opt-in: without it a consumer that wants a default color keeps one. */
  empty?: boolean;
}

// Alpha/transparent checkerboard — used for the "Mixed" swatch so it reads
// as "no single color" rather than a misleading solid black square.
const CHECKER_STYLE: CSSProperties = {
  backgroundImage:
    'linear-gradient(45deg, #888 25%, transparent 25%), linear-gradient(-45deg, #888 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #888 75%), linear-gradient(-45deg, transparent 75%, #888 75%)',
  backgroundSize: '6px 6px',
  backgroundPosition: '0 0, 0 3px, 3px -3px, -3px 0',
};


export default function ColorInput({ value, onChange, onChangeLive, showAlpha, swatchOnly, onRemove, mixed, empty }: ColorInputProps) {
  const popupCtx = useToolPopupOptional();
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const allTokens = useAtomValue(presetTokensAtom);
  const colorPresets = allTokens.filter(t => t.category === 'color');
  const livePreset = useAtomValue(livePresetTokenAtom);

  // Live swatch preview during a picker drag. The per-frame change is a DOM-only
  // patch (`onChangeLive`), so the committed `value` prop stays frozen until
  // release — without this the swatch + hex on THIS button would lag the drag.
  // Cleared once the committed value catches up (the release write), so there's
  // no flicker (the committed value then equals the last dragged color) and a
  // later external change resets it. A per-frame setState on one button is
  // cheap (React render, not a canvas re-render) — the code commit was the cost.
  const [livePreview, setLivePreview] = useLivePreview<string>([value]);

  const isPresetRef = value?.startsWith('var(--color-') ?? false;
  const presetName = isPresetRef ? parseVarRef(value) || '' : '';
  // Live override of THIS preset's value while it's being dragged in its edit
  // popup — so the swatch inside the blue preset pill tracks the edit in real
  // time (the committed token value doesn't change until release).
  const livePresetColor = isPresetRef && livePreset?.name === presetName ? livePreset.value : null;
  const resolvedColor = isPresetRef
    ? (livePresetColor ?? (colorPresets.find(t => t.name === presetName)?.value || '#000000'))
    : value;
  // While dragging, the live raw color overrides the committed value/preset so
  // the swatch + hex track the picker in real time.
  const displayColor = expandHex(livePreview ?? resolvedColor);
  // The button label always shows the HEX equivalent — rgb / rgba / hsl /
  // oklch / named colours are all converted, so the control reads
  // consistently regardless of how the value is authored in code.
  const displayText = toHexDisplay(livePreview ?? value) || '#000000';
  const presetLabel = presetName
    ? presetName.replace(/^color-/, '').split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
    : '';

  const handleCreatePreset = useCallback((color: string) => {
    if (popupCtx) {
      popupCtx.pushPanel('New Color Preset', (
        <CreateColorPresetPanel
          initialColor={color}
          onCreated={() => popupCtx.popPanel()}
        />
      ));
    }
    trace.action('color-input:create-preset-panel', { color });
  }, [popupCtx]);

  const handleEditPreset = useCallback((presetName: string) => {
    if (!popupCtx) return;
    const token = colorPresets.find(t => t.name === presetName);
    if (!token) return;
    const displayName = token.label || presetName.replace(/^color-/, '').split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    popupCtx.pushPanel(`Edit "${displayName}"`, (
      <ColorPresetEditPanel presetName={presetName} initialValue={token.value} onUpdate={(val) => {
        // Live-drag fast path: write the CSS variable directly on the iframe
        // contentRoot. setProperty is O(1) and triggers a repaint next frame
        // for every var(--name) consumer; the persistent mutation flushes
        // via the panel's debounced version bump.
        const bridge = getCanvasBridge() as any;
        if (typeof bridge?.setCanvasTokenVar === 'function') {
          bridge.setCanvasTokenVar(presetName, val);
        }
        queueMutation({ type: 'updatePresetToken', name: presetName, value: val });
      }} />
    ));
    trace.action('color-input:edit-preset-panel', { presetName });
  }, [popupCtx, colorPresets]);

  // One-shot preset click → write + flushNow so the picker's active-preset
  // highlight and the calling row's pill update in the SAME frame. Plain
  // `onChange` (used by the saturation / hue sliders during pointermove)
  // intentionally stays on the RAF + idle path — flushing every frame
  // tanks 60fps drag performance.
  const handleApplyPreset = useCallback((presetVar: string) => {
    onChange(presetVar);
    flushNow();
    trace.action('color-input:apply-preset-flush', { presetVar });
  }, [onChange]);

  // Color-picker callbacks. With a live path, the picker's per-frame drag
  // updates route to the cheap `onChangeLive` (DOM preview) and the code
  // commit fires once via `onChange` on release. Without one, `onChange`
  // handles every frame — the legacy behavior.
  const pickerOnChange = useCallback((c: string) => {
    setLivePreview(c);                 // drive this button's swatch live
    (onChangeLive ?? onChange)(c);     // canvas DOM patch (or legacy per-frame commit)
  }, [onChangeLive, onChange]);
  const pickerOnChangeEnd = onChangeLive ? onChange : undefined;

  // Refs the pushed Color panel reads from on every ToolPopup render.
  // Without these, the pushed `<ColorPicker .../>` JSX is captured at click
  // time — picking a preset writes the new value but the panel keeps
  // showing the OLD `activePresetName` / `value` until the user closes and
  // re-opens. Refs + a render-function in pushPanel keep the picker live.
  const liveValueRef = useRef<string>('#000000');
  const liveOnChangeRef = useRef<(c: string) => void>(pickerOnChange);
  const liveOnChangeEndRef = useRef<((c: string) => void) | undefined>(pickerOnChangeEnd);
  const liveOnApplyPresetRef = useRef<(c: string) => void>(handleApplyPreset);
  const liveActivePresetRef = useRef<string | undefined>(undefined);
  const liveCreatePresetRef = useRef<(color: string) => void>(handleCreatePreset);
  const liveEditPresetRef = useRef<(name: string) => void>(handleEditPreset);
  const liveColorPresetsRef = useRef(colorPresets);
  const liveShowAlphaRef = useRef(showAlpha);
  liveValueRef.current = resolvedColor || '#000000';
  liveOnChangeRef.current = pickerOnChange;
  liveOnChangeEndRef.current = pickerOnChangeEnd;
  liveOnApplyPresetRef.current = handleApplyPreset;
  liveActivePresetRef.current = presetName || undefined;
  liveCreatePresetRef.current = handleCreatePreset;
  liveEditPresetRef.current = handleEditPreset;
  liveColorPresetsRef.current = colorPresets;
  liveShowAlphaRef.current = showAlpha;

  const handleClick = () => {
    if (popupCtx) {
      // Inside a ToolPopup — push color picker as sliding panel.
      // Pass a render function (not a static element) so each ToolPopup
      // render reads fresh refs and the picker reflects the just-applied
      // preset / color immediately.
      trace.action('color-input:push-panel', { value });
      popupCtx.pushPanel('Color', () => (
        <ColorPicker
          value={liveValueRef.current}
          onChange={liveOnChangeRef.current}
          onChangeEnd={liveOnChangeEndRef.current}
          showAlpha={liveShowAlphaRef.current}
          onCreatePreset={liveCreatePresetRef.current}
          colorPresets={liveColorPresetsRef.current}
          onApplyPreset={liveOnApplyPresetRef.current}
          onEditPreset={liveEditPresetRef.current}
          activePresetName={liveActivePresetRef.current}
        />
      ));
    } else {
      // Standalone — open own popup
      setOpen(true);
      trace.action('color-input:open', { value });
    }
  };

  return (
    <>
      <button
        ref={btnRef}
        onClick={handleClick}
        className={swatchOnly
          ? "w-7 h-7 cut-corners border border-white/10 shrink-0 cursor-pointer hover:ring-1 hover:ring-[var(--border-focus)] transition-all"
          : isPresetRef
            ? "w-full h-8 flex items-center gap-2 px-1 bg-[var(--accent)] cut-corners cursor-pointer transition-colors min-w-0 overflow-hidden hover:opacity-90"
            : "w-full h-8 flex items-center gap-2 px-1 bg-[var(--grid-line)] border border-[var(--control-border)] hover:border-[var(--control-border-hover)] cut-corners cut-border hover:[--cut-border-color:var(--control-border-hover)] cursor-pointer transition-colors min-w-0 overflow-hidden"}
        style={swatchOnly ? { backgroundColor: displayColor } : undefined}
      >
        {!swatchOnly && (
          isPresetRef ? (
            <>
              <ColorSwatch style={{ backgroundColor: displayColor }} />
              {/* Label sits ON the accent fill, so it takes --accent-fg. */}
              <span className="text-xs font-medium text-[var(--accent-fg)] truncate flex-1">
                {presetLabel}
              </span>
              <span onClick={(e) => { e.stopPropagation(); onChange(''); }}
                className="text-[var(--accent-fg)]/70 hover:text-[var(--accent-fg)] transition-colors cursor-pointer text-sm ml-1 shrink-0">&times;</span>
            </>
          ) : (
            <>
              <ColorSwatch style={(mixed || empty) ? CHECKER_STYLE : { backgroundColor: displayColor }} />
              <span className={`text-xs truncate flex-1 text-left ${empty && !mixed ? 'text-[var(--text-secondary)]' : 'text-[var(--text-primary)]'}`}>{mixed ? 'Mixed' : empty ? 'Add' : displayText}</span>
              {onRemove && (
                <RemoveButton onClick={(e) => { e.stopPropagation(); onRemove(); }} />
              )}
            </>
          )
        )}
      </button>
      {/* Standalone popup — only when NOT inside a ToolPopup */}
      {!popupCtx && (
        <ToolPopup
          isOpen={open}
          onClose={() => setOpen(false)}
          title="Color"
          anchorRef={btnRef}
          width={280}
        >
          <StandaloneColorPickerWithPresets
            value={resolvedColor || '#000000'}
            onChange={pickerOnChange}
            onCommit={pickerOnChangeEnd}
            showAlpha={showAlpha}
            colorPresets={colorPresets}
            activePresetName={presetName || undefined}
          />
        </ToolPopup>
      )}
    </>
  );
}

function expandHex(value: string): string {
  if (value.startsWith('#') && value.length === 4) {
    return `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`;
  }
  return value || '#000000';
}

// ─── Standalone ColorPicker wrapper with preset support ─────────────────────
// Lives INSIDE the ToolPopup so it can use useToolPopup() for push/pop panels.

function StandaloneColorPickerWithPresets({ value, onChange, onCommit, showAlpha, colorPresets, activePresetName }: {
  value: string;
  onChange: (c: string) => void;
  /** Commit callback — see ColorInput's pickerOnChangeEnd. When set,
   *  `onChange` is the cheap per-frame preview and this is the code write. */
  onCommit?: (c: string) => void;
  showAlpha?: boolean;
  colorPresets: Array<{ name: string; value: string; label?: string }>;
  activePresetName?: string;
}) {
  const { pushPanel, popPanel } = useToolPopup();

  const handleCreate = useCallback((color: string) => {
    pushPanel('New Color Preset', (
      <CreateColorPresetPanel initialColor={color} onCreated={() => popPanel()} />
    ));
  }, [pushPanel, popPanel]);

  const handleEdit = useCallback((presetNameToEdit: string) => {
    const token = colorPresets.find(t => t.name === presetNameToEdit);
    if (!token) return;
    const displayName = (token.label || presetNameToEdit.replace(/^color-/, '')).split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    pushPanel(`Edit "${displayName}"`, (
      <ColorPresetEditPanel presetName={presetNameToEdit} initialValue={token.value} onUpdate={(val) => {
        // Live-drag fast path — see handleEditPreset comment above.
        const bridge = getCanvasBridge() as any;
        if (typeof bridge?.setCanvasTokenVar === 'function') {
          bridge.setCanvasTokenVar(presetNameToEdit, val);
        }
        queueMutation({ type: 'updatePresetToken', name: presetNameToEdit, value: val });
      }} />
    ));
  }, [pushPanel, colorPresets]);

  // Same one-shot vs continuous split as the popup-pushed picker above:
  // preset clicks go through a flush-on-write handler so the active-preset
  // highlight and the calling row's pill update in the same frame; the
  // sliders keep `onChange` plain so 60fps drags don't pay a flush cost.
  const handleApplyPreset = useCallback((presetVar: string) => {
    // Preset apply is a one-shot COMMIT — use onCommit when present.
    (onCommit ?? onChange)(presetVar);
    flushNow();
    trace.action('color-input:apply-preset-flush', { presetVar });
  }, [onChange, onCommit]);

  return (
    <ColorPicker
      value={value}
      onChange={onChange}
      onChangeEnd={onCommit}
      showAlpha={showAlpha}
      colorPresets={colorPresets}
      onApplyPreset={handleApplyPreset}
      activePresetName={activePresetName}
      onCreatePreset={handleCreate}
      onEditPreset={handleEdit}
    />
  );
}

// (Local `PresetEditPanel` was extracted to `ui/ColorPresetEditPanel.tsx`
// — every consumer now imports from there, including FillControl and
// GradientEditor, which used to ship their own near-duplicates.)
