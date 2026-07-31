// TypographyEditContent — the multi-field editor for a typography preset
// group (font, size, weight, line-height, spacing, decoration, color,
// shadow). Used both inside the LibraryPanel preset edit popup and by
// TypographyPresetControl in the TextStyleTool (it consumes this as the
// shared editor surface).

import React, { useState, useCallback } from 'react';
import { queueMutation } from '@/code/mutation/mutation-queue';
import { getCanvasBridge } from '@/canvas/canvas-bridge';
import { DesktopViewportIcon, TabletViewportIcon, MobileViewportIcon } from '@/shared/icons';
import ToolInput from '@/editor/controls/ToolInput';
import ToolSelect from '@/editor/controls/ToolSelect';
import ToolSegmentedControl from '@/editor/controls/ToolSegmentedControl';
import { FontFamilyControl } from '@/editor/tools/TextStyleTool/atoms/FontFamilyControl';
import { TextPropertyControl } from '@/editor/tools/TextStyleTool/atoms/TextPropertyControl';
import { ElementPropertyControl } from '@/editor/tools/TextStyleTool/atoms/ElementPropertyControl';
import { DecorationControl } from '@/editor/tools/TextStyleTool/atoms/DecorationControl';
import { ShadowControl as TextShadowControl } from '@/editor/tools/TextStyleTool/atoms/ShadowControl';
import ColorInput from '@/editor/controls/ColorInput';
import ControlLabel from '@/editor/controls/ControlLabel';
import { trace } from '@/shared/debug-trace';
import { TYPO_TAG_OPTIONS } from '@/editor/tools/typography-utils';
import type { TypoGroup as TypographyGroup } from '@/editor/tools/typography-utils';

interface TypographyEditContentProps {
  group: TypographyGroup;
  onUpdate: (name: string, value: string) => void;
  onDelete: (name: string) => void;
  onClose: () => void;
}

/** Responsive tier suffixes: base (desktop), md (tablet), sm (mobile) */
const RESPONSIVE_TIERS = [
  { value: 'base', icon: <DesktopViewportIcon size={14} className="text-[var(--text-secondary)]" /> },
  { value: 'md', icon: <TabletViewportIcon size={14} className="text-[var(--text-secondary)]" /> },
  { value: 'sm', icon: <MobileViewportIcon size={14} className="text-[var(--text-secondary)]" /> },
];

/** Responsive properties that change per breakpoint */
const RESPONSIVE_SUFFIXES = ['size', 'spacing', 'line-height'] as const;

export function TypographyEditContent({ group, onUpdate, onDelete, onClose }: TypographyEditContentProps) {
  // Local state for each value — changes reflect immediately in sub-panels
  const initVal = (suffix: string) => group.tokens.find(t => t.name.endsWith('-' + suffix))?.value ?? '';

  const [tag, setTag] = useState(() => initVal('tag') || 'p');
  const [font, setFont] = useState(() => initVal('font'));
  const [weight, setWeight] = useState(() => initVal('weight'));
  const [color, setColor] = useState(() => initVal('color'));
  const [transform, setTransform] = useState(() => initVal('transform'));
  const [decoration, setDecoration] = useState(() => initVal('decoration'));
  const [shadow, setShadow] = useState(() => initVal('shadow'));

  // Base (desktop) values
  const [size, setSize] = useState(() => initVal('size'));
  const [spacing, setSpacing] = useState(() => initVal('spacing'));
  const [lineHeight, setLineHeight] = useState(() => initVal('line-height'));

  // Medium (tablet) values
  const [sizeMd, setSizeMd] = useState(() => initVal('size-md'));
  const [spacingMd, setSpacingMd] = useState(() => initVal('spacing-md'));
  const [lineHeightMd, setLineHeightMd] = useState(() => initVal('line-height-md'));

  // Small (mobile) values
  const [sizeSm, setSizeSm] = useState(() => initVal('size-sm'));
  const [spacingSm, setSpacingSm] = useState(() => initVal('spacing-sm'));
  const [lineHeightSm, setLineHeightSm] = useState(() => initVal('line-height-sm'));

  // Min-width breakpoints (stored as tokens, defines when each tier kicks in)
  const [minDefault, setMinDefault] = useState(() => initVal('min-default') || '1200');
  const [minMd, setMinMd] = useState(() => initVal('min-md') || '600');

  // Active responsive tier
  const [tier, setTier] = useState('base');

  // Write to both local state AND token (auto-creates missing tokens for legacy groups)
  const writeVal = useCallback((suffix: string, value: string, setLocal: (v: string) => void) => {
    setLocal(value);
    let token = group.tokens.find(t => t.name.endsWith('-' + suffix));
    if (!token) {
      // Legacy group missing this token — create it on the fly
      const tokenName = `typo-${group.name}-${suffix}`;
      trace.action('typo-group-edit:auto-create-token', { group: group.name, suffix, tokenName });
      queueMutation({ type: 'addPresetToken', token: { name: tokenName, value, category: 'typography' } });
      // Push into group.tokens so subsequent writes find it
      group.tokens.push({ name: tokenName, value, category: 'typography' });
      token = group.tokens[group.tokens.length - 1];
    }
    // Keep the in-memory group in sync (not just ProjectFS) so a consumer reading group.tokens right
    // after an edit — e.g. applyPreset reading the freshly-picked tag on the create flow's "Done" —
    // sees the new value, not the stale one captured at panel open.
    token.value = value;
    trace.action('typo-group-edit:value-change', { group: group.name, suffix, value });
    onUpdate(token.name, value);
  }, [group.tokens, group.name, onUpdate]);

  // Live (per-frame) preview during a color-picker drag: paint the CSS var
  // straight onto the canvas via the bridge (instant, no re-render) and update
  // local state for the swatch — but DO NOT touch the mutation queue. The real
  // token write happens once on release via `writeVal` (the ColorInput's
  // `onChange`). Mirrors the live/commit split proven on ColorPresetEditPanel;
  // routing the per-frame callback straight to `writeVal` (→ queueMutation per
  // frame) is what made the picker low-FPS.
  const liveVal = useCallback((suffix: string, value: string, setLocal: (v: string) => void) => {
    setLocal(value);
    const token = group.tokens.find(t => t.name.endsWith('-' + suffix));
    const tokenName = token ? token.name : `typo-${group.name}-${suffix}`;
    (getCanvasBridge() as any)?.setCanvasTokenVar?.(tokenName, value);
  }, [group.tokens, group.name]);

  // Resolve the active tier's setters/values for responsive properties
  const responsiveProps = tier === 'sm'
    ? { size: sizeSm, setSize: setSizeSm, sizeSuffix: 'size-sm',
        spacing: spacingSm, setSpacing: setSpacingSm, spacingSuffix: 'spacing-sm',
        lineHeight: lineHeightSm, setLineHeight: setLineHeightSm, lineHeightSuffix: 'line-height-sm' }
    : tier === 'md'
    ? { size: sizeMd, setSize: setSizeMd, sizeSuffix: 'size-md',
        spacing: spacingMd, setSpacing: setSpacingMd, spacingSuffix: 'spacing-md',
        lineHeight: lineHeightMd, setLineHeight: setLineHeightMd, lineHeightSuffix: 'line-height-md' }
    : { size, setSize, sizeSuffix: 'size',
        spacing, setSpacing, spacingSuffix: 'spacing',
        lineHeight, setLineHeight, lineHeightSuffix: 'line-height' };

  return (
    <div className="flex flex-col gap-2">
      {/* Element tag (Paragraph / Heading 1–6). Stored as the `-tag` token; applying the preset retags
          the element and the preset's badge reflects it. */}
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Tag" property="" plain />
        <ToolSelect
          value={tag}
          onChange={(v) => writeVal('tag', v, setTag)}
          options={[...TYPO_TAG_OPTIONS]}
        />
      </div>
      <FontFamilyControl value={font} onChange={(v) => writeVal('font', v, setFont)} />
      <TextPropertyControl property="fontWeight" label="Weight" value={weight} onChange={(v) => writeVal('weight', v, setWeight)} />
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Color" property="color" plain />
        <ColorInput value={color || '#000000'} onChange={(v) => writeVal('color', v, setColor)} onChangeLive={(v) => liveVal('color', v, setColor)} />
      </div>
      <ElementPropertyControl property="textTransform" label="Transform" value={transform} onChange={(v) => writeVal('transform', v, setTransform)} />
      <DecorationControl value={decoration} onChange={(v) => writeVal('decoration', v, setDecoration)} />
      <TextShadowControl value={shadow} onChange={(v) => writeVal('shadow', v, setShadow)} />

      {/* ── Responsive section ── */}
      <div className="border-t border-[var(--border-light)] pt-2 -mx-3 px-3 flex items-center justify-between">
        <ControlLabel label="Breakpoint" property="" plain />
        <ToolSegmentedControl
          value={tier}
          onChange={(v) => { setTier(v); trace.action('typo-group-edit:tier-change', { tier: v }); }}
          options={RESPONSIVE_TIERS}
          size="compact"
        />
      </div>

      {/* Min Width — shown for base and md tiers */}
      {tier === 'base' && (
        <div className="flex items-center justify-between w-full">
          <ControlLabel label="Min Width" property="" plain />
          <ToolInput
            value={minDefault}
            onChange={(v) => writeVal('min-default', v, setMinDefault)}
            step={10}
          />
        </div>
      )}
      {tier === 'md' && (
        <div className="flex items-center justify-between w-full">
          <ControlLabel label="Min Width" property="" plain />
          <ToolInput
            value={minMd}
            onChange={(v) => writeVal('min-md', v, setMinMd)}
            step={10}
          />
        </div>
      )}

      <TextPropertyControl
        property="fontSize" label="Size"
        value={responsiveProps.size || (tier !== 'base' ? size : '')}
        onChange={(v) => writeVal(responsiveProps.sizeSuffix, v, responsiveProps.setSize)}
      />
      <TextPropertyControl
        property="letterSpacing" label="Spacing"
        value={responsiveProps.spacing || (tier !== 'base' ? spacing : '')}
        onChange={(v) => writeVal(responsiveProps.spacingSuffix, v, responsiveProps.setSpacing)}
      />
      <TextPropertyControl
        property="lineHeight" label="Line Height"
        value={responsiveProps.lineHeight || (tier !== 'base' ? lineHeight : '')}
        onChange={(v) => writeVal(responsiveProps.lineHeightSuffix, v, responsiveProps.setLineHeight)}
      />
    </div>
  );
}
