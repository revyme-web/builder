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
import { queueMutation, setForceRender } from '@/code/mutation/mutation-queue';
import { isComponentVariantViewportAtom } from '@/code/stores/viewport-store';
import { injectCanvasCSS, removeCanvasCSS, getInteractingViewport, getViewportPrefix } from '@/canvas/node-ops';
import { toHexDisplay } from '../../../ui/color-utils';
import { useTextStyles, readFromSnapshot } from '../../../hooks/useTextStyles';
import { textEditSnapshotAtom } from '@/code/stores/editor-store';
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

/** Gradient text can ALSO live as per-run SPAN MARKS (an edit-mode gradient
 *  application stores `<span style={{background: 'linear-gradient(…)',
 *  WebkitBackgroundClip: 'text', …}}>` in the node's rich content — the
 *  node's OWN styles carry nothing). Node-styles-only detection was blind to
 *  that: the row showed `#00000000` and the popup opened on the wrong tab
 *  ("shows black instead of gradient", 2026-08-06). */
function nodeCarriesSpanGradient(textContent: string | undefined | null): boolean {
  if (!textContent) return false;
  return /(?:linear|radial|conic)-gradient\(/.test(textContent)
    && /[Bb]ackground[-]?[Cc]lip['"]?\s*:\s*['"]?text/.test(textContent);
}

/** First gradient function in the rich content — for the row swatch when the
 *  gradient lives in span marks. Handles one nesting level (rgb()/var()). */
function extractSpanGradientCSS(textContent: string | undefined | null): string {
  if (!textContent) return '';
  const m = /((?:linear|radial|conic)-gradient\((?:[^()]|\([^()]*\))*\))/.exec(textContent);
  return m ? m[1] : '';
}

/** All color tokens in a CSS string (hex / rgb(a) / hsl(a)) — for building
 *  the Mixed preview from the gradient's stops. */
function extractColorTokens(css: string | undefined | null): string[] {
  if (!css) return [];
  return css.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g) ?? [];
}

/** Distinct solid TEXT colors carried by span runs in the rich content —
 *  matches plain `color:` in both the kebab HTML-string form (inside a
 *  useResponsiveText primary) and the camelCase JSX form. The lookbehind
 *  excludes `-webkit-text-fill-color` / `background-color`; camel variants
 *  (`WebkitTextFillColor`, `backgroundColor`) miss on case. Fully-transparent
 *  values are dropped. */
function extractSpanTextColors(textContent: string | undefined | null): string[] {
  if (!textContent || !/<(?:motion\.)?span\b/i.test(textContent)) return [];
  const out = new Set<string>();
  const re = /(?<![-\w])['"]?color['"]?\s*:\s*['"]?(#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)|[a-z]{3,20}\b)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(textContent))) {
    const v = m[1];
    if (!isFullyTransparentColor(v)) out.add(v);
  }
  return [...out];
}

/** Hard-stop swatch blending the gradient's stops with the solid run colors —
 *  the "Mixed" row preview for text combining gradient + solid runs. */
function buildMixedSwatchCSS(gradientCSS: string, spanColors: string[]): string {
  const colors = [...extractColorTokens(gradientCSS).slice(0, 2), ...spanColors].slice(0, 4);
  if (colors.length === 0) return '';
  const n = colors.length;
  const segs = colors
    .map((c, i) => `${c} ${Math.round((i * 100) / n)}% ${Math.round(((i + 1) * 100) / n)}%`)
    .join(', ');
  return `linear-gradient(90deg, ${segs})`;
}

/** A color that paints NOTHING — the gradient dialect writes the node's
 *  `color` as `rgba(0, 0, 0, 0)` (not the keyword `transparent`), and guards
 *  comparing only against the keyword let zero-alpha rgba pass as a "real
 *  solid" — the row showed `#00000000` and the popup opened on Solid over
 *  gradient text (2026-08-07, the trace-confirmed hole). */
function isFullyTransparentColor(v: string | undefined | null): boolean {
  const s = (v || '').trim().toLowerCase();
  if (!s || s === 'transparent') return true;
  if (/^#(?:0{8}|0{4})$/.test(s)) return true; // #00000000 / #0000
  // rgba(..., 0) / hsla(..., 0) — comma syntax with zero alpha.
  if (/^(?:rgba|hsla)\([^)]*,\s*(?:0|0?\.0+|0%)\s*\)$/.test(s)) return true;
  // Modern space syntax: rgb(0 0 0 / 0), color(... / 0%).
  if (/^(?:rgb|rgba|hsl|hsla|color)\([^)]*\/\s*(?:0|0?\.0+|0%)\s*\)$/.test(s)) return true;
  return false;
}

/** Inline span runs present in the node's rich content — either JSX-children
 *  `style={{…}}` runs (hasMixedContent nodes) OR HTML-string runs inside a
 *  useResponsiveText primary (which parse with hasMixedContent FALSE — keying
 *  on the flag alone left those nodes' spans out-painting every node-level
 *  write). */
function contentHasSpanRuns(textContent: string | undefined | null): boolean {
  return /<(?:motion\.)?span\b/i.test(textContent ?? '');
}

/** Span paint channels a NODE-level paint apply (solid or gradient, out of
 *  edit mode) must flatten: any of these surviving on a run out-paints the
 *  node's new value (fill-color over a node gradient, `color: transparent`
 *  over a node solid, span gradients over both). Highlight (`backgroundColor`)
 *  is orthogonal and deliberately not here. */
const SPAN_PAINT_CHANNEL_PROPS = [
  'color',
  'WebkitTextFillColor',
  'background',
  'backgroundImage',
  'WebkitBackgroundClip',
  'backgroundClip',
];

/** CSS properties to clear when removing gradient text */
const GRADIENT_CLEAR: Record<string, string> = {
  background: '',
  backgroundImage: '',
  WebkitBackgroundClip: '',
  WebkitTextFillColor: '',
  backgroundClip: '',
};

/** Popup content: Solid/Gradient tabs + picker with color presets */
function TextColorPopupContent({ styles, isEditing, onColorChange, onColorCommit, onGradientChange, onGradientLiveChange, onClearGradient, currentValue, initialTab, gradientContext, gradientCSS: gradientCSSProp }: {
  styles: Record<string, string>;
  isEditing: boolean;
  /** Tab seeded from the live SELECTION state (edit mode: a gradient mark on
   *  the selected run → gradient, a color mark → solid) instead of only the
   *  node's styles — so selecting a solid run inside gradient text opens the
   *  picker on Solid with that run's color, matching the other controls. */
  initialTab?: ColorTab;
  /** The node's gradient-text context (node styles OR span-mark gradients) —
   *  the fallback when the selection carries no explicit marks. Node styles
   *  alone are blind to span-carried gradients. */
  gradientContext?: boolean;
  /** Resolved gradient CSS for the editor (covers span-carried gradients —
   *  node styles alone would seed the GradientEditor empty). */
  gradientCSS?: string;
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
  const [tab, setTab] = useState<ColorTab>(() => initialTab ?? detectTab(styles));
  const allTokens = useAtomValue(presetTokensAtom);
  const colorPresets = allTokens.filter(t => t.category === 'color');
  const popupCtx = useToolPopup();

  // LIVE selection sync (edit mode): pushed panels get FROZEN props, so the
  // popup subscribes to the edit-session snapshot itself and follows the
  // selection — caret/range on a solid run → Solid tab with that run's color,
  // unmarked text inside gradient → Gradient. Only re-syncs when the DERIVED
  // tab actually changes, so a manual tab click (e.g. Solid → Gradient to
  // apply a gradient) isn't fought.
  const editSnapshot = useAtomValue(textEditSnapshotAtom);
  const selMark = (property: string): string => {
    if (!isEditing || !editSnapshot) return '';
    const r = readFromSnapshot(editSnapshot, property);
    return r.isMixed ? '' : (r.value || '');
  };
  const selGradient = selMark('backgroundGradient');
  const selColor = selMark('color');
  const fallbackTab: ColorTab = gradientContext ? 'gradient' : detectTab(styles);
  const liveTab: ColorTab | null = isEditing && editSnapshot
    ? (selGradient ? 'gradient' : (selColor && !isFullyTransparentColor(selColor) ? 'solid' : fallbackTab))
    : null;
  useEffect(() => {
    if (liveTab) setTab(liveTab);
  }, [liveTab]);

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

  // Live selection's gradient mark wins; node styles next; span-carried last.
  const gradientValue = selGradient || styles.background || styles.backgroundImage || gradientCSSProp || '';

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
  // Prefer the LIVE selection's color mark (edit mode) over the frozen prop.
  const rawSolid = (isEditing && selColor && !isFullyTransparentColor(selColor) ? selColor : '') || currentValue || styles.color || '';
  const resolvedSolid = rawSolid.startsWith('var(')
    ? (resolveTokenValue(rawSolid, allTokens) ?? rawSolid)
    : rawSolid;
  const solidColor = isFullyTransparentColor(resolvedSolid) ? '#ffffff' : resolvedSolid;

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
  const { styles, updateStyle, updateStyleLive, updateMultipleStyles, node, getValueSource, removeVariable, cmsBinding, isReplica } = useControl();
  const isComponentVariantVp = useAtomValue(isComponentVariantViewportAtom);
  // A scoped write lands in a viewport `@media` rule / variant object — a span
  // strip there would delete paint the OTHER viewports still rely on.
  const isScopedWrite = isReplica || isComponentVariantVp;
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

  // NODE-mode paint flatten: a node-level GRADIENT apply (or gradient clear)
  // writes the node's styles, but span runs carrying their own paint channels
  // (solid fill-colors, span gradients, `color: transparent`) out-paint it
  // per-run — the apply "does nothing" on rich text. Strip every span paint
  // channel so the node's new paint wins. Solid commits get the same via
  // `text.set('color')`'s flatten; this covers the gradient-side writes, which
  // go through updateMultipleStyles and bypass that path. Base writes only.
  const flattenSpanPaint = useCallback(() => {
    if (!node?.id || isScopedWrite || !contentHasSpanRuns((node as any)?.textContent)) return;
    trace.action('text-color:flatten-span-paint', { nodeId: node.id });
    for (const p of SPAN_PAINT_CHANNEL_PROPS) {
      queueMutation({ type: 'stripInlineSpanStyle', nodeId: node.id, property: p });
    }
    setForceRender();
  }, [node, isScopedWrite]);

  // Detect gradient from TipTap mark (edit mode) or element styles (node mode).
  // In edit mode a SOLID color mark on the selection wins over the node's
  // gradient — the caret/selection sitting on a solid run must show that solid
  // in the row (and open the popup on Solid), matching the other controls'
  // selection sync.
  const tiptapGradient = text.isEditing ? text.get('backgroundGradient').value : '';
  const selectionSolid = text.isEditing && !tiptapGradient
    && !!colorResult.value && !isFullyTransparentColor(colorResult.value) && !colorResult.isMixed;
  // The GRADIENT-TEXT CONTEXT — node styles OR span-mark gradients in the
  // rich content (an edit-mode gradient application stores the gradient as
  // whole-text span marks; the node's own styles then carry nothing). This is
  // what decides whether a solid pick needs the paired fill-color mark, and
  // the display fallback when the selection's marks are empty/mixed. Distinct
  // from `isGradient` (the row display): re-coloring an EXISTING solid run
  // has isGradient false, but the surrounding gradient context still demands
  // the fill-color pair.
  const spanGradientCSS = extractSpanGradientCSS((node as any)?.textContent);
  const nodeHasGradientText = detectTab(styles) === 'gradient'
    || nodeCarriesSpanGradient((node as any)?.textContent);
  const isGradient = tiptapGradient ? true : (selectionSolid ? false : nodeHasGradientText);
  const gradientCSS = tiptapGradient || styles.background || styles.backgroundImage || spanGradientCSS || '';

  /** Solid color — LIVE (every drag frame). Node mode: cheap DOM-only patch,
   *  no code write. Edit mode: TipTap mark (its own live editor transaction). */
  const handleColorChange = useCallback((c: string) => {
    trace.action('text-color:solid-change', { color: c });
    setLivePreviewColor(c); // drive the row swatch live
    if (text.isEditing) {
      text.set('color', c);
      // SOLID RUN INSIDE GRADIENT TEXT: the node-level gradient's inherited
      // `-webkit-text-fill-color: transparent` out-paints the span's `color`
      // (fill-color paints glyphs), so the mark alone was invisible. Carry the
      // fill-color on the run so it renders solid; scoped to gradient context
      // so plain solid text never accumulates fill-color spans.
      if (nodeHasGradientText) text.set('textFillColor', c);
    } else {
      updateStyleLive('color', c);
      // Rich node: also override the per-portion span paint live so the WHOLE
      // node previews `c` while dragging (the bare `<p>` patch above is hidden
      // behind the spans' inline color). Content probe, not hasMixedContent —
      // useResponsiveText nodes parse with the flag false. Fill-color rides
      // along: a run carrying an opaque `-webkit-text-fill-color` out-paints
      // the span `color` override alone.
      if (node?.id && contentHasSpanRuns((node as any)?.textContent)) {
        const sel = `[data-node-id="${getViewportPrefix(getInteractingViewport().vpId)}${node.id}"] span`;
        liveSpanSelRef.current = sel;
        injectCanvasCSS(sel, `color: ${c} !important; -webkit-text-fill-color: ${c} !important;`);
      }
    }
  }, [text, updateStyleLive, node, nodeHasGradientText, setLivePreviewColor]);

  /** Solid color — COMMIT (drag release + one-shot edits: hex, preset, clear).
   *  Writes to code. Routes through `text.set` so a rich node's per-portion span
   *  colors are FLATTENED (the spans inherit the node's new color) — `updateStyle`
   *  alone only set the `<p>`, which the spans overrode. `text.set` handles both
   *  modes: node → updateStyle + stripInlineSpanStyle; edit → TipTap mark. */
  const handleColorCommit = useCallback((c: string) => {
    trace.action('text-color:solid-commit', { color: c, gradientContext: nodeHasGradientText });
    text.set('color', c);
    if (text.isEditing && nodeHasGradientText) {
      // Selection inside gradient text: drop any gradient MARK on the run
      // (mixed selections) and pin the fill-color so the run paints solid.
      // The NODE-level gradient is untouched — the rest of the text keeps it.
      text.set('backgroundGradient', '');
      text.set('textFillColor', c);
    }
    clearLiveSpanRule();
  }, [text, clearLiveSpanRule, nodeHasGradientText]);

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
      // Rich node: span runs carrying their own paint (solid fill-colors, span
      // gradients) out-paint the node-level gradient per-run — flatten them so
      // the gradient actually shows.
      flattenSpanPaint();
      clearLiveSpanRule();
    }
  }, [text, updateMultipleStyles, flattenSpanPaint, clearLiveSpanRule]);

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
      // Rich node: neutralize the span runs' own paint for the preview — an
      // opaque span fill-color / span gradient out-paints the node gradient
      // being dragged (the commit strips them for real via flattenSpanPaint).
      if (node?.id && contentHasSpanRuns((node as any)?.textContent)) {
        const sel = `[data-node-id="${getViewportPrefix(getInteractingViewport().vpId)}${node.id}"] span`;
        liveSpanSelRef.current = sel;
        injectCanvasCSS(sel, 'color: transparent !important; -webkit-text-fill-color: transparent !important; background: none !important;');
      }
    }
  }, [text, updateStyleLive, node]);

  /** Clear gradient, restore solid color */
  const handleClearGradient = useCallback(() => {
    trace.action('text-color:gradient-clear', { isEditing: text.isEditing });
    if (text.isEditing) {
      // Selection-scoped: clears gradient MARKS on the run only — the node's
      // own gradient (the rest of the text) stays. Seed the run's fill-color
      // too: with the node gradient's inherited transparent fill, a bare
      // color would stay invisible until the user picks (see TextFillColorMark).
      text.set('backgroundGradient', '');
      text.set('color', '#ffffff');
      if (nodeHasGradientText) text.set('textFillColor', '#ffffff');
    } else {
      updateMultipleStyles({
        ...GRADIENT_CLEAR,
        color: '#ffffff',
      });
      // Rich node: the runs' own paint would out-paint the restored solid.
      flattenSpanPaint();
      clearLiveSpanRule();
    }
  }, [text, updateMultipleStyles, nodeHasGradientText, flattenSpanPaint, clearLiveSpanRule]);

  const handleClick = () => {
    if (popupCtx) {
      // Seed the tab from the live SELECTION (edit mode), not just the node
      // styles: a selected solid run inside gradient text opens on Solid with
      // the run's color; an unmarked selection inside gradient text opens on
      // Gradient — same sync contract as the other text controls.
      const nodeFallbackTab: ColorTab = nodeHasGradientText ? 'gradient' : 'solid';
      const selectionTab: ColorTab = text.isEditing
        ? (tiptapGradient ? 'gradient' : (selectionSolid ? 'solid' : nodeFallbackTab))
        : nodeFallbackTab;
      popupCtx.pushPanel('Color', (
        <TextColorPopupContent
          styles={styles}
          isEditing={text.isEditing}
          initialTab={selectionTab}
          gradientContext={nodeHasGradientText}
          gradientCSS={gradientCSS}
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

  // NODE-selected (not editing) with gradient + solid runs mixed in one text:
  // the row reads "Mixed" with a blended preview instead of "Gradient". The
  // generic mixed read (colorResult.isMixed) misses this shape — the runs
  // live inside the useResponsiveText primary string, not as direct JSX
  // children — so detect the span colors in the rich content directly.
  const spanTextColors = extractSpanTextColors((node as any)?.textContent);
  const nodeMixed = !text.isEditing && nodeHasGradientText && spanTextColors.length > 0;
  const mixedSwatchCSS = nodeMixed ? buildMixedSwatchCSS(gradientCSS, spanTextColors) : '';

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
  const swatchBg = nodeMixed ? mixedSwatchCSS : (isGradient ? gradientCSS : solidSwatch);
  // Label always shows the HEX equivalent — rgb / rgba / hsl / oklch / named
  // are all converted (var()/gradient pass through untouched), matching the
  // Fill control and every other color swatch in the editor.
  const label = nodeMixed || (colorResult.isMixed && livePreviewColor == null)
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
            className="w-full h-8 flex items-center gap-2 px-2 bg-[var(--accent)] cut-corners cursor-pointer transition-colors min-w-0 overflow-hidden hover:opacity-90"
          >
            <ColorSwatch style={{ background: livePreset?.name === activePresetToken.name ? livePreset.value : activePresetToken.value }} />
            <span className="text-xs text-[var(--accent-fg)] truncate flex-1 text-left">
              {activePresetToken.label || activePresetToken.name.replace(/^color-/, '').split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}
            </span>
            <span
              className="text-[var(--accent-fg)] opacity-70 hover:opacity-100 text-sm leading-none cursor-pointer shrink-0"
              onClick={clearPreset}
            >
              &times;
            </span>
          </button>
        ) : (
          <ControlActionRow onClick={handleClick}>
            <ColorSwatch style={{ background: swatchBg }} />
            <span className={`text-xs truncate flex-1 text-left ${nodeMixed || colorResult.isMixed || isGradient ? 'text-[var(--text-secondary)]' : ''}`}>{label}</span>
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
