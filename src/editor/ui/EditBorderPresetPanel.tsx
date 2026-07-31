// EditBorderPresetPanel.tsx — Live editor for an existing compound border
// preset GROUP. Each field change fires `updatePresetToken` for the matching
// facet (width / style / color, or width / image-source / image-slice for
// gradient). bumpVersion is debounced so dragging a slider doesn't avalanche
// through every preset consumer — the canvas itself updates instantly via
// the CSS variable.
//
// Flavor toggle: a Solid/Gradient segmented control sits at the top so the
// user can swap an existing preset between the two flavors in place. The
// switch removes the tokens that don't belong to the new flavor and adds
// fresh defaults for the missing ones; width is shared and preserved.
//
// Used by:
//   - BorderControl's blue-pill edit popup on a node
//   - PresetsPanel / LibraryPanel border row edit popups

import { useCallback, useEffect } from 'react';
import { useDebouncedCallback } from '@/editor/hooks/useDebouncedCallback';
import { useSetAtom } from 'jotai';
import ToolInput from '../controls/ToolInput';
import ToolSelect from '../controls/ToolSelect';
import ToolSegmentedControl from '../controls/ToolSegmentedControl';
import ColorInput from '../controls/ColorInput';
import ControlLabel from '../controls/ControlLabel';
import GradientEditor from './GradientEditor';
import { queueMutation } from '@/code/mutation/mutation-queue';
import { projectVersionAtom } from '@/code/project/project-fs';
import {
  getBorderTokenValue,
  createDefaultSolidBorderTokens,
  createDefaultGradientBorderTokens,
  type BorderGroup,
} from './border-preset-utils';
import { liveUpdatePresetToken } from './preset-live-update';
import { trace } from '@/shared/debug-trace';

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

export default function EditBorderPresetPanel({ group }: { group: BorderGroup }) {
  const bumpVersion = useSetAtom(projectVersionAtom);
  // Debounced version bump so dragging a slider doesn't avalanche through
  // every preset consumer.
  const debouncedBump = useDebouncedCallback(() => bumpVersion(v => v + 1), 300);

  const update = useCallback((suffix: 'width' | 'style' | 'color' | 'image-source' | 'image-slice', value: string) => {
    const tokenName = `border-${group.name}-${suffix}`;
    // liveUpdatePresetToken paints the canvas immediately via the bridge AND
    // queues the tokens.css write. The version bump is debounced so dragging
    // a slider doesn't avalanche through every preset consumer.
    liveUpdatePresetToken(tokenName, value);
    debouncedBump.call();
    trace.action('border-preset:edit', { tokenName, value });
  }, [group.name, debouncedBump]);

  const switchFlavor = useCallback((next: 'solid' | 'gradient') => {
    if (next === group.flavor) return;
    trace.action('border-preset:switch-flavor', { name: group.name, from: group.flavor, to: next });

    // Drop tokens that don't belong to the new flavor. Width is shared and
    // is intentionally preserved across the swap.
    for (const token of group.tokens) {
      if (next === 'solid') {
        if (token.name.endsWith('-image-source') || token.name.endsWith('-image-slice')) {
          queueMutation({ type: 'removePresetToken', name: token.name });
        }
      } else {
        if (token.name.endsWith('-style') || token.name.endsWith('-color')) {
          queueMutation({ type: 'removePresetToken', name: token.name });
        }
      }
    }

    // Add the missing facets for the new flavor (skip width — it already exists).
    const existing = new Set(group.tokens.map(t => t.name));
    const fresh = next === 'gradient'
      ? createDefaultGradientBorderTokens(group.name)
      : createDefaultSolidBorderTokens(group.name);
    for (const t of fresh) {
      if (!existing.has(t.name)) {
        queueMutation({ type: 'addPresetToken', token: t });
      }
    }

    // Immediate version bump — flavor swap is a discrete UI action, not a
    // continuous slider drag, so don't fold it into the debounced edit timer.
    debouncedBump.cancel();
    bumpVersion(v => v + 1);
  }, [group, bumpVersion, debouncedBump]);

  useEffect(() => {
    return () => {
      debouncedBump.cancel();
      bumpVersion(v => v + 1);
    };
  }, [bumpVersion, debouncedBump]);

  const flavorTabs = (
    <ToolSegmentedControl
      value={group.flavor}
      onChange={(v) => switchFlavor(v as 'solid' | 'gradient')}
      options={[{ value: 'solid', label: 'Solid' }, { value: 'gradient', label: 'Gradient' }]}
      size="sm"
    />
  );

  if (group.flavor === 'gradient') {
    const widthVal = getBorderTokenValue(group, 'width');
    const gradVal = getBorderTokenValue(group, 'image-source');
    return (
      <div className="flex flex-col gap-2">
        {flavorTabs}
        <div className="flex items-center justify-between w-full">
          <ControlLabel label="Width" property="borderWidth" plain />
          <ToolInput value={widthVal} onChange={(v) => update('width', v)} step={1} />
        </div>
        <GradientEditor value={gradVal} onChange={(css) => update('image-source', css)} />
      </div>
    );
  }

  const widthVal = getBorderTokenValue(group, 'width');
  const styleVal = getBorderTokenValue(group, 'style') || 'solid';
  const colorVal = getBorderTokenValue(group, 'color') || '#000000';
  return (
    <div className="flex flex-col gap-2">
      {flavorTabs}
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Width" property="borderWidth" plain />
        <ToolInput value={widthVal} onChange={(v) => update('width', v)} step={1} />
      </div>
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Style" property="borderStyle" plain />
        <ToolSelect
          value={styleVal}
          onChange={(v) => update('style', v)}
          options={BORDER_STYLE_OPTIONS}
        />
      </div>
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Color" property="borderColor" plain />
        <ColorInput value={colorVal} onChange={(v) => update('color', v)} showAlpha />
      </div>
    </div>
  );
}
