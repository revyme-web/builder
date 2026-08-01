// TextColorControl.tsx — Text color with Solid/Gradient popup.
// Row: normal ColorInput swatch + value.
// Popup (pushPanel or standalone ToolPopup): Solid/Gradient tabs at top.
// Solid: ColorPicker. Gradient: GradientEditor (background-clip: text).

import { useState, useRef, useCallback, useEffect } from 'react';
import { useLivePreview } from '../../../hooks/useLivePreview';
import { useAtomValue } from 'jotai';
import { ControlLabel, ControlActionRow, ColorSwatch } from '../../../controls';
import ToolSegmentedControl from '../../../controls/ToolSegmentedControl';
import ToolPopup, { useToolPopupOptional, useToolPopup } from '../../../ui/ToolPopup';
import ColorPicker from '../../../ui/ColorPicker';
import GradientEditor from '../../../ui/GradientEditor';
import CreateColorPresetPanel from '../../../ui/CreateColorPresetPanel';
import ColorPresetEditPanel from '../../../ui/ColorPresetEditPanel';
import { getCanvasBridge } from '@/canvas/canvas-bridge';
import { queueMutation } from '@/code/mutation/mutation-queue';
import { injectCanvasCSS, removeCanvasCSS, getInteractingViewport, getViewportPrefix } from '@/canvas/node-ops';
import { toHexDisplay } from '../../../ui/color-utils';
import { useTextStyles } from '../../../hooks/useTextStyles';
import { useControl } from '../../../controls/ControlProvider';
import { LegacyVariableBoundPill } from '../../../controls/VariableBoundPill';
import { CmsBoundPill } from '../../../controls/CmsBoundPill';
import { presetTokensAtom, livePresetTokenAtom } from '@/code/stores/preset-store';
import { resolveTokenValue } from '@/code/project/preset-ops';
import { trace } from '@/shared/debug-trace';
import LocaleBoundPill, { useLocaleStyleOverrides } from '@/editor/controls/LocaleBoundPill';
import { parseVarRef } from '@/shared/css-utils';

type ColorTab = 'solid' | 'gradient';

/** Detect if current element has gradient text applied */
function detectTab(styles: Record<string, string>): ColorTab {
  const bg = styles.background || styles.backgroundImage || '';
  const clip = styles.WebkitBackgroundClip || styles.backgroundClip || '';
  if (bg.includes('gradient') && clip === 'text') return 'gradient';
  return 'solid';
}

/** CSS properties to clear when removing gradient text */
const GRADIENT_CLEAR: Record<string, string> = {
  background: '',
  backgroundImage: '',
  WebkitBackgroundClip: '',
  WebkitTextFillColor: '',
  backgroundClip: '',
};

/** Popup content: Solid/Gradient tabs + picker with color presets */
function TextColorPopupContent({ styles, isEditing, onColorChange, onColorCommit, onGradientChange, onGradientLiveChange, onClearGradient, currentValue }: {
  styles: Record<string, string>;
  isEditing: boolean;
  onColorChange: (color: string) => void;
  /** Commit (code write) — fires on drag release + one-shot edits. */
  onColorCommit: (color: string) => void;
  onGradientChange: (css: string) => void;
  /** Live (per-frame) gradient preview — DOM-only patch during a stop/direction drag. */
  onGradientLiveChange: (css: string) => void;
  onClearGradient: () => void;
  /** Live value for the color property — used to detect an active preset
   *  reference (e.g. `var(--color-brand-light)`) so the matching preset row
   *  highlights and the SV/hue picker lands on the resolved hex. */
  currentValue: string;
}) {
  const [tab, setTab] = useState<ColorTab>(() => detectTab(styles));
  const allTokens = useAtomValue(presetTokensAtom);
  const colorPresets = allTokens.filter(t => t.category === 'color');
  const popupCtx = useToolPopup();

  const handleTabChange = (v: string) => {
    const t = v as ColorTab;
    trace.action('text-color:tab-change', { from: tab, to: t });
    if (t === 'solid' && tab === 'gradient') {
      onClearGradient();
    }
    setTab(t);
  };

  const handleCreatePreset = useCallback((color: string) => {
    popupCtx.pushPanel('New Color Preset', (
      <CreateColorPresetPanel initialColor={color} onCreated={() => popupCtx.popPanel()} />
    ));
  }, [popupCtx]);

  // Edit a color preset — slides in the shared ColorPresetEditPanel (same as
  // the Fill popup + ColorInput). Without this the preset grid had no hover
  // "Edit" badge here. The panel's live drag sets `livePresetTokenAtom` (the
  // pill swatch sync) + paints the canvas via setCanvasTokenVar; commit queues
  // the tokens.css write.
  const handleEditPreset = useCallback((name: string) => {
    const token = colorPresets.find(t => t.name === name);
    if (!token) return;
    const displayName = (token.label || name.replace(/^color-/, '')).split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    popupCtx.pushPanel(`Edit "${displayName}"`, (
      <ColorPresetEditPanel
        presetName={name}
        initialValue={token.value}
        onUpdate={(val) => {
          const bridge = getCanvasBridge() as any;
          if (typeof bridge?.setCanvasTokenVar === 'function') bridge.setCanvasTokenVar(name, val);
          queueMutation({ type: 'updatePresetToken', name, value: val });
        }}
      />
    ));
  }, [popupCtx, colorPresets]);

  const gradientValue = styles.background || styles.backgroundImage || '';

  // Detect active color preset from the live value. Matches both `var(--name)`
  // forms — bare custom-property usage AND values that came through after a
  // typography preset already set the color via `--typo-*-color`. Only color
  // presets count (we filter by category) so a typography token like
  // --typo-heading-color won't accidentally highlight a row.
  const activePresetName = (() => {
    const v = currentValue || '';
    const name = parseVarRef(v);
    if (!name) return undefined;
    return colorPresets.some(p => p.name === name) ? name : undefined;
  })();

  // Resolve `var(--name)` to its underlying hex so the picker's SV square
  // and hue slider start on the actual rendered color. parseColor inside
  // ColorPicker can't read `var()`; passing the raw string falls back to
  // black and confuses the user.
  const rawSolid = currentValue || styles.color || '';
  const resolvedSolid = rawSolid.startsWith('var(')
    ? (resolveTokenValue(rawSolid, allTokens) ?? rawSolid)
    : rawSolid;
  const solidColor = (resolvedSolid === 'transparent' || !resolvedSolid) ? '#ffffff' : resolvedSolid;

  return (
    <div className="flex flex-col gap-2">
      <ToolSegmentedControl
        value={tab}
        onChange={handleTabChange}
        options={[
          { value: 'solid', label: 'Solid' },
          { value: 'gradient', label: 'Gradient' },
        ]}
        size="sm"
      />

      {tab === 'solid' && (
        <ColorPicker
          value={solidColor}
          onChange={onColorChange}
          onChangeEnd={onColorCommit}
          showAlpha
          colorPresets={colorPresets}
          onApplyPreset={(varVal) => onColorCommit(varVal)}
          onCreatePreset={handleCreatePreset}
          onEditPreset={handleEditPreset}
          activePresetName={activePresetName}
        />
      )}

      {tab === 'gradient' && (
        <GradientEditor
          value={gradientValue}
          onChange={onGradientChange}
          onLiveChange={onGradientLiveChange}
          hideOverlay={isEditing}
        />
      )}
    </div>
  );
}

export function TextColorControl() {
  const text = useTextStyles();
  const { styles, updateStyle, updateStyleLive, updateMultipleStyles, node, getValueSource, removeVariable, cmsBinding } = useControl();
  // Locale :lang() overrides on color → blue Locale pill (Phase 4).
  const colorLocaleOverrides = useLocaleStyleOverrides('color', node?.id ?? null);
  const popupCtx = useToolPopupOptional();
  const rowRef = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const colorResult = text.get('color');
  const allTokens = useAtomValue(presetTokensAtom);
  const livePreset = useAtomValue(livePresetTokenAtom);

  // Live row-swatch preview during a solid-color picker drag — the per-frame
  // change is a DOM-only patch, so the committed `color` stays frozen until
  // release. Mirror the dragged color here so the Color row swatch + hex track
  // it in real time; cleared once the committed value catches up (flicker-free).
  const [livePreviewColor, setLivePreviewColor] = useLivePreview<string>([colorResult.value]);

  // For a RICH-text node (per-portion `<span style={{color}}>` runs), the spans'
  // inline color overrides the `<p>`, so the per-frame `<p>` patch is invisible.
  // During a drag we inject a canvas-CSS rule forcing every inner span to the live
  // color (a live preview of the flatten); the spans are PERMANENTLY flattened on
  // commit via `text.set` (the stripInlineSpanStyle mutation). This ref holds the
  // injected selector so commit / unmount can clear it.
  const liveSpanSelRef = useRef<string | null>(null);
  const clearLiveSpanRule = useCallback(() => {
    if (liveSpanSelRef.current) { removeCanvasCSS(liveSpanSelRef.current); liveSpanSelRef.current = null; }
  }, []);
  useEffect(() => clearLiveSpanRule, [clearLiveSpanRule]);

  // Detect gradient from TipTap mark (edit mode) or element styles (node mode)
  const tiptapGradient = text.isEditing ? text.get('backgroundGradient').value : '';
  const isGradient = tiptapGradient ? true : detectTab(styles) === 'gradient';
  const gradientCSS = tiptapGradient || styles.background || styles.backgroundImage || '';

  /** Solid color — LIVE (every drag frame). Node mode: cheap DOM-only patch,
   *  no code write. Edit mode: TipTap mark (its own live editor transaction). */
  const handleColorChange = useCallback((c: string) => {
    trace.action('text-color:solid-change', { color: c });
    setLivePreviewColor(c); // drive the row swatch live
    if (text.isEditing) {
      text.set('color', c);
    } else {
      updateStyleLive('color', c);
      // Rich node: also override the per-portion span colors live so the WHOLE
      // node previews `c` while dragging (the bare `<p>` patch above is hidden
      // behind the spans' inline color).
      if ((node as any)?.hasMixedContent && node?.id) {
        const sel = `[data-node-id="${getViewportPrefix(getInteractingViewport().vpId)}${node.id}"] span`;
        liveSpanSelRef.current = sel;
        injectCanvasCSS(sel, `color: ${c} !important;`);
      }
    }
  }, [text, updateStyleLive, node]);

  /** Solid color — COMMIT (drag release + one-shot edits: hex, preset, clear).
   *  Writes to code. Routes through `text.set` so a rich node's per-portion span
   *  colors are FLATTENED (the spans inherit the node's new color) — `updateStyle`
   *  alone only set the `<p>`, which the spans overrode. `text.set` handles both
   *  modes: node → updateStyle + stripInlineSpanStyle; edit → TipTap mark. */
  const handleColorCommit = useCallback((c: string) => {
    trace.action('text-color:solid-commit', { color: c });
    text.set('color', c);
    clearLiveSpanRule();
  }, [text, clearLiveSpanRule]);

  /** Gradient change — COMMIT (drag release + one-shot). TipTap mark in edit
   *  mode, element-level otherwise. */
  const handleGradientChange = useCallback((css: string) => {
    trace.action('text-color:gradient-change', { css: css.slice(0, 60), isEditing: text.isEditing });
    if (text.isEditing) {
      text.set('backgroundGradient', css);
    } else {
      updateMultipleStyles({
        background: css,
        WebkitBackgroundClip: 'text',
        WebkitTextFillColor: 'transparent',
        backgroundClip: 'text',
        color: 'transparent',
      });
    }
  }, [text, updateMultipleStyles]);

  /** Gradient change — LIVE (every drag frame). Node mode: DOM-only patches,
   *  NO code write (the commit lands once on release via handleGradientChange) —
   *  routing the per-frame callback straight to the code write is what made the
   *  text-gradient drag low-FPS. The `background` shorthand resets
   *  background-clip to border-box, so it MUST be patched FIRST and the
   *  text-clip props re-asserted after (separate synchronous patches, so the
   *  final DOM state is clip:text — no flicker). Edit mode: the TipTap gradient
   *  command is already live (no re-parse), so mirror handleGradientChange. */
  const handleGradientLive = useCallback((css: string) => {
    if (text.isEditing) {
      text.set('backgroundGradient', css);
    } else {
      // Re-assert the text-clip props FIRST, then update ONLY the gradient via
      // the `backgroundImage` LONGHAND. Using the `background` SHORTHAND here
      // (as the commit does) resets `background-clip` to border-box, and since
      // these are separate per-frame patches the browser sometimes paints the
      // un-clipped full-box gradient before `clip: text` re-applies — the
      // intermittent flash. The longhand never touches `background-clip`, so the
      // clip stays `text` on every frame. (The commit keeps `background` — it's
      // a single ordered applyTwoPass, so it can't flash.)
      updateStyleLive('WebkitBackgroundClip', 'text');
      updateStyleLive('backgroundClip', 'text');
      updateStyleLive('WebkitTextFillColor', 'transparent');
      updateStyleLive('color', 'transparent');
      updateStyleLive('backgroundImage', css);
    }
  }, [text, updateStyleLive]);

  /** Clear gradient, restore solid color */
  const handleClearGradient = useCallback(() => {
    trace.action('text-color:gradient-clear', { isEditing: text.isEditing });
    if (text.isEditing) {
      text.set('backgroundGradient', '');
      text.set('color', '#ffffff');
    } else {
      updateMultipleStyles({
        ...GRADIENT_CLEAR,
        color: '#ffffff',
      });
    }
  }, [text, updateMultipleStyles]);

  const handleClick = () => {
    if (popupCtx) {
      popupCtx.pushPanel('Color', (
        <TextColorPopupContent
          styles={styles}
          isEditing={text.isEditing}
          onColorChange={handleColorChange}
          onColorCommit={handleColorCommit}
          onGradientChange={handleGradientChange}
          onGradientLiveChange={handleGradientLive}
          onClearGradient={handleClearGradient}
          currentValue={colorResult.value || ''}
        />
      ));
    } else {
      setIsOpen(true);
    }
  };

  // Display: show gradient preview swatch or normal color
  const displayColor = isGradient ? undefined : colorResult.value;
  const displayGradient = isGradient ? gradientCSS : undefined;

  trace.fn('TextColorControl:render', { tab: isGradient ? 'gradient' : 'solid', value: colorResult.value, isEditing: text.isEditing });

  // Determine what to show in the row button. When the value is a
  // `var(--name)` reference (preset applied), resolve it to the underlying
  // color so the label reads "#ffffff" instead of the raw var() string —
  // matches what the user sees on canvas. The swatch already paints the
  // resolved color via CSS so this only affects the label text.
  const resolvedColor = !isGradient && colorResult.value?.startsWith('var(')
    ? (resolveTokenValue(colorResult.value, allTokens) ?? colorResult.value)
    : colorResult.value;
  // During a solid-color drag, the live raw color overrides the committed
  // value/preset so the row swatch + hex track the picker in real time.
  const solidSwatch = (!isGradient && livePreviewColor != null) ? livePreviewColor : (resolvedColor || '#000000');
  const swatchBg = isGradient ? gradientCSS : solidSwatch;
  // Label always shows the HEX equivalent — rgb / rgba / hsl / oklch / named
  // are all converted (var()/gradient pass through untouched), matching the
  // Fill control and every other color swatch in the editor.
  const label = colorResult.isMixed && livePreviewColor == null
    ? 'Mixed'
    : isGradient
      ? 'Gradient'
      : toHexDisplay(solidSwatch);

  // Detect an active color preset on this control's value. Mirrors the
  // logic in the popup so the row stays in sync with the picker grid.
  // Only color presets count — a typography token like `--typo-heading-color`
  // is not a color preset and shouldn't make the row turn blue.
  const colorPresetTokens = allTokens.filter(t => t.category === 'color');
  const activePresetToken = (() => {
    if (isGradient || colorResult.isMixed || !colorResult.value) return null;
    const name = parseVarRef(colorResult.value);
    if (!name) return null;
    return colorPresetTokens.find(p => p.name === name) ?? null;
  })();
  /** Remove the preset reference and bake in the resolved hex so the
   *  visible color doesn't change — only the var() linkage. */
  const clearPreset = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (!activePresetToken) return;
    handleColorCommit(activePresetToken.value);
  }, [activePresetToken, handleColorCommit]);

  // Locale-localized color → blue Locale pill (reopens the Localize popup).
  if (colorLocaleOverrides.length > 0 && node?.id) {
    return (
      <div className="grid grid-cols-[var(--tool-label-col)_minmax(0,1fr)] items-center w-full">
        <ControlLabel label="Color" property="color" cell />
        <LocaleBoundPill
          property="color"
          propertyLabel="Color"
          nodeId={node.id}
          baseValue={styles.color || ''}
          onChangeBase={(v) => updateStyle('color', v)}
        />
      </div>
    );
  }

  // CMS-bound: blue pill with the link icon, takes priority over the
  // variable pill below — same pattern as ContentControl.
  if (cmsBinding?.getBindingForProperty('color')) {
    return (
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Color" property="color" />
        <CmsBoundPill property="color" fallbackValue={resolvedColor || ''} />
      </div>
    );
  }

  // Variable-bound: swap the swatch button for the purple pill, mirroring
  // every other variabilizable property in the right panel.
  const colorVarSource = getValueSource('color');
  const isColorVar = colorVarSource.source === 'prop' && !!colorVarSource.ref;
  if (isColorVar) {
    return (
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Color" property="color" />
        <LegacyVariableBoundPill
          property="color"
          propertyLabel="Color"
          variableRef={colorVarSource.ref!}
          currentValue={colorResult.value || ''}
          removeVariable={removeVariable}
        />
      </div>
    );
  }

  return (
    <>
      <div ref={rowRef} className="flex items-center justify-between w-full">
        <ControlLabel label="Color" property="color" />
        {activePresetToken ? (
          <button
            onClick={handleClick}
            className="w-full h-8 flex items-center gap-2 px-2 bg-[var(--accent)] rounded-[var(--radius-lg)] cursor-pointer transition-colors min-w-0 overflow-hidden hover:opacity-90"
          >
            <ColorSwatch style={{ background: livePreset?.name === activePresetToken.name ? livePreset.value : activePresetToken.value }} />
            <span className="text-xs text-[var(--accent-fg)] truncate flex-1 text-left">
              {activePresetToken.label || activePresetToken.name.replace(/^color-/, '').split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}
            </span>
            <span
              className="text-white/60 hover:text-white text-sm leading-none cursor-pointer shrink-0"
              onClick={clearPreset}
            >
              &times;
            </span>
          </button>
        ) : (
          <ControlActionRow onClick={handleClick}>
            <ColorSwatch style={{ background: swatchBg }} />
            <span className={`text-xs truncate flex-1 text-left ${colorResult.isMixed || isGradient ? 'text-[var(--text-secondary)]' : ''}`}>{label}</span>
          </ControlActionRow>
        )}
      </div>
      {!popupCtx && (
        <ToolPopup isOpen={isOpen} onClose={() => setIsOpen(false)} title="Color" anchorRef={rowRef}>
          <TextColorPopupContent
            styles={styles}
            isEditing={false}
            onColorChange={handleColorChange}
            onColorCommit={handleColorCommit}
            onGradientChange={handleGradientChange}
            onGradientLiveChange={handleGradientLive}
            onClearGradient={handleClearGradient}
            currentValue={colorResult.value || ''}
          />
        </ToolPopup>
      )}
    </>
  );
}
